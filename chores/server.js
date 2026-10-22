'use strict';
// Chores – a tiny chores & pocket-money tracker, built to run as a Home Assistant add-on.
// Zero dependencies: Node's http + built-in SQLite (node --experimental-sqlite).

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 8099);
const DATA_DIR = fs.existsSync('/data') ? '/data' : path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'chores.db'));

// ---------------------------------------------------------------- schema
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS children (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, emoji TEXT DEFAULT '⭐',
  pin TEXT, ha_user TEXT, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS chores (
  id INTEGER PRIMARY KEY, child_id INTEGER NOT NULL, name TEXT NOT NULL, emoji TEXT DEFAULT '🧹',
  value INTEGER NOT NULL DEFAULT 0,          -- pence
  frequency TEXT NOT NULL DEFAULT 'daily',   -- daily | days | weekly | anytime
  days TEXT DEFAULT '',                      -- for 'days': "1,3,5"  (1=Mon … 7=Sun)
  needs_approval INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS bundles (
  id INTEGER PRIMARY KEY, child_id INTEGER NOT NULL, name TEXT NOT NULL,
  period TEXT NOT NULL DEFAULT 'week',       -- week | month
  target INTEGER NOT NULL,                   -- number of approved chores needed
  chore_ids TEXT DEFAULT '[]',               -- JSON array; empty = any chore
  reward INTEGER NOT NULL,                   -- pence
  start_date TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS completions (
  id INTEGER PRIMARY KEY, chore_id INTEGER NOT NULL, child_id INTEGER NOT NULL,
  date TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | rejected
  value INTEGER NOT NULL, created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(chore_id, date));
CREATE TABLE IF NOT EXISTS payouts (
  id INTEGER PRIMARY KEY, child_id INTEGER NOT NULL, amount INTEGER NOT NULL,
  note TEXT, date TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));
`);
// migrations for existing databases
const cols = db.prepare('PRAGMA table_info(chores)').all().map(c => c.name);
if (!cols.includes('kind')) db.exec("ALTER TABLE chores ADD COLUMN kind TEXT NOT NULL DEFAULT 'chore'");   // chore | routine
if (!cols.includes('due_time')) db.exec("ALTER TABLE chores ADD COLUMN due_time TEXT DEFAULT ''");          // 'HH:MM' or ''
if (!cols.includes('remind_time')) db.exec("ALTER TABLE chores ADD COLUMN remind_time TEXT DEFAULT ''");    // 'HH:MM' or ''
if (!cols.includes('alert_parents')) db.exec("ALTER TABLE chores ADD COLUMN alert_parents INTEGER NOT NULL DEFAULT 0");
const kidCols = db.prepare('PRAGMA table_info(children)').all().map(c => c.name);
if (!kidCols.includes('notify_targets')) db.exec("ALTER TABLE children ADD COLUMN notify_targets TEXT DEFAULT '[]'");
db.exec(`CREATE TABLE IF NOT EXISTS notifications_sent (
  chore_id INTEGER NOT NULL, date TEXT NOT NULL, kind TEXT NOT NULL, PRIMARY KEY (chore_id, date, kind))`);

const q = (sql) => db.prepare(sql);
const getSetting = (k) => q('SELECT value FROM settings WHERE key=?').get(k)?.value ?? null;
const setSetting = (k, v) => q('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, v);

// ---------------------------------------------------------------- dates (local time)
const pad = (n) => String(n).padStart(2, '0');
const toStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromStr = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const today = () => toStr(new Date());
const addDays = (s, n) => { const d = fromStr(s); d.setDate(d.getDate() + n); return toStr(d); };
const isoWeekday = (s) => ((fromStr(s).getDay() + 6) % 7) + 1; // 1=Mon … 7=Sun
const weekStart = (s) => addDays(s, 1 - isoWeekday(s));
const monthStart = (s) => s.slice(0, 7) + '-01';
const periodOf = (period, s) => period === 'month' ? monthStart(s) : weekStart(s);
const periodEnd = (period, start) => {
  if (period === 'month') { const d = fromStr(start); d.setMonth(d.getMonth() + 1); d.setDate(0); return toStr(d); }
  return addDays(start, 6);
};

// ---------------------------------------------------------------- domain
function choreDueOn(chore, dateStr) {
  switch (chore.frequency) {
    case 'daily': return true;
    case 'days': return chore.days.split(',').map(Number).includes(isoWeekday(dateStr));
    case 'weekly': return true; // due once per week – shown until done
    default: return false;      // anytime
  }
}

function bundleProgress(bundle, periodStart) {
  const end = periodEnd(bundle.period, periodStart);
  const ids = JSON.parse(bundle.chore_ids || '[]');
  const rows = q(`SELECT c.chore_id, c.status FROM completions c JOIN chores ch ON ch.id=c.chore_id
                  WHERE c.child_id=? AND c.date BETWEEN ? AND ? AND ch.kind='chore'`).all(bundle.child_id, periodStart, end)
    .filter(r => ids.length === 0 || ids.includes(r.chore_id));
  return {
    approved: rows.filter(r => r.status === 'approved').length,
    pending: rows.filter(r => r.status === 'pending').length,
    start: periodStart, end,
  };
}

// Reward is earned when the period has ended and the target was met.
function bundleEarnings(bundle, uptoDate) {
  let total = 0, periods = [];
  let p = periodOf(bundle.period, bundle.start_date);
  while (periodEnd(bundle.period, p) < uptoDate) {
    const prog = bundleProgress(bundle, p);
    const met = prog.approved >= bundle.target;
    if (met) total += bundle.reward;
    periods.push({ ...prog, met });
    p = addDays(periodEnd(bundle.period, p), 1);
  }
  return { total, periods };
}

function balanceFor(childId) {
  const t = today();
  const chores = q('SELECT COALESCE(SUM(value),0) v FROM completions WHERE child_id=? AND status=?').get(childId, 'approved').v;
  const bundles = q('SELECT * FROM bundles WHERE child_id=?').all(childId);
  const bundleTotal = bundles.reduce((s, b) => s + bundleEarnings(b, t).total, 0);
  const paid = q('SELECT COALESCE(SUM(amount),0) v FROM payouts WHERE child_id=?').get(childId).v;
  const pending = q('SELECT COALESCE(SUM(value),0) v FROM completions WHERE child_id=? AND status=?').get(childId, 'pending').v;
  return { earnedChores: chores, earnedBundles: bundleTotal, paid, pending, balance: chores + bundleTotal - paid };
}

function dashboard(childId) {
  const child = q('SELECT id,name,emoji,ha_user FROM children WHERE id=?').get(childId);
  if (!child) return null;
  const t = today();
  const ws = weekStart(t);
  const chores = q('SELECT * FROM chores WHERE child_id=? AND active=1 ORDER BY sort,id').all(childId);
  const todayComps = q('SELECT * FROM completions WHERE child_id=? AND date=?').all(childId, t);
  const weekComps = q('SELECT * FROM completions WHERE child_id=? AND date BETWEEN ? AND ?').all(childId, ws, addDays(ws, 6));
  const byChore = (list, id) => list.find(c => c.chore_id === id);

  const todays = [], anytime = [], routines = [];
  for (const c of chores) {
    const done = byChore(todayComps, c.id);
    if (c.frequency === 'anytime') { anytime.push({ ...c, completion: done || null }); continue; }
    if (!choreDueOn(c, t)) continue;
    if (c.frequency === 'weekly') {
      const wk = weekComps.find(x => x.chore_id === c.id && x.status !== 'rejected');
      if (wk && wk.date !== t) continue; // already done this week
    }
    (c.kind === 'routine' ? routines : todays).push({ ...c, completion: done || null });
  }
  routines.sort((a, b) => (a.due_time || '99:99').localeCompare(b.due_time || '99:99'));

  const bundles = q('SELECT * FROM bundles WHERE child_id=? AND active=1').all(childId).map(b => {
    const p = periodOf(b.period, t);
    return { ...b, chore_ids: JSON.parse(b.chore_ids || '[]'), progress: bundleProgress(b, p) };
  });

  const history = q(`SELECT c.id, c.date, c.status, c.value, ch.name, ch.emoji, ch.kind FROM completions c
                     JOIN chores ch ON ch.id=c.chore_id WHERE c.child_id=? ORDER BY c.date DESC, c.id DESC LIMIT 30`).all(childId);
  const payouts = q('SELECT * FROM payouts WHERE child_id=? ORDER BY date DESC, id DESC LIMIT 10').all(childId);

  return { child, today: t, now: `${pad(new Date().getHours())}:${pad(new Date().getMinutes())}`, todays, anytime, routines, bundles, money: balanceFor(childId), history, payouts };
}

// ---------------------------------------------------------------- auth
const sessions = new Map(); // token -> { role, childId }
const parseCookies = (h = '') => Object.fromEntries(h.split(';').map(s => s.trim().split('=')).filter(a => a[0]));

function identify(req) {
  const cookies = parseCookies(req.headers.cookie);
  const sess = sessions.get(cookies.chores_session);
  if (sess) return { ...sess, via: 'pin' };
  const haUser = req.headers['x-remote-user-name'] || null;
  const parentPin = getSetting('parent_pin');
  if (!parentPin) return { role: 'setup', haUser };
  const parents = JSON.parse(getSetting('parent_ha_users') || '[]');
  if (haUser && parents.includes(haUser)) return { role: 'parent', haUser, via: 'ha' };
  const child = haUser ? q('SELECT id FROM children WHERE ha_user=?').get(haUser) : null;
  if (child) return { role: 'child', childId: child.id, haUser, via: 'ha' };
  return { role: 'guest', haUser };
}

let lastPinAttempt = 0;

// ---------------------------------------------------------------- http plumbing
const send = (res, code, body, headers = {}) => {
  const json = JSON.stringify(body ?? {});
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(json);
};
const readBody = (req) => new Promise((resolve, reject) => {
  let data = '';
  req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(); });
  req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
});
class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const need = (cond, code, msg) => { if (!cond) throw new HttpError(code, msg); };
const pence = (v) => Math.max(0, Math.round(Number(v) || 0));

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler });

// --- session
route('GET', '/api/me', (ctx) => {
  const me = ctx.me;
  const children = q('SELECT id,name,emoji FROM children ORDER BY id').all();
  return { ...me, children: me.role === 'parent' || me.role === 'setup' ? children : children.filter(c => c.id === me.childId) };
});
route('POST', '/api/setup', async (ctx) => {
  need(!getSetting('parent_pin'), 400, 'Already set up');
  const { pin } = ctx.body;
  need(/^\d{4,8}$/.test(pin || ''), 400, 'PIN must be 4–8 digits');
  setSetting('parent_pin', pin);
  setSetting('parent_ha_users', JSON.stringify(ctx.me.haUser ? [ctx.me.haUser] : []));
  return { ok: true };
});
route('POST', '/api/pin', async (ctx) => {
  const now = Date.now(); if (now - lastPinAttempt < 1000) await new Promise(r => setTimeout(r, 1000)); lastPinAttempt = now;
  const { pin } = ctx.body;
  let sess = null;
  if (pin && pin === getSetting('parent_pin')) sess = { role: 'parent' };
  else { const c = pin ? q('SELECT id FROM children WHERE pin=?').get(pin) : null; if (c) sess = { role: 'child', childId: c.id }; }
  need(sess, 401, 'Wrong PIN');
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, sess);
  ctx.headers['Set-Cookie'] = `chores_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200`;
  return { ok: true, ...sess };
});
route('POST', '/api/logout', (ctx) => {
  sessions.delete(parseCookies(ctx.req.headers.cookie).chores_session);
  ctx.headers['Set-Cookie'] = 'chores_session=; Path=/; Max-Age=0';
  return { ok: true };
});

// --- parent-only guard helper
const parent = (fn) => (ctx) => { need(ctx.me.role === 'parent', 403, 'Parents only'); return fn(ctx); };

// --- settings
const parentTargets = () => JSON.parse(getSetting('parent_notify_targets') || '[]');
route('GET', '/api/settings', parent(() => ({
  parentHaUsers: JSON.parse(getSetting('parent_ha_users') || '[]'),
  parentNotifyTargets: parentTargets(),
  notifyOnChore: getSetting('notify_on_chore') !== '0',
  notifyOnRoutine: getSetting('notify_on_routine') === '1',
})));
route('PUT', '/api/settings', parent((ctx) => {
  const { parentPin, parentHaUsers, parentNotifyTargets, notifyOnChore, notifyOnRoutine } = ctx.body;
  if (parentPin !== undefined) { need(/^\d{4,8}$/.test(parentPin), 400, 'PIN must be 4–8 digits'); setSetting('parent_pin', parentPin); }
  if (Array.isArray(parentHaUsers)) setSetting('parent_ha_users', JSON.stringify(parentHaUsers.map(String)));
  if (Array.isArray(parentNotifyTargets)) setSetting('parent_notify_targets', JSON.stringify(cleanTargets(parentNotifyTargets)));
  if (notifyOnChore !== undefined) setSetting('notify_on_chore', notifyOnChore ? '1' : '0');
  if (notifyOnRoutine !== undefined) setSetting('notify_on_routine', notifyOnRoutine ? '1' : '0');
  return { ok: true };
}));
route('GET', '/api/notify-targets', parent(async () => ({ connected: !!HA_URL, targets: await listNotifyTargets() })));
route('POST', '/api/notify-test', parent(async (ctx) => {
  const targets = cleanTargets(ctx.body.targets || []); need(targets.length, 400, 'Pick at least one device');
  const results = await notify(targets, 'Chores', 'Test alert from the Chores add-on 👋');
  return { results };
}));

// --- children
route('GET', '/api/children', parent(() => q('SELECT * FROM children ORDER BY id').all().map(k => ({ ...k, notify_targets: JSON.parse(k.notify_targets || '[]') }))));
route('POST', '/api/children', parent((ctx) => {
  const { name, emoji, pin, haUser, notifyTargets } = ctx.body; need(name, 400, 'Name required');
  const r = q('INSERT INTO children(name,emoji,pin,ha_user,notify_targets) VALUES(?,?,?,?,?)').run(name, emoji || '⭐', pin || null, haUser || null, JSON.stringify(cleanTargets(notifyTargets || [])));
  return q('SELECT * FROM children WHERE id=?').get(r.lastInsertRowid);
}));
route('PUT', '/api/children/:id', parent((ctx) => {
  const { name, emoji, pin, haUser, notifyTargets } = ctx.body;
  q('UPDATE children SET name=COALESCE(?,name), emoji=COALESCE(?,emoji), pin=?, ha_user=?, notify_targets=? WHERE id=?')
    .run(name ?? null, emoji ?? null, pin || null, haUser || null, JSON.stringify(cleanTargets(notifyTargets || [])), ctx.params.id);
  return q('SELECT * FROM children WHERE id=?').get(ctx.params.id);
}));
route('DELETE', '/api/children/:id', parent((ctx) => {
  const id = ctx.params.id;
  for (const t of ['completions', 'payouts', 'bundles', 'chores']) q(`DELETE FROM ${t} WHERE child_id=?`).run(id);
  q('DELETE FROM children WHERE id=?').run(id);
  return { ok: true };
}));

// --- chores
route('GET', '/api/chores', parent((ctx) => ctx.query.childId
  ? q('SELECT * FROM chores WHERE child_id=? ORDER BY sort,id').all(ctx.query.childId)
  : q('SELECT * FROM chores ORDER BY child_id,sort,id').all()));
const choreFields = (b) => {
  need(b.name, 400, 'Name required');
  need(['daily', 'days', 'weekly', 'anytime'].includes(b.frequency), 400, 'Bad frequency');
  const days = b.frequency === 'days' ? (b.days || []).map(Number).filter(d => d >= 1 && d <= 7).join(',') : '';
  if (b.frequency === 'days') need(days, 400, 'Pick at least one day');
  const kind = b.kind === 'routine' ? 'routine' : 'chore';
  if (kind === 'routine') need(b.frequency !== 'anytime', 400, 'Routines need a schedule');
  const hhmm = (v) => /^\d{2}:\d{2}$/.test(v || '') ? v : '';
  const dueTime = hhmm(b.dueTime), remindTime = b.frequency === 'anytime' ? '' : hhmm(b.remindTime);
  return [b.name, b.emoji || '🧹', kind === 'routine' ? 0 : pence(b.value), b.frequency, days,
    b.needsApproval === false || (kind === 'routine' && b.needsApproval === undefined) ? 0 : 1, kind, dueTime,
    remindTime, b.alertParents && dueTime ? 1 : 0];
};
route('POST', '/api/chores', parent((ctx) => {
  const b = ctx.body; need(b.childId, 400, 'childId required');
  const r = q('INSERT INTO chores(child_id,name,emoji,value,frequency,days,needs_approval,kind,due_time,remind_time,alert_parents) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(b.childId, ...choreFields(b));
  return q('SELECT * FROM chores WHERE id=?').get(r.lastInsertRowid);
}));
route('PUT', '/api/chores/:id', parent((ctx) => {
  const b = ctx.body;
  q('UPDATE chores SET name=?,emoji=?,value=?,frequency=?,days=?,needs_approval=?,kind=?,due_time=?,remind_time=?,alert_parents=?, active=? WHERE id=?')
    .run(...choreFields(b), b.active === false ? 0 : 1, ctx.params.id);
  return q('SELECT * FROM chores WHERE id=?').get(ctx.params.id);
}));
route('DELETE', '/api/chores/:id', parent((ctx) => {
  // keep history: just deactivate; hard delete only if never completed
  const used = q('SELECT COUNT(*) n FROM completions WHERE chore_id=?').get(ctx.params.id).n;
  if (used) q('UPDATE chores SET active=0 WHERE id=?').run(ctx.params.id);
  else q('DELETE FROM chores WHERE id=?').run(ctx.params.id);
  return { ok: true, archived: !!used };
}));

// --- bundles (goals)
route('GET', '/api/bundles', parent(() => q('SELECT * FROM bundles ORDER BY child_id,id').all().map(b => ({ ...b, chore_ids: JSON.parse(b.chore_ids) }))));
const bundleFields = (b) => {
  need(b.name, 400, 'Name required');
  need(['week', 'month'].includes(b.period), 400, 'Bad period');
  need(Number(b.target) >= 1, 400, 'Target must be at least 1');
  return [b.name, b.period, Math.round(Number(b.target)), JSON.stringify((b.choreIds || []).map(Number)), pence(b.reward)];
};
route('POST', '/api/bundles', parent((ctx) => {
  const b = ctx.body; need(b.childId, 400, 'childId required');
  const start = b.startDate || periodOf(b.period, today());
  const r = q('INSERT INTO bundles(child_id,name,period,target,chore_ids,reward,start_date) VALUES(?,?,?,?,?,?,?)').run(b.childId, ...bundleFields(b), start);
  return q('SELECT * FROM bundles WHERE id=?').get(r.lastInsertRowid);
}));
route('PUT', '/api/bundles/:id', parent((ctx) => {
  const b = ctx.body;
  q('UPDATE bundles SET name=?,period=?,target=?,chore_ids=?,reward=?,active=? WHERE id=?').run(...bundleFields(b), b.active === false ? 0 : 1, ctx.params.id);
  return q('SELECT * FROM bundles WHERE id=?').get(ctx.params.id);
}));
route('DELETE', '/api/bundles/:id', parent((ctx) => { q('DELETE FROM bundles WHERE id=?').run(ctx.params.id); return { ok: true }; }));
route('GET', '/api/bundles/:id/history', parent((ctx) => {
  const b = q('SELECT * FROM bundles WHERE id=?').get(ctx.params.id); need(b, 404, 'Not found');
  return bundleEarnings(b, today()).periods;
}));

// --- dashboard & completions
route('GET', '/api/dashboard/:childId', (ctx) => {
  const id = Number(ctx.params.childId);
  need(ctx.me.role === 'parent' || (ctx.me.role === 'child' && ctx.me.childId === id), 403, 'Not your dashboard');
  const d = dashboard(id); need(d, 404, 'No such child'); return d;
});
route('POST', '/api/complete', (ctx) => {
  const chore = q('SELECT * FROM chores WHERE id=? AND active=1').get(ctx.body.choreId); need(chore, 404, 'No such chore');
  need(ctx.me.role === 'parent' || (ctx.me.role === 'child' && ctx.me.childId === chore.child_id), 403, 'Not your chore');
  const date = ctx.me.role === 'parent' && ctx.body.date ? ctx.body.date : today();
  const existing = q('SELECT * FROM completions WHERE chore_id=? AND date=?').get(chore.id, date);
  need(!existing || existing.status === 'rejected', 409, 'Already done today');
  if (existing) q('DELETE FROM completions WHERE id=?').run(existing.id);
  const status = (chore.needs_approval && ctx.me.role !== 'parent') ? 'pending' : 'approved';
  const r = q('INSERT INTO completions(chore_id,child_id,date,status,value) VALUES(?,?,?,?,?)').run(chore.id, chore.child_id, date, status, chore.value);
  if (ctx.me.role === 'child') alertParentsOfCompletion(chore, status); // fire and forget
  return q('SELECT * FROM completions WHERE id=?').get(r.lastInsertRowid);
});
route('DELETE', '/api/completions/:id', (ctx) => {
  const c = q('SELECT * FROM completions WHERE id=?').get(ctx.params.id); need(c, 404, 'Not found');
  const kind = q('SELECT kind FROM chores WHERE id=?').get(c.chore_id)?.kind;
  need(ctx.me.role === 'parent' || (ctx.me.childId === c.child_id && (c.status === 'pending' || kind === 'routine')), 403, 'Cannot undo');
  q('DELETE FROM completions WHERE id=?').run(c.id); return { ok: true };
});
route('GET', '/api/pending', parent(() => q(`SELECT c.*, ch.name chore_name, ch.emoji chore_emoji, k.name child_name
   FROM completions c JOIN chores ch ON ch.id=c.chore_id JOIN children k ON k.id=c.child_id
   WHERE c.status='pending' ORDER BY c.date DESC, c.id DESC`).all()));
route('POST', '/api/completions/:id/approve', parent((ctx) => { q("UPDATE completions SET status='approved' WHERE id=?").run(ctx.params.id); return { ok: true }; }));
route('POST', '/api/completions/:id/reject', parent((ctx) => { q("UPDATE completions SET status='rejected' WHERE id=?").run(ctx.params.id); return { ok: true }; }));

// --- payouts
route('POST', '/api/payouts', parent((ctx) => {
  const { childId, amount, note } = ctx.body; need(childId && pence(amount) > 0, 400, 'childId and amount required');
  q('INSERT INTO payouts(child_id,amount,note,date) VALUES(?,?,?,?)').run(childId, pence(amount), note || null, ctx.body.date || today());
  return balanceFor(childId);
}));
route('DELETE', '/api/payouts/:id', parent((ctx) => { q('DELETE FROM payouts WHERE id=?').run(ctx.params.id); return { ok: true }; }));

// ---------------------------------------------------------------- Home Assistant notifications
// Inside HA the Supervisor injects SUPERVISOR_TOKEN; HA_API_URL/SUPERVISOR_URL can be set for local testing.
const TOKEN = process.env.SUPERVISOR_TOKEN || process.env.HA_TOKEN || '';
const HA_URL = process.env.HA_API_URL || (TOKEN ? 'http://supervisor/core/api' : null);
const SUP_URL = process.env.SUPERVISOR_URL || 'http://supervisor';
let panelUrl = null; // e.g. /hassio/ingress/<slug>, so tapping a notification opens the app

const cleanTargets = (list) => [...new Set((list || []).map(String).filter(t => /^[a-z0-9_]+$/.test(t)))];

async function haFetch(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`${r.status} ${await r.text().catch(() => '')}`.trim());
  return r.json().catch(() => ({}));
}

async function listNotifyTargets() {
  if (!HA_URL) return [];
  try {
    const domains = await haFetch(`${HA_URL}/services`);
    const n = domains.find(d => d.domain === 'notify');
    return n ? Object.keys(n.services).filter(s => !['send_message', 'notify'].includes(s)).sort() : [];
  } catch (e) { console.error('notify list failed:', e.message); return []; }
}

async function notify(targets, title, message) {
  const results = {};
  if (!HA_URL) { console.log(`[notify:dry-run] ${targets.join(',')}: ${title} – ${message}`); return results; }
  await Promise.all(cleanTargets(targets).map(async (t) => {
    const data = panelUrl ? { url: panelUrl, clickAction: panelUrl } : undefined;
    try { await haFetch(`${HA_URL}/services/notify/${t}`, { method: 'POST', body: JSON.stringify({ title, message, ...(t === 'persistent_notification' ? {} : { data }) }) }); results[t] = 'ok'; }
    catch (e) { results[t] = e.message; console.error(`notify ${t} failed:`, e.message); }
  }));
  return results;
}

async function alertParentsOfCompletion(chore, status) {
  try {
    const routine = chore.kind === 'routine';
    if (routine ? getSetting('notify_on_routine') !== '1' : getSetting('notify_on_chore') === '0') return;
    const targets = parentTargets(); if (!targets.length) return;
    const kid = q('SELECT name FROM children WHERE id=?').get(chore.child_id);
    const msg = `${kid.name} has done ${chore.emoji} ${chore.name}` + (status === 'pending' ? ' – needs checking' : '');
    await notify(targets, routine ? 'Routine done' : 'Chore done', msg);
  } catch (e) { console.error('completion alert failed:', e.message); }
}

// Is this job due today and still not done?
function outstandingToday(c, t) {
  if (c.frequency === 'anytime' || !choreDueOn(c, t)) return false;
  const from = c.frequency === 'weekly' ? weekStart(t) : t;
  return !q("SELECT 1 FROM completions WHERE chore_id=? AND date BETWEEN ? AND ? AND status!='rejected'").get(c.id, from, t);
}

const GRACE_MIN = 30; // after a restart, don't fire reminders more than 30 minutes old
const minutes = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const markSent = (id, date, kind) => q('INSERT OR IGNORE INTO notifications_sent(chore_id,date,kind) VALUES(?,?,?)').run(id, date, kind).changes > 0;

async function reminderTick() {
  try {
    const d = new Date(), t = today(), nowMin = d.getHours() * 60 + d.getMinutes();
    const inWindow = (hhmm) => hhmm && nowMin >= minutes(hhmm) && nowMin - minutes(hhmm) <= GRACE_MIN;
    const jobs = q(`SELECT ch.*, k.name kid_name, k.notify_targets FROM chores ch JOIN children k ON k.id=ch.child_id
                    WHERE ch.active=1 AND (ch.remind_time!='' OR ch.due_time!='')`).all();
    for (const c of jobs) {
      const remindDue = inWindow(c.remind_time), deadline = inWindow(c.due_time);
      if (!remindDue && !deadline) continue;
      if (!outstandingToday(c, t)) continue;
      const kidTargets = JSON.parse(c.notify_targets || '[]');
      if (remindDue && markSent(c.id, t, 'remind') && kidTargets.length)
        await notify(kidTargets, `Reminder: ${c.name}`, `${c.emoji} Time to do ${c.name}` + (c.due_time ? ` (by ${c.due_time})` : ''));
      if (deadline && markSent(c.id, t, 'due')) {
        if (kidTargets.length) await notify(kidTargets, `${c.name} not done yet`, `${c.emoji} ${c.name} was due by ${c.due_time} – do it now!`);
        if (c.alert_parents && parentTargets().length) await notify(parentTargets(), 'Missed job', `${c.kid_name} hasn't done ${c.emoji} ${c.name} (due ${c.due_time})`);
      }
    }
    q('DELETE FROM notifications_sent WHERE date < ?').run(addDays(t, -7));
  } catch (e) { console.error('reminder tick failed:', e); }
}

