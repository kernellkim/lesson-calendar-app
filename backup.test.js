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
