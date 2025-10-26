// api/index.js
import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';

const app = express();

/* ------------ CORS global ------------ */
function corsHeaders(req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', '*'); // ganti ke domain FE jika perlu
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  next();
}
app.use(cors());
app.use(corsHeaders);
app.use(express.json());

/* ------------ ENV untuk opsi A ------------ */
// GH_REPO="owner/repo" contoh: "sigitars9-hue/api-gv-comics-data"
// GH_BRANCH="main" (opsional)
// GITHUB_TOKEN (opsional, untuk rate limit lega)
const GH_REPO   = process.env.GH_REPO;
const GH_BRANCH = process.env.GH_BRANCH || 'main';
const GH_TOKEN  = process.env.GITHUB_TOKEN || '';
const RAW_URL   = GH_REPO
  ? `https://raw.githubusercontent.com/${GH_REPO}/${GH_BRANCH}/data.json`
  : null;

// fallback lokal (dev only)
const DATA_PATH = path.join(process.cwd(), 'data.json');

// cache ringan di memori (per instance)
let __cache = { etag: null, data: null, ts: 0 };

async function load() {
  // jika belum set GH_REPO → baca lokal (untuk dev)
  if (!RAW_URL) {
    const raw = fs.readFileSync(DATA_PATH, 'utf-8');
    return JSON.parse(raw);
  }

  // cache 10 detik
  const now = Date.now();
  if (__cache.data && now - __cache.ts < 10_000) return __cache.data;

  const headers = {};
  if (GH_TOKEN) headers['Authorization'] = `token ${GH_TOKEN}`;
  if (__cache.etag) headers['If-None-Match'] = __cache.etag;

  const resp = await fetch(RAW_URL, { headers });

  if (resp.status === 304 && __cache.data) {
    __cache.ts = now;
    return __cache.data;
  }

  if (!resp.ok) {
    // fallback ke cache lama atau file lokal
    if (__cache.data) return __cache.data;
    const raw = fs.readFileSync(DATA_PATH, 'utf-8');
    return JSON.parse(raw);
  }

  const text = await resp.text();
  const json = JSON.parse(text);

  __cache = {
    etag: resp.headers.get('etag'),
    data: json,
    ts: now,
  };
  return json;
}

/* ------------ Helpers ------------ */
function toCard(s) {
  return {
    id: s.slug,
    slug: s.slug,
    title: s.title,
    cover: s.cover,
    updatedAt: s.chapters?.[0]?.createdAt || null,
    badge: s.type || 'UP',
  };
}

async function getData() {
  const data = await load();
  return {
    series: Array.isArray(data.series) ? data.series : [],
    chapters: data.chapters && typeof data.chapters === 'object' ? data.chapters : {},
    announcements: Array.isArray(data.announcements) ? data.announcements : [],
  };
}

/* ------------ Routes ------------ */

// Root
app.get('/', (req, res) => {
  res.json({
    ok: true,
    name: 'gv-comics-api',
    docs: [
      '/latest?page=1',
      '/recommendations?type=manhwa',
      '/announcements',
      '/manga/:slug',
      '/manga/chapter/:id',
      '/search?q=keyword',
      '/genres',
      '/by-genre/:name?page=1&pageSize=20',
      '/popular?range=daily|weekly|all',
    ],
  });
});

/* ===================== LATEST ===================== */
app.get(['/latest', '/manga/latest', '/recent'], async (req, res) => {
  const { series } = await getData();
  const page = parseInt(req.query.page || '1', 10);
  const pageSize = parseInt(req.query.pageSize || '20', 10);
  const sorted = [...series].sort((a, b) =>
    new Date(b?.chapters?.[0]?.createdAt || 0) - new Date(a?.chapters?.[0]?.createdAt || 0)
  );
  const start = (page - 1) * pageSize;
  res.json(sorted.slice(start, start + pageSize).map(toCard));
});

