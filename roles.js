'use strict';
/*
 * קטלוג התפקידים — מקור האמת היחיד. השרת שולח אותו ללקוח, כך שכל הטקסטים
 * (בעברית) וכל ערכי ברירת המחדל מוגדרים במקום אחד.
 *
 * team: 'crew' (הטובים) | 'imp' (צוות האימפוסטר) | 'solo' (משחק לבד)
 * core: תפקיד בסיס שתמיד קיים (אי אפשר לכבות)
 * nums: ערכים מספריים שהמארח יכול לשנות (בעיקר ניקוד)
 * toggles: מתגים ייחודיים לתפקיד
 */
const ROLES = [
  {
    id: 'crew', goal: 'להצביע נגד האימפוסטר. הצבעה נכונה = נקודות.', ability: 'עונה ומחפש', core: true, team: 'crew', emoji: '🙂', name: 'שחקן רגיל',
    short: 'עונה על השאלה של כולם ומחפש את מי שלא',
    desc: 'מקבל את השאלה המשותפת. המטרה: לזהות מי ענה על שאלה אחרת ולהצביע נגדו. אם האימפוסטר לא יודע מההתחלה, גם שחקן רגיל לא בטוח שהוא לא האימפוסטר עד שהשאלה המשותפת נחשפת.',
    nums: [
      { key: 'correct', label: 'נקודות על הצבעה נכונה', min: 0, max: 1000, step: 50, def: 200 },
      { key: 'group', label: 'בונוס לכולם כשהקבוצה צדקה', min: 0, max: 1000, step: 50, def: 100 }
    ],
    toggles: []
  },
  {
    id: 'imposter', goal: 'לא להיתפס. מקבלים נקודות על כל מי שלא חשד בכם, ובונוס אם לא הודחתם.', ability: 'שאלה אחרת', core: true, team: 'imp', emoji: '😈', name: 'אימפוסטר',
    short: 'קיבל שאלה קצת אחרת — וצריך להשתלב',
    desc: 'מקבל שאלה דומה אבל שונה. בשלב השיחה השאלה של כולם נחשפת, ואז הוא מבין שהוא האימפוסטר וצריך להסביר את התשובה שלו בלי להיתפס.',
    nums: [
      { key: 'fooled', label: 'נקודות על כל שחקן שלא חשד בו', min: 0, max: 500, step: 25, def: 100 },
      { key: 'escape', label: 'בונוס כשלא נתפס', min: 0, max: 1000, step: 50, def: 200 }
    ],
    toggles: [
      { key: 'aware', label: 'האימפוסטר יודע מההתחלה', hint: 'בתחילת הסבב האימפוסטר רואה שהוא האימפוסטר (בלי לראות את השאלה של כולם). כשכבוי, הוא מגלה את זה רק בשלב השיחה.', def: true },
      { key: 'team', label: 'אימפוסטרים מכירים זה את זה', hint: 'כשיש כמה אימפוסטרים, כל אחד רואה מי השאר. עובד רק כשהאימפוסטר יודע מההתחלה.', def: false }
    ]
  },
  {
    id: 'accomplice', early: true, goal: 'לעזור לאימפוסטר לברוח. מנצחים אם אף אימפוסטר לא הודח.', ability: 'יודע מי האימפוסטר', team: 'imp', emoji: '🤝', name: 'שותף',
    short: 'יודע מי האימפוסטר ומחפה עליו',
    desc: 'מקבל את השאלה של כולם, אבל יודע מי האימפוסטר (האימפוסטר לא יודע עליו). מנצח אם אף אימפוסטר לא נתפס. נכנס רק בסבב שיש בו אימפוסטר.',
    def: { min: 4, chance: 50 },
    nums: [{ key: 'win', label: 'נקודות כשאף אימפוסטר לא נתפס', min: 0, max: 1000, step: 50, def: 300 }],
    toggles: [
      { key: 'known', label: 'האימפוסטר יודע מי השותף', hint: 'האימפוסטר רואה את השם של השותף שלו. עובד רק כשהאימפוסטר יודע מההתחלה.', def: false }
    ]
  },
  {
    id: 'agent', goal: 'לגרום לקבוצה להדיח את שחקן המטרה שלכם.', ability: 'מטרה סודית', team: 'solo', emoji: '🎯', name: 'סוכן',
    short: 'צריך להפליל שחקן תמים',
    desc: 'מקבל שחקן מטרה. המשימה: לשכנע את כולם להצביע נגד המטרה. מצליח אם המטרה מקבלת הכי הרבה קולות (גם בתיקו, וגם אם שומר הראש הציל אותה).',
    def: { min: 5, chance: 40 },
    nums: [{ key: 'win', label: 'נקודות על משימה מוצלחת', min: 0, max: 1000, step: 50, def: 400 }],
    toggles: [
      { key: 'anyTarget', label: 'המטרה יכולה להיות גם אימפוסטר', hint: 'כשכבוי, המטרה תמיד שחקן תמים.', def: false }
    ]
  },
  {
    id: 'jester', early: true, goal: 'לגרום לקבוצה להדיח אתכם.', ability: 'רוצה להיות מודח', team: 'solo', emoji: '🃏', name: 'ג׳וקר',
    short: 'רוצה שיחשדו בו',
    desc: 'מנצח אם הוא מקבל הכי הרבה קולות (גם בתיקו). צריך להיראות חשוד, אבל לא חשוד מדי.',
    def: { min: 5, chance: 30 },
    nums: [{ key: 'win', label: 'נקודות כשהוא מקבל הכי הרבה קולות', min: 0, max: 1000, step: 50, def: 400 }],
    toggles: [
      { key: 'impQuestion', label: 'הג׳וקר מקבל את שאלת האימפוסטר', hint: 'התשובה שלו תיראה חשודה באמת, וזה מקל עליו.', def: false }
    ]
  },
  {
    id: 'gambler', goal: 'להמר נכון אם הקבוצה תצדק או תטעה.', ability: 'הימור על הקבוצה', team: 'solo', emoji: '🎰', name: 'מהמר',
    short: 'מהמר אם הקבוצה תצדק',
    desc: 'בשלב ההצבעה, חוץ מההצבעה הרגילה, המהמר מהמר אם הקבוצה תצדק או תטעה. הימור נכון מביא נקודות.',
    def: { min: 4, chance: 30 },
    nums: [
      { key: 'win', label: 'נקודות על הימור נכון', min: 0, max: 1000, step: 50, def: 300 },
      { key: 'lose', label: 'קנס על הימור שגוי', min: 0, max: 500, step: 50, def: 100 }
    ],
    toggles: [
      { key: 'penalty', label: 'הימור שגוי מוריד נקודות', hint: 'כשכבוי, הימור שגוי פשוט לא נותן כלום.', def: true }
    ]
  },
  {
    id: 'detective', goal: 'להוביל את הקבוצה לאימפוסטר בעזרת המידע הסודי שלכם.', ability: 'בדיקה של שחקן', team: 'crew', emoji: '🔍', name: 'בלש',
    short: 'בודק שחקן אחד בסוד',
    desc: 'בתחילת הסבב מקבל מידע על שחקן אחד: האם הוא אימפוסטר או לא. משתמש במידע כדי להוביל את הקבוצה.',
    def: { min: 4, chance: 50 },
    nums: [{ key: 'lead', label: 'בונוס כשהצביע נכון והקבוצה צדקה', min: 0, max: 1000, step: 50, def: 150 }],
    toggles: [
      { key: 'canHitImp', label: 'הבדיקה יכולה לחשוף אימפוסטר', hint: 'כשכבוי, הבלש תמיד מקבל שם של מישהו שהוא לא אימפוסטר. כשפעיל, נבדק שחקן אקראי — ואולי זה האימפוסטר.', def: false }
    ]
  },
  {
    id: 'mayor', goal: 'להצביע נגד האימפוסטר. הקול שלכם שווה יותר.', ability: 'קול כפול', team: 'crew', emoji: '🗳️', name: 'ראש העיר',
    short: 'הקול שלו שווה יותר',
    desc: 'ההצבעה של ראש העיר נספרת כמה פעמים. שחקן חזק מאוד — שימו לב למי הוא מצביע.',
    def: { min: 4, chance: 40 },
    nums: [{ key: 'weight', label: 'כמה קולות שווה ההצבעה שלו', min: 2, max: 3, step: 1, def: 2 }],
    toggles: [
      { key: 'public', label: 'כולם יודעים מי ראש העיר', hint: 'כשפעיל, יופיע סימן 🗳️ ליד השם שלו אצל כולם.', def: true }
    ]
  },
  {
    id: 'insider', goal: 'להשתמש בשאלה השנייה כדי לזהות מי ענה עליה.', ability: 'רואה את שתי השאלות', team: 'crew', emoji: '📜', name: 'מודיע',
    short: 'רואה את שתי השאלות',
    desc: 'מקבל את השאלה של כולם, ורואה גם את השאלה שקיבלו האימפוסטרים (בלי לדעת מי קיבל אותה).',
    def: { min: 5, chance: 30 },
    nums: [{ key: 'lead', label: 'בונוס כשהצביע נכון והקבוצה צדקה', min: 0, max: 1000, step: 50, def: 150 }],
    toggles: [
      { key: 'seesCount', label: 'המודיע רואה כמה אימפוסטרים יש', hint: 'שימושי במיוחד כשכמות האימפוסטרים אקראית.', def: false }
    ]
  },
  {
    id: 'twins', goal: 'שניכם בצד הטוב. אם שניכם מצביעים נכון — בונוס.', ability: 'מכירים זה את זה', team: 'crew', emoji: '👯', name: 'תאומים',
    short: 'שני שחקנים שמכירים זה את זה',
    desc: 'שני שחקנים תמימים שיודעים זה על זה שהם בצד הטוב. תופס שני מקומות.',
    def: { min: 6, chance: 30 },
    nums: [{ key: 'bonus', label: 'בונוס אם שניהם הצביעו נכון', min: 0, max: 500, step: 50, def: 100 }],
    toggles: []
  },
  {
    id: 'guardian', goal: 'להגן על שחקן תמים שעומד להיות מודח.', team: 'crew', emoji: '🛡️', name: 'שומר ראש',
    short: 'מגן בסוד על שחקן אחד מהדחה',
    desc: 'בשלב ההצבעה, חוץ מההצבעה הרגילה, בוחר בסוד שחקן אחד להגן עליו. אם השחקן המוגן מקבל הכי הרבה קולות — הוא לא מודח, ואף אחד לא מודח בסבב הזה.',
    ability: 'הגנה סודית בשלב ההצבעה',
    def: { min: 5, chance: 35 },
    nums: [{ key: 'save', label: 'בונוס כשההגנה הצילה שחקן תמים', min: 0, max: 1000, step: 50, def: 300 }],
    toggles: [
      { key: 'self', label: 'יכול להגן על עצמו', hint: 'כשכבוי, השומר חייב לבחור מישהו אחר.', def: false },
      { key: 'protectImp', label: 'הגנה על אימפוסטר עובדת', hint: 'כשכבוי, אם השומר הגן על אימפוסטר — ההגנה נכשלת והאימפוסטר מודח בכל זאת.', def: false }
    ]
  },
  {
    id: 'seer', goal: 'לגלות מי מבין שני החשודים הוא האימפוסטר.', team: 'crew', emoji: '🔮', name: 'רואה',
    short: 'רואה שני שמות — אחד מהם אימפוסטר',
    desc: 'מקבל חזון: שני שחקנים, שאחד מהם בוודאות אימפוסטר. הוא לא יודע מי מהשניים. בסבב בלי אימפוסטר החזון מראה שלא נמצא אף אימפוסטר.',
    ability: 'חזון על שני חשודים',
    def: { min: 5, chance: 35 },
    nums: [{ key: 'lead', label: 'בונוס כשהצביע נכון והקבוצה צדקה', min: 0, max: 1000, step: 50, def: 150 }],
    toggles: [
      { key: 'lateVision', label: 'החזון מגיע רק בשלב השיחה', hint: 'כשפעיל, הרואה מקבל את השמות רק אחרי שכולם ענו. זה מונע ממנו לכוון את התשובה שלו.', def: false },
      { key: 'honestNone', label: 'חזון אמין בסבב בלי אימפוסטר', hint: 'כשכבוי, בסבב בלי אימפוסטר הרואה מקבל שני שמות תמימים כאילו אחד מהם אימפוסטר — חזון שקרי.', def: true }
    ]
  },
  {
    id: 'snoop', goal: 'לעקוב אחרי ההצבעה של השחקן שלכם ולהסיק מסקנות.', team: 'crew', emoji: '👁️', name: 'מציץ',
    short: 'רואה בזמן אמת למי שחקן אחר מצביע',
    desc: 'בשלב ההצבעה רואה בשידור חי את ההצבעה של שחקן אחד שנבחר עבורו. אם השחקן הזה מתנהג מוזר — זה רמז טוב.',
    ability: 'מעקב חי אחרי הצבעה',
    def: { min: 4, chance: 35 },
    nums: [{ key: 'lead', label: 'בונוס כשהצביע נכון והקבוצה צדקה', min: 0, max: 1000, step: 50, def: 150 }],
    toggles: [
      { key: 'twoTargets', label: 'עוקב אחרי שני שחקנים', hint: 'המציץ רואה את ההצבעות של שני שחקנים במקום אחד.', def: false }
    ]
  },
  {
    id: 'avenger', goal: 'להצביע נכון. מי שידיח אתכם — ישלם.', team: 'crew', emoji: '⚔️', name: 'נוקם',
    short: 'מי שמדיח אותו — משלם',
    desc: 'שחקן תמים עם עוקץ: אם הנוקם מקבל הכי הרבה קולות, כל מי שהצביע נגדו מאבד נקודות. גורם לכולם לחשוב פעמיים לפני שמצביעים.',
    ability: 'קנס למי שהדיח אותו',
    def: { min: 5, chance: 30 },
    nums: [{ key: 'penalty', label: 'קנס לכל מי שהצביע נגדו', min: 0, max: 500, step: 25, def: 150 }],
    toggles: [
      { key: 'announce', label: 'כולם יודעים שיש נוקם בסבב', hint: 'מופיעה הודעה לכולם שיש נוקם (בלי לגלות מי).', def: true }
    ]
  },
  {
    id: 'forger', early: true, goal: 'לבלבל את הקבוצה כדי שהאימפוסטר יברח.', team: 'imp', emoji: '🖋️', name: 'זייפן',
    short: 'מכיר את שתי השאלות ומטשטש עקבות',
    desc: 'מקבל את השאלה של כולם וגם את השאלה של האימפוסטרים. המטרה: לענות תשובה שמתאימה לשתיהן, לבלבל את הקבוצה ולעזור לאימפוסטר לברוח. מנצח אם אף אימפוסטר לא נתפס. נכנס רק בסבב שיש בו אימפוסטר.',
    ability: 'רואה את שתי השאלות',
    def: { min: 5, chance: 30 },
    nums: [{ key: 'win', label: 'נקודות כשאף אימפוסטר לא נתפס', min: 0, max: 1000, step: 50, def: 300 }],
    toggles: [
      { key: 'knowsImps', label: 'הזייפן יודע מי האימפוסטר', hint: 'כשכבוי, הוא יודע רק מה השאלה של האימפוסטר — לא מי קיבל אותה.', def: false }
    ]
  },
  {
    id: 'shadow', goal: 'להצביע בדיוק כמו הרוב.', team: 'solo', emoji: '👤', name: 'צל',
    short: 'מנצח אם הצביע כמו הרוב',
    desc: 'לא אכפת לו מי האימפוסטר — הוא רוצה להיות עם הרוב. מקבל נקודות אם הצביע לשחקן (או לאפשרות) שקיבל הכי הרבה קולות.',
    ability: 'מרוויח מהצבעה עם הרוב',
    def: { min: 4, chance: 30 },
    nums: [{ key: 'win', label: 'נקודות כשהצביע כמו הרוב', min: 0, max: 1000, step: 50, def: 250 }],
    toggles: [
      { key: 'tie', label: 'תיקו נחשב', hint: 'כשפעיל, גם הצבעה לאחד המובילים בתיקו מזכה בנקודות.', def: false }
    ]
  },
  {
    id: 'lawyer', goal: 'לשמור שהלקוח שלכם לא יודח.', team: 'solo', emoji: '⚖️', name: 'עורך דין',
    short: 'חייב להציל את הלקוח שלו',
    desc: 'מקבל לקוח — שחקן אחד. מנצח אם הלקוח לא מקבל הכי הרבה קולות. בונוס אם אף אחד לא הצביע נגד הלקוח.',
    ability: 'מגן על לקוח',
    def: { min: 5, chance: 25 },
    nums: [
      { key: 'win', label: 'נקודות כשהלקוח לא הודח', min: 0, max: 1000, step: 50, def: 200 },
      { key: 'zero', label: 'בונוס כשאף אחד לא הצביע נגד הלקוח', min: 0, max: 500, step: 50, def: 100 }
    ],
    toggles: [
      { key: 'impClient', label: 'הלקוח תמיד אימפוסטר', hint: 'כשפעיל, הלקוח הוא תמיד אימפוסטר (כשיש כזה) — ועורך הדין יודע את זה.', def: false }
    ]
  }
];

