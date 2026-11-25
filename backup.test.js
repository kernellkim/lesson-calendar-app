// Run: node backup.test.js   (sync state machine, launch overwrite guard, read-back verify)
const assert = require('assert');
const B = require('./backup.js');
const S = (st) => B.status(st);

// not logged in
let s = B.init({});
assert.equal(S(s), 'local-only');
assert.match(B.text(s), /로그인/);
s = B.next(s, 'edit'); assert.equal(S(s), 'local-only');

// login -> edit -> push -> saved
s = B.next(B.init({ lastBackupAt: '2026-10-29T23:20:00.000Z' }), 'login');
assert.equal(S(s), 'saved');
s = B.next(s, 'edit'); assert.equal(S(s), 'dirty');
s = B.next(s, 'start'); assert.equal(S(s), 'saving'); assert.equal(B.text(s), '백업 중…');
s = B.next(s, 'ok', '2026-10-30T08:57:00'); assert.equal(S(s), 'saved');
assert.equal(B.text(s, new Date('2026-10-30T12:00:00')), '클라우드에 백업됨 · 오늘 08:57');
assert.equal(B.when('2026-10-29T18:20:00', new Date('2026-10-30T09:00:00')), '어제 18:20');

// edit during a push stays dirty
s = B.next(B.next(B.init({ loggedIn: true }), 'edit'), 'start');
s = B.next(s, 'edit');
s = B.next(s, 'ok', '2026-10-30T09:00:00');
assert.equal(S(s), 'dirty');

// failure keeps dirty data and shows the error; offline is separate; a retry that works clears it
s = B.next(B.next(B.next(B.init({ loggedIn: true }), 'edit'), 'start'), 'fail', 'boom', false);
assert.equal(S(s), 'error'); assert.equal(s.error, 'boom'); assert.equal(s.dirty, true);
s = B.next(s, 'start'); s = B.next(s, 'fail', 'x', true); assert.equal(S(s), 'offline');
s = B.next(s, 'start'); s = B.next(s, 'ok', '2026-10-30T09:05:00'); assert.equal(S(s), 'saved');

// logout
assert.equal(S(B.next(s, 'logout')), 'local-only');
// adopting the cloud copy clears dirty
s = B.next(B.next(B.init({ loggedIn: true }), 'edit'), 'clean', '2026-10-30T10:00:00');
assert.equal(S(s), 'saved');
// state is not mutated in place
const a = B.init({ loggedIn: true }); B.next(a, 'edit'); assert.equal(a.dirty, false);

// launch guard
const T1 = '2026-10-29T10:00:00.000Z', T2 = '2026-10-30T10:00:00.000Z';
assert.equal(B.guard({ cloudAt: null, lastBackupAt: '', dirty: false }), 'push');
assert.equal(B.guard({ cloudAt: T1, lastBackupAt: T1, dirty: false }), 'none');
assert.equal(B.guard({ cloudAt: T1, lastBackupAt: T1, dirty: true }), 'push');
assert.equal(B.guard({ cloudAt: T2, lastBackupAt: T1, dirty: false }), 'pull');
assert.equal(B.guard({ cloudAt: T2, lastBackupAt: T1, dirty: true }), 'ask');            // never silently overwrite
assert.equal(B.guard({ cloudAt: T2, lastBackupAt: T1, dirty: true, pendingAt: T2 }), 'push'); // it was our own push
assert.equal(B.guard({ cloudAt: '2026-10-30T10:00:00+00:00', lastBackupAt: T1, dirty: true, pendingAt: T2 }), 'push'); // same instant, other format

// push guard: only our own known cloud row may be overwritten
assert.equal(B.foreign(null, '', ''), false);                       // no cloud row yet: first insert
assert.equal(B.foreign(T1, T1, ''), false);                         // cloud is what we last synced
assert.equal(B.foreign('2026-10-29T10:00:00+00:00', T1, ''), false); // same instant, other format
assert.equal(B.foreign(T2, T1, ''), true);                          // another device pushed since
assert.equal(B.foreign(T2, '', ''), true);                          // never synced, but the cloud has data
assert.equal(B.foreign(T2, T1, T2), false);                         // our own push landed, app closed before confirming
assert.equal(B.foreign(T2, T1, T1), true);
s = B.next(B.next(B.next(B.init({ loggedIn: true }), 'edit'), 'start'), 'conflict');
assert.equal(S(s), 'dirty'); assert.equal(s.dirty, true);           // refused push keeps the edits unbacked

