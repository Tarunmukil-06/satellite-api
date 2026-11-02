// visibility.js - decides which satellites a person can really see with the naked eye.
const sat = require('satellite.js');

const DEG = Math.PI / 180;
const KM_PER_AU = 149597870.7;

// Approximate "standard magnitudes" (brightness at 1000 km range, half-illuminated).
// Satellites in the CelesTrak "visual" group are the brightest ones, so unknown ones get DEFAULT_STD_MAG.
// Optional improvement: parse Mike McCants' qs.mag file to get a real value per NORAD id.
const STD_MAG = {
  25544: -1.8, // ISS
  48274: -1.0, // Tiangong core module (approx)
  20580: 2.2,  // Hubble (approx)
};
const DEFAULT_STD_MAG = 3.5;

function parseTle(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const out = [];
  for (let i = 0; i + 2 < lines.length; i += 3) {
    const name = lines[i].replace(/^0 /, '');
    const l1 = lines[i + 1], l2 = lines[i + 2];
    if (!l1.startsWith('1 ') || !l2.startsWith('2 ')) { i -= 2; continue; }
    try {
      const satrec = sat.twoline2satrec(l1, l2);
      if (satrec.error) continue;
      out.push({ name, noradId: parseInt(l1.substring(2, 7), 10), satrec });
    } catch (_) { /* skip bad TLE */ }
  }
  return out;
}

// Brightness estimate: diffuse-sphere model (the same one used by Heavens-Above style predictors).
function estimateMagnitude(stdMag, rangeKm, phaseRad) {
  const phaseTerm = Math.sin(phaseRad) + (Math.PI - phaseRad) * Math.cos(phaseRad);
  if (phaseTerm <= 0) return 99;
  return stdMag - 15 + 5 * Math.log10(rangeKm) - 2.5 * Math.log10(phaseTerm);
}

function norm(v) { return Math.hypot(v.x, v.y, v.z); }

// Full state of one satellite for one observer at one instant. Returns null if SGP4 fails.
function state(item, date, observer) {
  const pv = sat.propagate(item.satrec, date);
  if (!pv || !pv.position) return null;
  const gmst = sat.gstime(date);
  const ecf = sat.eciToEcf(pv.position, gmst);
  const look = sat.ecfToLookAngles(observer, ecf);
  const sun = sat.sunPos(sat.jday(date)).rsun; // AU, same ECI frame
  const sunKm = { x: sun.x * KM_PER_AU, y: sun.y * KM_PER_AU, z: sun.z * KM_PER_AU };
  const shadow = sat.shadowFraction(sun, pv.position); // 0 = fully sunlit, 1 = full umbra

  // observer position in ECI, to get the Sun-satellite-observer phase angle
  const obsEcf = sat.geodeticToEcf(observer);
  const obsEci = sat.ecfToEci(obsEcf, gmst);
  const toSun = { x: sunKm.x - pv.position.x, y: sunKm.y - pv.position.y, z: sunKm.z - pv.position.z };
  const toObs = { x: obsEci.x - pv.position.x, y: obsEci.y - pv.position.y, z: obsEci.z - pv.position.z };
  const cos = (toSun.x * toObs.x + toSun.y * toObs.y + toSun.z * toObs.z) / (norm(toSun) * norm(toObs));
  const phase = Math.acos(Math.max(-1, Math.min(1, cos)));

  const stdMag = STD_MAG[item.noradId] ?? DEFAULT_STD_MAG;
  const geo = sat.eciToGeodetic(pv.position, gmst);
  return {
    az: look.azimuth / DEG,
    el: look.elevation / DEG,
    rangeKm: look.rangeSat,
    altKm: geo.height,
    sunlit: shadow < 0.5,
    mag: estimateMagnitude(stdMag, look.rangeSat, phase),
  };
}

// How high is the Sun above the observer's horizon (degrees)?
function sunElevationDeg(date, observer) {
  const gmst = sat.gstime(date);
  const sun = sat.sunPos(sat.jday(date)).rsun;
  const ecf = sat.eciToEcf({ x: sun.x * KM_PER_AU, y: sun.y * KM_PER_AU, z: sun.z * KM_PER_AU }, gmst);
  return sat.ecfToLookAngles(observer, ecf).elevation / DEG;
}

const isVisible = (s, o) => s && s.el >= o.minEl && s.sunlit && s.mag <= o.maxMag;

// Main entry: all satellites a person could see right now.
function visibleNow(items, latDeg, lonDeg, altM, date = new Date(), opts = {}) {
  const o = { minEl: 10, maxMag: 4.0, maxSunEl: -6, ...opts };
  const observer = { latitude: latDeg * DEG, longitude: lonDeg * DEG, height: altM / 1000 };
  const sunEl = sunElevationDeg(date, observer);
  const dark = sunEl <= o.maxSunEl;
  const result = [];
  if (dark) {
    for (const item of items) {
      const s = state(item, date, observer);
      if (!isVisible(s, o)) continue;
      const later = state(item, new Date(date.getTime() + 1000), observer);
      let azRate = later.az - s.az;
      if (azRate > 180) azRate -= 360; if (azRate < -180) azRate += 360;
      // how many more seconds stays visible (checked in 10 s steps, max 15 min)
      let secs = 0;
      for (let t = 10; t <= 900; t += 10) {
        const f = state(item, new Date(date.getTime() + t * 1000), observer);
        if (!isVisible(f, o)) break;
        secs = t;
      }
      result.push({
        noradId: item.noradId, name: item.name,
        az: +s.az.toFixed(2), el: +s.el.toFixed(2),
        azRate: +azRate.toFixed(4), elRate: +(later.el - s.el).toFixed(4), // degrees per second
        mag: +s.mag.toFixed(1), rangeKm: Math.round(s.rangeKm), altKm: Math.round(s.altKm),
        visibleForSec: secs,
      });
    }
  }
  result.sort((a, b) => a.mag - b.mag);
  return { time: date.toISOString(), sunElevation: +sunEl.toFixed(1), dark, filters: o, satellites: result };
}

module.exports = { parseTle, state, visibleNow, sunElevationDeg, estimateMagnitude };
