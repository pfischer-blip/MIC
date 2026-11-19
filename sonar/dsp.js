/* Phone sonar signal processing. Works in browser (window.SonarDSP) and Node (module.exports). */
(function (root) {
  'use strict';

  function nextPow2(n) { let p = 1; while (p < n) p <<= 1; return p; }

  // In-place iterative radix-2 complex FFT.
  function fft(re, im, inverse) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const ang = (inverse ? 2 : -2) * Math.PI / len;
      for (let k = 0; k < half; k++) {
        const cr = Math.cos(ang * k), ci = Math.sin(ang * k);
        for (let i = k; i < n; i += len) {
          const b = i + half;
          const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
          re[b] = re[i] - xr; im[b] = im[i] - xi;
          re[i] += xr; im[i] += xi;
        }
      }
    }
    if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }

  // Speed of sound in dry air (m/s) at temperature tC (deg C).
  function speedOfSound(tC) { return 331.3 * Math.sqrt(1 + tC / 273.15); }

  // Hann-windowed linear chirp from f0 to f1 Hz lasting dur seconds.
  function makeChirp(fs, f0, f1, dur) {
    const n = Math.round(dur * fs), x = new Float32Array(n), k = (f1 - f0) / dur;
    for (let i = 0; i < n; i++) {
      const t = i / fs;
      const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
      x[i] = w * Math.sin(2 * Math.PI * (f0 * t + 0.5 * k * t * t));
    }
    return x;
  }

  // Matched filter: returns fn(signal) -> envelope of cross-correlation with template,
  // indexed by lag (sample where the template starts). Uses the analytic signal so the
  // envelope is smooth (no carrier ripple).
  function createMatchedFilter(template, maxSignalLen) {
    const n = nextPow2(maxSignalLen + template.length);
    const tr = new Float64Array(n), ti = new Float64Array(n);
    tr.set(template); fft(tr, ti, false);
    let energy = 0; for (let i = 0; i < template.length; i++) energy += template[i] * template[i];
    return function (sig) {
      const re = new Float64Array(n), im = new Float64Array(n);
      re.set(sig.length > n ? sig.subarray(0, n) : sig);
      fft(re, im, false);
      for (let k = 0; k < n; k++) {
        // X * conj(T), then analytic: keep DC/Nyquist, double positive, zero negative.
        let r = re[k] * tr[k] + im[k] * ti[k];
        let q = im[k] * tr[k] - re[k] * ti[k];
        const g = (k === 0 || k === n / 2) ? 1 : (k < n / 2 ? 2 : 0);
        re[k] = r * g; im[k] = q * g;
      }
      fft(re, im, true);
      const valid = Math.max(0, sig.length - template.length + 1);
      const env = new Float32Array(valid);
      for (let i = 0; i < valid; i++) env[i] = Math.hypot(re[i], im[i]) / energy;
      return env;
    };
  }

  function argmax(a, lo, hi) {
    lo = Math.max(0, lo | 0); hi = Math.min(a.length, hi | 0);
    let b = lo; for (let i = lo + 1; i < hi; i++) if (a[i] > a[b]) b = i;
    return b;
  }

  // Parabolic interpolation around index i -> fractional offset in [-0.5, 0.5].
  function parabolic(a, i) {
    if (i <= 0 || i >= a.length - 1) return 0;
    const y0 = a[i - 1], y1 = a[i], y2 = a[i + 1], d = y0 - 2 * y1 + y2;
    if (d === 0) return 0;
    const o = 0.5 * (y0 - y2) / d;
    return Math.max(-0.5, Math.min(0.5, o));
  }

  function interp(a, x) {
    const i = Math.floor(x), f = x - i;
    if (i < 0 || i + 1 >= a.length) return 0;
    return a[i] * (1 - f) + a[i + 1] * f;
  }

  function median(a) {
    if (!a.length) return 0;
    const s = Array.from(a).sort((x, y) => x - y), m = s.length >> 1;
    return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]);
  }

  /*
   * Given the envelope of a recording containing a periodic ping train (period I samples),
   * find each ping's direct speaker->mic arrival and average the echo profiles that follow it.
   * Everything is measured relative to the direct arrival, so unknown speaker/mic latency cancels.
   * Returns { profile (normalised to direct peak = 1), directAmp, pings, prominence } or null.
   */
  function extractProfile(env, I, profileLen, fs) {
    if (env.length < I + profileLen) return null;
    const p = argmax(env, 0, I);
    const win = Math.max(2, Math.round(0.001 * fs));
    const acc = new Float64Array(profileLen);
    let count = 0, ampSum = 0;
    for (let k = 0; ; k++) {
      const c = Math.round(p + k * I);
      if (c + win + profileLen + 1 >= env.length) break;
      const q = argmax(env, c - win, c + win + 1);
      const x0 = q + parabolic(env, q);
      const amp = interp(env, x0) || env[q];
      if (amp <= 0) continue;
      for (let j = 0; j < profileLen; j++) acc[j] += interp(env, x0 + j) / amp;
      ampSum += amp; count++;
    }
    if (!count) return null;
    const profile = new Float32Array(profileLen);
    for (let j = 0; j < profileLen; j++) profile[j] = acc[j] / count;
    // How much the direct peak stands out from the rest of the period (detects "no ping heard").
    const prominence = (ampSum / count) / (median(env.subarray(0, Math.min(env.length, I))) + 1e-12);
    return { profile, directAmp: ampSum / count, pings: count, prominence };
  }

  // Convert between profile sample index (samples after direct arrival) and distance in metres.
  // offset = half the speaker-to-mic spacing plus any user calibration offset.
  function idxToDist(j, fs, c, offset) { return c * (j / fs) / 2 + offset; }
  function distToIdx(d, fs, c, offset) { return Math.round((d - offset) * 2 * fs / c); }

  /*
   * Find the strongest echo in [minRange, maxRange] of a (residual) profile.
   * Returns { distance, index, strength, snrDb } or null if nothing clears the threshold.
   */
  function detectEcho(resid, fs, c, opts) {
    const off = opts.offset || 0;
    const lo = Math.max(1, distToIdx(opts.minRange, fs, c, off));
    const hi = Math.min(resid.length - 1, distToIdx(opts.maxRange, fs, c, off));
    if (hi <= lo + 2) return null;
    const j = argmax(resid, lo, hi);
    const strength = resid[j];
    const floor = median(resid.subarray(lo, hi)) + 1e-9;
    const snrDb = 20 * Math.log10(strength / floor);
    if (snrDb < (opts.minSnrDb == null ? 10 : opts.minSnrDb)) return null;
    const jf = j + parabolic(resid, j);
    return { distance: idxToDist(jf, fs, c, off), index: jf, strength, snrDb };
  }

  // Residual = |profile - reference|, used both for calibration (static clutter removal)
  // and motion (difference from a slowly-updated background).
  function residual(profile, ref) {
    const out = new Float32Array(profile.length);
    for (let i = 0; i < profile.length; i++) out[i] = ref ? Math.abs(profile[i] - ref[i]) : profile[i];
    return out;
  }

  // Least-squares slope of (t, d) samples -> velocity in m/s. Positive = moving away.
  function velocity(samples) {
    const n = samples.length;
    if (n < 3) return null;
    let st = 0, sd = 0; for (const s of samples) { st += s.t; sd += s.d; }
    const mt = st / n, md = sd / n;
    let num = 0, den = 0;
    for (const s of samples) { num += (s.t - mt) * (s.d - md); den += (s.t - mt) * (s.t - mt); }
    return den > 0 ? num / den : null;
  }

  const api = { nextPow2, fft, speedOfSound, makeChirp, createMatchedFilter, extractProfile,
    detectEcho, residual, velocity, idxToDist, distToIdx, median, argmax };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SonarDSP = api;
})(typeof window !== 'undefined' ? window : globalThis);
