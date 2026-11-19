// Simulates what the phone mic hears and checks the DSP recovers distances and velocity.
const D = require('../dsp.js');
const fs = 48000, f0 = 3000, f1 = 11000, dur = 0.004, T = 20, c = D.speedOfSound(T);
const I = Math.round(0.05 * fs), K = 4, maxRange = 4, offset = 0;
const chirp = D.makeChirp(fs, f0, f1, dur);
const profileLen = D.distToIdx(maxRange + 0.3, fs, c, 0);
const chunkLen = (K + 1) * I + chirp.length;
const mf = D.createMatchedFilter(chirp, chunkLen);
let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
function addAt(buf, t0, amp) { // fractional-delay chirp via analytic formula
  const k = (f1 - f0) / dur, n = chirp.length;
  const s = Math.floor(t0 * fs);
  for (let i = s; i < s + n + 2 && i < buf.length; i++) {
    const t = i / fs - t0; if (t < 0 || t > dur) continue;
    const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * t / dur);
    buf[i] += amp * w * Math.sin(2 * Math.PI * (f0 * t + 0.5 * k * t * t));
  }
}
// fixed phone-body coupling "ringing" right after the direct path
const ring = Array.from({ length: 40 }, (_, i) => ({ dt: (i + 1) * 0.00008, a: 0.25 * Math.exp(-i / 8) * gauss() }));
function record(target, phase) {
  const buf = new Float32Array(chunkLen);
  const lat = 0.0123 + phase; // unknown output->input latency
  for (let p = -1; p <= K + 1; p++) {
    const t0 = lat + p * I / fs;
    addAt(buf, t0, 1.0);
    for (const r of ring) addAt(buf, t0 + r.dt, r.a);
    addAt(buf, t0 + 2 * 2.6 / c, 0.02);  // far wall
    addAt(buf, t0 + 2 * 3.7 / c, 0.012); // another surface
    if (target) addAt(buf, t0 + 2 * target / c, 0.03);
  }
  for (let i = 0; i < buf.length; i++) buf[i] += 0.004 * gauss();
  return buf;
}
const measure = (buf) => D.extractProfile(mf(buf), I, profileLen, fs);
// 1) calibration: no target
let base = null;
for (let n = 0; n < 6; n++) {
  const r = measure(record(null, rnd() * 0.04));
  if (!base) base = new Float32Array(r.profile.length);
  for (let i = 0; i < base.length; i++) base[i] += r.profile[i] / 6;
}
const opts = { minRange: 0.3, maxRange, offset, minSnrDb: 10 };
let maxErr = 0;
for (const d of [0.4, 0.75, 1.2, 1.9, 3.1]) {
  const r = measure(record(d, rnd() * 0.04));
  const det = D.detectEcho(D.residual(r.profile, base), fs, c, opts);
  const err = det ? Math.abs(det.distance - d) : Infinity;
  maxErr = Math.max(maxErr, err);
  console.log(`true ${d.toFixed(2)} m -> ${det ? det.distance.toFixed(3) + ' m, SNR ' + det.snrDb.toFixed(1) + ' dB' : 'none'}  (pings ${r.pings}, prominence ${r.prominence.toFixed(0)})`);
}
// uncalibrated: wall at 2.6 m should be the strongest echo beyond the ringing
const r0 = measure(record(null, 0.01));
const det0 = D.detectEcho(r0.profile, fs, c, { ...opts, minRange: 0.6 });
console.log('uncalibrated, no target ->', det0 && det0.distance.toFixed(3), 'm (expect 2.6 wall)');
// 2) motion: target moving from 1.0 m toward phone at -0.5 m/s, background-difference method
let bg = null; const hist = [];
for (let n = 0; n < 12; n++) {
  const t = n * K * I / fs, d = 1.5 - 0.5 * t;
  const r = measure(record(d, rnd() * 0.04));
  if (!bg) { bg = Float32Array.from(base); }
  const det = D.detectEcho(D.residual(r.profile, bg), fs, c, opts);
  for (let i = 0; i < bg.length; i++) bg[i] = 0.9 * bg[i] + 0.1 * r.profile[i];
  if (det) hist.push({ t, d: det.distance }); if (process.env.DBG) console.log(t.toFixed(2), d.toFixed(3), det && det.distance.toFixed(3));
}
const v = D.velocity(hist.slice(-10));
console.log(`motion: ${hist.length}/12 detections, velocity ${v.toFixed(3)} m/s (true -0.500)`);
if (maxErr > 0.03 || Math.abs(v + 0.5) > 0.05) { console.log('FAIL'); process.exit(1); }
console.log('PASS, max static error', (maxErr * 100).toFixed(1), 'cm');