async function initHa() {
  if (!TOKEN) return console.log('No SUPERVISOR_TOKEN – notifications run in dry-run mode');
  try { const info = await haFetch(`${SUP_URL}/addons/self/info`); panelUrl = `/hassio/ingress/${info.data.slug}`; }
  catch (e) { console.error('Could not read add-on info:', e.message); }
}
initHa();
setInterval(reminderTick, 30 * 1000);
setTimeout(reminderTick, 5000);

// ---------------------------------------------------------------- server
const INDEX = path.join(__dirname, 'public', 'index.html');
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (!p.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed' });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(fs.readFileSync(INDEX));
    }
    for (const r of routes) {
      const m = r.method === req.method && p.match(r.re);
      if (!m) continue;
      const ctx = { req, params: m.groups || {}, query: Object.fromEntries(url.searchParams), headers: {}, me: identify(req) };
      ctx.body = ['POST', 'PUT'].includes(req.method) ? await readBody(req) : {};
      const out = await r.handler(ctx);
      return send(res, 200, out, ctx.headers);
    }
    send(res, 404, { error: 'Not found' });
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.code, { error: e.message });
    console.error(e); send(res, 500, { error: 'Server error' });
  }
});
server.listen(PORT, () => console.log(`Chores listening on :${PORT}, data in ${DATA_DIR}`));
