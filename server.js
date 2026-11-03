// server.js - Express API for the satellite app (v2: retries, backup data, clear error logs).
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { parseTle, visibleNow } = require('./visibility');
const { bodiesNow } = require('./sky');

const app = express();
app.use(cors());

const DATA_DIR = path.join(__dirname, 'data'); // fresh downloads are cached here
const SEED_DIR = path.join(__dirname, 'seed'); // backup copies shipped with the code
fs.mkdirSync(DATA_DIR, { recursive: true });

// "visual" = ~100 brightest satellites, "stations" = ISS, Tiangong etc.
const GROUPS = ['visual', 'stations'];
const MAX_AGE_MS = 6 * 60 * 60 * 1000;
const RETRY_MS = 3 * 60 * 1000;
  const REPO_RAW = 'https://raw.githubusercontent.com/Tarunmukil-06/satellite-api/main/seed';
  const urlsFor = (g) => [
    `${REPO_RAW}/${g}.tle`, // kept fresh by the GitHub job (reachable from Render)
    `https://celestrak.org/NORAD/elements/gp.php?GROUP=${g}&FORMAT=tle`,
  ];

let items = [];
let loadedAt = 0; // last successful load
let lastTry = 0;
let source = 'none'; // live | backup | none
let running = null;

async function download(group) {
  for (const url of urlsFor(group)) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'satellite-sky/1.0 (personal project)' },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();
      if (!text.includes('\n1 ')) throw new Error('unexpected response');
      return text;
    } catch (e) {
      const why = e.cause ? (e.cause.code || e.cause.message) : e.message;
      console.warn(`download failed for ${group} (${url}): ${e.message} [${why}]`);
    }
  }
  return null;
}

async function loadGroup(group) {
  const file = path.join(DATA_DIR, `${group}.tle`);
  try {
    if (Date.now() - fs.statSync(file).mtimeMs < MAX_AGE_MS) {
      return { text: fs.readFileSync(file, 'utf8'), live: true };
    }
  } catch (_) {}
  const text = await download(group);
  if (text) {
    fs.writeFileSync(file, text);
    console.log(`downloaded ${group}`);
    return { text, live: true };
  }
  if (fs.existsSync(file)) return { text: fs.readFileSync(file, 'utf8'), live: false };
  const seed = path.join(SEED_DIR, `${group}.tle`);
  if (fs.existsSync(seed)) {
    console.warn(`using bundled backup data for ${group}`);
    return { text: fs.readFileSync(seed, 'utf8'), live: false };
  }
  return { text: '', live: false };
}

function refresh() {
  if (running) return running;
  running = (async () => {
    lastTry = Date.now();
    const map = new Map();
    let allLive = true;
    for (const g of GROUPS) {
      const { text, live } = await loadGroup(g);
      if (!live) allLive = false;
      for (const it of parseTle(text)) map.set(it.noradId, it);
    }
    if (map.size > 0) {
      items = [...map.values()];
      loadedAt = Date.now();
      source = allLive ? 'live' : 'backup';
    }
    console.log(`${items.length} satellites loaded (${source})`);
  })()
    .catch((e) => console.error('refresh error', e))
    .finally(() => { running = null; });
  return running;
}

function needRefresh() {
  const now = Date.now();
  if (items.length === 0) return now - lastTry > 30 * 1000;
  if (now - loadedAt > MAX_AGE_MS) return now - lastTry > RETRY_MS;
  return source !== 'live' && now - lastTry > RETRY_MS;
}

app.get('/api/health', (_req, res) =>
  res.json({
    ok: true,
    satellitesLoaded: items.length,
    dataSource: source,
    tleLoadedAt: loadedAt ? new Date(loadedAt).toISOString() : null,
  }));

app.get('/api/sky', async (req, res) => {
  const lat = parseFloat(req.query.lat), lon = parseFloat(req.query.lon), alt = parseFloat(req.query.alt || '0');
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180)
    return res.status(400).json({ error: 'lat and lon are required (degrees)' });
  if (needRefresh()) {
    const p = refresh();
    if (items.length === 0) await p;
  }
  const altM = Number.isFinite(alt) ? alt : 0;
  const opts = {};
  if (req.query.maxMag) opts.maxMag = parseFloat(req.query.maxMag);
  if (req.query.minEl) opts.minEl = parseFloat(req.query.minEl);
  const now = new Date();
  const bodies = bodiesNow(lat, lon, altM, now);
  if (items.length === 0) {
    // still return Sun/Moon/planets even without satellites
    return res.json({ time: now.toISOString(), sunElevation: null, dark: false, satellites: [], bodies, dataSource: 'none',
      warning: 'No satellite data available on the server yet.' });
  }
  const sky = visibleNow(items, lat, lon, altM, now, opts);
  res.json({ ...sky, bodies, dataSource: source });
});

const PORT = process.env.PORT || 3000;
refresh().finally(() => app.listen(PORT, '0.0.0.0', () => console.log(`API running on port ${PORT}`)));