/* צלילים (נוצרים בקוד, בלי קבצים), רטט וקונפטי */
(function () {
  'use strict';
  let ctx = null, master = null, noiseBuf = null;
  let muted = false;
  try { muted = localStorage.getItem('imp_mute') === '1'; } catch (e) {}
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  function ac() {
    if (!ctx) {
      try {
        ctx = new (window.AudioContext || window.webkitAudioContext)();
        master = ctx.createGain(); master.gain.value = 0.7;
        const comp = ctx.createDynamicsCompressor();
        master.connect(comp); comp.connect(ctx.destination);
        noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 1, ctx.sampleRate);
        const d = noiseBuf.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      } catch (e) { ctx = null; }
    }
    if (ctx && ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function tone(f, dur, o) {
    o = o || {};
    const a = ac(); if (!a || muted) return;
    const t = a.currentTime + (o.at || 0);
    const osc = a.createOscillator(), g = a.createGain();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(f, t);
    if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, t + dur);
    if (o.detune) osc.detune.value = o.detune;
    const v = o.v || 0.18;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(v, t + (o.attack || 0.008));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g); g.connect(master);
    osc.start(t); osc.stop(t + dur + 0.05);
  }

  function noise(dur, o) {
    o = o || {};
    const a = ac(); if (!a || muted || !noiseBuf) return;
    const t = a.currentTime + (o.at || 0);
    const src = a.createBufferSource(); src.buffer = noiseBuf;
    const f = a.createBiquadFilter(); f.type = o.filter || 'bandpass';
    f.frequency.setValueAtTime(o.f || 1200, t);
    if (o.fTo) f.frequency.exponentialRampToValueAtTime(o.fTo, t + dur);
    f.Q.value = o.q || 1;
    const g = a.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(o.v || 0.25, t + (o.attack || 0.005));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g); g.connect(master);
    src.start(t); src.stop(t + dur + 0.05);
  }

  const S = {
    tap: () => tone(700, 0.05, { type: 'triangle', v: 0.07 }),
    toggleOn: () => { tone(620, 0.07, { type: 'triangle', v: 0.1 }); tone(930, 0.09, { type: 'triangle', v: 0.1, at: 0.05 }); },
    toggleOff: () => { tone(760, 0.07, { type: 'triangle', v: 0.1 }); tone(500, 0.09, { type: 'triangle', v: 0.1, at: 0.05 }); },
    join: () => { tone(660, 0.12, { v: 0.14 }); tone(990, 0.18, { v: 0.14, at: 0.09 }); },
    leave: () => { tone(560, 0.12, { v: 0.12 }); tone(370, 0.2, { v: 0.12, at: 0.09 }); },
    start: () => { [392, 494, 587, 784].forEach((f, i) => tone(f, 0.2, { type: 'square', v: 0.06, at: i * 0.08 })); noise(0.5, { f: 3000, fTo: 8000, v: 0.08, at: 0.2, filter: 'highpass' }); },
    flip: () => { noise(0.22, { f: 800, fTo: 4000, v: 0.2, q: 0.7 }); tone(300, 0.15, { to: 600, type: 'sine', v: 0.08 }); },
    send: () => { tone(520, 0.08, { type: 'triangle', v: 0.14 }); tone(880, 0.14, { type: 'triangle', v: 0.14, at: 0.06 }); noise(0.12, { f: 5000, v: 0.05, filter: 'highpass' }); },
    phase: () => { tone(523, 0.18, { v: 0.12 }); tone(784, 0.28, { v: 0.12, at: 0.12 }); tone(1046, 0.3, { v: 0.06, at: 0.12 }); },
    tick: () => tone(1100, 0.05, { type: 'square', v: 0.05 }),
    tickLast: () => tone(1400, 0.09, { type: 'square', v: 0.08 }),
    vote: () => { tone(180, 0.18, { type: 'sine', v: 0.3, to: 90 }); noise(0.08, { f: 1500, v: 0.12 }); },
    ready: () => { tone(740, 0.08, { v: 0.12 }); tone(1110, 0.12, { v: 0.1, at: 0.07 }); },
    drumroll: (sec) => { const n = Math.floor((sec || 2) * 16); for (let i = 0; i < n; i++) noise(0.06, { f: 250 + (i / n) * 250, q: 0.8, v: 0.1 + 0.2 * (i / n), at: i / 16 }); },
    stamp: () => { tone(120, 0.3, { type: 'sine', v: 0.45, to: 50 }); noise(0.16, { f: 600, v: 0.4, q: 0.5, filter: 'lowpass' }); },
    win: () => { [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.26, { type: 'triangle', v: 0.14, at: i * 0.1 })); tone(1318, 0.5, { type: 'sine', v: 0.08, at: 0.42 }); },
    lose: () => { tone(392, 0.35, { type: 'sawtooth', v: 0.06, to: 300 }); tone(311, 0.5, { type: 'sawtooth', v: 0.06, at: 0.28, to: 196 }); },
    sneaky: () => { [330, 311, 294, 277].forEach((f, i) => tone(f, 0.18, { type: 'triangle', v: 0.1, at: i * 0.14 })); },
    pop: () => { tone(900, 0.06, { to: 1500, v: 0.08 }); },
    fanfare: () => { [523, 523, 523, 659, 784, 1047].forEach((f, i) => tone(f, i === 5 ? 0.7 : 0.15, { type: 'square', v: 0.05, at: [0, .12, .24, .36, .52, .7][i] })); noise(1, { f: 5000, fTo: 9000, v: 0.06, at: 0.7, filter: 'highpass' }); },
    error: () => { tone(220, 0.12, { type: 'square', v: 0.07 }); tone(180, 0.18, { type: 'square', v: 0.07, at: 0.1 }); },
    pause: () => { tone(600, 0.1, { v: 0.1 }); tone(400, 0.16, { v: 0.1, at: 0.08 }); },
    whoosh: () => noise(0.35, { f: 400, fTo: 2400, v: 0.12, q: 0.6 })
  };

  function play(name, arg) { try { if (!muted && S[name]) S[name](arg); } catch (e) {} }
  function vibrate(p) { try { if (!muted && navigator.vibrate) navigator.vibrate(p); } catch (e) {} }
  function setMuted(m) { muted = !!m; try { localStorage.setItem('imp_mute', muted ? '1' : '0'); } catch (e) {} }

  document.addEventListener('pointerdown', ac, { passive: true });

  /* ---------- קונפטי ---------- */
  const cv = () => document.getElementById('confetti');
  let parts = [], raf = 0;
  function confetti(opts) {
    if (reduced) return;
    const c = cv(); if (!c) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = innerWidth * dpr; c.height = innerHeight * dpr;
    const colors = (opts && opts.colors) || ['#ffc83d', '#3dd39a', '#b08cff', '#ff5468', '#6fc3ff', '#ffffff'];
    const n = (opts && opts.count) || 140;
    for (let i = 0; i < n; i++) {
      parts.push({
        x: innerWidth * (0.2 + Math.random() * 0.6) * dpr, y: innerHeight * 0.35 * dpr,
        vx: (Math.random() - 0.5) * 16 * dpr, vy: (-Math.random() * 16 - 6) * dpr,
        s: (5 + Math.random() * 6) * dpr, r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.4,
        c: colors[i % colors.length], life: 0
      });
    }
    if (!raf) raf = requestAnimationFrame(step);
  }
  function step() {
    const c = cv(), g = c.getContext('2d');
    g.clearRect(0, 0, c.width, c.height);
    parts = parts.filter(p => p.life < 220 && p.y < c.height + 40);
    for (const p of parts) {
      p.life++; p.vy += 0.45; p.vx *= 0.985; p.x += p.vx; p.y += p.vy; p.r += p.vr;
      g.save(); g.translate(p.x, p.y); g.rotate(p.r);
      g.globalAlpha = Math.max(0, 1 - p.life / 220);
      g.fillStyle = p.c; g.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2);
      g.restore();
    }
    raf = parts.length ? requestAnimationFrame(step) : 0;
    if (!raf) g.clearRect(0, 0, c.width, c.height);
  }

  window.FX = { play, vibrate, confetti, setMuted, isMuted: () => muted, reduced };
})();
