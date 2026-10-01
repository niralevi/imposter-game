'use strict';
const crypto = require('crypto');
const QUESTIONS = mergeQuestions(require('./questions'), (() => { try { return require('./questions-extra'); } catch (e) { return {}; } })());

/** מאחד את מאגר השאלות הנוסף לתוך הראשי (לפי id של קבוצה), בלי כפילויות */
function mergeQuestions(base, extra) {
  const out = {}, seen = new Set();
  for (const topic of ['numbers', 'words']) {
    const pools = new Map();
    for (const p of [...(base[topic] || []), ...(extra[topic] || [])]) {
      if (!pools.has(p.id)) pools.set(p.id, { id: p.id, name: p.name, qs: [] });
      const tgt = pools.get(p.id);
      for (const q of p.qs) { const k = q.trim(); if (!seen.has(k)) { seen.add(k); tgt.qs.push(k); } }
    }
    out[topic] = [...pools.values()].filter(p => p.qs.length >= 2);
  }
  return out;
}
const R = require('./roles');

/* ---------- מאגר השאלות: אינדקס לפי מזהה קצר ---------- */
const qid = t => { let h = 5381; for (let i = 0; i < t.length; i++) h = ((h * 33) ^ t.charCodeAt(i)) >>> 0; return h.toString(36); };
const QIDX = {};   // id -> { t: טקסט, topic, pool }
const BANK = {};   // topic -> [{ pool, ids }]
for (const topic of ['numbers', 'words']) {
  BANK[topic] = (QUESTIONS[topic] || []).map(p => ({ pool: p.id, ids: p.qs.map(t => { const id = qid(t); QIDX[id] = { t, topic, pool: p.id }; return id; }) }));
}
const SEEN_CAP = 8000;

const PHASES = ['answer', 'discuss', 'vote', 'reveal'];
const GRACE_LOBBY = 30e3;   // כמה זמן שחקן מנותק נשאר בלובי
const GRACE_GAME = 120e3;   // כמה זמן שחקן מנותק נשאר במשחק
const HOST_GRACE = 10e3;    // אחרי כמה זמן מארח מנותק מעביר את הניהול
const MIN_PLAYERS = 3;
const LEADERS = ['detective', 'seer', 'insider', 'snoop'];

const newId = () => crypto.randomBytes(6).toString('hex');

class Room {
  constructor(code, onEmpty) {
    this.code = code;
    this.onEmpty = onEmpty;
    this.players = new Map();   // id -> player
    this.hostId = null;
    this.cfg = R.defaultCfg();
    this.round = null;          // הסבב הנוכחי (null בלובי)
    this.game = null;           // { total, n, stats }
    this.timer = null;
    this.seen = new Set();      // שאלות שכבר יצאו לשחקנים בחדר (כולל ממשחקים קודמים שלהם)
    this.lastPool = null;
    this.banned = new Set();
    this.events = [];           // אירועים קצרים להצגה כהודעה (טוסט)
    this.syncQueued = false;
    this.hostTimer = null;
  }

  uniqueName(name, exceptId) {
    const taken = new Set([...this.players.values()].filter(p => p.id !== exceptId).map(p => p.name));
    if (!taken.has(name)) return name;
    for (let i = 2; i < 99; i++) { const n = (name.slice(0, 13) + ' ' + i); if (!taken.has(n)) return n; }
    return name;
  }

