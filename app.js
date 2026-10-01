/* מי האימפוסטר? — לקוח. השרת הוא מקור האמת; הלקוח רק מציג ושולח פעולות. */
(function () {
  'use strict';

  /* ================= עזרים ================= */
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const FX = window.FX || { play() {}, vibrate() {}, confetti() {}, setMuted() {}, isMuted: () => true, reduced: true };
  const store = {
    get(k, d, s) { try { const v = (s ? sessionStorage : localStorage).getItem(k); return v == null ? d : v; } catch (e) { return d; } },
    set(k, v, s) { try { (s ? sessionStorage : localStorage).setItem(k, v); } catch (e) {} },
    del(k, s) { try { (s ? sessionStorage : localStorage).removeItem(k); } catch (e) {} }
  };
  const rnd = n => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => (b % 36).toString(36)).join('');
  const clone = o => JSON.parse(JSON.stringify(o));
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function dur(sec) {
    if (sec < 60) return sec + ' שנ׳';
    const m = Math.floor(sec / 60), s = sec % 60;
    return s ? m + ':' + String(s).padStart(2, '0') + ' דק׳' : (m === 1 ? 'דקה' : m + ' דק׳');
  }
  const clock = ms => { const s = Math.max(0, Math.ceil(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };

  /* ================= מצב ================= */
  let CAT = null, RB = {};               // קטלוג התפקידים מהשרת
  let S = null, ME = null, offset = 0;   // מצב מהשרת
  let conn = 'connecting';
  let ws = null, retry = 0;
  const me = {
    name: store.get('imp_name', ''), avatar: store.get('imp_av', ''),
    token: store.get('imp_tok', '', true) || (() => { const t = rnd(20); store.set('imp_tok', t, true); return t; })(),
    code: store.get('imp_code', '', true)
  };
  const ui = {
    err: '', busy: false, codeDigits: ['', '', '', ''], tab: 'game', drafts: {}, flipped: {}, autoFlip: {},
    modal: null, seenEvents: new Set(), firstState: true, suspense: {}, confettiDone: {},
    prev: { phase: null, rid: null, paused: false }, lastTick: -1, autoSent: {}, cfgTimer: 0, cfgEditAt: 0
  };
  const urlCode = (new URLSearchParams(location.search).get('c') || '').replace(/\D/g, '').slice(0, 4);
  if (urlCode.length === 4) ui.codeDigits = urlCode.split('');

  function seenList() { try { const l = JSON.parse(store.get('imp_seen', '[]')); return Array.isArray(l) ? l : []; } catch (e) { return []; } }

  /* ================= חיבור ================= */
  function connect() {
    conn = 'connecting'; paintBar();
    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
    ws.onopen = () => {
      conn = 'ok'; retry = 0; paintBar();
      if (me.code) send({ t: 'join', code: me.code, token: me.token, name: me.name, avatar: me.avatar });
    };
    ws.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch (x) { return; } onMsg(m); };
    ws.onclose = () => {
      conn = 'bad'; paintBar();
      setTimeout(connect, Math.min(6000, 400 * Math.pow(2, retry++)));
    };
  }
  function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }

  function onMsg(m) {
    if (m.t === 'catalog') {
      CAT = m.c; RB = Object.fromEntries(CAT.roles.map(r => [r.id, r]));
      if (!CAT.avatars.includes(me.avatar)) me.avatar = CAT.avatars[Math.floor(Math.random() * CAT.avatars.length)];
      return render();
    }
    if (m.t === 'joined') {
      me.code = m.code; ME = m.you; ui.busy = false; ui.err = '';
      store.set('imp_code', m.code, true);
      try { history.replaceState(null, '', '?c=' + m.code); } catch (e) {}
      FX.play('join');
      send({ t: 'seen', ids: seenList() }); // השאלות שכבר ראיתם — כדי שלא יחזרו
      return;
    }
    if (m.t === 'qseen') { const l = seenList(); for (const id of m.ids || []) if (!l.includes(id)) l.push(id); store.set('imp_seen', JSON.stringify(l.slice(-7000))); return; }
    if (m.t === 'state') return onState(m.s);
    if (m.t === 'denied') {
      ui.busy = false;
      const why = { noroom: 'לא מצאנו חדר עם הקוד הזה. בדקו את הספרות ונסו שוב.', banned: 'המארח הוציא אותך מהחדר הזה.', name: 'כתבו שם לפני שנכנסים.', full: 'החדר מלא.', bad: 'משהו השתבש. רעננו את הדף.' }[m.why] || 'לא הצלחנו להיכנס לחדר.';
      leaveLocal(why); FX.play('error'); return;
    }
    if (m.t === 'kicked') { leaveLocal('המארח הוציא אותך מהחדר.'); FX.play('error'); return; }
    if (m.t === 'closed') { leaveLocal('המארח סגר את החדר.'); return; }
    if (m.t === 'react') return floater(m.from, m.e);
  }

  function leaveLocal(msg) {
    S = null; ME = null; me.code = ''; store.del('imp_code', true);
    ui.err = msg || ''; ui.modal = null; ui.firstState = true; ui.seenEvents.clear();
    try { history.replaceState(null, '', location.pathname); } catch (e) {}
    closeModalNow(); render();
  }

  /* ================= מעברי מצב: צלילים, טוסטים ================= */
  function onState(s) {
    const prev = S; S = s; ME = s.you; offset = s.serverNow - Date.now();
    const r = s.round, ph = s.phase, rid = r ? r.rid : null;
    // טוסטים על אירועים חדשים
    for (const ev of s.events) {
      if (ui.seenEvents.has(ev.id)) continue;
      ui.seenEvents.add(ev.id);
      if (ui.firstState) continue;
      toast(ev.text);
      if (ev.who === ME) continue;
      if (ev.kind === 'join' || ev.kind === 'back') FX.play('join');
      else if (ev.kind === 'leave' || ev.kind === 'off') FX.play('leave');
      else if (ev.kind === 'host') FX.play('pop');
    }
    if (!ui.firstState) {
      if (rid && rid !== ui.prev.rid) {
        if (r.n === 1 && ui.prev.phase === 'lobby') { FX.play('start'); FX.vibrate([30, 40, 30]); }
        else FX.play('whoosh');
        ui.lastTick = -1; ui.revTab = 'round';
      } else if (ph !== ui.prev.phase) {
        if (ph === 'discuss' || ph === 'vote') { FX.play('phase'); FX.vibrate(40); }
        if (ph === 'lobby' && prev) FX.play('whoosh');
        ui.lastTick = -1;
      }
      if (r && r.paused !== ui.prev.paused) FX.play('pause');
    }
    if (ph === 'reveal' && rid && !ui.suspense[rid]) startSuspense(rid, ui.firstState);
    if (ph === 'lobby' && ui.modal && ui.modal.type === 'manage') ui.modal = null;
    ui.prev = { phase: ph, rid, paused: !!(r && r.paused) };
    ui.firstState = false;
    // ברגע שהתפקיד מותר להצגה: תפקיד מיוחד או אימפוסטר מקבלים חלון גדול וברור; שחקן רגיל מקבל הודעה קצרה
    if (r && r.inRound && !r.roleHidden && r.myRole && r.phase !== 'reveal') {
      const key = rid + ':' + r.myRole;
      if (!ui.autoFlip[key]) {
        ui.autoFlip[key] = true;
        if (r.myRole === 'crew') { if (!ui.autoFlip[rid + ':crewtoast']) { ui.autoFlip[rid + ':crewtoast'] = 1; setTimeout(() => toast('🙂 בסבב הזה אתם שחקנים רגילים'), 600); } }
        else setTimeout(() => { if (S && S.round && S.round.rid === rid) { openModal({ type: 'intro' }); FX.play(r.myRole === 'imposter' ? 'sneaky' : 'flip'); FX.vibrate([40, 30, 40]); } }, 650);
      }
    }
    // עדכון הגדרות מהשרת רק כשהמארח לא באמצע עריכה
    if (ui.localCfg && Date.now() - ui.cfgEditAt > 1200) ui.localCfg = null;
    render();
  }

  function startSuspense(rid, instant) {
    const ms = instant || FX.reduced ? 0 : 2300;
    ui.suspense[rid] = Date.now() + ms;
    if (ms) FX.play('drumroll', 2.1);
    setTimeout(() => {
      if (!S || !S.round || S.round.rid !== rid) return;
      render();
      const res = S.round.result, mine = res && res.gain ? res.gain[ME] : undefined;
      FX.play('stamp'); FX.vibrate(60);
      setTimeout(() => {
        if (mine === undefined) return;
        if (mine > 0) { FX.play('win'); if (!ui.confettiDone[rid]) { ui.confettiDone[rid] = 1; FX.confetti(); } }
        else FX.play('lose');
        if (S.round.last) setTimeout(() => { FX.play('fanfare'); FX.confetti({ count: 220 }); }, 900);
      }, 350);
    }, ms);
  }

  /* ================= מנוע ציור (מיזוג DOM קטן) ================= */
  const keyOf = n => (n.nodeType === 1 ? n.getAttribute('data-k') : null);
  function morph(a, b) {
    if (a.nodeType !== b.nodeType || a.nodeName !== b.nodeName || keyOf(a) !== keyOf(b)) { a.replaceWith(b); return; }
    if (a.nodeType === 3 || a.nodeType === 8) { if (a.nodeValue !== b.nodeValue) a.nodeValue = b.nodeValue; return; }
    for (const at of [...a.attributes]) if (!b.hasAttribute(at.name)) a.removeAttribute(at.name);
    for (const at of [...b.attributes]) if (a.getAttribute(at.name) !== at.value) a.setAttribute(at.name, at.value);
    if (a.nodeName === 'INPUT' || a.nodeName === 'TEXTAREA') {
      if (document.activeElement !== a && a.value !== b.value) a.value = b.value;
      if (a.type === 'checkbox') a.checked = b.checked;
      return;
    }
    kids(a, b);
  }
  function kids(a, b) {
    const next = [...b.childNodes], keyed = new Map();
    for (const c of a.childNodes) { const k = keyOf(c); if (k) keyed.set(k, c); }
    for (let i = 0; i < next.length; i++) {
      const nb = next[i], cur = a.childNodes[i], k = keyOf(nb);
      if (k && keyed.has(k)) {
        const old = keyed.get(k); keyed.delete(k);
        if (old !== cur) a.insertBefore(old, cur || null);
        morph(old, nb);
      } else if (!k && cur && !keyOf(cur) && cur.nodeName === nb.nodeName && cur.nodeType === nb.nodeType) {
        morph(cur, nb);
      } else a.insertBefore(nb, cur || null);
    }
    while (a.childNodes.length > next.length) a.lastChild.remove();
  }
  function paint(el, html) {
    const t = document.createElement(el.tagName);
    t.innerHTML = html;
    kids(el, t);
  }

  /* ================= רכיבי UI קטנים ================= */
  const P = id => (S && S.players.find(p => p.id === id)) || null;
  const nm = id => { const p = P(id); return p ? esc(p.name) : '?'; };
  const avOf = id => { const p = P(id); return p ? p.avatar : '❔'; };
  const who = id => `<span class="who-chip">${avOf(id)} ${nm(id)}</span>`;
  const isHost = () => S && S.hostId === ME;
  const cfg = () => (ui.localCfg || (S && S.cfg));
  const teamPill = t => CAT ? `<span class="pill team-${t}">${CAT.teams[t].emoji} ${CAT.teams[t].name}</span>` : '';
  const sw = (on, act, attrs, dis) => `<button class="switch" role="switch" aria-checked="${!!on}" data-act="${act}" ${attrs || ''} ${dis ? 'disabled' : ''}><span class="sr">${on ? 'פעיל' : 'כבוי'}</span></button>`;
  function stepper(path, val, min, max, step, fmt) {
    return `<div class="stepper" dir="ltr"><button data-act="step" data-p="${path}" data-d="${-step}" data-min="${min}" data-max="${max}" ${val <= min ? 'disabled' : ''} aria-label="הפחת">−</button><output>${fmt ? fmt(val) : val}</output><button data-act="step" data-p="${path}" data-d="${step}" data-min="${min}" data-max="${max}" ${val >= max ? 'disabled' : ''} aria-label="הוסף">+</button></div>`;
  }
  const setRow = (title, sub, ctl) => `<div class="set"><div class="lbl"><b>${title}</b>${sub ? `<span>${sub}</span>` : ''}</div>${ctl}</div>`;
  const waiting = '<div class="waiting" aria-hidden="true"><i></i><i></i><i></i></div>';

  /* ================= טוסטים ותגובות ================= */
  function toast(text) {
    const box = $('#toasts'); if (!box) return;
    const t = document.createElement('div'); t.className = 'toast'; t.textContent = text; box.appendChild(t);
    while (box.children.length > 3) box.firstChild.remove();
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 320); }, 2800);
  }
  function floater(from, e) {
    const box = $('#floaters'); if (!box) return;
    const f = document.createElement('div'); f.className = 'floater';
    f.style.left = (10 + Math.random() * 80) + '%';
    f.innerHTML = `${esc(e)}<small>${nm(from)}</small>`;
    box.appendChild(f); FX.play('pop');
    setTimeout(() => f.remove(), 2700);
  }

  /* ================= סרגל עליון ================= */
  function paintBar() {
    const bar = $('#bar'); if (!bar) return;
    const c = conn === 'ok' ? '' : ' bad', txt = conn === 'ok' ? (me.code && S ? 'חדר ' + me.code : 'מחובר') : conn === 'connecting' ? 'מתחבר…' : 'החיבור נפל, מתחבר מחדש…';
    paint(bar, `<div class="conn${c}" role="status"><span class="dot"></span>${esc(txt)}</div>
      <div class="row" style="gap:8px">
        <button class="icon-btn" data-act="rules" aria-label="איך משחקים">?</button>
        <button class="icon-btn" data-act="mute" aria-label="${FX.isMuted() ? 'הפעל צלילים' : 'השתק צלילים'}">${FX.isMuted() ? '🔇' : '🔊'}</button>
      </div>`);
  }

  /* ================= הגדרות: קריאה/כתיבה ================= */
  const getP = (o, p) => p.split('.').reduce((x, k) => (x == null ? x : x[k]), o);
  function setP(o, p, v) { const ks = p.split('.'), last = ks.pop(); ks.reduce((x, k) => x[k], o)[last] = v; }
  function editCfg(mut) {
    if (!isHost() || !S || S.phase !== 'lobby') return;
    const c = clone(cfg()); mut(c);
    ui.localCfg = c; ui.cfgEditAt = Date.now();
    clearTimeout(ui.cfgTimer);
    ui.cfgTimer = setTimeout(() => send({ t: 'cfg', cfg: ui.localCfg || c }), 160);
    render();
  }
  const specials = () => CAT ? CAT.roles.filter(r => !r.core) : [];
  const activeRoles = () => specials().filter(r => cfg().roles[r.id].enabled);
  const onlineN = () => S ? S.players.filter(p => p.online).length : 0;
  const PACES = [
    { id: 'fast', e: '⚡', t: 'מהיר', d: 'סבב של כ-2 דקות', v: { ansT: 30, disT: 60, votT: 20, revT: 10 } },
    { id: 'normal', e: '☕', t: 'רגיל', d: 'סבב של כ-3 דקות', v: { ansT: 45, disT: 90, votT: 30, revT: 15 } },
    { id: 'slow', e: '🛋️', t: 'רגוע', d: 'סבב של כ-4.5 דקות', v: { ansT: 60, disT: 150, votT: 45, revT: 20 } }
  ];
  const IMP_PRESETS = [
    { id: 'mostly', e: '🎯', t: 'כמעט תמיד אחד', d: 'הפתעה נדירה', v: { zero: 4, some: 4, all: 2 } },
    { id: 'balanced', e: '⚖️', t: 'מאוזן', d: '8 מתוך 10 עם אחד', v: { zero: 8, some: 8, all: 4 } },
    { id: 'spicy', e: '🌶️', t: 'פיקנטי', d: 'הרבה הפתעות', v: { zero: 15, some: 15, all: 5 } },
    { id: 'chaos', e: '🌀', t: 'כאוס', d: 'אי אפשר לסמוך על כלום', v: { zero: 20, some: 25, all: 15 } }
  ];
  const DIST = [
    { k: 'zero', e: '🚫', t: 'אף אחד', d: 'סבב בלי אימפוסטר — כולם קיבלו אותה שאלה' },
    { k: 'one', e: '🎯', t: 'אחד', d: 'המצב הרגיל. מקבל את כל מה שנשאר' },
    { k: 'some', e: '👥', t: 'כמה', d: 'שני אימפוסטרים או יותר (אבל לא כולם)' },
    { k: 'all', e: '😈', t: 'כולם', d: 'כל השחקנים אימפוסטרים, ואף אחד לא יודע' }
  ];
  function summary(c) {
    const per = c.ansT + c.disT + c.votT + c.revT, mins = Math.max(1, Math.round(per * c.rounds / 60));
    const n = specials().filter(r => c.roles[r.id].enabled).length;
    return `${c.rounds} סבבים (כ-${mins} דקות) · ${c.randomImps ? `אימפוסטרים אקראיים, ${c.impDist.one}% אחד` : 'אימפוסטר אחד בכל סבב'} · ${n ? n + ' תפקידים מיוחדים' : 'בלי תפקידים מיוחדים'}`;
  }

  /* ================= מסך פתיחה ================= */
  function home() {
    const avs = CAT ? CAT.avatars.map(a => `<button class="av-pick" data-act="av" data-v="${a}" aria-pressed="${a === me.avatar}" aria-label="דמות ${a}">${a}</button>`).join('') : '';
    const dis = ui.busy || conn !== 'ok' ? 'disabled' : '';
    return `<section class="screen home" data-k="home">
      <div class="hero"><div class="hero-mark" aria-hidden="true"><span>${me.avatar || '🕵️'}</span></div>
        <h1 class="title">מי האימפוסטר?</h1><p class="lead">כולם עונים על אותה שאלה. כמעט כולם.</p></div>
      <div class="panel">
        <label class="label" for="nm">איך קוראים לך?</label>
        <input id="nm" class="field" maxlength="16" autocomplete="nickname" enterkeyhint="go" placeholder="השם שלך" value="${esc(me.name)}">
        <p class="label" style="margin-top:14px">הדמות שלך</p>
        <div class="avatars" role="group" aria-label="בחירת דמות">${avs}</div>
        <button class="btn" data-act="create" ${dis}>✨ פתיחת חדר חדש</button>
        <div class="or">או הצטרפות לחדר קיים</div>
        <div class="code-in" role="group" aria-label="קוד החדר, 4 ספרות">${[0, 1, 2, 3].map(i => `<input id="cd${i}" data-ci="${i}" inputmode="numeric" autocomplete="off" maxlength="1" value="${esc(ui.codeDigits[i])}" aria-label="ספרה ${i + 1}">`).join('')}</div>
        <button class="btn soft" data-act="join" ${dis}>הצטרפות לחדר</button>
        ${ui.err ? `<p class="err" role="alert" data-k="err-${esc(ui.err)}">${esc(ui.err)}</p>` : ''}
      </div>
      <button class="btn ghost" data-act="rules">📖 איך משחקים?</button>
    </section>`;
  }

  /* ================= לובי ================= */
  function playerCard(p, host) {
    const tags = [p.host ? '👑 מארח/ת' : '', p.id === ME ? 'זה את/ה' : '', p.online ? '' : 'מנותק/ת'].filter(Boolean).join(' · ');
    const btn = p.id === ME ? `<button class="more" data-act="profile" aria-label="עריכת השם והדמות">✏️</button>`
      : host ? `<button class="more" data-act="pmenu" data-id="${p.id}" aria-label="פעולות על ${esc(p.name)}">⋯</button>` : '';
    return `<div class="pc${p.id === ME ? ' me' : ''}${p.online ? '' : ' off'}" data-k="p-${p.id}">
      <div class="av">${p.avatar}${p.online ? '' : '<span class="st off">!</span>'}</div>
      <div class="grow" style="min-width:0"><div class="nm">${esc(p.name)}</div><div class="sub">${tags || 'מוכן/ה'}</div></div>${btn}</div>`;
  }
  function lobby() {
    const host = isHost(), c = cfg(), n = onlineN();
    const codeP = `<div class="panel room-panel"><div class="room-code"><div><div class="label">קוד החדר</div>
        <div class="digits" aria-label="קוד החדר ${esc(me.code)}">${me.code.split('').map(d => `<span>${d}</span>`).join('')}</div></div>
        <div class="stack" style="min-width:150px"><button class="btn sm soft" data-act="copy">🔗 העתקת קישור</button>${navigator.share ? '<button class="btn sm soft" data-act="share">📤 שליחה לחברים</button>' : ''}</div></div>
      <p class="small muted" style="margin:10px 0 0">חברים פותחים את הקישור, או נכנסים לאתר ומקלידים את הקוד.</p></div>`;
    const need = Math.max(0, 3 - n);
    const plP = `<div class="panel"><div class="row between" style="margin-bottom:10px"><h2 style="margin:0">שחקנים <span class="count">${S.players.length}</span></h2>
        <span class="small ${need ? 'muted' : 'ok-tx'}">${need ? `חסרים עוד ${need} כדי להתחיל` : '✓ אפשר להתחיל'}</span></div>
      <div class="plist">${S.players.map(p => playerCard(p, host)).join('')}</div></div>`;
    return `<section class="screen" data-k="lobby"><div class="lobby-grid"><div class="side stack">${codeP}${plP}</div>
      <div>${host ? settingsPanel(c, n) : guestPanel(c)}</div></div></section>`;
  }

  function guestPanel(c) {
    const act = activeRoles();
    return `<div class="panel"><h2>ההגדרות של המארח</h2><p class="small muted" style="margin-top:-6px">${esc(summary(c))}</p>
      <div class="chips" style="margin:10px 0 4px"><span class="pill">🔁 ${c.rounds} סבבים</span><span class="pill">✍️ ${dur(c.ansT)}</span><span class="pill">💬 ${dur(c.disT)}</span><span class="pill">🗳️ ${dur(c.votT)}</span><span class="pill">${c.topics.numbers && c.topics.words ? '🔢💬 מספרים ומילים' : c.topics.words ? '💬 שאלות במילים' : '🔢 שאלות במספרים'}</span><span class="pill">${c.roleReveal === 'answered' ? '🙈 תפקיד נחשף אחרי תשובה' : '👁️ תפקיד נחשף מיד'}</span><span class="pill">${c.vote.multi ? `😈 עד ${c.vote.maxMarks} חשודים` : '😈 חשוד אחד'}</span>${c.vote.guess ? `<span class="pill">🎭 ניחוש תפקידים +${c.vote.guessPts}</span>` : ''}</div>
      ${c.randomImps ? `<h3 style="margin-top:16px">כמה אימפוסטרים יהיו?</h3>${distBar(c.impDist)}` : ''}
      <h3 style="margin-top:16px">תפקידים שעשויים להופיע</h3>
      <div class="chips">${act.map(r => `<button class="pill clickable" data-team="${r.team}" data-act="roleView" data-id="${r.id}">${r.emoji} ${r.name}</button>`).join('') || '<span class="small muted">רק שחקנים רגילים ואימפוסטרים</span>'}</div>
      <p class="small muted" style="margin-bottom:0">הקישו על תפקיד כדי לקרוא מה הוא עושה.</p></div>
      <div class="panel flat center"><p class="muted" style="margin:0">מחכים שהמארח יתחיל את המשחק</p>${waiting}</div>`;
  }

  function settingsPanel(c, n) {
    const tabs = [['game', '⏱️', 'קצב'], ['imps', '😈', 'אימפוסטרים'], ['vote', '🗳️', 'הצבעה'], ['roles', '🎭', 'תפקידים'], ['score', '🏅', 'ניקוד']];
    const body = ui.tab === 'vote' ? tabVote(c) : ui.tab === 'imps' ? tabImps(c, n) : ui.tab === 'roles' ? tabRoles(c, n) : ui.tab === 'score' ? tabScore(c) : tabGame(c);
    return `<div class="panel settings"><div class="row between"><h2 style="margin:0">הגדרות המשחק</h2><button class="btn xs ghost" data-act="resetAll">↺ ברירת מחדל</button></div>
      <p class="small muted summary">${esc(summary(c))}</p>
      <div class="tabs" role="tablist" aria-label="קטגוריות הגדרות">${tabs.map(([k, e, t]) => `<button class="tab" role="tab" aria-selected="${ui.tab === k}" data-act="tab" data-v="${k}"><span aria-hidden="true">${e}</span> ${t}${k === 'roles' ? ` <span class="badge">${activeRoles().length}</span>` : ''}${k === 'imps' && c.randomImps ? ' <span class="badge">🎲</span>' : ''}</button>`).join('')}</div>
      <div class="tabpanel" role="tabpanel" data-k="tab-${ui.tab}">${body}</div></div>`;
  }

  const TOPICS = [
    { k: 'numbers', e: '🔢', t: 'מספרים', d: 'עונים במספר: כמה אחים יש לך?' },
    { k: 'words', e: '💬', t: 'מילים', d: 'עונים במילים: איזו חיה מפחידה אותך?' }
  ];
  function tabGame(c) {
    const pace = PACES.find(p => Object.keys(p.v).every(k => c[k] === p.v[k]));
    return `<h3>נושאי שאלות</h3><div class="presets">${TOPICS.map(x => `<button class="preset" data-act="topic" data-v="${x.k}" aria-pressed="${!!c.topics[x.k]}"><span class="e">${x.e}</span><b>${x.t}</b><span>${x.d}</span></button>`).join('')}</div>
      <p class="small muted" style="margin:6px 0 0">אפשר להפעיל את שניהם: בכל סבב יוגרל נושא אחד מהמופעלים.</p>
      <h3 style="margin-top:18px">קצב מהיר</h3><div class="presets three">${PACES.map(p => `<button class="preset" data-act="pace" data-v="${p.id}" aria-pressed="${pace === p}"><span class="e">${p.e}</span><b>${p.t}</b><span>${p.d}</span></button>`).join('')}</div>
      <h3 style="margin-top:18px">כיוון עדין</h3>
      ${setRow('🔁 מספר סבבים', 'המנצח נקבע לפי הניקוד בסוף', stepper('rounds', c.rounds, 1, 50, 1))}
      ${setRow('✍️ זמן לענות', 'כשכולם ענו — עוברים מיד', stepper('ansT', c.ansT, 10, 600, 5, dur))}
      ${setRow('💬 זמן שיחה', 'כשכולם לוחצים „מוכנים” — עוברים להצבעה', stepper('disT', c.disT, 10, 900, 10, dur))}
      ${setRow('🗳️ זמן הצבעה', 'כשכולם הצביעו — עוברים לחשיפה', stepper('votT', c.votT, 10, 600, 5, dur))}
      ${setRow('⏭️ הפסקה בין סבבים', 'אחרי החשיפה, לפני הסבב הבא', stepper('revT', c.revT, 5, 120, 5, dur))}`;
  }

  function distBar(d) {
    return `<div class="dist" role="img" aria-label="${DIST.map(x => x.t + ' ' + d[x.k] + '%').join(', ')}">${DIST.map(x => `<i class="${x.k}" style="flex-grow:${d[x.k]}">${d[x.k] >= 9 ? `${x.e} ${d[x.k]}%` : d[x.k] >= 5 ? x.e : ''}</i>`).join('')}</div>`;
  }
  function tabImps(c, n) {
    const d = c.impDist, it = RB.imposter, t = c.roles.imposter.toggles;
    let h = setRow('🎲 כמות אימפוסטרים אקראית', c.randomImps ? 'לרוב יהיה אימפוסטר אחד — ולפעמים אף אחד, כמה, או כולם.' : 'כבוי: בדיוק אימפוסטר אחד בכל סבב.', sw(c.randomImps, 'cfgToggle', 'data-p="randomImps" aria-label="כמות אימפוסטרים אקראית"'));
    if (c.randomImps) {
      const preset = IMP_PRESETS.find(p => ['zero', 'some', 'all'].every(k => d[k] === p.v[k]));
      const per10 = k => Math.round(d[k] / 10);
      const sm = n >= 4 ? `בין 2 ל-${n - 1}` : n === 3 ? '2' : 'בין 2 ל-(מספר השחקנים פחות 1)';
      h += `<div class="imp-box" data-k="impbox">
        <div class="presets four">${IMP_PRESETS.map(p => `<button class="preset" data-act="impPreset" data-v="${p.id}" aria-pressed="${preset === p}"><span class="e">${p.e}</span><b>${p.t}</b><span>${p.d}</span></button>`).join('')}</div>
        ${distBar(d)}
        ${DIST.map(x => x.k === 'one'
          ? `<div class="sl-row locked"><span class="nm">${x.e} ${x.t}</span><div class="lockbar"><i style="width:${d.one}%"></i><span>השאר הולך לכאן אוטומטית</span></div><output>${d.one}%</output></div>`
          : `<div class="sl-row"><label class="nm" for="dist-${x.k}">${x.e} ${x.t}</label><input id="dist-${x.k}" class="slider" type="range" min="0" max="100" step="1" value="${d[x.k]}" data-act="dist" data-v="${x.k}" aria-describedby="dd-${x.k}"><output>${d[x.k]}%</output></div><p class="small muted sl-d" id="dd-${x.k}">${x.d}${x.k === 'some' ? ` (עכשיו: ${sm})` : ''}</p>`).join('')}
        <div class="note">בכל 10 סבבים, בערך: <b>${per10('one')}</b> עם אימפוסטר אחד${d.zero ? `, <b>${per10('zero') || 'פחות מ-1'}</b> בלי אימפוסטר` : ''}${d.some ? `, <b>${per10('some') || 'פחות מ-1'}</b> עם כמה` : ''}${d.all ? `, <b>${per10('all') || 'פחות מ-1'}</b> שבהם כולם אימפוסטרים` : ''}.</div>
        ${d.zero || d.all ? `<div class="note ok">בשלב ההצבעה יופיעו גם ${[d.zero ? '„🚫 אין אימפוסטר”' : '', d.all ? '„😈 כולם אימפוסטרים”' : ''].filter(Boolean).join(' ו')} — ומי שבוחר נכון מקבל נקודות כמו על תפיסה.</div>` : ''}
      </div>`;
    } else h += `<div class="note">רוצים הפתעות? הפעילו את המתג, ותוכלו לקבוע בדיוק באיזה אחוז מהסבבים יהיו אפס, כמה או כולם אימפוסטרים.</div>`;
    h += `<h3 style="margin-top:18px">${it.emoji} מה האימפוסטר יודע</h3>` + it.toggles.map(tg => setRow(tg.label, tg.hint, sw(t[tg.key], 'cfgToggle', `data-p="roles.imposter.toggles.${tg.key}" aria-label="${esc(tg.label)}"`))).join('');
    return h;
  }

  function roleTile(r, c, n) {
    const rc = c.roles[r.id], on = rc.enabled, locked = on && n < rc.min;
    return `<div class="rt${on ? ' on' : ''}${locked ? ' locked' : ''}" data-team="${r.team}" data-k="rt-${r.id}">
      <button class="rt-main" data-act="role" data-id="${r.id}" aria-label="הגדרות ${esc(r.name)}"><span class="e" aria-hidden="true">${r.emoji}</span>
        <span class="t"><b>${r.name}</b><span>${r.short}</span>
        <span class="meta"><span class="pill" title="מינימום שחקנים">👥 מ-${rc.min}</span><span class="pill" title="סיכוי להופיע">🎲 ${rc.chance}%</span>${locked ? `<span class="pill warn">צריך ${rc.min} שחקנים</span>` : ''}<span class="pill gear">⚙️ הגדרות</span></span></span></button>
      ${sw(on, 'roleToggle', `data-id="${r.id}" aria-label="${esc(r.name)}"`)}</div>`;
  }
  const REVEALS = [
    { id: 'start', e: '👁️', t: 'בתחילת הסבב', d: 'רואים את התפקיד לפני שעונים' },
    { id: 'answered', e: '🙈', t: 'אחרי שעונים', d: 'מתגלה אחרי ששולחים תשובה (חוץ מג׳וקר, זייפן ושותף — הם צריכים לדעת לפני)' }
  ];
  function tabRoles(c, n) {
    const teams = ['crew', 'imp', 'solo'];
    return `<h3>מתי התפקיד נחשף לשחקן</h3><div class="presets">${REVEALS.map(p => `<button class="preset" data-act="reveal" data-v="${p.id}" aria-pressed="${c.roleReveal === p.id}"><span class="e">${p.e}</span><b>${p.t}</b><span>${p.d}</span></button>`).join('')}</div>
      <div style="height:12px"></div>${setRow('🎭 מקסימום תפקידים בסבב', 'גם אם הרבה תפקידים פעילים, לא יוגרלו יותר מזה בסבב אחד', stepper('maxSpecial', c.maxSpecial, 0, 12, 1))}
      <div class="row wrap" style="gap:8px;margin:8px 0 4px"><button class="btn xs soft" data-act="allRoles" data-v="1">הפעלת כולם</button><button class="btn xs soft" data-act="allRoles" data-v="0">כיבוי כולם</button>
      <span class="small muted">הקישו על תפקיד כדי לשנות מינימום שחקנים, סיכוי, ניקוד ויכולות.</span></div>
      ${teams.map(tm => `<div class="team-h" data-team="${tm}">${CAT.teams[tm].emoji} ${CAT.teams[tm].name}</div><div class="roles">${specials().filter(r => r.team === tm).map(r => roleTile(r, c, n)).join('')}</div>`).join('')}`;
  }
  function numsRows(id, c, ed) {
    const r = RB[id], rc = c.roles[id];
    return r.nums.map(x => setRow(x.label, '', ed ? stepper(`roles.${id}.nums.${x.key}`, rc.nums[x.key], x.min, x.max, x.step) : `<b class="val">${rc.nums[x.key]}</b>`)).join('');
  }
  function tabVote(c) {
    const v = c.vote, nRoles = activeRoles().length;
    let h = setRow('😈 הצבעה על כמה חשודים', v.multi ? 'כל אחד יכול לסמן כמה שחקנים כאימפוסטרים' : 'כבוי: כל אחד מצביע לשחקן אחד', sw(v.multi, 'cfgToggle', 'data-p="vote.multi" aria-label="הצבעה על כמה חשודים"'));
    if (v.multi) h += setRow('כמה חשודים מותר לסמן', 'לכל שחקן, בכל סבב', stepper('vote.maxMarks', v.maxMarks, 2, 6, 1))
      + setRow('קנס על סימון של שחקן תמים', 'כדי שלא יסמנו את כולם', stepper('vote.wrong', v.wrong, 0, 300, 25))
      + `<div class="note">מי מודח? מי שקיבל הכי הרבה קולות, <b>וגם</b> כל מי שסומן על ידי לפחות חצי מהמצביעים. ככה אפשר לתפוס כמה אימפוסטרים בסבב אחד.</div>`;
    h += `<h3 style="margin-top:18px">🎭 ניחוש תפקידים</h3>` + setRow('ניחוש תפקידים בהצבעה', 'חושבים שמישהו עורך דין? מנחשים — ואם צדקתם, מקבלים נקודות', sw(v.guess, 'cfgToggle', 'data-p="vote.guess" aria-label="ניחוש תפקידים"'));
    if (v.guess) {
      h += setRow('כמה ניחושים מותר', 'לכל שחקן, בכל סבב', stepper('vote.maxGuesses', v.maxGuesses, 1, 5, 1))
        + setRow('נקודות על ניחוש נכון', '', stepper('vote.guessPts', v.guessPts, 0, 500, 25))
        + setRow('קנס על ניחוש שגוי', '0 = בלי קנס', stepper('vote.guessWrong', v.guessWrong, 0, 300, 25))
        + `<div class="note${nRoles ? '' : ' warn'}">${nRoles ? `אפשר לנחש רק את ${nRoles} התפקידים שהפעלתם. ניחוש תפקיד <b>לא</b> נחשב קול להדחה — כך שהג׳וקר לא מרוויח ממנו.` : 'אין תפקידים מיוחדים פעילים, אז אין מה לנחש. הפעילו תפקידים בלשונית „תפקידים”.'}</div>`;
    }
    return h;
  }
  function tabScore(c) {
    return `<h3>🙂 שחקנים רגילים וצד הטובים</h3>${numsRows('crew', c, true)}<h3 style="margin-top:18px">😈 אימפוסטר</h3>${numsRows('imposter', c, true)}
      <div class="note">הניקוד של כל תפקיד מיוחד נמצא בהגדרות של התפקיד עצמו (לשונית „תפקידים”).</div>`;
  }

  /* ================= במשחק ================= */
  const PH = { answer: ['✍️', 'עונים'], discuss: ['💬', 'מדברים'], vote: ['🗳️', 'מצביעים'], reveal: ['🔦', 'חשיפה'] };
  const remain = r => r.paused ? r.remaining : r.endsAt ? r.endsAt - (Date.now() + offset) : 0;
  function timerHtml(r) {
    if (!r.endsAt && !r.paused) return '';
    const C = 213.6, rem = remain(r), f = r.duration ? clamp(rem / r.duration, 0, 1) : 0;
    return `<div class="timer${rem <= 5000 ? ' low' : ''}${r.paused ? ' paused' : ''}" data-timer role="timer" aria-label="זמן שנותר">
      <svg viewBox="0 0 78 78" aria-hidden="true"><circle class="bg" cx="39" cy="39" r="34"/><circle class="fg" cx="39" cy="39" r="34" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - f)}"/></svg>
      <span class="num">${r.paused ? '⏸' : clock(rem)}</span></div>`;
  }
  function header(r) {
    const i = ['answer', 'discuss', 'vote', 'reveal'].indexOf(r.phase);
    return `<div class="gtop"><div class="info"><div class="rnd">סבב ${r.n} מתוך ${r.total}</div><div class="ph" data-k="ph-${r.phase}"><span aria-hidden="true">${PH[r.phase][0]}</span> ${PH[r.phase][1]}</div>
      <div class="steps" aria-hidden="true">${[0, 1, 2, 3].map(k => `<i class="${k < i ? 'done' : k === i ? 'now' : ''}"></i>`).join('')}</div></div>${timerHtml(r)}</div>`;
  }
  function strip(r) {
    const st = p => r.phase === 'answer' ? p.answered : r.phase === 'discuss' ? p.ready : r.phase === 'vote' ? p.voted : false;
    return `<div class="strip" aria-label="מצב השחקנים">${r.active.map(id => { const p = P(id); if (!p) return '';
      const done = st(p), off = !p.online;
      return `<div class="s${done ? ' done' : ''}${off ? ' off' : ''}" data-k="s-${id}" title="${esc(p.name)}"><div class="av">${p.avatar}${off ? '<span class="st off">!</span>' : done ? '<span class="st">✓</span>' : r.phase !== 'reveal' ? '<span class="st wait">…</span>' : ''}${p.badge === 'mayor' ? '<span class="bdg">🗳️</span>' : ''}</div><span class="n">${esc(p.name)}</span></div>`; }).join('')}</div>`;
  }

  function roleInfo(r) {
    const i = r.info || {}, role = r.myRole, c = cfg(), list = ids => (ids || []).map(who).join(' ו');
    switch (role) {
      case 'crew': return ['שחקן רגיל', c.roles.imposter.toggles.aware ? 'קיבלתם את השאלה של כולם. ענו בכנות, ובשלב השיחה מצאו את מי שענה על שאלה אחרת.' : r.phase === 'answer' ? 'ענו בכנות. בשלב השיחה תתגלה השאלה של כולם — ואם היא שונה משלכם, אתם האימפוסטר.' : 'קיבלתם את השאלה של כולם. מצאו את מי שענה על שאלה אחרת.'];
      case 'imposter': return ['אתם האימפוסטר!', 'קיבלתם שאלה קצת שונה משל כולם. ענו כך שהתשובה תשתלב.' + (i.mates && i.mates.length ? `<br>שותפים לפשע: ${list(i.mates)}` : '') + (i.accomplice ? `<br>השותף שלכם: ${who(i.accomplice)}` : '')];
      case 'accomplice': return ['שותף', `${i.imps && i.imps.length > 1 ? 'האימפוסטרים' : 'האימפוסטר'}: ${list(i.imps)}. הגנו עליו בלי שיחשדו בכם.`];
      case 'agent': return ['סוכן', i.target ? `המטרה: ${who(i.target)}. שכנעו את כולם להצביע נגדה.` : 'המטרה יצאה מהמשחק — המשימה בוטלה.'];
      case 'jester': return ['ג׳וקר', 'גרמו לכולם להצביע נגדכם — בלי שזה ייראה מכוון.' + (c.roles.jester.toggles.impQuestion ? '<br><strong>קיבלתם את שאלת האימפוסטר.</strong>' : '')];
      case 'gambler': return ['מהמר', 'בשלב ההצבעה תהמרו: האם הקבוצה תצדק?'];
      case 'detective': return ['בלש', i.check ? `בדקתם את ${who(i.check.who)}: <strong>${i.check.isImp ? '😈 אימפוסטר!' : '✓ לא אימפוסטר'}</strong>` : 'לא היה את מי לבדוק בסבב הזה.'];
      case 'mayor': return ['ראש העיר', `הקול שלכם נספר <strong>${i.weight}</strong> פעמים.`];
      case 'insider': return ['מודיע', `השאלה השנייה: <strong>${esc(r.info.other)}</strong>` + (i.count !== undefined ? `<br>כמות אימפוסטרים: <strong>${i.count}</strong>` : '')];
      case 'twins': return ['תאומים', i.twin ? `התאום/ה שלכם: ${who(i.twin)}. שניכם בצד הטוב.` : 'התאום/ה יצא/ה מהמשחק.'];
      case 'guardian': return ['שומר ראש', 'בשלב ההצבעה תבחרו בסוד את מי להגן. אם הוא יקבל הכי הרבה קולות — הוא ניצל.'];
      case 'seer': return ['רואה', i.visionLater ? 'החזון יגיע בשלב השיחה…' : i.pair && i.pair.length ? `אחד מהם אימפוסטר: ${i.pair.map(who).join(' או ')}` : '🔮 החזון: אין אימפוסטר בסבב הזה.'];
      case 'snoop': {
        let t = `אתם עוקבים אחרי: ${list(i.watch)}`;
        const vl = v => !v || !v.length ? 'עוד לא הצביע/ה' : v.map(x => x === 'none' ? '🚫 אין אימפוסטר' : x === 'all' ? '😈 כולם' : nm(x)).join(', ');
        if (i.watchVotes) t += '<br>' + Object.entries(i.watchVotes).map(([w, v]) => `${nm(w)} חושד/ת ב: <strong>${vl(v)}</strong>`).join('<br>');
        return ['מציץ', t];
      }
      case 'avenger': return ['נוקם', `אם תודחו — כל מי שהצביע נגדכם יאבד <strong>${c.roles.avenger.nums.penalty}</strong> נקודות.`];
      case 'forger': return ['זייפן', `השאלה של האימפוסטר: <strong>${esc(i.other)}</strong>. ענו תשובה שמתאימה לשתי השאלות.` + (i.imps ? `<br>האימפוסטר: ${list(i.imps)}` : '')];
      case 'shadow': return ['צל', 'הצביעו למי שלדעתכם יקבל הכי הרבה קולות.'];
      case 'lawyer': return ['עורך דין', i.client ? `הלקוח שלכם: ${who(i.client)}${i.clientImp ? ' <strong>(אימפוסטר!)</strong>' : ''}. אל תתנו לו להיות מודח.` : 'הלקוח יצא מהמשחק.'];
    }
    return [RB[role] ? RB[role].name : '', ''];
  }
  function roleCard(r) {
    if (r.roleHidden) return `<div class="card3d" data-k="card-${r.rid}"><div class="flip locked"><div class="face front"><span aria-hidden="true">🔒</span> התפקיד שלכם יתגלה אחרי ששולחים תשובה</div></div></div>`;
    const role = r.myRole, def = RB[role] || RB.crew, open = ui.flipped[r.rid] !== false, [title, body] = roleInfo(r);
    return `<div class="card3d" data-k="card-${r.rid}"><button class="flip${open ? ' open' : ''}" data-act="flip" aria-expanded="${open}">
      <div class="face front"><span aria-hidden="true">🙈</span> התפקיד מוסתר — הקישו כדי להציג</div>
      <div class="face back" data-team="${def.team}"><span class="e" aria-hidden="true">${def.emoji}</span><div class="grow"><div class="rc-lbl">התפקיד שלך</div><b>${title} ${teamPill(def.team)}</b>
        ${def.goal && role !== 'crew' ? `<div class="goal">🏁 ${def.goal}</div>` : ''}<div class="d">${body}</div><div class="hide-hint">הקישו כדי להסתיר</div></div></div></button></div>`;
  }
  const answersList = (r, mark) => r.active.map(id => `<div class="ans" data-k="a-${id}"><span class="av">${avOf(id)}</span><div class="grow"><div class="who">${nm(id)}${id === ME ? ' (את/ה)' : ''}</div><div class="a">${esc(r.answers[id] ?? '—')}</div></div>${mark ? mark(id) : ''}</div>`).join('');

  function phaseAnswer(r) {
    const d = ui.drafts[r.rid] || '';
    return `${roleCard(r)}<div class="panel"><p class="q-label">השאלה שלכם <span class="pill topic-chip">${r.topic === 'words' ? '💬 עונים במילים' : '🔢 עונים במספר'}</span></p><div class="question">${esc(r.myQuestion)}</div>
      ${r.myAnswer !== null ? `<div class="sent" data-k="sent">✓ נשלח: ${esc(r.myAnswer)}</div><p class="center small muted">מחכים לשאר (${r.answeredCount}/${r.active.length})</p>${waiting}`
      : `<div class="row answer-row"><input id="ans" class="field grow" maxlength="60" placeholder="${r.topic === 'words' ? 'מילה או שתיים' : 'התשובה שלכם'}" enterkeyhint="send" autocomplete="off" value="${esc(d)}" aria-label="התשובה שלכם"><button class="btn sm send" data-act="answer" ${d.trim() ? '' : 'disabled'}>שליחה</button></div>
        <p class="center small muted">ענו ${r.answeredCount}/${r.active.length} · אם הזמן נגמר, מה שכתבתם נשלח אוטומטית</p>`}</div>`;
  }
  function crewQ(r) {
    const diff = r.myQuestion && r.myQuestion !== r.crewQuestion && (r.myRole === 'crew' || r.myRole === 'imposter');
    return `<div class="panel crewq${diff ? ' alert' : ''}"><p class="q-label">השאלה של כולם</p><div class="question">${esc(r.crewQuestion)}</div>
      ${diff ? `<div class="note warn" data-k="impnote">😈 זו לא השאלה שקיבלתם — אתם האימפוסטר! (אתם קיבלתם: „${esc(r.myQuestion)}”) הסבירו את התשובה שלכם בלי להיתפס.</div>` : ''}</div>`;
  }
  function phaseDiscuss(r) {
    const mine = P(ME), ready = mine && mine.ready;
    return `${roleCard(r)}${crewQ(r)}<div class="panel"><h3>התשובות</h3>${answersList(r, id => P(id) && P(id).ready ? '<span class="mark ok">✓ מוכן/ה</span>' : '')}</div>
      <button class="btn${ready ? ' soft' : ''}" data-act="ready">${ready ? '✓ מוכנים — לחצו לביטול' : '🗳️ מוכנים להצבעה'}</button>
      <p class="center small muted">${r.readyCount}/${r.active.length} מוכנים. כשכולם מוכנים — עוברים להצבעה.</p>`;
  }
  function phaseVote(r) {
    const vo = S.voteOptions, vc = cfg().vote, role = r.myRole, marks = r.myMarks || {}, pick = r.myPick;
    const sus = Object.keys(marks).filter(t => marks[t] === 'imposter');
    const impN = sus.length, gN = Object.values(marks).filter(x => x !== 'imposter').length;
    const canGuess = vc.guess && (S.guessable || []).length;
    const maxI = vc.multi ? vc.maxMarks : 1;
    const guide = vc.multi ? `הקישו על עד <b>${vc.maxMarks}</b> שחקנים שלדעתכם אימפוסטרים${vc.wrong ? ` (סימון של תמים: −${vc.wrong})` : ''}` : 'הקישו על השחקן שלדעתכם האימפוסטר';
    const card = id => {
      const p = P(id), self = id === ME, ans = esc(r.answers[id] ?? '—');
      const head = `<span class="av">${avOf(id)}</span><div class="grow"><div class="who">${nm(id)}${p && p.badge === 'mayor' ? ' 🗳️' : ''}${self ? ' <span class="you-tag">את/ה</span>' : ''}</div><div class="a">${ans}</div></div>`;
      if (self) return `<div class="vcard self" data-k="v-${id}"><div class="vc-top">${head}</div><div class="vc-foot muted">זו התשובה שלך</div></div>`;
      const m = marks[id], rr = m && m !== 'imposter' ? RB[m] : null, impOn = m === 'imposter';
      const full = !impOn && vc.multi && impN >= vc.maxMarks;
      return `<div class="vcard${impOn ? ' imp' : ''}${rr ? ' guess' : ''}" data-k="v-${id}">
        <button class="vc-top" data-act="mark" data-id="${id}" aria-pressed="${impOn}" ${full ? 'disabled' : ''}>${head}<span class="vc-check" aria-hidden="true">${impOn ? '😈' : ''}</span></button>
        <div class="vc-foot">${impOn ? '<span class="tag imp">😈 חשוד/ה</span>' : `<span class="muted">${full ? 'הגעתם למקסימום' : 'הקישו כדי לחשוד'}</span>`}
          ${canGuess ? `<button class="vc-guess" data-act="guessOpen" data-id="${id}" aria-pressed="${!!rr}" ${!rr && gN >= vc.maxGuesses ? 'disabled' : ''}>${rr ? `${rr.emoji} ${rr.name}?` : '🎭 ניחוש תפקיד'}</button>` : ''}</div></div>`;
    };
    const myChoice = pick ? (pick === 'none' ? '🚫 אין אימפוסטר' : '😈 כולם אימפוסטרים') : sus.length ? sus.map(nm).join(', ') : '';
    const order = [ME, ...r.active.filter(id => id !== ME)].filter(id => r.active.includes(id));
    let h = `${role === 'crew' ? '' : roleCard(r)}<div class="panel compact"><p class="q-label">השאלה של כולם</p><div class="question sm">${esc(r.crewQuestion)}</div></div>`;
    h += `<div class="panel vote-panel"><div class="row between wrap" style="gap:8px"><h3 style="margin:0">😈 מי האימפוסטר?</h3><span class="pill">${impN}/${maxI} חשודים${canGuess ? ` · 🎭 ${gN}/${vc.maxGuesses}` : ''}</span></div>
      <p class="small muted vguide">${guide}.${canGuess ? ` ניחוש תפקיד נכון: +${vc.guessPts}.` : ''}</p>
      <div class="my-choice${myChoice ? ' set' : ''}" data-k="mych">${myChoice ? `🗳️ הבחירה שלך: <b>${myChoice}</b>` : '⏳ עוד לא בחרתם'}</div>
      <div class="vgrid">${order.map(card).join('')}</div></div>`;
    if (vo.none || vo.all) {
      const opt = (v, e, t, d) => `<button class="vopt" data-act="pick" data-v="${v}" aria-pressed="${pick === v}" data-k="p-${v}"><span class="e">${e}</span><b>${t}</b><span>${d}</span></button>`;
      h += `<div class="panel"><h3 style="margin-top:0">🤔 או שאולי בסבב הזה…</h3><p class="small muted" style="margin-top:-4px">בחירה כאן מחליפה את החשודים שסימנתם למעלה.</p>
        <div class="vopts">${vo.none ? opt('none', '🚫', 'אין אימפוסטר', 'כולם קיבלו את אותה שאלה') : ''}${vo.all ? opt('all', '😈', 'כולם אימפוסטרים', 'כל אחד קיבל שאלה אחרת') : ''}</div></div>`;
    }
    if (role === 'gambler') h += `<div class="panel" data-team="solo"><h3 style="margin-top:0">🎰 ההימור הסודי שלכם: הקבוצה…</h3><div class="bet"><button data-act="bet" data-v="right" aria-pressed="${r.myBet === 'right'}">✅ תצדק</button><button data-act="bet" data-v="wrong" aria-pressed="${r.myBet === 'wrong'}">❌ תטעה</button></div></div>`;
    if (role === 'guardian') h += `<div class="panel" data-team="crew"><h3 style="margin-top:0">🛡️ על מי להגן בסוד?</h3><div class="chips">${r.active.filter(id => id !== ME || (r.info && r.info.canSelf)).map(id => `<button class="pill clickable big" data-act="protect" data-id="${id}" aria-pressed="${r.myProtect === id}">${avOf(id)} ${nm(id)}</button>`).join('')}</div></div>`;
    h += `<p class="center small muted">הצביעו ${r.votedCount}/${r.active.length} · אפשר לשנות עד סוף הזמן</p>`;
    return h;
  }
  function spectator(r) {
    return `<div class="panel center"><div style="font-size:48px" aria-hidden="true">👀</div><h2>אתם צופים בסבב הזה</h2><p class="muted" style="margin:0">תצטרפו אוטומטית בסבב הבא.</p></div>
      ${r.crewQuestion ? `<div class="panel"><p class="q-label">השאלה של כולם</p><div class="question sm">${esc(r.crewQuestion)}</div>${answersList(r)}</div>` : ''}`;
  }

  const WHY = { fooled: 'שחקנים שלא חשדו בך', escape: 'לא נתפסת', correct: 'סימון נכון', wrong: 'סימנת שחקן תמים', group: 'הקבוצה צדקה', twins: 'בונוס תאומים', avenger: 'הדחת את הנוקם', guess: 'ניחוש תפקיד נכון', guessWrong: 'ניחוש תפקיד שגוי', lead: 'השתמשת במידע והקבוצה צדקה' };
  const WHY_ROLE = { accomplice: 'אף אימפוסטר לא נתפס', forger: 'אף אימפוסטר לא נתפס', agent: 'המטרה שלך קיבלה הכי הרבה קולות', jester: 'קיבלת הכי הרבה קולות', shadow: 'הצבעת כמו הרוב', lawyer: 'הלקוח שלך לא הודח', gambler: 'ההימור שלך', guardian: 'הצלת שחקן תמים' };
  const ROLE_RANK = { imposter: 0, accomplice: 1, forger: 1 };
  function reveal(r) {
    const res = r.result;
    if (ui.suspense[r.rid] > Date.now()) return `<div class="suspense" data-k="sus-${r.rid}"><div class="drum" aria-hidden="true">🥁</div><div class="dots">מי זה היה…</div></div>`;
    const kind = res.kind, imps = res.imps, many = imps.length > 1, ej = res.ejected || [], caught = res.caught || [];
    let head, mood;
    if (kind === 'none') { head = res.groupRight ? '🎉 צדקתם! לא היה אימפוסטר' : '😅 לא היה אימפוסטר בכלל!'; mood = res.groupRight ? 'crew' : 'calm'; }
    else if (kind === 'all') { head = res.groupRight ? '🎉 צדקתם! כולם היו אימפוסטרים' : '🤯 כולם היו אימפוסטרים!'; mood = res.groupRight ? 'crew' : 'imp'; }
    else if (res.saved && !res.groupRight) { head = '🛡️ השומר הציל!'; mood = 'calm'; }
    else if (res.groupRight) { head = caught.length > 1 ? `🎉 תפסתם ${caught.length} אימפוסטרים!` : many ? '🎉 תפסתם אימפוסטר!' : '🎉 תפסתם את האימפוסטר!'; mood = 'crew'; }
    else { head = many ? '😈 האימפוסטרים ברחו!' : '😈 האימפוסטר ברח!'; mood = 'imp'; }
    document.body.dataset.mood = mood;
    const impLine = kind === 'none' ? 'לא היה אימפוסטר בסבב הזה' : kind === 'all' ? 'כל השחקנים היו אימפוסטרים'
      : `${many ? 'האימפוסטרים' : 'האימפוסטר'}: ${imps.map(id => `<span class="who-chip imp">${avOf(id)} ${nm(id)}</span>`).join(' ')}`;
    const tl = res.verdict === 'none' ? 'רוב הקולות: „אין אימפוסטר”' : res.verdict === 'all' ? 'רוב הקולות: „כולם אימפוסטרים”'
      : ej.length ? `${ej.length > 1 ? 'הודחו' : 'הודח/ה'}: ${ej.map(nm).join(' ו')}` : res.saved ? `${nm(res.saved)} היה/תה אמור/ה להיות מודח/ת — אבל היה/תה מוגן/ת`
      : res.tops && res.tops.length > 1 ? 'תיקו בהצבעה — אף אחד לא הודח' : 'אף אחד לא הצביע';
    const g = res.gain[ME];
    const myRole = res.roles[ME];
    const mineL = g === undefined ? '' : `<div class="mine ${g > 0 ? 'pos' : g < 0 ? 'neg' : ''}" data-k="mine">${g > 0 ? `+${g} נקודות לכם 🎉` : g < 0 ? `${g} נקודות 😬` : 'לא קיבלתם נקודות בסבב הזה'}</div>`;
    const myDet = (res.detail || {})[ME] || [];
    const why = k => k === 'role' ? (WHY_ROLE[myRole] || 'המשימה של התפקיד') : (WHY[k] || k);
    const detH = myDet.length ? `<div class="breakdown" data-k="bd">${myDet.map(([k, n]) => `<span class="pill ${n < 0 ? 'neg' : 'pos'}">${why(k)} ${n > 0 ? '+' : ''}${n}</span>`).join('')}</div>` : '';
    const qp = kind === 'all'
      ? `<div class="b"><small>😈 כולם קיבלו</small>${esc(res.b)}</div><div class="a dim"><small>השאלה הרגילה (אף אחד לא קיבל)</small>${esc(res.a)}</div>`
      : `<div class="a"><small>🙂 ${kind === 'none' ? 'כולם קיבלו' : 'השאלה של כולם'}</small>${esc(res.a)}</div><div class="b${kind === 'none' ? ' dim' : ''}"><small>😈 ${kind === 'none' ? 'שאלת האימפוסטר (אף אחד לא קיבל)' : many ? 'האימפוסטרים קיבלו' : 'האימפוסטר קיבל'}</small>${esc(res.b)}</div>`;
    // אירועים מיוחדים
    const roleHolder = rid => r.active.find(id => res.roles[id] === rid);
    const ev = [];
    if (res.saved) ev.push(`🛡️ ${who(roleHolder('guardian'))} הגן/ה על ${who(res.saved)} והציל/ה מהדחה`);
    if (res.guardFail) ev.push(`🛡️ השומר ניסה להגן על אימפוסטר — וההגנה נכשלה`);
    if (res.avengerHit) ev.push(`⚔️ הנוקם ${who(roleHolder('avenger'))} הודח! ${res.hitList.length} שחקנים שילמו ${cfg().roles.avenger.nums.penalty} נקודות`);
    if (roleHolder('agent')) ev.push(`🎯 הסוכן ${who(roleHolder('agent'))} ${res.agentOk ? 'הצליח להפליל את' : 'נכשל בניסיון להפליל את'} ${res.target ? who(res.target) : 'המטרה'}`);
    if (roleHolder('jester')) ev.push(`🃏 הג׳וקר ${who(roleHolder('jester'))} ${res.jesterWon ? 'קיבל הכי הרבה קולות וניצח — בדיוק מה שרצה!' : 'לא הצליח למשוך מספיק חשד'}`);
    if (roleHolder('lawyer') && res.client) ev.push(`⚖️ עורך הדין ${who(roleHolder('lawyer'))} ${res.lawyerOk ? 'הציל את' : 'לא הצליח להציל את'} הלקוח ${who(res.client)}`);
    if (res.check) ev.push(`🔍 הבלש ${who(roleHolder('detective'))} בדק את ${who(res.check.who)} — ${res.check.isImp ? 'אימפוסטר' : 'לא אימפוסטר'}`);
    if (res.pair && roleHolder('seer')) ev.push(`🔮 הרואה ${who(roleHolder('seer'))} ראה את ${res.pair.map(who).join(' ו')}`);
    if (res.twins && res.twins.length === 2) ev.push(`👯 התאומים: ${res.twins.map(who).join(' ו')}`);
    Object.entries(res.bets || {}).forEach(([id, b]) => ev.push(`🎰 ${who(id)} הימר/ה שהקבוצה ${b === 'right' ? 'תצדק' : 'תטעה'} — ${(b === 'right') === res.groupRight ? 'וצדק/ה!' : 'וטעה/תה'}`));
    const gl = [];
    Object.entries(res.guesses || {}).forEach(([v, list]) => list.forEach(x => { const rr = RB[x.role]; gl.push(`<p>${who(v)} ניחש/ה ש${who(x.t)} ${rr.emoji} ${rr.name} — ${x.ok ? `<b class="ok-tx">צדק/ה! +${cfg().vote.guessPts}</b>` : 'טעה/תה'}</p>`); }));
    // הטבלה המרכזית: מי היה מי, מה ענה, מי חשד בו, כמה נקודות
    const isImp = id => imps.includes(id);
    const voteName = x => x === 'none' ? '🚫 אין אימפוסטר' : x === 'all' ? '😈 כולם' : nm(x);
    const rank = id => (isImp(id) ? 0 : ROLE_RANK[res.roles[id]] ?? (res.roles[id] === 'crew' ? 3 : 2));
    const rowsIds = [...r.active].sort((a, b) => rank(a) - rank(b) || (res.tally[b] || 0) - (res.tally[a] || 0));
    const rolePill = id => {
      const rr = RB[res.roles[id]] || RB.crew;
      return rr.id === 'crew' ? '<span class="pill rp muted">🙂 רגיל</span>' : `<span class="pill rp team-${rr.team}">${rr.emoji} ${rr.name}</span>`;
    };
    const rowH = id => {
      const n = res.tally[id] || 0, gg = res.gain[id] || 0, by = r.active.filter(v => (res.votes[v] || []).includes(id));
      const mine = (res.votes[id] || []);
      const st = ej.includes(id) ? `<span class="tag ${isImp(id) ? 'imp' : 'warn'}">🚪 הודח/ה</span>` : res.saved === id ? '<span class="tag ok">🛡️ ניצל/ה</span>' : isImp(id) && kind !== 'all' ? '<span class="tag fled">🏃 ברח/ה</span>' : '';
      const impQ = isImp(id) && (kind === 'one' || kind === 'some');
      return `<div class="wr${isImp(id) ? ' imp' : ''}${id === ME ? ' me' : ''}" data-k="w-${id}">
        <span class="av">${avOf(id)}</span>
        <div class="wr-main">
          <div class="wr-l1"><b class="wr-name">${nm(id)}</b>${id === ME ? '<span class="you-tag">את/ה</span>' : ''}${rolePill(id)}${st}</div>
          <div class="wr-ans"><span class="muted">${impQ ? 'ענה/תה על שאלת האימפוסטר:' : 'ענה/תה:'}</span> <b>${esc(r.answers ? r.answers[id] ?? '—' : '—')}</b></div>
          <div class="wr-votes"><span>🗳️ חשד/ה ב: ${mine.length ? mine.map(voteName).join(', ') : '<span class="muted">—</span>'}</span><span>👀 חשדו בו/ה: ${by.length ? by.map(v => `<span class="mini" title="${nm(v)}">${avOf(v)}</span>`).join('') : '<span class="muted">אף אחד</span>'}</span></div>
        </div>
        <div class="wr-pts${gg > 0 ? ' pos' : gg < 0 ? ' neg' : ''}">${gg > 0 ? '+' : ''}${gg}</div></div>`;
    };
    const special = ['none', 'all'].filter(k => res.tally[k]).map(k => `<div class="wr opt"><b>${voteName(k)}</b> · ${res.tally[k]} קולות: ${r.active.filter(v => (res.votes[v] || []).includes(k)).map(nm).join(', ')}</div>`).join('');
    const board = [...S.players].filter(p => r.active.includes(p.id) || p.score).sort((a, b) => b.score - a.score);
    const boardH = board.map((p, i) => { const gg = res.gain[p.id]; return `<div class="br${p.id === ME ? ' me' : ''}" data-k="b-${p.id}"><span class="pos">${['🥇', '🥈', '🥉'][i] || i + 1}</span><span class="av sm">${p.avatar}</span><span class="nm">${esc(p.name)}${p.id === ME ? ' (את/ה)' : ''}</span>${gg ? `<span class="gain${gg < 0 ? ' neg' : ''}">${gg > 0 ? '+' : ''}${gg}</span>` : ''}<span class="sc">${p.score}</span></div>`; }).join('');
    let fin = '';
    if (r.last) {
      const pod = [board[1], board[0], board[2]];
      fin = `<div class="panel final" data-k="final"><div class="verdict"><div class="big">🏆 סוף המשחק</div><div class="sub">${board[0] ? `המנצח/ת: <b>${esc(board[0].name)}</b> עם ${board[0].score} נקודות` : ''}</div></div>
        <div class="podium">${pod.map((p, i) => p ? `<div class="pl p${[2, 1, 3][i]}"><div class="av">${p.avatar}</div><b>${esc(p.name)}</b><div class="blk">${[2, 1, 3][i]}</div></div>` : '<div class="pl"></div>').join('')}</div>
        ${(r.awards || []).length ? `<h3>פרסים</h3>${r.awards.map(a => `<div class="aw"><span class="e">${a.e}</span><div class="grow"><b>${a.title}</b><div class="small muted">${a.who.map(nm).join(', ')} · ${a.value} ${a.unit}</div></div></div>`).join('')}` : ''}</div>`;
    }
    const tab = ui.revTab === 'board' ? 'board' : 'round';
    const tabs = `<div class="tabs rev-tabs" role="tablist"><button class="tab" role="tab" aria-selected="${tab === 'round'}" data-act="revTab" data-v="round">🔦 מה קרה בסבב</button><button class="tab" role="tab" aria-selected="${tab === 'board'}" data-act="revTab" data-v="board">🏅 טבלת ניקוד</button></div>`;
    const roundBody = `<div class="panel compact"><div class="qpair two">${qp}</div></div>
      <div class="panel who-was"><h3>מי היה מי</h3>${rowsIds.map(rowH).join('')}${special}</div>
      ${ev.length ? `<div class="panel events"><h3>✨ מה עוד קרה</h3>${ev.map(e => `<p>${e}</p>`).join('')}</div>` : ''}
      ${gl.length ? `<div class="panel events"><h3>🎭 ניחושי תפקידים</h3>${gl.join('')}</div>` : ''}`;
    return `<div class="verdict rv" data-k="vd-${r.rid}"><div class="big">${head}</div><div class="sub">${impLine}</div><div class="sub small">${tl}</div>${mineL}${detH}</div>
      ${fin}${tabs}
      <div data-k="rt-${tab}">${tab === 'round' ? roundBody : `<div class="panel board">${boardH}</div>`}</div>
      ${r.last ? '' : `<p class="center small muted next" data-k="next">הסבב הבא מתחיל בעוד <b data-count>${clock(remain(r))}</b></p>`}`;
  }

  function game() {
    const r = S.round;
    if (r.phase !== 'reveal') document.body.dataset.mood = r.phase === 'vote' ? 'imp' : '';
    const ban = [];
    if (r.paused) ban.push('<div class="banner pause" data-k="bn-p">⏸️ המשחק מושהה — מחכים למארח</div>');
    (r.banners || []).forEach(b => { if (b === 'avenger') ban.push('<div class="banner" data-k="bn-av">⚔️ יש נוקם בסבב הזה. חשבו פעמיים לפני שמצביעים.</div>'); });
    let body;
    if (!r.inRound) body = r.phase === 'reveal' ? reveal(r) : spectator(r);
    else body = r.phase === 'answer' ? phaseAnswer(r) : r.phase === 'discuss' ? phaseDiscuss(r) : r.phase === 'vote' ? phaseVote(r) : reveal(r);
    const rd = r.inRound && !r.roleHidden && r.myRole && r.phase !== 'reveal' ? RB[r.myRole] : null;
    const chip = rd ? `<button class="role-chip" data-team="${rd.team}" data-act="roleIntro" data-k="rchip-${r.myRole}"><span class="e">${rd.emoji}</span><span>התפקיד שלך: <b>${rd.name}</b></span><span class="i">ⓘ</span></button>` : '';
    return `<section class="screen" data-k="g-${r.rid}-${r.phase}">${header(r)}${chip}${ban.join('')}${r.phase !== 'reveal' ? strip(r) : ''}${body}</section>`;
  }

  /* ================= סרגל תחתון ================= */
  function dock() {
    if (!S) return '';
    const host = isHost(), r = S.round;
    const reacts = r && r.phase !== 'answer' && CAT ? `<div class="react-bar" role="group" aria-label="תגובות">${CAT.reactions.map(e => `<button data-act="react" data-v="${e}" aria-label="תגובה ${e}">${e}</button>`).join('')}</div>` : '';
    if (!r) {
      const n = onlineN();
      return host ? `<div class="in"><button class="btn start" data-act="start" ${n < 3 ? 'disabled' : ''}>🚀 התחלת המשחק (${n} שחקנים)</button>
          <button class="btn ghost sm full" data-act="closeRoom" style="margin-top:8px">סגירת החדר</button></div>`
        : `<div class="in"><button class="btn ghost" data-act="leave">יציאה מהחדר</button></div>`;
    }
    if (!host) return `<div class="in">${reacts}</div>`;
    if (r.phase === 'reveal' && r.last) return `<div class="in">${reacts}<div class="row"><button class="btn" data-act="h" data-a="restart">🔁 משחק חוזר</button><button class="btn soft" data-act="h" data-a="lobby">⚙️ ללובי</button></div></div>`;
    const skip = { answer: 'לשיחה', discuss: 'להצבעה', vote: 'לחשיפה', reveal: 'לסבב הבא' }[r.phase];
    const canTime = r.endsAt || r.paused;
    return `<div class="in">${reacts}<div class="hostbar" role="toolbar" aria-label="פקדי מארח">
      <button data-act="h" data-a="${r.paused ? 'resume' : 'pause'}" ${canTime ? '' : 'disabled'}><span class="i">${r.paused ? '▶️' : '⏸️'}</span>${r.paused ? 'המשך' : 'השהיה'}</button>
      <button data-act="h" data-a="addTime" ${canTime && r.phase !== 'reveal' ? '' : 'disabled'}><span class="i">⏱️</span>+30 שנ׳</button>
      <button data-act="skipConfirm"><span class="i">⏭️</span>${skip}</button>
      <button data-act="manage"><span class="i">👥</span>שחקנים</button>
      <button data-act="more"><span class="i">⋯</span>עוד</button></div></div>`;
  }

  /* ================= מודאלים ================= */
  function openModal(m) { ui.modal = m; render(); const el = $('#modal .sheet'); if (el) el.focus(); FX.play('tap'); }
  function closeModal() {
    const root = $('#modal'); if (!ui.modal || !root) return;
    ui.modal = null; root.classList.add('closing');
    setTimeout(() => { if (!ui.modal) { root.classList.remove('open', 'closing'); root.innerHTML = ''; } }, 240);
  }
  function confirmBox(text, yes, onYes, danger) { openModal({ type: 'confirm', text, yes, onYes, danger }); }

  function roleModal(id, editable) {
    const r = RB[id], c = cfg(), rc = c.roles[id], ed = editable && isHost() && S && S.phase === 'lobby', n = onlineN();
    let h = `<div class="role-head" data-team="${r.team}"><span class="e" aria-hidden="true">${r.emoji}</span><div><h2>${r.name}</h2><div class="chips" style="margin-top:6px">${teamPill(r.team)}${r.ability ? `<span class="pill">✨ ${r.ability}</span>` : ''}</div></div></div>
      <p style="margin:0 0 12px">${r.desc}</p>`;
    if (!r.core) {
      h += `<h3>מתי התפקיד מופיע</h3>`;
      if (ed) {
        h += setRow('התפקיד פעיל', rc.enabled ? 'יוגרל בסבבים לפי ההגדרות למטה' : 'כבוי — לא יופיע במשחק', sw(rc.enabled, 'roleToggle', `data-id="${id}" aria-label="התפקיד פעיל"`))
          + setRow('👥 מינימום שחקנים', 'קבוע לתפקיד הזה', `<b class="val">${rc.min}</b>`)
          + `<div class="set col"><div class="lbl"><b>🎲 סיכוי להופיע בכל סבב</b><span>כשיש מספיק שחקנים ומקום לעוד תפקיד</span></div>
             <div class="sl-row single"><input class="slider" type="range" min="0" max="100" step="5" value="${rc.chance}" data-act="chance" data-id="${id}" aria-label="סיכוי להופיע"><output>${rc.chance}%</output></div></div>`;
      } else h += `<div class="chips"><span class="pill">${rc.enabled ? '✓ פעיל' : 'כבוי'}</span><span class="pill">👥 מ-${rc.min} שחקנים</span><span class="pill">🎲 ${rc.chance}% בכל סבב</span></div>`;
      h += `<div class="note ${rc.enabled && n < rc.min ? 'warn' : ''}">${!rc.enabled ? 'התפקיד כבוי.' : n < rc.min ? `בחדר יש ${n} שחקנים — התפקיד יופיע רק מ-${rc.min}.` : `בחדר של ${n} שחקנים: סיכוי של ${rc.chance}% בכל סבב (אם לא הגענו למקסימום התפקידים).`}</div>`;
    }
    if (r.nums.length) h += `<h3 style="margin-top:14px">🏅 ניקוד</h3>${numsRows(id, c, ed)}`;
    if (r.toggles.length) h += `<h3 style="margin-top:14px">⚙️ יכולות וחוקים</h3>` + r.toggles.map(tg => setRow(tg.label, tg.hint, ed ? sw(rc.toggles[tg.key], 'cfgToggle', `data-p="roles.${id}.toggles.${tg.key}" aria-label="${esc(tg.label)}"`) : `<span class="pill">${rc.toggles[tg.key] ? 'פעיל' : 'כבוי'}</span>`)).join('');
    h += `<div class="row" style="margin-top:18px">${ed ? `<button class="btn soft" data-act="resetRole" data-id="${id}">↺ איפוס התפקיד</button>` : ''}<button class="btn" data-act="modalClose">סיום</button></div>`;
    return h;
  }
  function rulesModal() {
    return `<div class="role-head"><span class="e">📖</span><h2>איך משחקים</h2></div><div class="rules">
      <p>כולם מקבלים שאלה שעונים עליה במספר או במילים (לפי מה שהמארח בחר) — חוץ מהאימפוסטר, שמקבל שאלה דומה אבל שונה. המטרה: לגלות מי קיבל שאלה אחרת.</p>
      <ol><li><b>✍️ עונים</b> — כל אחד עונה בסוד על השאלה שלו.</li>
      <li><b>💬 מדברים</b> — השאלה של כולם נחשפת לצד כל התשובות. תשאלו, תחשדו, תתווכחו. מי שקיבל שאלה שונה צריך להסביר את התשובה שלו בלי להיתפס.</li>
      <li><b>🗳️ מצביעים</b> — מסמנים מי לדעתכם האימפוסטר (אם המארח הפעיל — אפשר כמה חשודים). מי שקיבל הכי הרבה קולות מודח. אפשר גם לנחש תפקידים של שחקנים (למשל „הוא עורך הדין”) ולקבל נקודות על ניחוש נכון.</li>
      <li><b>🔦 חשיפה</b> — מגלים מי היה מי, ומחלקים נקודות.</li></ol>
      <p><b>🎲 אימפוסטרים אקראיים:</b> אם המארח הפעיל, ברוב הסבבים יש אימפוסטר אחד — אבל לפעמים אין בכלל, יש כמה, או שכולם אימפוסטרים. אז יופיעו בהצבעה גם „אין אימפוסטר” ו„כולם אימפוסטרים”.</p>
      <p><b>🎭 תפקידים מיוחדים:</b> המארח יכול להוסיף תפקידים כמו בלש, ג׳וקר, שומר ראש ועוד. התפקיד שלכם מתגלה לבד בקלף בראש המסך (אפשר להקיש עליו כדי להסתיר או להציג שוב).</p>
      <p><b>🏅 ניקוד:</b> הצבעה נכונה והצלחה קבוצתית נותנות נקודות. האימפוסטר מקבל נקודות על כל מי שלא חשד בו ובונוס אם ברח.</p></div>
      <button class="btn" data-act="modalClose" style="margin-top:6px">הבנתי, יאללה</button>`;
  }
  function playerModal(id) {
    const p = P(id); if (!p) return '<p>השחקן כבר לא בחדר.</p>';
    return `<div class="role-head"><span class="e">${p.avatar}</span><div><h2>${esc(p.name)}</h2><p class="small muted" style="margin:4px 0 0">${p.online ? '🟢 מחובר/ת' : '🔴 מנותק/ת — יחכה לו/ה מקום לזמן מה'}</p></div></div>
      <div class="stack"><button class="btn soft" data-act="transfer" data-id="${id}" ${p.online ? '' : 'disabled'}>👑 העברת הניהול</button>
      <button class="btn danger" data-act="kick" data-id="${id}">🚫 הוצאה מהחדר</button></div>`;
  }
  function manageModal() {
    const r = S.round;
    return `<div class="role-head"><span class="e">👥</span><h2>ניהול שחקנים</h2></div>
      ${S.players.map(p => { const inR = r && r.active.includes(p.id);
        const st = !r ? '' : !inR ? 'צופה' : r.phase === 'answer' ? (p.answered ? '✓ ענה/תה' : '… עונה') : r.phase === 'discuss' ? (p.ready ? '✓ מוכן/ה' : '… מדבר/ת') : r.phase === 'vote' ? (p.voted ? '✓ הצביע/ה' : '… מתלבט/ת') : '';
        return `<div class="pc wide" data-k="m-${p.id}"><div class="av">${p.avatar}${p.online ? '' : '<span class="st off">!</span>'}</div><div class="grow" style="min-width:0"><div class="nm">${esc(p.name)}${p.host ? ' 👑' : ''}</div><div class="sub">${p.online ? 'מחובר/ת' : 'מנותק/ת'}${st ? ' · ' + st : ''} · ${p.score} נק׳</div></div>
          ${p.id !== ME ? `<button class="btn xs soft" data-act="transfer" data-id="${p.id}" ${p.online ? '' : 'disabled'}>👑</button><button class="btn xs danger" data-act="kick" data-id="${p.id}" aria-label="הוצאת ${esc(p.name)}">הוצאה</button>` : ''}</div>`; }).join('')}
      <button class="btn" data-act="modalClose" style="margin-top:12px">סגירה</button>`;
  }
  function moreModal() {
    const r = S.round;
    return `<div class="role-head"><span class="e">⋯</span><h2>עוד פעולות</h2></div><div class="stack">
      ${r && r.phase === 'answer' ? `<button class="btn soft" data-act="redeal">🔀 החלפת שאלה ותפקידים</button>` : ''}
      <button class="btn soft" data-act="toLobby">⚙️ חזרה ללובי (המשחק ייעצר)</button>
      <button class="btn danger" data-act="closeRoom">סגירת החדר לכולם</button></div>`;
  }
  function profileModal() {
    const p = P(ME) || {};
    return `<div class="role-head"><span class="e">${esc(p.avatar)}</span><h2>הפרופיל שלך</h2></div>
      <label class="label" for="pnm">השם</label><input id="pnm" class="field" maxlength="16" value="${esc(ui.profName ?? p.name)}">
      <p class="label" style="margin-top:12px">הדמות</p><div class="avatars wrap">${CAT.avatars.map(a => `<button class="av-pick" data-act="pav" data-v="${a}" aria-pressed="${a === p.avatar}">${a}</button>`).join('')}</div>
      <div class="row" style="margin-top:10px"><button class="btn" data-act="saveProfile">שמירה</button><button class="btn ghost" data-act="leave">יציאה מהחדר</button></div>`;
  }
  function introModal() {
    const r = S && S.round; if (!r || !r.myRole) return '';
    const d = RB[r.myRole] || RB.crew, [title, body] = roleInfo(r);
    return `<div class="intro" data-team="${d.team}"><div class="rc-lbl">התפקיד שלך בסבב הזה</div><div class="intro-e" aria-hidden="true">${d.emoji}</div>
      <h2>${title}</h2><div>${teamPill(d.team)}</div>
      ${d.goal ? `<div class="goal big">🏁 ${d.goal}</div>` : ''}<div class="intro-d">${body}</div>
      ${r.myRole !== 'imposter' ? `<p class="small muted">${d.desc}</p>` : ''}<p class="small muted">🤫 אל תראו את המסך לאף אחד. אפשר לחזור לכאן בכל רגע דרך הכפתור „התפקיד שלך”.</p>
      <button class="btn" data-act="modalClose">הבנתי 👍</button></div>`;
  }
  function guessModal(id) {
    const r = S && S.round; if (!r) return '';
    const cur = (r.myMarks || {})[id];
    return `<div class="role-head"><span class="e">${avOf(id)}</span><div><h2>מה התפקיד של ${nm(id)}?</h2><p class="small muted" style="margin:4px 0 0">ניחוש נכון: +${cfg().vote.guessPts}. ניחוש לא נחשב קול להדחה.</p></div></div>
      <div class="guess-grid">${(S.guessable || []).map(k => { const rr = RB[k]; return `<button class="preset" data-team="${rr.team}" data-act="guessSet" data-id="${id}" data-role="${k}" aria-pressed="${cur === k}"><span class="e">${rr.emoji}</span><b>${rr.name}</b><span>${rr.short}</span></button>`; }).join('')}</div>
      <div class="row" style="margin-top:14px">${cur && cur !== 'imposter' ? `<button class="btn soft" data-act="guessSet" data-id="${id}" data-role="">ביטול הניחוש</button>` : ''}<button class="btn ghost" data-act="modalClose">סגירה</button></div>`;
  }
  function modalBody() {
    const m = ui.modal;
    if (m.type === 'role') return roleModal(m.id, m.edit);
    if (m.type === 'rules') return rulesModal();
    if (m.type === 'intro') return introModal();
    if (m.type === 'guess') return guessModal(m.id);
    if (m.type === 'player') return playerModal(m.id);
    if (m.type === 'manage') return manageModal();
    if (m.type === 'more') return moreModal();
    if (m.type === 'profile') return profileModal();
    if (m.type === 'confirm') return `<p class="confirm-tx">${m.text}</p><div class="row"><button class="btn ${m.danger ? 'danger' : ''}" data-act="confirmYes">${m.yes}</button><button class="btn ghost" data-act="modalClose">ביטול</button></div>`;
    return '';
  }
  function paintModal() {
    const root = $('#modal'); if (!root) return;
    if (!ui.modal) return;
    if (['role', 'manage', 'more', 'profile', 'player', 'intro', 'guess'].includes(ui.modal.type) && !S) { ui.modal = null; return closeModalNow(); }
    if ((ui.modal.type === 'intro' && !(S.round && S.round.myRole && S.round.phase !== 'reveal')) || (ui.modal.type === 'guess' && !(S.round && S.round.phase === 'vote'))) { ui.modal = null; return closeModalNow(); }
    root.classList.add('open'); root.classList.remove('closing');
    const k = ui.modal.type + (ui.modal.id || '');
    paint(root, `<div class="scrim" data-act="modalClose"></div><div class="sheet" role="dialog" aria-modal="true" tabindex="-1" data-k="sh-${k}"><div class="grab" aria-hidden="true"></div><button class="icon-btn x" data-act="modalClose" aria-label="סגירה">✕</button>${modalBody()}</div>`);
  }

  /* ================= ציור ראשי ================= */
  function render() {
    paintBar();
    const app = $('#app'), dk = $('#dock');
    if (!app) return;
    if (!CAT) { paint(app, `<div class="center" style="padding:80px 0"><div class="title">מי האימפוסטר?</div>${waiting}<p class="muted">${conn === 'bad' ? 'אין חיבור לשרת. מנסים שוב…' : 'מתחברים…'}</p></div>`); return; }
    let html;
    if (!S) { html = home(); document.body.dataset.mood = 'calm'; }
    else if (S.phase === 'lobby') { html = lobby(); document.body.dataset.mood = ''; }
    else html = game();
    app.className = S && S.phase === 'lobby' ? 'wide' : '';
    paint(app, html);
    if (dk) { dk.className = 'dock' + (S && S.phase === 'lobby' ? ' wide' : ''); paint(dk, dock()); }
    paintModal();
    if (!S && !ui.avScrolled) { const a = $('.av-pick[aria-pressed="true"]'); if (a) { a.scrollIntoView({ block: 'nearest', inline: 'center' }); ui.avScrolled = true; } }
  }
  function closeModalNow() { const m = $('#modal'); if (m) { m.classList.remove('open', 'closing'); m.innerHTML = ''; } }

  /* ================= פעולות ================= */
  function nameInput() { const el = $('#nm'); return el ? el.value.replace(/\s+/g, ' ').trim().slice(0, 16) : me.name; }
  function doCreate() {
    const n = nameInput(); if (!n) { ui.err = 'כתבו שם לפני שפותחים חדר.'; FX.play('error'); const el = $('#nm'); el && el.focus(); return render(); }
    me.name = n; store.set('imp_name', n); store.set('imp_av', me.avatar);
    ui.busy = true; ui.err = ''; send({ t: 'create', name: n, avatar: me.avatar, token: me.token }); render();
  }
  function doJoin() {
    const n = nameInput(), code = ui.codeDigits.join('');
    if (!n) { ui.err = 'כתבו שם לפני שמצטרפים.'; FX.play('error'); return render(); }
    if (!/^\d{4}$/.test(code)) { ui.err = 'קוד החדר הוא 4 ספרות.'; FX.play('error'); const el = $('#cd0'); el && el.focus(); return render(); }
    me.name = n; store.set('imp_name', n); store.set('imp_av', me.avatar);
    me.code = code; ui.busy = true; ui.err = ''; send({ t: 'join', code, name: n, avatar: me.avatar, token: me.token }); render();
  }
  function sendAnswer() {
    const r = S && S.round, el = $('#ans'); if (!r || !el) return;
    const t = el.value.trim(); if (!t) return;
    send({ t: 'answer', text: t }); FX.play('send'); FX.vibrate(20);
  }
  const hostA = (a, extra) => send(Object.assign({ t: 'host', a }, extra || {}));

  const ACT = {
    mute() { FX.setMuted(!FX.isMuted()); if (!FX.isMuted()) FX.play('toggleOn'); paintBar(); },
    rules() { openModal({ type: 'rules' }); },
    av(b) { me.avatar = b.dataset.v; store.set('imp_av', me.avatar); FX.play('pop'); render(); },
    create: doCreate, join: doJoin,
    copy() { const u = location.origin + location.pathname + '?c=' + me.code;
      (navigator.clipboard ? navigator.clipboard.writeText(u) : Promise.reject()).then(() => toast('🔗 הקישור הועתק'), () => toast('קוד החדר: ' + me.code)); FX.play('pop'); },
    share() { navigator.share({ title: 'מי האימפוסטר?', text: `בואו לשחק איתי! קוד החדר: ${me.code}`, url: location.origin + location.pathname + '?c=' + me.code }).catch(() => {}); },
    profile() { ui.profName = null; openModal({ type: 'profile' }); },
    pav(b) { send({ t: 'profile', avatar: b.dataset.v, name: ($('#pnm') || {}).value }); me.avatar = b.dataset.v; store.set('imp_av', me.avatar); FX.play('pop'); },
    saveProfile() { const v = ($('#pnm') || {}).value || ''; if (v.trim()) { send({ t: 'profile', name: v, avatar: (P(ME) || {}).avatar }); me.name = v.trim().slice(0, 16); store.set('imp_name', me.name); } closeModal(); },
    pmenu(b) { openModal({ type: 'player', id: b.dataset.id }); },
    tab(b) { ui.tab = b.dataset.v; FX.play('tap'); render(); },
    step(b) { const p = b.dataset.p, d = +b.dataset.d; editCfg(c => setP(c, p, clamp(getP(c, p) + d, +b.dataset.min, +b.dataset.max))); FX.play('tap'); },
    cfgToggle(b) { const p = b.dataset.p; let on; editCfg(c => { on = !getP(c, p); setP(c, p, on); }); FX.play(on ? 'toggleOn' : 'toggleOff'); },
    roleToggle(b) { const id = b.dataset.id; let on; editCfg(c => { on = c.roles[id].enabled = !c.roles[id].enabled; }); FX.play(on ? 'toggleOn' : 'toggleOff'); },
    role(b) { openModal({ type: 'role', id: b.dataset.id, edit: true }); },
    roleView(b) { openModal({ type: 'role', id: b.dataset.id, edit: false }); },
    pace(b) { const p = PACES.find(x => x.id === b.dataset.v); editCfg(c => Object.assign(c, p.v)); FX.play('toggleOn'); },
    topic(b) { const k = b.dataset.v, o = k === 'numbers' ? 'words' : 'numbers'; editCfg(c => { c.topics[k] = !c.topics[k]; if (!c.topics.numbers && !c.topics.words) c.topics[o] = true; }); FX.play('toggleOn'); },
    reveal(b) { editCfg(c => { c.roleReveal = b.dataset.v; }); FX.play('toggleOn'); },
    impPreset(b) { const p = IMP_PRESETS.find(x => x.id === b.dataset.v); editCfg(c => { Object.assign(c.impDist, p.v); c.impDist.one = 100 - p.v.zero - p.v.some - p.v.all; }); FX.play('toggleOn'); },
    allRoles(b) { const on = b.dataset.v === '1'; editCfg(c => specials().forEach(r => { c.roles[r.id].enabled = on; })); FX.play(on ? 'toggleOn' : 'toggleOff'); },
    resetAll() { confirmBox('להחזיר את כל ההגדרות לברירת המחדל?', 'איפוס', () => editCfg(c => Object.assign(c, clone(CAT.defaults)))); },
    resetRole(b) { const id = b.dataset.id; editCfg(c => { c.roles[id] = clone(CAT.defaults.roles[id]); }); FX.play('toggleOff'); },
    start() { hostA('start'); },
    leave() { confirmBox('לצאת מהחדר?', 'יציאה', () => { send({ t: 'leave' }); leaveLocal(''); }); },
    closeRoom() { confirmBox('לסגור את החדר? כל השחקנים ייצאו.', 'סגירת החדר', () => hostA('close'), true); },
    flip() { const r = S.round; ui.flipped[r.rid] = ui.flipped[r.rid] === false; FX.play('flip'); render(); },
    answer: sendAnswer,
    ready() { send({ t: 'ready' }); FX.play('ready'); },
    mark(b) { const id = b.dataset.id, cur = (S.round.myMarks || {})[id]; send({ t: 'mark', target: id, role: cur === 'imposter' ? null : 'imposter' }); FX.play(cur === 'imposter' ? 'toggleOff' : 'vote'); FX.vibrate(25); },
    guessOpen(b) { openModal({ type: 'guess', id: b.dataset.id }); },
    guessSet(b) { send({ t: 'mark', target: b.dataset.id, role: b.dataset.role || null }); FX.play(b.dataset.role ? 'ready' : 'toggleOff'); closeModal(); },
    pick(b) { const v = b.dataset.v; send({ t: 'pick', v: S.round.myPick === v ? null : v }); FX.play('vote'); FX.vibrate(25); },
    roleIntro() { openModal({ type: 'intro' }); },
    revTab(b) { ui.revTab = b.dataset.v; FX.play('tap'); render(); },
    bet(b) { send({ t: 'bet', v: b.dataset.v }); FX.play('pop'); },
    protect(b) { send({ t: 'protect', target: b.dataset.id }); FX.play('ready'); },
    react(b) { send({ t: 'react', e: b.dataset.v }); },
    h(b) { hostA(b.dataset.a); FX.play('tap'); },
    skipConfirm() { const r = S.round; const t = { answer: 'לדלג לשלב השיחה? מי שלא ענה יישאר בלי תשובה.', discuss: 'לעבור עכשיו להצבעה?', vote: 'לחשוף עכשיו? מי שלא הצביע לא ייספר.', reveal: 'להתחיל את הסבב הבא עכשיו?' }[r.phase]; confirmBox(t, 'כן, ממשיכים', () => hostA('skip')); },
    manage() { openModal({ type: 'manage' }); },
    more() { openModal({ type: 'more' }); },
    redeal() { confirmBox('להחליף את השאלה ולחלק תפקידים מחדש? תשובות שנשלחו יימחקו.', 'החלפה', () => hostA('redeal')); },
    toLobby() { confirmBox('לחזור ללובי? המשחק הנוכחי ייעצר והניקוד יתאפס.', 'חזרה ללובי', () => hostA('lobby'), true); },
    transfer(b) { const id = b.dataset.id; confirmBox(`להעביר את הניהול ל${nm(id)}?`, 'העברה', () => hostA('transfer', { id })); },
    kick(b) { const id = b.dataset.id; confirmBox(`להוציא את ${nm(id)} מהחדר? הוא/היא לא יוכל/תוכל לחזור.`, 'הוצאה', () => hostA('kick', { id }), true); },
    modalClose() { closeModal(); },
    confirmYes() { const f = ui.modal && ui.modal.onYes; closeModal(); if (f) f(); }
  };

  document.addEventListener('click', e => {
    const b = e.target.closest('[data-act]'); if (!b || b.disabled) return;
    const f = ACT[b.dataset.act]; if (!f) return;
    if (b.tagName === 'BUTTON' && !['mute', 'step', 'cfgToggle', 'roleToggle', 'mark', 'pick', 'guessSet', 'react', 'av', 'pav', 'flip', 'tab', 'answer', 'ready'].includes(b.dataset.act)) FX.play('tap');
    f(b, e);
  });
  document.addEventListener('input', e => {
    const t = e.target;
    if (t.id === 'nm') { ui.err = ''; return; }
    if (t.id === 'pnm') { ui.profName = t.value; return; }
    if (t.id === 'ans' && S && S.round) { ui.drafts[S.round.rid] = t.value; const s = $('.answer-row .send'); if (s) s.disabled = !t.value.trim(); return; }
    if (t.dataset.ci !== undefined) {
      const i = +t.dataset.ci, digits = t.value.replace(/\D/g, '');
      if (digits.length > 1) { digits.slice(0, 4 - i).split('').forEach((d, k) => { ui.codeDigits[i + k] = d; }); }
      else ui.codeDigits[i] = digits;
      render();
      const nx = $('#cd' + Math.min(3, i + Math.max(1, digits.length)));
      if (digits && nx) nx.focus();
      if (ui.codeDigits.join('').length === 4 && digits) FX.play('pop');
      return;
    }
    if (t.dataset.act === 'dist') {
      const k = t.dataset.v; let v = +t.value;
      editCfg(c => { const others = ['zero', 'some', 'all'].filter(x => x !== k).reduce((s, x) => s + c.impDist[x], 0); v = Math.min(v, 100 - others); c.impDist[k] = v; c.impDist.one = 100 - others - v; });
      if (+t.value !== v) t.value = v;
      return;
    }
    if (t.dataset.act === 'chance') { const id = t.dataset.id, v = +t.value; editCfg(c => { c.roles[id].chance = v; }); }
  });
  document.addEventListener('keydown', e => {
    const t = e.target;
    if (e.key === 'Escape' && ui.modal) return closeModal();
    if (e.key !== 'Enter' && e.key !== 'Backspace') return;
    if (e.key === 'Enter' && t.id === 'ans') { e.preventDefault(); return sendAnswer(); }
    if (e.key === 'Enter' && t.id === 'nm') { e.preventDefault(); return ui.codeDigits.join('').length === 4 ? doJoin() : doCreate(); }
    if (e.key === 'Enter' && t.dataset.ci !== undefined) { e.preventDefault(); return doJoin(); }
    if (e.key === 'Enter' && t.id === 'pnm') { e.preventDefault(); return ACT.saveProfile(); }
    if (e.key === 'Backspace' && t.dataset.ci !== undefined && !t.value) { const pv = $('#cd' + (+t.dataset.ci - 1)); if (pv) { pv.focus(); ui.codeDigits[+t.dataset.ci - 1] = ''; render(); } }
  });

  /* ================= שעון: טיימר, תקתוק, שליחה אוטומטית ================= */
  setInterval(() => {
    const r = S && S.round; if (!r) return;
    const rem = remain(r);
    const el = $('[data-timer]');
    if (el && r.duration) {
      const C = 213.6, f = clamp(rem / r.duration, 0, 1);
      const fg = el.querySelector('.fg'), num = el.querySelector('.num');
      if (fg) fg.setAttribute('stroke-dashoffset', C * (1 - f));
      if (num) num.textContent = r.paused ? '⏸' : clock(rem);
      el.classList.toggle('low', rem <= 5000 && !r.paused);
    }
    const cnt = $('[data-count]'); if (cnt) cnt.textContent = clock(rem);
    if (!r.paused && r.endsAt && r.phase !== 'reveal') {
      const s = Math.ceil(rem / 1000);
      if (s <= 5 && s >= 1 && s !== ui.lastTick) { ui.lastTick = s; FX.play(s === 1 ? 'tickLast' : 'tick'); if (s <= 3) FX.vibrate(15); }
    }
    if (r.phase === 'answer' && r.inRound && r.myAnswer === null && !ui.autoSent[r.rid] && rem < 1500 && !r.paused) {
      const d = (ui.drafts[r.rid] || '').trim();
      if (d) { ui.autoSent[r.rid] = 1; send({ t: 'answer', text: d }); FX.play('send'); }
    }
    if (r.phase === 'reveal' && ui.suspense[r.rid] && ui.suspense[r.rid] <= Date.now() && $('.suspense')) render();
  }, 250);

  window.addEventListener('DOMContentLoaded', () => { connect(); render(); });
})();