const BY_ID = Object.fromEntries(ROLES.map(r => [r.id, r]));
const SPECIAL = ROLES.filter(r => !r.core).map(r => r.id);
const TEAMS = {
  crew: { name: 'הטובים', emoji: '🛡️' },
  imp: { name: 'צוות האימפוסטר', emoji: '😈' },
  solo: { name: 'משחק לבד', emoji: '🎲' }
};

const AVATARS = ['🦊','🐼','🐸','🐙','🦉','🐯','🐨','🦄','🐧','🐢','🦁','🐵','🐰','🐻','🦖','🐳','🦩','🐝','🦔','🐺','🐮','🐷','🦜','🐞'];
const REACTIONS = ['😂','🤔','😱','🤨','👀','🔥','👏','🤥'];

const LIMITS = {
  rounds: [1, 50], ansT: [10, 600], disT: [10, 900], votT: [10, 600], revT: [5, 120], maxSpecial: [0, 12]
};

const VOTE_NUMS = [['maxMarks', 2, 6], ['wrong', 0, 300], ['maxGuesses', 1, 5], ['guessPts', 0, 500], ['guessWrong', 0, 300]];

function defaultRoleCfg(r) {
  const o = { enabled: false, min: r.def ? r.def.min : 3, chance: r.def ? r.def.chance : 100, nums: {}, toggles: {} };
  if (r.core) o.enabled = true;
  r.nums.forEach(n => { o.nums[n.key] = n.def; });
  r.toggles.forEach(t => { o.toggles[t.key] = t.def; });
  return o;
}

