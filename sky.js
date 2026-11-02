// sky.js - Sun, Moon and planets (az/el) using astronomy-engine.
const A = require('astronomy-engine');
const BODIES = [
  ['Sun', 'star'], ['Moon', 'moon'], ['Mercury', 'planet'], ['Venus', 'planet'], ['Mars', 'planet'],
  ['Jupiter', 'planet'], ['Saturn', 'planet'], ['Uranus', 'planet'], ['Neptune', 'planet'],
];
function bodiesNow(lat, lon, altM, date = new Date()) {
  const obs = new A.Observer(lat, lon, altM);
  return BODIES.map(([name, type]) => {
    const eq = A.Equator(name, date, obs, true, true);
    const hor = A.Horizon(date, obs, eq.ra, eq.dec, 'normal');
    let mag = null, phase = null;
    try { const ill = A.Illumination(name, date); mag = +ill.mag.toFixed(1); phase = ill.phase_fraction; } catch (_) {}
    return { name, type, az: +hor.azimuth.toFixed(2), el: +hor.altitude.toFixed(2), mag, illuminated: phase };
  });
}
module.exports = { bodiesNow };
