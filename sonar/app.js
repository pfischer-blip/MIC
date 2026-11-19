(() => {
  'use strict';
  const D = window.SonarDSP;
  const $ = (id) => document.getElementById(id);
  const S = { ctx: null, stream: null, src: null, node: null, player: null, gain: null, timer: null,
    ring: null, ringPos: 0, written: 0, fs: 48000, mode: 'distance', baseline: null, calAcc: null, calLeft: 0,
    bg: null, history: [], lastProfile: null, lastResid: null, lastDet: null, cfg: null, mf: null, sinkGain: null };

  function readCfg() {
    const [f0, f1] = $('band').value.split(',').map(Number);
    const temp = Number($('temp').value) || 20;
    const maxR = Math.max(0.5, Number($('maxR').value) || 4);
    const c = D.speedOfSound(temp);
    return { f0, f1, dur: 0.004, temp, c, minR: Math.max(0.05, Number($('minR').value) || 0.3), maxR,
      offset: (Number($('offset').value) || 0) / 100, vol: Number($('vol').value), minSnrDb: Number($('snr').value) || 10 };
  }

  // Build the ping train / matched filter for current settings.
  function setup() {
    const cfg = readCfg(), fs = S.fs;
    const f1 = Math.min(cfg.f1, fs * 0.45), f0 = Math.min(cfg.f0, f1 - 1000);
    // Ping period: long enough for an echo from maxR plus some room-decay margin.
    const periodS = Math.max(0.05, 2 * cfg.maxR / cfg.c + 0.025);
    cfg.I = Math.round(periodS * fs);
    cfg.K = Math.max(2, Math.round(0.2 / periodS)); // pings averaged per update (~5 updates/s)
    cfg.chirp = D.makeChirp(fs, f0, f1, cfg.dur);
    cfg.profileLen = D.distToIdx(cfg.maxR + 0.3, fs, cfg.c, 0);
    cfg.chunkLen = (cfg.K + 1) * cfg.I + cfg.chirp.length;
    S.mf = D.createMatchedFilter(cfg.chirp, cfg.chunkLen);
    S.cfg = cfg;
    $('cval').textContent = cfg.c.toFixed(1);
    $('fsval').textContent = fs;
    return cfg;
  }

  function startPlayer() {
    const cfg = S.cfg, ctx = S.ctx;
    if (S.player) { try { S.player.stop(); } catch (e) {} S.player.disconnect(); }
    const buf = ctx.createBuffer(1, cfg.I, S.fs);
    buf.getChannelData(0).set(cfg.chirp);
    const p = ctx.createBufferSource();
    p.buffer = buf; p.loop = true; p.connect(S.gain); p.start();
    S.player = p;
    S.gain.gain.value = cfg.vol;
  }

  const WORKLET = `class R extends AudioWorkletProcessor{constructor(){super();this.b=new Float32Array(2048);this.n=0}
  process(i){const c=i[0]&&i[0][0];if(c){for(let k=0;k<c.length;k++){this.b[this.n++]=c[k];if(this.n===2048){this.port.postMessage(this.b);this.b=new Float32Array(2048);this.n=0}}}return true}}
  registerProcessor('sonar-rec',R);`;

  function pushSamples(x) {
    const r = S.ring, n = r.length;
    for (let i = 0; i < x.length; i++) { r[S.ringPos] = x[i]; S.ringPos = (S.ringPos + 1) % n; }
    S.written += x.length;
  }
  function latest(len) {
    const r = S.ring, n = r.length, out = new Float32Array(len);
    let p = (S.ringPos - len + n) % n;
    for (let i = 0; i < len; i++) { out[i] = r[p]; p = (p + 1) % n; }
    return out;
  }

  async function start() {
    try {
      status('Requesting microphone…');
      // iOS 17+: tell Safari we play and record at the same time.
      if (navigator.audioSession) { try { navigator.audioSession.type = 'play-and-record'; } catch (e) {} }
      const AC = window.AudioContext || window.webkitAudioContext;
      S.ctx = new AC({ latencyHint: 'interactive' });
      await S.ctx.resume();
      S.stream = await navigator.mediaDevices.getUserMedia({ audio: {
        echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } });
      S.fs = S.ctx.sampleRate;
      S.ring = new Float32Array(S.fs * 2); S.ringPos = 0; S.written = 0;
      setup();
      S.src = S.ctx.createMediaStreamSource(S.stream);
      S.sinkGain = S.ctx.createGain(); S.sinkGain.gain.value = 0; S.sinkGain.connect(S.ctx.destination);
      if (S.ctx.audioWorklet) {
        const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
        await S.ctx.audioWorklet.addModule(url);
        S.node = new AudioWorkletNode(S.ctx, 'sonar-rec');
        S.node.port.onmessage = (e) => pushSamples(e.data);
      } else {
        S.node = S.ctx.createScriptProcessor(2048, 1, 1);
        S.node.onaudioprocess = (e) => pushSamples(e.inputBuffer.getChannelData(0));
      }
      S.src.connect(S.node); S.node.connect(S.sinkGain);
      S.gain = S.ctx.createGain(); S.gain.connect(S.ctx.destination);
      startPlayer();
      S.bg = null; S.history = [];
      S.timer = setInterval(tick, Math.round(S.cfg.K * S.cfg.I / S.fs * 1000));
      $('startBtn').textContent = 'Stop'; $('startBtn').classList.add('on'); $('calBtn').disabled = false;
      status('Pinging…');
      if (navigator.wakeLock) navigator.wakeLock.request('screen').then((l) => (S.wake = l)).catch(() => {});
    } catch (e) {
      status('Could not start: ' + (e && e.message ? e.message : e) + '. The page must be opened over https and the mic allowed.', 'bad');
      stop();
    }
  }

  function stop() {
    clearInterval(S.timer); S.timer = null;
    if (S.stream) S.stream.getTracks().forEach((t) => t.stop());
    if (S.ctx) S.ctx.close().catch(() => {});
    if (S.wake) { S.wake.release().catch(() => {}); S.wake = null; }
    S.ctx = S.stream = S.player = null;
    $('startBtn').textContent = 'Start'; $('startBtn').classList.remove('on'); $('calBtn').disabled = true;
  }

  function status(msg, kind) { const el = $('status'); el.textContent = msg; el.style.color = kind === 'bad' ? 'var(--bad)' : kind === 'warn' ? 'var(--warn)' : ''; }

  function tick() {
    const cfg = S.cfg;
    if (S.written < cfg.chunkLen + S.fs * 0.1) return;
    const env = S.mf(latest(cfg.chunkLen));
    const r = D.extractProfile(env, cfg.I, cfg.profileLen, S.fs);
    if (!r || r.prominence < 8) {
      status('Not hearing the ping clearly. Turn volume up, silent switch off, uncover the bottom of the phone.', 'warn');
      show(null); return;
    }
    const prof = r.profile; S.lastProfile = prof;
    if (S.calLeft > 0) {
      for (let i = 0; i < prof.length; i++) S.calAcc[i] += prof[i];
      if (--S.calLeft === 0) {
        const n = S.calN; S.baseline = S.calAcc.map((v) => v / n);
        status('Calibrated. Now point at your target.');
        $('calBtn').textContent = 'Recalibrate';
      } else status(`Calibrating… hold still (${S.calLeft})`);
    } else if (!/Calibrated|Pinging/.test($('status').textContent)) status('Pinging…');

    let ref = S.baseline, opts = { minRange: cfg.minR, maxRange: cfg.maxR, offset: cfg.offset, minSnrDb: cfg.minSnrDb };
    if (S.mode === 'motion') {
      if (!S.bg) S.bg = Float32Array.from(prof);
      ref = S.bg;
    } else if (!ref) {
      opts.minRange = Math.max(cfg.minR, 0.5); // without calibration the phone's own ringing hides very close echoes
    }
    const resid = D.residual(prof, ref);
    S.lastResid = resid;
    const det = D.detectEcho(resid, S.fs, cfg.c, opts);
    if (S.mode === 'motion') { const a = 0.15; for (let i = 0; i < S.bg.length; i++) S.bg[i] = (1 - a) * S.bg[i] + a * prof[i]; }
    const now = performance.now() / 1000;
    if (det) S.history.push({ t: now, d: det.distance, snr: det.snrDb });
    S.history = S.history.filter((h) => now - h.t < 15);
    S.lastDet = det;
    show(det, now);
  }

  function fmt(d) { return d < 1 ? (d * 100).toFixed(1) + ' cm' : d.toFixed(2) + ' m'; }

  function show(det, now) {
    if (det) {
      // Median of the last 3 readings within 0.6 s to suppress single-ping glitches.
      const recent = S.history.filter((h) => now - h.t < 0.6).map((h) => h.d);
      const d = D.median(recent.length ? recent.slice(-3) : [det.distance]);
      $('dist').textContent = fmt(d);
      $('distsub').textContent = `${(d * 3.28084).toFixed(2)} ft · ${(d * 39.3701).toFixed(1)} in · signal ${det.snrDb > 60 ? "60+" : det.snrDb.toFixed(0)} dB`;
    } else {
      $('dist').textContent = '--';
      $('distsub').textContent = S.mode === 'motion' ? 'No movement detected' : 'No clear echo';
    }
    const m = $('motion');
    const win = S.history.filter((h) => now - h.t < 1.2);
    const v = D.velocity(win);
    if (v != null && Math.abs(v) > 0.05 && win.length >= 4) {
      const cms = Math.abs(v * 100).toFixed(0);
      m.textContent = v < 0 ? `⬇ approaching ${cms} cm/s` : `⬆ moving away ${cms} cm/s`;
      m.style.color = v < 0 ? 'var(--warn)' : 'var(--ok)';
    } else { m.textContent = det ? 'steady' : ''; m.style.color = 'var(--mut)'; }
    draw();
  }

  function setupCanvas(cv) {
    if (!cv.dataset.h) cv.dataset.h = cv.getAttribute('height');
    const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = Number(cv.dataset.h);
    if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); cv.style.height = h + 'px'; }
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
    return { g, w, h };
  }

  function draw() {
    const cfg = S.cfg; if (!cfg) return;
    // Echo profile in dB relative to the direct sound.
    { const { g, w, h } = setupCanvas($('profile'));
      const xOf = (d) => (d / cfg.maxR) * w, top = 0, bot = -60, yOf = (db) => h - ((Math.max(bot, Math.min(top, db)) - bot) / (top - bot)) * (h - 14) - 14;
      g.fillStyle = '#8a98b0'; g.font = '11px sans-serif';
      for (let d = 0; d <= cfg.maxR + 1e-6; d += cfg.maxR > 5 ? 2 : 1) { g.fillRect(xOf(d), h - 14, 1, 4); g.fillText(d + 'm', Math.min(w - 20, xOf(d) + 2), h - 2); }
      const plot = (arr, color, lw) => { if (!arr) return; g.strokeStyle = color; g.lineWidth = lw; g.beginPath();
        for (let j = 0; j < arr.length; j++) { const d = D.idxToDist(j, S.fs, cfg.c, cfg.offset); if (d > cfg.maxR) break;
          const y = yOf(20 * Math.log10(arr[j] + 1e-6)); j ? g.lineTo(xOf(d), y) : g.moveTo(xOf(d), y); } g.stroke(); };
      plot(S.lastProfile, '#5b6b86', 1);
      if (S.mode === 'distance') plot(S.baseline, '#fbbf24', 1);
      plot(S.lastResid, '#38bdf8', 1.5);
      g.fillStyle = 'rgba(248,113,113,.15)'; g.fillRect(0, 0, xOf(cfg.minR), h - 14);
      if (S.lastDet) { g.fillStyle = '#f87171'; g.fillRect(xOf(S.lastDet.distance) - 1, 0, 2, h - 14); }
    }
    // Distance history.
    { const { g, w, h } = setupCanvas($('history'));
      const now = performance.now() / 1000, yOf = (d) => h - 4 - (d / cfg.maxR) * (h - 8);
      g.strokeStyle = '#22304a'; g.fillStyle = '#8a98b0'; g.font = '11px sans-serif';
      for (let d = 0; d <= cfg.maxR; d += cfg.maxR > 5 ? 2 : 1) { g.beginPath(); g.moveTo(0, yOf(d)); g.lineTo(w, yOf(d)); g.stroke(); g.fillText(d + 'm', 2, yOf(d) - 2); }
      g.fillStyle = '#38bdf8';
      for (const p of S.history) { const x = w - ((now - p.t) / 15) * w; g.beginPath(); g.arc(x, yOf(p.d), 2.5, 0, 7); g.fill(); }
    }
  }

  // UI wiring
  $('startBtn').onclick = () => (S.ctx ? stop() : start());
  $('calBtn').onclick = () => { S.calN = 10; S.calLeft = 10; S.calAcc = new Float32Array(S.cfg.profileLen); status('Calibrating… hold still'); };
  document.querySelectorAll('#modeSeg button').forEach((b) => b.onclick = () => {
    document.querySelectorAll('#modeSeg button').forEach((x) => x.classList.toggle('sel', x === b));
    S.mode = b.dataset.mode; S.bg = null; S.history = [];
  });
  $('zeroBtn').onclick = () => {
    if (!S.lastDet) { status('Start pinging and aim at a surface first.', 'warn'); return; }
    const v = prompt('Actual distance to the surface right now, in cm?');
    const truth = Number(v); if (!v || !isFinite(truth)) return;
    const cur = S.lastDet.distance - S.cfg.offset;
    $('offset').value = (truth - cur * 100).toFixed(1);
    S.cfg.offset = Number($('offset').value) / 100; save();
    status(`Correction set to ${$('offset').value} cm.`);
  };
  const keys = ['temp', 'band', 'minR', 'maxR', 'offset', 'vol', 'snr'];
  function save() { const o = {}; keys.forEach((k) => (o[k] = $(k).value)); try { localStorage.setItem('sonar-cfg', JSON.stringify(o)); } catch (e) {} }
  try { const o = JSON.parse(localStorage.getItem('sonar-cfg') || '{}'); keys.forEach((k) => { if (o[k] != null) $(k).value = o[k]; }); } catch (e) {}
  keys.forEach((k) => $(k).addEventListener('change', () => {
    save();
    if (!S.ctx) { $('cval').textContent = readCfg().c.toFixed(1); return; }
    if (k === 'vol') { S.cfg.vol = Number($('vol').value); S.gain.gain.value = S.cfg.vol; return; }
    const needsRestart = ['band', 'maxR', 'temp'].includes(k);
    setup();
    if (needsRestart) { S.baseline = null; S.bg = null; S.history = []; $('calBtn').textContent = 'Calibrate'; startPlayer();
      clearInterval(S.timer); S.timer = setInterval(tick, Math.round(S.cfg.K * S.cfg.I / S.fs * 1000)); status('Settings changed, please recalibrate.'); }
  }));
  $('cval').textContent = readCfg().c.toFixed(1);
  window.addEventListener('resize', draw);
  document.addEventListener('visibilitychange', () => { if (document.hidden && S.ctx) stop(); });
  window.__sonar = S; // for debugging
})();