function defaultCfg() {
  return {
    rounds: 5, ansT: 45, disT: 90, votT: 30, revT: 15,
    randomImps: false,
    topics: { numbers: true, words: true }, // נושאי השאלות: מספרים ו/או מילים
    roleReveal: 'start', // מתי התפקיד נחשף לשחקן: start = בתחילת הסבב, answered = אחרי ששלח תשובה
    impDist: { zero: 8, one: 80, some: 8, all: 4 },
    maxSpecial: 3,
    vote: { multi: true, maxMarks: 3, wrong: 50, guess: true, maxGuesses: 2, guessPts: 150, guessWrong: 0 },
    roles: Object.fromEntries(ROLES.map(r => [r.id, defaultRoleCfg(r)]))
  };
}

const clampInt = (v, lo, hi, d) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};

/** מנקה הגדרות שהגיעו מהלקוח. כל ערך לא תקין מוחלף בברירת המחדל. */
function sanitizeCfg(raw, prev) {
  const base = prev || defaultCfg();
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = defaultCfg();
  for (const k of Object.keys(LIMITS)) out[k] = clampInt(src[k] ?? base[k], LIMITS[k][0], LIMITS[k][1], base[k]);
  out.randomImps = typeof src.randomImps === 'boolean' ? src.randomImps : base.randomImps;
  const tp = src.topics && typeof src.topics === 'object' ? src.topics : (base.topics || {});
  const bt = base.topics || { numbers: true, words: true };
  out.topics = { numbers: typeof tp.numbers === 'boolean' ? tp.numbers : bt.numbers, words: typeof tp.words === 'boolean' ? tp.words : bt.words };
  if (!out.topics.numbers && !out.topics.words) out.topics.numbers = true; // תמיד לפחות נושא אחד
  out.roleReveal = ['start', 'answered'].includes(src.roleReveal) ? src.roleReveal : (['start', 'answered'].includes(base.roleReveal) ? base.roleReveal : 'start');
  const d = src.impDist && typeof src.impDist === 'object' ? src.impDist : base.impDist;
  // "אחד" הוא תמיד השארית: 0 + כמה + כולם לא עוברים 100, והשאר הולך לאימפוסטר אחד
  for (const k of ['zero', 'some', 'all']) out.impDist[k] = clampInt(d[k] ?? base.impDist[k], 0, 100, base.impDist[k]);
  let rest = out.impDist.zero + out.impDist.some + out.impDist.all;
  if (rest > 100) {
    const f = 100 / rest;
    for (const k of ['zero', 'some', 'all']) out.impDist[k] = Math.floor(out.impDist[k] * f);
    rest = out.impDist.zero + out.impDist.some + out.impDist.all;
  }
  out.impDist.one = 100 - rest;
  const sv = src.vote && typeof src.vote === 'object' ? src.vote : {}, bv = base.vote || out.vote;
  for (const [k, lo, hi] of VOTE_NUMS) out.vote[k] = clampInt(sv[k] ?? bv[k], lo, hi, out.vote[k]);
  for (const k of ['multi', 'guess']) out.vote[k] = typeof sv[k] === 'boolean' ? sv[k] : (typeof bv[k] === 'boolean' ? bv[k] : out.vote[k]);
  const rs = src.roles && typeof src.roles === 'object' ? src.roles : {};
  for (const r of ROLES) {
    const s = rs[r.id] && typeof rs[r.id] === 'object' ? rs[r.id] : {};
    const b = base.roles[r.id] || defaultRoleCfg(r);
    const o = out.roles[r.id];
    o.enabled = r.core ? true : (typeof s.enabled === 'boolean' ? s.enabled : b.enabled);
    o.min = r.def ? r.def.min : 3; // מינימום השחקנים קבוע לכל תפקיד ולא ניתן לשינוי
    o.chance = clampInt(s.chance ?? b.chance, 0, 100, b.chance);
    const sn = s.nums && typeof s.nums === 'object' ? s.nums : {};
    r.nums.forEach(n => { o.nums[n.key] = clampInt(sn[n.key] ?? b.nums[n.key], n.min, n.max, n.def); });
    const st = s.toggles && typeof s.toggles === 'object' ? s.toggles : {};
    r.toggles.forEach(t => { o.toggles[t.key] = typeof st[t.key] === 'boolean' ? st[t.key] : b.toggles[t.key]; });
  }
  return out;
}