  profile(p, name, avatar) {
    if (this.round && this.round.active.includes(p.id)) return;
    const n = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 16);
    if (n) p.name = this.uniqueName(n, p.id);
    if (R.AVATARS.includes(avatar)) p.avatar = avatar;
    this.sync();
  }

  /* ---------- שחקנים ---------- */
  addPlayer(ws, name, avatar, token) {
    const id = newId();
    name = this.uniqueName(name);
    const p = {
      id, token, ws, name, avatar, online: true, score: 0, joinedAt: Date.now(),
      spectator: !!this.round, dropTimer: null, lastReact: 0
    };
    this.players.set(id, p);
    if (!this.hostId) this.hostId = id;
    this.event('join', `${name} הצטרף/ה`, id);
    this.sync();
    return p;
  }

  reattach(p, ws) {
    if (p.ws && p.ws !== ws) { try { p.ws.close(4000, 'replaced'); } catch (e) {} }
    p.ws = ws; p.online = true;
    clearTimeout(p.dropTimer); p.dropTimer = null;
    this.event('back', `${p.name} חזר/ה`, p.id);
    this.sync();
    this.checkAuto();
  }

  disconnect(p) {
    p.ws = null; p.online = false;
    clearTimeout(p.dropTimer);
    p.dropTimer = setTimeout(() => this.removePlayer(p.id, 'timeout'), this.round ? GRACE_GAME : GRACE_LOBBY);
    if (p.id === this.hostId) {
      clearTimeout(this.hostTimer);
      this.hostTimer = setTimeout(() => {
        const h = this.players.get(this.hostId);
        if (h && !h.online) this.pickNewHost();
      }, HOST_GRACE);
    }
    this.event('off', `${p.name} התנתק/ה`, p.id);
    this.sync();
    this.checkAuto();
  }

  pickNewHost() {
    const next = [...this.players.values()].find(p => p.online && p.id !== this.hostId);
    if (next) { this.hostId = next.id; this.event('host', `${next.name} הוא/היא המארח/ת עכשיו`, next.id); this.sync(); }
  }

  removePlayer(id, why) {
    const p = this.players.get(id);
    if (!p) return;
    clearTimeout(p.dropTimer);
    this.players.delete(id);
    if (why === 'kick') { this.banned.add(p.token); this.send(p, { t: 'kicked' }); p.ws && (p.ws.room = null); }
    this.event('leave', why === 'kick' ? `${p.name} הוצא/ה מהמשחק` : `${p.name} יצא/ה`, id);
    if (this.players.size === 0) return this.destroy();
    if (this.hostId === id) {
      const next = [...this.players.values()].find(q => q.online) || this.players.values().next().value;
      this.hostId = next.id;
      this.event('host', `${next.name} הוא/היא המארח/ת עכשיו`, next.id);
    }
    if (this.round) this.dropFromRound(id);
    this.sync();
  }

  dropFromRound(id) {
    const r = this.round;
    if (!r.active.includes(id)) return;
    r.active = r.active.filter(x => x !== id);
    delete r.answers[id]; delete r.marks[id]; delete r.picks[id]; delete r.bets[id]; delete r.protects[id]; r.ready.delete(id);
    for (const v in r.marks) delete r.marks[v][id]; // סימונים על מי שיצא נמחקים
    for (const v in r.protects) if (r.protects[v] === id) delete r.protects[v];
    if (r.info.client === id) r.info.client = null;
    if (r.info.watch) r.info.watch = r.info.watch.filter(x => x !== id);
    if (r.info.pair && r.info.pair.includes(id)) r.info.pair = r.info.pair.filter(x => x !== id);
    const wasImp = r.imps.includes(id);
    r.imps = r.imps.filter(x => x !== id);
    if (r.info.target === id) r.info.target = null;
    if (r.info.check && r.info.check.who === id) r.info.check = null;
    if (r.info.twins && r.info.twins.includes(id)) r.info.twins = r.info.twins.filter(x => x !== id);
    if (r.phase === 'reveal') return;
    if (r.active.length < MIN_PLAYERS) { this.event('info', 'נשארו פחות מ-3 שחקנים, חוזרים ללובי'); return this.toLobby(); }
    if (wasImp && !r.imps.length && r.kind !== 'none') { this.event('info', 'האימפוסטר יצא, מחלקים את הסבב מחדש'); return this.startRound(true); }
    if (r.kind === 'some' && r.imps.length === 1) r.kind = 'one';
    this.checkAuto();
  }

  online() { return [...this.players.values()].filter(p => p.online); }

  /* ---------- הגדרות ---------- */
  setCfg(raw) {
    if (this.round) return;
    this.cfg = R.sanitizeCfg(raw, this.cfg);
    this.sync();
  }

  /* ---------- סבבים ---------- */
  /** שחקן שולח את רשימת השאלות שכבר ראה (נשמרת אצלו בדפדפן) — כדי שלא יחזרו */
  addSeen(ids) {
    if (!Array.isArray(ids)) return;
    for (const id of ids.slice(-SEEN_CAP)) if (typeof id === 'string' && QIDX[id]) this.seen.add(id);
  }

  /**
   * בוחרים נושא, ואז שתי שאלות שונות מאותה קבוצה: אחת לכולם ואחת לאימפוסטר.
   * שאלות שמישהו בחדר כבר ראה לא יוצאות, עד שכמעט כל הנושא נגמר — ואז מתחילים מחדש.
   */
  drawPair() {
    const t = this.cfg.topics || { numbers: true };
    const on = ['numbers', 'words'].filter(k => t[k] && BANK[k].length);
    const topic = on.length ? on[Math.floor(Math.random() * on.length)] : 'numbers';
    const pools = BANK[topic];
    const fresh = p => p.ids.filter(id => !this.seen.has(id));
    let cand = pools.filter(p => fresh(p).length >= 1 && p.ids.length >= 2);
    const freshCount = pools.reduce((n, p) => n + fresh(p).length, 0);
    if (freshCount < 6) { // כמעט הכל נוצל: מאפסים את הזיכרון של הנושא הזה
      pools.forEach(p => p.ids.forEach(id => this.seen.delete(id)));
      cand = pools.filter(p => p.ids.length >= 2);
      this.event('info', '🔄 עברתם על כל השאלות בנושא — מתחילים סיבוב חדש');
    }
    // בוחרים שאלה ראשונה באקראי מבין כל השאלות הטריות (קבוצה גדולה = יותר סיכוי), לא מאותה קבוצה כמו בסבב הקודם אם אפשר
    const weighted = [];
    for (const p of cand) for (const id of fresh(p).length ? fresh(p) : p.ids) weighted.push([p, id]);
    let pickd = weighted[Math.floor(Math.random() * weighted.length)];
    for (let i = 0; i < 6 && pickd[0].pool === this.lastPool && cand.length > 1; i++) pickd = weighted[Math.floor(Math.random() * weighted.length)];
    const [pool, first] = pickd;
    const others = pool.ids.filter(id => id !== first);
    const freshOthers = others.filter(id => !this.seen.has(id));
    const second = (freshOthers.length ? freshOthers : others)[Math.floor(Math.random() * (freshOthers.length || others.length))];
    this.lastPool = pool.pool;
    const used = [first, second];
    used.forEach(id => this.seen.add(id));
    this.broadcast({ t: 'qseen', ids: used });
    return { topic, pool: pool.pool, qa: QIDX[first].t, qb: QIDX[second].t };
  }

  startGame() {
    const ok = this.online();
    if (ok.length < MIN_PLAYERS) return this.event('info', 'צריך לפחות 3 שחקנים מחוברים');
    this.players.forEach(p => { p.score = 0; });
    this.game = { total: this.cfg.rounds, n: 0, stats: {}, history: [] };
    this.startRound(false);
  }

  startRound(redeal) {
    const act = this.online();
    if (act.length < MIN_PLAYERS) { this.event('info', 'אין מספיק שחקנים מחוברים'); return this.toLobby(); }
    if (!redeal) this.game.n++;
    act.forEach(p => { p.spectator = false; });
    [...this.players.values()].filter(p => !p.online).forEach(p => { p.spectator = true; });
    const ids = act.map(p => p.id);
    const a = R.assignRoles(ids, this.cfg);
    const dq = this.drawPair();
    this.round = {
      rid: newId(), n: this.game.n, kind: a.kind, imps: a.imps, roles: a.roles, info: a.info,
      topic: dq.topic, a: dq.qa, b: dq.qb, active: ids, answers: {}, marks: {}, picks: {}, bets: {}, protects: {}, ready: new Set(),
      phase: null, endsAt: 0, paused: false, remaining: 0, result: null
    };
    this.setPhase('answer');
  }

  duration(ph) {
    const c = this.cfg;
    if (ph === 'answer') return c.ansT;
    if (ph === 'discuss') return c.disT;
    if (ph === 'vote') return c.votT;
    if (ph === 'reveal') return this.isLast() ? 0 : c.revT;
    return 0;
  }
  isLast() { return this.game && this.round && this.round.n >= this.game.total; }

  setPhase(ph) {
    const r = this.round;
    if (!r) return;
    clearTimeout(this.timer);
    r.phase = ph; r.paused = false;
    if (ph === 'reveal') this.score();
    const d = this.duration(ph) * 1000;
    r.endsAt = d ? Date.now() + d : 0;
    if (d) this.timer = setTimeout(() => this.onTimer(), d);
    this.sync();
  }

  onTimer() {
    const r = this.round;
    if (!r || r.paused) return;
    if (r.phase === 'reveal') return this.isLast() ? null : this.startRound(false);
    this.setPhase(PHASES[PHASES.indexOf(r.phase) + 1]);
  }

  /** מעבר אוטומטי כשכל המחוברים סיימו */
  checkAuto() {
    const r = this.round;
    if (!r || r.paused) return;
    const live = r.active.filter(id => { const p = this.players.get(id); return p && p.online; });
    if (!live.length) return;
    if (r.phase === 'answer' && live.every(id => r.answers[id] !== undefined)) this.setPhase('discuss');
    else if (r.phase === 'discuss' && live.every(id => r.ready.has(id))) this.setPhase('vote');
    else if (r.phase === 'vote' && live.every(id => this.voted(id) && (r.roles[id] !== 'gambler' || r.bets[id]) && (r.roles[id] !== 'guardian' || r.protects[id]))) this.setPhase('reveal');
  }

  toLobby() {
    clearTimeout(this.timer);
    this.round = null; this.game = null;
    this.players.forEach(p => { p.spectator = false; });
    this.sync();
  }

  /* ---------- פעולות שחקנים ---------- */
  answer(p, text) {
    const r = this.round;
    if (!r || r.phase !== 'answer' || !r.active.includes(p.id) || r.answers[p.id] !== undefined) return;
    const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!t) return;
    r.answers[p.id] = t;
    this.sync(); this.checkAuto();
  }

  voteOptions() {
    const c = this.cfg;
    return { none: c.randomImps && c.impDist.zero > 0, all: c.randomImps && c.impDist.all > 0 };
  }

  /** רשימת הקולות להדחה של שחקן: ['none'] / ['all'] / מזהי השחקנים שסימן כאימפוסטרים */
  votesOf(id) {
    const r = this.round;
    if (r.picks[id]) return [r.picks[id]];
    const m = r.marks[id] || {};
    return Object.keys(m).filter(t => m[t] === 'imposter');
  }
  voted(id) { return this.votesOf(id).length > 0; }
  guessable() { return R.SPECIAL.filter(k => this.cfg.roles[k].enabled); }

  /** סימון שחקן: role = 'imposter' (קול להדחה), תפקיד מיוחד (ניחוש), או null לביטול */
  mark(p, target, role) {
    const r = this.round, v = this.cfg.vote;
    if (!r || r.phase !== 'vote' || !r.active.includes(p.id) || !r.active.includes(target) || target === p.id) return;
    const m = r.marks[p.id] = r.marks[p.id] || {};
    if (role == null) { delete m[target]; return this.sync(); }
    if (role === 'imposter') {
      const cur = Object.keys(m).filter(t => m[t] === 'imposter' && t !== target);
      if (!v.multi) cur.forEach(t => delete m[t]);          // הצבעה רגילה: קול אחד, מחליפים
      else if (cur.length >= v.maxMarks) return;             // הצבעה מרובה: עד המקסימום
      delete r.picks[p.id];
    } else {
      if (!v.guess || !this.guessable().includes(role)) return;
      const cur = Object.keys(m).filter(t => m[t] !== 'imposter' && t !== target);
      if (cur.length >= v.maxGuesses) return;
    }
    m[target] = role;
    this.sync(); this.checkAuto();
  }

  /** בחירה באפשרות מיוחדת: 'none' / 'all' / null. מבטלת סימוני אימפוסטר (ניחושי תפקידים נשארים). */
  pick(p, val) {
    const r = this.round;
    if (!r || r.phase !== 'vote' || !r.active.includes(p.id)) return;
    const o = this.voteOptions();
    if (val === null) delete r.picks[p.id];
    else if ((val === 'none' && o.none) || (val === 'all' && o.all)) {
      r.picks[p.id] = val;
      const m = r.marks[p.id] || {};
      for (const t in m) if (m[t] === 'imposter') delete m[t];
    } else return;
    this.sync(); this.checkAuto();
  }

  bet(p, v) {
    const r = this.round;
    if (!r || r.phase !== 'vote' || r.roles[p.id] !== 'gambler' || !['right', 'wrong'].includes(v)) return;
    r.bets[p.id] = v;
    this.sync(); this.checkAuto();
  }

  protect(p, target) {
    const r = this.round;
    if (!r || r.phase !== 'vote' || r.roles[p.id] !== 'guardian' || !r.active.includes(target)) return;
    if (target === p.id && !this.cfg.roles.guardian.toggles.self) return;
    r.protects[p.id] = target;
    this.sync(); this.checkAuto();
  }

  ready(p) {
    const r = this.round;
    if (!r || r.phase !== 'discuss' || !r.active.includes(p.id)) return;
    if (r.ready.has(p.id)) r.ready.delete(p.id); else r.ready.add(p.id);
    this.sync(); this.checkAuto();
  }

  react(p, e) {
    if (!R.REACTIONS.includes(e) || Date.now() - p.lastReact < 600) return;
    p.lastReact = Date.now();
    this.broadcast({ t: 'react', from: p.id, e });
  }

  hostAction(p, m) {
    if (p.id !== this.hostId) return;
    const r = this.round, a = m.a;
    if (a === 'start' && !r) return this.startGame();
    if (a === 'kick' && m.id !== p.id && this.players.has(m.id)) return this.removePlayer(m.id, 'kick');
    if (a === 'transfer' && m.id !== p.id && this.players.has(m.id) && this.players.get(m.id).online) {
      this.hostId = m.id; this.event('host', `${this.players.get(m.id).name} הוא/היא המארח/ת עכשיו`, m.id); return this.sync();
    }
    if (a === 'close') { this.broadcast({ t: 'closed' }); return this.destroy(); }
    if (!r) return;
    if (a === 'lobby') return this.toLobby();
    if (a === 'skip') {
      if (r.phase === 'reveal') return this.isLast() ? this.toLobby() : this.startRound(false);
      return this.setPhase(PHASES[PHASES.indexOf(r.phase) + 1]);
    }
    if (a === 'restart' && r.phase === 'reveal' && this.isLast()) return this.startGame();
    if (a === 'redeal' && r.phase === 'answer') { this.event('info', 'המארח החליף את השאלה וחילק תפקידים מחדש'); return this.startRound(true); }
    if (a === 'pause' && !r.paused && r.endsAt) {
      clearTimeout(this.timer); r.paused = true; r.remaining = Math.max(1000, r.endsAt - Date.now());
      this.event('info', 'המשחק הושהה'); return this.sync();
    }
    if (a === 'resume' && r.paused) {
      r.paused = false; r.endsAt = Date.now() + r.remaining;
      this.timer = setTimeout(() => this.onTimer(), r.remaining);
      this.event('info', 'המשחק ממשיך'); this.sync(); return this.checkAuto();
    }
    if (a === 'addTime' && r.endsAt && r.phase !== 'reveal') {
      if (r.paused) r.remaining += 30e3;
      else { clearTimeout(this.timer); r.endsAt += 30e3; this.timer = setTimeout(() => this.onTimer(), r.endsAt - Date.now()); }
      return this.sync();
    }
  }

  /* ---------- ניקוד ---------- */
  score() {
    const r = this.round, c = this.cfg.roles, vc = this.cfg.vote, st = this.game.stats;
    if (r.result) return;
    const isImp = id => r.imps.includes(id);
    const roleOf = id => r.roles[id];
    const holder = rid => r.active.find(id => roleOf(id) === rid) || null;
    const weight = id => roleOf(id) === 'mayor' ? c.mayor.nums.weight : 1;
    const V = {}; for (const id of r.active) V[id] = this.votesOf(id);
    const tally = {}; let W = 0;
    for (const id of r.active) { if (V[id].length) W += weight(id); for (const t of V[id]) tally[t] = (tally[t] || 0) + weight(id); }
    const max = Math.max(0, ...Object.values(tally));
    const tops = max > 0 ? Object.keys(tally).filter(k => tally[k] === max) : [];
    const uniq = tops.length === 1 ? tops[0] : null;
    let verdict = null, ejected = [];
    if (uniq === 'none' || uniq === 'all') verdict = uniq;
    else {
      if (uniq) ejected.push(uniq);                          // מי שקיבל הכי הרבה קולות
      if (vc.multi) {                                        // וגם כל מי שסומן על ידי לפחות חצי מהמצביעים
        const need = Math.max(2, Math.ceil(W / 2));
        for (const t of Object.keys(tally)) if (t !== 'none' && t !== 'all' && tally[t] >= need && !ejected.includes(t)) ejected.push(t);
      }
    }
    // שומר ראש: מי שמוגן ועמד להיות מודח — ניצל
    let saved = null, guardFail = false;
    const guard = holder('guardian'), prot = guard ? r.protects[guard] : null;
    if (prot && ejected.includes(prot)) {
      if (!isImp(prot) || c.guardian.toggles.protectImp) { saved = prot; ejected = ejected.filter(x => x !== prot); } else guardFail = true;
    }
    const out = id => ejected.includes(id);
    const kind = r.kind;
    const caught = ejected.filter(isImp);
    const groupRight = kind === 'none' ? verdict === 'none' : kind === 'all' ? verdict === 'all' : caught.length > 0;
    const isGood = t => kind === 'none' ? t === 'none' : kind === 'all' ? t === 'all' : isImp(t);
    const allGood = id => V[id].length > 0 && V[id].every(isGood);
    const gain = {}, detail = {};
    const add = (id, n, why) => { if (!n) return; gain[id] += n; (detail[id] = detail[id] || []).push([why, n]); };
    const S = id => (st[id] = st[id] || { good: 0, esc: 0, sus: 0, mis: 0, jest: 0, bet: 0, save: 0, law: 0, guess: 0 });
    const avenger = holder('avenger'), avengerHit = !!(avenger && out(avenger));
    // "קיבל הכי הרבה קולות": הודח, או היה בראש ההצבעה (גם בתיקו, וגם אם השומר הציל אותו)
    const topped = id => !!id && (out(id) || tops.includes(id));
    const agentOk = !!(r.info.target && topped(r.info.target));
    for (const id of r.active) {
      gain[id] = 0;
      const role = roleOf(id);
      if (role === 'imposter' && kind !== 'all') {
        const fooled = r.active.filter(q => !isImp(q) && !V[q].includes(id)).length;
        add(id, fooled * c.imposter.nums.fooled, 'fooled');
        if (!out(id)) { add(id, c.imposter.nums.escape, 'escape'); S(id).esc++; }
      } else if (role === 'accomplice') { if (!groupRight) add(id, c.accomplice.nums.win, 'role'); }
      else if (role === 'forger') { if (!groupRight) add(id, c.forger.nums.win, 'role'); }
      else if (role === 'agent') { if (agentOk) { add(id, c.agent.nums.win, 'role'); S(id).mis++; } }
      else if (role === 'jester') { if (topped(id)) { add(id, c.jester.nums.win, 'role'); S(id).jest++; } }
      else if (role === 'shadow') {
        const ok = V[id].some(t => out(t) || t === verdict || t === uniq || (c.shadow.toggles.tie && tops.length > 1 && tops.includes(t)));
        if (ok) add(id, c.shadow.nums.win, 'role');
      } else if (role === 'lawyer') {
        const cl = r.info.client;
        if (cl && !out(cl)) { add(id, c.lawyer.nums.win + (tally[cl] ? 0 : c.lawyer.nums.zero), 'role'); S(id).law++; }
      } else if (role === 'gambler') {
        const b = r.bets[id];
        if (b && (b === 'right') === groupRight) { add(id, c.gambler.nums.win, 'role'); S(id).bet++; }
        else if (b && c.gambler.toggles.penalty) add(id, -c.gambler.nums.lose, 'role');
      } else {
        // צד הטוב — וגם כולם בסבב "כולם אימפוסטרים": נקודות על כל סימון נכון, קנס על סימון תמים (בהצבעה מרובה)
        let right = 0, wrong = 0;
        for (const t of V[id]) { if (isGood(t)) right++; else if (t !== 'none' && t !== 'all') wrong++; }
        if (right) { add(id, right * c.crew.nums.correct, 'correct'); S(id).good += right; }
        if (vc.multi && wrong) add(id, -wrong * vc.wrong, 'wrong');
        if (groupRight) add(id, c.crew.nums.group * Math.max(1, caught.length), 'group');
        if (role === 'guardian' && saved && !isImp(saved)) { add(id, c.guardian.nums.save, 'role'); S(id).save++; }
        // תפקידי מידע (בלש, רואה, מודיע, מציץ): בונוס כשהשתמשו במידע — הצביעו נכון והקבוצה צדקה
        if (LEADERS.includes(role) && groupRight && allGood(id) && c[role].nums.lead) { add(id, c[role].nums.lead, 'lead'); S(id).lead = (S(id).lead || 0) + 1; }
      }
      S(id).sus += (tally[id] || 0);
    }
    const tw = r.info.twins;
    if (tw && tw.length === 2 && tw.every(allGood)) tw.forEach(id => add(id, c.twins.nums.bonus, 'twins'));
    const hitList = [];
    if (avengerHit) for (const v of r.active) if (V[v].includes(avenger)) { add(v, -c.avenger.nums.penalty, 'avenger'); hitList.push(v); }
    // ניחושי תפקידים
    const guesses = {};
    for (const v of r.active) {
      const m = r.marks[v] || {};
      for (const [t, rid] of Object.entries(m)) {
        if (rid === 'imposter') continue;
        const ok = roleOf(t) === rid;
        (guesses[v] = guesses[v] || []).push({ t, role: rid, ok });
        if (ok) { add(v, vc.guessPts, 'guess'); S(v).guess++; } else add(v, -vc.guessWrong, 'guessWrong');
      }
    }
    for (const id of r.active) { const p = this.players.get(id); if (p) p.score += gain[id]; }
    r.result = {
      tally, tops, verdict, ejected, caught, groupRight, gain, detail, guesses, votes: V, saved, guardFail, avengerHit, hitList,
      top: verdict || (ejected.length === 1 ? ejected[0] : null),
      agentOk,
      lawyerOk: !!(r.info.client && !out(r.info.client)),
      jesterWon: r.active.some(id => roleOf(id) === 'jester' && topped(id))
    };
    this.game.history.push({ n: r.n, kind, groupRight, imps: r.imps.length });
  }

  awards() {
    const st = this.game ? this.game.stats : {};
    const list = [
      ['🔍', 'עין של נץ', 'good', 'הצבעות נכונות'],
      ['🎭', 'מלך ההסוואה', 'esc', 'בריחות'],
      ['👀', 'הכי חשוד', 'sus', 'קולות נגדו'],
      ['🎯', 'הסוכן החשאי', 'mis', 'משימות'],
      ['🃏', 'הליצן', 'jest', 'ניצחונות ג׳וקר'],
      ['🎰', 'יד חמה', 'bet', 'הימורים נכונים'],
      ['🛡️', 'המגן', 'save', 'הצלות'],
      ['⚖️', 'הפרקליט', 'law', 'לקוחות שניצלו'],
      ['🧠', 'קורא מחשבות', 'guess', 'תפקידים שנוחשו'],
      ['🧭', 'המנווט', 'lead', 'הובלות מוצלחות']
    ];
    const out = [];
    for (const [e, title, k, unit] of list) {
      const ids = Object.keys(st).filter(id => this.players.has(id));
      const mx = Math.max(0, ...ids.map(id => st[id][k] || 0));
      if (!mx) continue;
      out.push({ e, title, unit, value: mx, who: ids.filter(id => (st[id][k] || 0) === mx) });
    }
    return out;
  }

  /* ---------- תצוגה אישית לכל שחקן ---------- */
  view(pid) {
    const r = this.round, me = this.players.get(pid);
    const cfgR = this.cfg.roles;
    const publicMayor = r && cfgR.mayor.toggles.public ? Object.keys(r.roles).find(id => r.roles[id] === 'mayor') : null;
    const players = [...this.players.values()].map(p => ({
      id: p.id, name: p.name, avatar: p.avatar, online: p.online, score: p.score,
      host: p.id === this.hostId, spectator: !!(r && !r.active.includes(p.id)),
      answered: !!(r && r.answers[p.id] !== undefined),
      voted: !!(r && r.active.includes(p.id) && this.voted(p.id)),
      ready: !!(r && r.ready.has(p.id)),
      badge: p.id === publicMayor && r.phase !== 'reveal' ? 'mayor' : null
    }));
    const v = {
      code: this.code, you: pid, hostId: this.hostId, serverNow: Date.now(), cfg: this.cfg,
      phase: r ? r.phase : 'lobby', players, guessable: this.guessable(), events: this.events.slice(-5), round: null, voteOptions: this.voteOptions()
    };
    if (!r) return v;
    const inRound = r.active.includes(pid);
    const role = inRound ? r.roles[pid] : null;
    const aware = cfgR.imposter.toggles.aware;
    const past = ph => PHASES.indexOf(r.phase) >= PHASES.indexOf(ph);
    const out = {
      rid: r.rid, n: r.n, topic: r.topic, total: this.game.total, phase: r.phase, endsAt: r.endsAt, paused: r.paused,
      remaining: r.paused ? r.remaining : 0, duration: this.duration(r.phase) * 1000,
      inRound, active: r.active, last: this.isLast(),
      myAnswer: r.answers[pid] ?? null, myMarks: r.marks[pid] || {}, myPick: r.picks[pid] || null, myBet: r.bets[pid] ?? null, myProtect: r.protects[pid] ?? null,
      banners: (cfgR.avenger.toggles.announce && r.phase !== 'reveal' && Object.values(r.roles).includes('avenger')) ? ['avenger'] : [],
      answeredCount: Object.keys(r.answers).length, votedCount: r.active.filter(id => this.voted(id)).length, readyCount: r.ready.size
    };
    // המארח יכול לבחור שהתפקיד יתגלה רק אחרי ששלחו תשובה. ההסתרה נעשית בשרת, כך שהמידע בכלל לא נשלח.
    // תפקידים שהתשובה שלהם תלויה בתפקיד (ג׳וקר, זייפן, שותף) תמיד רואים אותו מההתחלה
    const early = role && R.BY_ID[role] && R.BY_ID[role].early;
    out.roleHidden = !!(inRound && !early && this.cfg.roleReveal === 'answered' && r.phase === 'answer' && r.answers[pid] === undefined);
    if (inRound) {
      const jesterB = role === 'jester' && cfgR.jester.toggles.impQuestion;
      out.myQuestion = role === 'imposter' || jesterB ? r.b : r.a;
      // אימפוסטר שלא יודע רואה בדיוק את מה ששחקן רגיל רואה
      out.myRole = role === 'imposter' && !aware && !past('discuss') ? 'crew' : role;
      const info = {};
      if (out.myRole === 'imposter' && aware) {
        if (cfgR.imposter.toggles.team && r.kind !== 'all') info.mates = r.imps.filter(x => x !== pid);
        if (cfgR.accomplice.toggles.known) info.accomplice = Object.keys(r.roles).find(id => r.roles[id] === 'accomplice') || null;
      }
      if (role === 'accomplice') info.imps = r.imps;
      if (role === 'agent') info.target = r.info.target;
      if (role === 'detective') info.check = r.info.check || null;
      if (role === 'insider') { info.other = r.b; if (cfgR.insider.toggles.seesCount) info.count = r.imps.length; }
      if (role === 'twins') info.twin = (r.info.twins || []).find(x => x !== pid) || null;
      if (role === 'mayor') info.weight = cfgR.mayor.nums.weight;
      if (role === 'guardian') info.canSelf = cfgR.guardian.toggles.self;
      if (role === 'seer' && (!cfgR.seer.toggles.lateVision || past('discuss'))) { info.pair = r.info.pair || null; info.vision = true; }
      if (role === 'seer' && cfgR.seer.toggles.lateVision && !past('discuss')) info.visionLater = true;
      if (role === 'snoop') {
        info.watch = r.info.watch || [];
        if (r.phase === 'vote') info.watchVotes = Object.fromEntries(info.watch.map(id => [id, this.votesOf(id)]));
      }
      if (role === 'forger') { info.other = r.b; if (cfgR.forger.toggles.knowsImps) info.imps = r.imps; }
      if (role === 'lawyer') { info.client = r.info.client || null; info.clientImp = !!(cfgR.lawyer.toggles.impClient && r.info.client && r.imps.includes(r.info.client)); }
      out.info = info;
      if (out.roleHidden) { out.myRole = null; out.info = {}; }
    }
    // בסבב "כולם אימפוסטרים" כולם קיבלו את שאלה ב׳ — מציגים אותה, כדי שהסבב ייראה רגיל לגמרי
    if (past('discuss')) { out.crewQuestion = r.kind === 'all' ? r.b : r.a; out.answers = r.answers; }
    if (r.phase === 'reveal') {
      out.result = Object.assign({}, r.result, {
        kind: r.kind, imps: r.imps, roles: r.roles, a: r.a, b: r.b, marks: r.marks, bets: r.bets,
        target: r.info.target || null, check: r.info.check || null, twins: r.info.twins || null,
        protects: r.protects, client: r.info.client || null, pair: r.info.pair || null, watch: r.info.watch || null
      });
      if (this.isLast()) out.awards = this.awards();
    }
    v.round = out;
    return v;
  }

  /* ---------- תקשורת ---------- */
  event(kind, text, who) {
    this.events.push({ id: newId(), kind, text, who: who || null, at: Date.now() });
    if (this.events.length > 20) this.events.shift();
  }
  send(p, obj) { if (p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(obj)); }
  broadcast(obj) { this.players.forEach(p => this.send(p, obj)); }
  sync() {
    if (this.syncQueued) return;
    this.syncQueued = true;
    setImmediate(() => {
      this.syncQueued = false;
      this.players.forEach(p => this.send(p, { t: 'state', s: this.view(p.id) }));
    });
  }
  destroy() {
    clearTimeout(this.timer); clearTimeout(this.hostTimer);
    this.players.forEach(p => { clearTimeout(p.dropTimer); if (p.ws) p.ws.room = null; });
    this.players.clear();
    this.onEmpty(this);
  }
}

module.exports = { Room, MIN_PLAYERS };