/* ===================== POPULAR ===================== */
app.get('/popular', async (req, res) => {
  const { series } = await getData();
  const range = String(req.query.range || 'daily').toLowerCase();
  let sorted = [...series];

  if (range === 'daily') {
    sorted.sort((a, b) => (b.bookmarks || 0) - (a.bookmarks || 0));
  } else if (range === 'weekly') {
    sorted.sort((a, b) => (b.views || 0) - (a.views || 0));
  } else {
    sorted.sort(
      (a, b) =>
        (b.rating || 0) - (a.rating || 0) ||
        (b.views || 0) - (a.views || 0) ||
        (b.bookmarks || 0) - (a.bookmarks || 0)
    );
  }

  res.json(sorted.slice(0, 10).map(toCard));
});

/* ================== RECOMMENDATIONS ================= */
app.get('/recommendations', async (req, res) => {
  const { series } = await getData();
  const items = series.slice(0, 15).map((s) => ({
    id: s.slug,
    slug: s.slug,
    title: s.title,
    cover: s.cover,
    updatedAt: null,
  }));
  res.json(items);
});

/* ================== ANNOUNCEMENTS =================== */
app.get('/announcements', async (req, res) => {
  const { announcements } = await getData();
  res.json(announcements);
});

/* ====================== DETAIL SERIES ====================== */
app.get(['/manga/:slug', '/series/:slug'], async (req, res) => {
  const { series } = await getData();
  const found = series.find((s) => s.slug === req.params.slug);
  if (!found) return res.status(404).json({ error: 'series not found' });

  res.json({
    info: {
      slug: found.slug,
      title: found.title,
      description: found.description || '',
      type: found.type || 'Manhwa',
      genres: found.genres || [],
      author: found.author || '-',
      artist: found.artist || '-',
      status: found.status || 'Ongoing',
      cover: found.cover,
      banner: found.banner || found.cover,
      rating: found.rating || 0,
      views: found.views || 0,
      bookmarks: found.bookmarks || 0,
    },
    chapters: found.chapters || [],
  });
});

/* ===================== HALAMAN CHAPTER ===================== */
app.get(['/manga/chapter/:id', '/chapter/:id', '/chapters/:id'], async (req, res) => {
  const { chapters } = await getData();
  const pages = chapters[req.params.id];
  if (!pages) return res.status(404).json({ error: 'chapter not found' });
  res.json(pages);
});

/* ========================= SEARCH ========================= */
app.get('/search', async (req, res) => {
  const { series } = await getData();
  const qRaw = String(req.query.q || '').trim();
  if (!qRaw) return res.json([]);

  const norm = (s) =>
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  const terms = norm(qRaw).split(' ').filter(Boolean);

  const hits = series.filter((s) => {
    const hay =
      norm(s.title || '') +
      ' ' +
      norm(s.slug || '') +
      ' ' +
      norm((s.genres || []).join(' '));
    return terms.every((t) => hay.includes(t));
  });

  res.json(hits.map(toCard));
});

/* ========================= GENRES ========================= */
app.get('/genres', async (req, res) => {
  const { series } = await getData();
  const set = new Set();
  series.forEach((s) => (s.genres || []).forEach((g) => set.add(String(g))));
  res.json(Array.from(set).sort((a, b) => a.localeCompare(b)));
});

/* ========================= BY GENRE ========================= */
app.get('/by-genre/:name', async (req, res) => {
  const { series } = await getData();
  const name = (req.params.name || '').toLowerCase();
  const page = parseInt(req.query.page || '1', 10);
  const pageSize = parseInt(req.query.pageSize || '20', 10);

  const filtered = series.filter((s) =>
    (s.genres || []).some((g) => String(g).toLowerCase() === name)
  );

  const start = (page - 1) * pageSize;
  res.json({
    total: filtered.length,
    page,
    pageSize,
    items: filtered.slice(start, start + pageSize).map(toCard),
  });
});

/* ------------ Export handler untuk Vercel ------------ */
// export default app;  // ← JANGAN ini
export default function handler(req, res) {
  return app(req, res);
}