function shuffle(a) {
  a = [...a];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
const pick = a => a[Math.floor(Math.random() * a.length)];

/** בוחר כמה אימפוסטרים יהיו בסבב. */
function drawImpCount(n, cfg) {
  if (!cfg.randomImps) return { kind: 'one', k: 1 };
  const d = cfg.impDist;
  const opts = [['zero', d.zero], ['one', d.one], ['some', d.some], ['all', d.all]].filter(([, w]) => w > 0);
  const total = opts.reduce((s, [, w]) => s + w, 0);
  let x = Math.random() * total, kind = 'one';
  for (const [k, w] of opts) { if ((x -= w) < 0) { kind = k; break; } }
  if (kind === 'zero') return { kind: 'none', k: 0 };
  if (kind === 'all') return { kind: 'all', k: n };
  if (kind === 'some') {
    // בין 2 ל-(n-1). כמויות קטנות יותר סבירות יותר (משקל 1/k).
    const ks = []; for (let k = 2; k <= n - 1; k++) ks.push(k);
    if (!ks.length) return { kind: 'one', k: 1 };
    const ws = ks.map(k => 1 / (k - 1)), tw = ws.reduce((a, b) => a + b, 0);
    let y = Math.random() * tw;
    for (let i = 0; i < ks.length; i++) if ((y -= ws[i]) < 0) return { kind: 'some', k: ks[i] };
    return { kind: 'some', k: ks[ks.length - 1] };
  }
  return { kind: 'one', k: 1 };
}

/**
 * מחלק תפקידים לסבב.
 * כללים: לאימפוסטר אין תפקיד נוסף; לכל שחקן לכל היותר תפקיד אחד;
 * תמיד נשארים לפחות 2 שחקנים בצד הטוב; לא יותר מ-maxSpecial תפקידים מיוחדים.
 */
function assignRoles(ids, cfg) {
  const n = ids.length;
  const order = shuffle(ids);
  const { kind, k } = drawImpCount(n, cfg);
  const imps = order.slice(0, k);
  const roles = {}; // id -> roleId
  const info = {};
  ids.forEach(id => { roles[id] = imps.includes(id) ? 'imposter' : 'crew'; });
  if (kind === 'all') return { kind, imps, roles, info };

  let pool = order.slice(k);            // שחקנים בלי תפקיד מיוחד (עדיין)
  let crewSide = pool.length;           // כמה נשארו בצד הטוב
  let used = 0;
  const enabled = shuffle(SPECIAL.filter(id => cfg.roles[id].enabled));
  for (const rid of enabled) {
    if (used >= cfg.maxSpecial) break;
    const rc = cfg.roles[rid], def = BY_ID[rid];
    if (n < rc.min || Math.random() * 100 >= rc.chance) continue;
    const need = rid === 'twins' ? 2 : 1;
    if (pool.length < need) continue;
    // תפקידים שלא בצד הטוב מורידים שחקן מהצד הטוב
    if (def.team !== 'crew' && crewSide - need < 2) continue;
    if ((rid === 'accomplice' || rid === 'forger') && !imps.length) continue;
    const who = pool.slice(0, need); pool = pool.slice(need);
    who.forEach(id => { roles[id] = rid; });
    if (def.team !== 'crew') crewSide -= need;
    used++;
    if (rid === 'twins') info.twins = who;
  }
  // מידע נלווה לתפקידים
  const agent = ids.find(id => roles[id] === 'agent');
  if (agent) {
    const anyT = cfg.roles.agent.toggles.anyTarget;
    const cand = ids.filter(id => id !== agent && (anyT || !imps.includes(id)));
    info.target = cand.length ? pick(cand) : null;
  }
  const det = ids.find(id => roles[id] === 'detective');
  if (det) {
    const hit = cfg.roles.detective.toggles.canHitImp;
    const cand = ids.filter(id => id !== det && (hit || !imps.includes(id)));
    if (cand.length) { const w = pick(cand); info.check = { who: w, isImp: imps.includes(w) }; }
  }
  const seer = ids.find(id => roles[id] === 'seer');
  if (seer) {
    const inn = shuffle(ids.filter(id => id !== seer && !imps.includes(id)));
    if (imps.length && inn.length) info.pair = shuffle([pick(imps), inn[0]]);
    else if (!imps.length && !cfg.roles.seer.toggles.honestNone && inn.length >= 2) info.pair = [inn[0], inn[1]];
    else info.pair = null; // "לא נמצא אימפוסטר"
  }
  const snoop = ids.find(id => roles[id] === 'snoop');
  if (snoop) info.watch = shuffle(ids.filter(id => id !== snoop)).slice(0, cfg.roles.snoop.toggles.twoTargets ? 2 : 1);
  const lawyer = ids.find(id => roles[id] === 'lawyer');
  if (lawyer) {
    const others = ids.filter(id => id !== lawyer);
    info.client = cfg.roles.lawyer.toggles.impClient && imps.length ? pick(imps) : (others.length ? pick(others) : null);
  }
  return { kind, imps, roles, info };
}

function catalog() {
  return { roles: ROLES, teams: TEAMS, avatars: AVATARS, reactions: REACTIONS, limits: LIMITS, defaults: defaultCfg() };
}

module.exports = { ROLES, BY_ID, SPECIAL, TEAMS, AVATARS, REACTIONS, LIMITS, defaultCfg, sanitizeCfg, assignRoles, shuffle, catalog };