// read-back verify
const sent = { at: T2, events: 2, enrollments: 1 };
const row = { updated_at: '2026-10-30T10:00:00+00:00', data: { events: [{}, {}], enrollments: [{}] } };
assert.equal(B.verify(sent, row), null);
assert.match(B.verify(sent, null), /찾지/);
assert.match(B.verify(sent, Object.assign({}, row, { updated_at: T1 })), /시각/);
assert.match(B.verify(sent, { updated_at: T2, data: { events: [{}], enrollments: [{}] } }), /개수/);

// 24h reminder
const now = Date.parse('2026-10-30T12:00:00Z');
assert.equal(B.stale('2026-10-29T11:00:00Z', now), true);
assert.equal(B.stale('2026-10-30T01:00:00Z', now), false);
assert.equal(B.stale('', now), false);
console.log('OK backup');

// ---- trainer seal in settings (persists through reload, cloud restore, backup import) ----
{
  const assert = require('assert'), fs = require('fs');
  const B = require('./backup.js');
  const valid = (v) => typeof v === 'string' && v.length < 20000 && /^[ML0-9. -]+$/.test(v);
  assert.strictEqual(B.pickSeal('M1 1L2 2', '', valid), 'M1 1L2 2');          // reload / import / adopt with a seal
  assert.strictEqual(B.pickSeal(undefined, 'M3 3L4 4', valid), 'M3 3L4 4');   // old backup or cloud copy without one keeps this device's
  assert.strictEqual(B.pickSeal('<script>', 'M3 3L4 4', valid), 'M3 3L4 4');  // invalid never lands
  assert.strictEqual(B.pickSeal('', '', valid), '');
  // the three places that copy settings field by field must all use it
  const src = fs.readFileSync(__dirname + '/index.html', 'utf8');
  assert.strictEqual((src.match(/Backup\.pickSeal\(/g) || []).length, 3, 'initStore, adopt and import must each call pickSeal');
  assert(/function blob\(\)[^\n]*settings: state\.settings/.test(src) && /exportedAt[^\n]*settings: state\.settings/.test(src), 'blob and export carry settings as a whole');
  console.log('OK trainer seal');
}

// refresher: parallel calls share ONE request; tokens saved before anyone gets them; "already used" never loops
(async () => {
  const mk = (call, store) => {
    const o = { sess: store || { access: 'a0', refresh: 'r0', exp: 0 }, calls: 0 };
    o.get = B.refresher({ read: () => o.sess, write: (j) => { o.sess = { access: j.access, refresh: j.refresh, exp: Date.now() + 1e6 }; }, call: (r) => { o.calls++; return call(r, o); } });
    return o;
  };
  // 1) five parallel callers -> one request, all get the new token, stored before they resume
  let a = mk(async (r) => { await new Promise((x) => setTimeout(x, 10)); return { access: 'a1', refresh: 'r1' }; });
  const got = await Promise.all([1, 2, 3, 4, 5].map(() => a.get()));
  assert.deepEqual(got, ['a1', 'a1', 'a1', 'a1', 'a1']); assert.equal(a.calls, 1); assert.equal(a.sess.refresh, 'r1');
  assert.equal(await a.get(), 'a1'); assert.equal(a.calls, 1);   // still valid: no new request
  // 2) already used, but another window saved a fresh session meanwhile -> use it, no loop
  let b = mk(async (r, o) => { o.sess = { access: 'a9', refresh: 'r9', exp: Date.now() + 1e6 }; throw new Error('Invalid Refresh Token: Already Used'); });
  assert.equal(await b.get(), 'a9'); assert.equal(b.calls, 1);
  // 3) already used and nothing new stored -> expired, exactly one request, repeated calls each try once (caller drops the session)
  let c = mk(async () => { throw new Error('Invalid Refresh Token: Already Used'); });
  await assert.rejects(Promise.all([c.get(), c.get(), c.get()]), (e) => e.expired === true && e.message === B.EXPIRED);
  assert.equal(c.calls, 1);
  // 4) a network error is not "expired"
  let d = mk(async () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(d.get(), (e) => !e.expired);
  console.log('refresher ok');
})().catch((e) => { console.error(e); process.exit(1); });
