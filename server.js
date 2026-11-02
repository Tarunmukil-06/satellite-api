// server.js - Express API for the satellite app.
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { parseTle, visibleNow } = require('./visibility');
const { bodiesNow } = require('./sky');

const app = express();
app.use(cors());

const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
// "visual" = ~100 brightest satellites, "stations" = ISS, Tiangong etc.
const GROUPS = ['visual', 'stations'];
const MAX_AGE_MS = 6 * 60 * 60 * 1000; // CelesTrak asks for no more than one download per 2 hours

let items = [];
let loadedAt = 0;

async function loadGroup(group) {
  const file = path.join(DATA_DIR, `${group}.tle`);
  let fresh = false;
  try { fresh = Date.now() - fs.statSync(file).mtimeMs < MAX_AGE_MS; } catch (_) {}
  if (!fresh) {
    try {
      const res = await fetch(`https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=tle`);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();
      if (!text.includes('\n1 ')) throw new Error('unexpected response');
      fs.writeFileSync(file, text);
      console.log(`downloaded ${group}`);
    } catch (e) {
      console.warn(`could not download ${group}: ${e.message} (using cached file if any)`);
    }
  }
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

async function refresh() {
  const map = new Map();
  for (const g of GROUPS) for (const it of parseTle(await loadGroup(g))) map.set(it.noradId, it);
  items = [...map.values()];
  loadedAt = Date.now();
  console.log(`${items.length} satellites loaded`);
}

app.get('/api/health', (_req, res) => res.json({ ok: true, satellitesLoaded: items.length, tleLoadedAt: new Date(loadedAt).toISOString() }));

app.get('/api/sky', async (req, res) => {
  const lat = parseFloat(req.query.lat), lon = parseFloat(req.query.lon), alt = parseFloat(req.query.alt || '0');
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180)
    return res.status(400).json({ error: 'lat and lon are required (degrees)' });
  if (Date.now() - loadedAt > MAX_AGE_MS) await refresh();
  if (items.length === 0) return res.status(503).json({ error: 'No satellite data yet. Check internet on the server and retry.' });
  const opts = {};
  if (req.query.maxMag) opts.maxMag = parseFloat(req.query.maxMag);
  if (req.query.minEl) opts.minEl = parseFloat(req.query.minEl);
  const now = new Date();
  const sky = visibleNow(items, lat, lon, Number.isFinite(alt) ? alt : 0, now, opts);
  res.json({ ...sky, bodies: bodiesNow(lat, lon, Number.isFinite(alt) ? alt : 0, now) });
});

const PORT = process.env.PORT || 3000;
refresh().finally(() => app.listen(PORT, '0.0.0.0', () => console.log(`API running on port ${PORT}`)));
