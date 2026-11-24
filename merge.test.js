// Run: node merge.test.js   (3-way merge of two devices + a fake cloud with the conditional update; no network, no real data)
const assert = require('assert');
const { merge } = require('./merge.js');
const B = require('./backup.js');

const clone = (x) => JSON.parse(JSON.stringify(x));
const ev = (id, date, start, extra) => Object.assign({ id, title: 'A', memberId: 'm1', enrollmentId: 'en1', date, start, end: addMin(start), memo: '', status: 'scheduled' }, extra);
const addMin = (s) => { const [h, m] = s.split(':').map(Number); return String(h + 1).padStart(2, '0') + ':' + String(m).padStart(2, '0'); };
const SIGN = 'M1 1L2 2';
const world = () => ({
  events: [ev('e1', '2026-11-20', '10:00'), ev('e2', '2026-11-21', '10:00'), ev('e3', '2026-11-22', '10:00')],
  enrollments: [{ id: 'en1', month: '2026-11', name: 'A', dong: 'A', ho: '101', phone: '', memberId: 'm1', days: [5], start: '10:00', end: '11:00', plan: [{ day: 5, start: '10:00', end: '11:00', memberId: 'm1' }] }],
  members: [{ id: 'm1', name: 'A' }],
  settings: { instructor: 'T', label: 'L', colors: { 'A101': 0 } }
});

/* ---- fake Supabase: one row, conditional update on updated_at ---- */
function makeCloud() { return { row: null, n: 0 }; }
function tick(cloud) { return new Date(Date.UTC(2026, 10, 24, 0, 0, ++cloud.n)).toISOString(); }
// a device = { data, lastAt, base: {at,data}|null, dirty }; sync() follows the app: conditional write, else pull + merge (3 tries), conflicts answered by `choose`
function device(cloud, data) { return { data: clone(data), lastAt: '', base: null, dirty: false, asked: [] }; }
function sync(d, cloud, choose, mergeFirst) {   // mergeFirst = resolveLater: no direct write while clashes are pending
  for (let tries = 0; tries < 4; tries++) {
    if (!cloud.row || (cloud.row.at === d.lastAt && !(mergeFirst && tries === 0))) {                       // conditional PATCH succeeds
      const at = tick(cloud); cloud.row = { at, data: clone(d.data) };
      d.base = { at, data: clone(d.data) }; d.lastAt = at; d.dirty = false; return 'pushed';
    }
    const base = B.baseFor(d.base, d.lastAt);
    if (!base) return 'fallback-dialog';
    const r = merge(base, d.data, cloud.row.data);
    if (r.conflicts.length) {
      if (!choose) { d.asked = r.conflicts; return 'ask'; }
      r.conflicts.forEach((c, i) => c.set(choose(c, i)));
    }
    d.base = { at: cloud.row.at, data: clone(cloud.row.data) }; d.lastAt = cloud.row.at;   // 'clean' with the cloud copy, then mine on top
    d.data = r.data; d.dirty = true;
  }
  return 'gave-up';
}
const find = (d, id) => d.data.events.find((e) => e.id === id);

function twoDevices() {
  const cloud = makeCloud(), phone = device(cloud, world()), ipad = device(cloud, world());
  sync(phone, cloud);                 // phone pushes first; the iPad pulls that same copy (equal) and takes it as base
  ipad.data = clone(cloud.row.data); ipad.base = clone({ at: cloud.row.at, data: cloud.row.data }); ipad.lastAt = cloud.row.at;
  return { cloud, phone, ipad };
}

// 1. 11/20 case: iPad signs 3, the stale phone adds events, both sync -> signs and new events survive, no dialog
{
  const { cloud, phone, ipad } = twoDevices();
  ['e1', 'e2', 'e3'].forEach((id) => Object.assign(find(ipad, id), { status: 'done', sign: SIGN }));
  sync(ipad, cloud);
  phone.data.events.push(ev('n1', '2026-11-27', '10:00', { manual: true }), ev('n2', '2026-11-28', '10:00')); phone.dirty = true;
  assert.equal(sync(phone, cloud), 'pushed');
  ['e1', 'e2', 'e3'].forEach((id) => assert.equal(find(phone, id).sign, SIGN));
  assert.equal(phone.data.events.length, 5);
  assert.deepEqual(cloud.row.data.events.map((e) => e.id).sort(), ['e1', 'e2', 'e3', 'n1', 'n2']);
  assert.equal(cloud.row.data.events.filter((e) => e.sign).length, 3);
  sync(ipad, cloud); assert.equal(ipad.data.events.length, 5);          // and the iPad gets the new events
  console.log('OK 1 signs + new events both survive');
}
// 2. same event: iPad signs, phone moves its time -> both survive
{
  const { cloud, phone, ipad } = twoDevices();
  Object.assign(find(ipad, 'e1'), { status: 'done', sign: SIGN }); sync(ipad, cloud);
  Object.assign(find(phone, 'e1'), { start: '14:00', end: '15:00', manual: true }); phone.dirty = true;
  assert.equal(sync(phone, cloud), 'pushed');
  const e = cloud.row.data.events.find((x) => x.id === 'e1');
  assert.equal(e.sign, SIGN); assert.equal(e.status, 'done'); assert.equal(e.start, '14:00'); assert.equal(e.manual, true);
  console.log('OK 2 sign + time move on the same event');
}
// 3. phone deletes an event the iPad signed -> ask; the default keeps the signed one
{
  const { cloud, phone, ipad } = twoDevices();
  Object.assign(find(ipad, 'e2'), { status: 'done', sign: SIGN }); sync(ipad, cloud);
  phone.data.events = phone.data.events.filter((e) => e.id !== 'e2'); phone.dirty = true;
  assert.equal(sync(phone, cloud), 'ask');
  assert.equal(phone.asked.length, 1); assert.equal(phone.asked[0].def, 'theirs'); assert.equal(phone.asked[0].mine, '삭제함');
  assert.equal(sync(phone, cloud, (c) => c.def), 'pushed'); assert(find(phone, 'e2').sign);   // default: the sign stays
  const t = twoDevices(); Object.assign(find(t.ipad, 'e2'), { status: 'done', sign: SIGN }); sync(t.ipad, t.cloud);
  t.phone.data.events = t.phone.data.events.filter((e) => e.id !== 'e2');
  sync(t.phone, t.cloud, () => 'mine'); assert(!find(t.phone, 'e2'), 'choosing the delete removes it');
  console.log('OK 3 delete vs signed asks');
}
// 4. both edit the same field -> ask; different fields of the same item merge
{
  const { cloud, phone, ipad } = twoDevices();
  find(ipad, 'e1').memo = 'ipad'; find(ipad, 'e1').start = '09:00'; sync(ipad, cloud);
  find(phone, 'e1').memo = 'phone'; find(phone, 'e1').end = '12:00'; phone.dirty = true;
  assert.equal(sync(phone, cloud), 'ask');
  assert.deepEqual(phone.asked.map((c) => c.field), ['메모']);        // only the memo clashes
  sync(phone, cloud, () => 'theirs');
  const e = find(phone, 'e1'); assert.equal(e.memo, 'ipad'); assert.equal(e.start, '09:00'); assert.equal(e.end, '12:00');
  console.log('OK 4 same field asks, other fields merge');
}
// 5. deleted on one side, untouched on the other -> stays deleted (both directions)
{
  const { cloud, phone, ipad } = twoDevices();
  phone.data.events = phone.data.events.filter((e) => e.id !== 'e3'); phone.dirty = true; sync(phone, cloud);
  find(ipad, 'e1').memo = 'x'; ipad.dirty = true;
  assert.equal(sync(ipad, cloud), 'pushed'); assert(!find(ipad, 'e3')); assert(!cloud.row.data.events.some((e) => e.id === 'e3'));
  assert(cloud.row.data.events.find((e) => e.id === 'e1').memo === 'x');
  console.log('OK 5 delete stays deleted');
}
// 6. a cloud-side edit (like the SQL restore) = only theirs changed
{
  const { cloud, phone } = twoDevices();
  const restored = clone(cloud.row.data); Object.assign(restored.events.find((e) => e.id === 'e1'), { status: 'done', sign: SIGN }); restored.events.push(ev('r1', '2026-11-29', '10:00'));
  cloud.row = { at: tick(cloud), data: restored };                    // written directly, not by a device
  phone.data.events.find((e) => e.id === 'e2').memo = 'm'; phone.dirty = true;
  assert.equal(sync(phone, cloud), 'pushed');
  assert.equal(find(phone, 'e1').sign, SIGN); assert(find(phone, 'r1')); assert.equal(find(phone, 'e2').memo, 'm');
  console.log('OK 6 cloud-side edit merges');
}
// status/sign/noshow differ on both sides: ask, default = the side with a sign
{
  const { cloud, phone, ipad } = twoDevices();
  Object.assign(find(ipad, 'e1'), { status: 'done', sign: SIGN }); sync(ipad, cloud);
  Object.assign(find(phone, 'e1'), { status: 'done', noshow: true }); phone.dirty = true;
  assert.equal(sync(phone, cloud), 'ask');
  const c = phone.asked[0]; assert.equal(c.def, 'theirs'); assert.equal(c.mine, '노쇼'); assert.equal(c.theirs, '사인 완료');
  sync(phone, cloud, (x) => x.def); const e = find(phone, 'e1'); assert.equal(e.sign, SIGN); assert(!e.noshow);
  console.log('OK sign vs noshow asks, sign is the default');
}
// an explicit clear wins over a stale copy of the sign
{
  const { cloud, phone, ipad } = twoDevices();
  Object.assign(find(ipad, 'e1'), { status: 'done', sign: SIGN }); sync(ipad, cloud); sync(phone, cloud);
  const e = find(ipad, 'e1'); e.status = 'scheduled'; delete e.sign; ipad.dirty = true; sync(ipad, cloud);   // cleared on purpose
  find(phone, 'e2').memo = 'q'; phone.dirty = true; sync(phone, cloud);
  assert(!find(phone, 'e1').sign && find(phone, 'e1').status === 'scheduled');
  console.log('OK explicit clear wins');
}
// monthly confirm and member seal are never lost; a cleared seal ('') wins
{
  const base = world(), mine = clone(base), theirs = clone(base);
  theirs.enrollments[0].confirm = SIGN; theirs.enrollments[0].confirmCount = 3; theirs.members[0].seal = SIGN; theirs.members[0].sealAt = 'x';
  mine.enrollments[0].phone = '010';                                   // stale device edits something else
  let r = merge(base, mine, theirs).data;
  assert.equal(r.enrollments[0].confirm, SIGN); assert.equal(r.enrollments[0].phone, '010'); assert.equal(r.members[0].seal, SIGN);
  const cleared = clone(theirs); cleared.members[0].seal = ''; delete cleared.members[0].sealAt;
  r = merge(theirs, theirs, cleared).data; assert.equal(r.members[0].seal, '');
  console.log('OK confirm / seal');
}
// plan lines merge per line; a manual lesson is never dropped by a plan edit on the other side
{
  const base = world(), mine = clone(base), theirs = clone(base);
  mine.enrollments[0].plan.push({ day: 1, start: '09:00', end: '10:00', memberId: 'm1' });
  theirs.enrollments[0].plan.push({ day: 3, start: '09:00', end: '10:00', memberId: 'm1' });
  let r = merge(base, mine, theirs);
  assert.equal(r.conflicts.length, 0); assert.equal(r.data.enrollments[0].plan.length, 3);
  theirs.enrollments[0].plan = [{ day: 5, start: '15:00', end: '16:00', memberId: 'm1' }]; mine.enrollments[0].plan = [{ day: 5, start: '12:00', end: '13:00', memberId: 'm1' }];
  r = merge(base, mine, theirs); assert.equal(r.conflicts.length, 1); assert.equal(r.conflicts[0].field, '요일·시간표');
  const m2 = clone(base), t2 = clone(base);
  Object.assign(m2.events[0], { manual: true, date: '2026-11-25' });                // phone moved a lesson by hand
  t2.events = t2.events.filter((e) => e.id !== 'e2'); t2.events.push(ev('g1', '2026-12-04', '10:00'));   // iPad regenerated other lessons
  r = merge(base, m2, t2).data;
  assert(r.events.find((e) => e.id === 'e1' && e.manual && e.date === '2026-11-25')); assert(r.events.find((e) => e.id === 'g1')); assert(!r.events.find((e) => e.id === 'e2'));
  console.log('OK plan lines + manual');
}
// the same new lesson created on both devices becomes one (the signed one wins)
{
  const base = world(), mine = clone(base), theirs = clone(base);
  mine.events.push(ev('x1', '2026-12-01', '10:00')); theirs.events.push(ev('y1', '2026-12-01', '10:00', { status: 'done', sign: SIGN }));
  const r = merge(base, mine, theirs).data.events.filter((e) => e.date === '2026-12-01');
  assert.equal(r.length, 1); assert.equal(r[0].id, 'y1');
  console.log('OK duplicate lesson');
}
// deleted 신청서 vs the other side adding lessons to it: ask; deleted vs only derived changes: stays deleted
{
  const base = world(), mine = clone(base), theirs = clone(base);
  mine.enrollments = []; theirs.events.push(ev('z1', '2026-11-30', '10:00'));
  assert.equal(merge(base, mine, theirs).conflicts.length, 1);
  const t3 = clone(base); t3.enrollments[0].days = [1]; t3.enrollments[0].count = 9;
  const r = merge(base, mine, t3); assert.equal(r.conflicts.length, 0); assert.equal(r.data.enrollments.length, 0);
  console.log('OK enrollment delete');
}
// a STALE base never deletes data: items missing from the base are kept; a base item that neither side changed is not restored; a stale `at` is not trusted
{
  const stale = world(); stale.events = [stale.events[0]];                               // base knows only e1
  const mine = world(), theirs = world();                                                 // both sides still have e1..e3
  const r = merge(stale, mine, theirs).data;
  assert.equal(r.events.length, 3, 'nothing disappears because the base is old');
  assert.equal(B.baseFor({ at: '2026-11-24T00:00:01.000Z', data: stale }, '2026-11-24T00:00:09.000Z'), null);
  assert.equal(B.baseFor({ at: '2026-11-24T00:00:09.000Z', data: stale }, '2026-11-24T00:00:09.000Z'), stale);
  assert.equal(B.baseFor(null, 'x'), null); assert.equal(B.baseFor({ at: 'a', data: {} }, ''), null);
  console.log('OK stale base');
}
// bootstrap right after the deploy: only a synced, not dirty device whose lastBackupAt is the cloud's updated_at
{
  const at = '2026-11-24T00:00:00.000Z';
  assert(B.canBootstrap(false, false, at, at)); assert(!B.canBootstrap(false, true, at, at)); assert(!B.canBootstrap(true, false, at, at));
  assert(!B.canBootstrap(false, false, at, '2026-11-23T00:00:00.000Z')); assert(!B.canBootstrap(false, false, at, ''));
  const fs = require('fs'), src = fs.readFileSync(__dirname + '/index.html', 'utf8');
  assert(/<script src="merge\.js">/.test(src) && /'\.\/merge\.js'/.test(fs.readFileSync(__dirname + '/sw.js', 'utf8')), 'merge.js is loaded and cached');
  // every place where local and cloud become equal must hand the data to syn, or the base would go stale
  const oks = src.match(/syn\('(ok|clean)'[^;]*;/g) || [];
  assert(oks.length >= 3 && oks.every((x) => /,\s*(undefined|null),\s*\w+(\.data)?\)/.test(x) || x.indexOf('row.data') > 0 || /\bb\)/.test(x)), 'syn ok/clean always passes the data: ' + oks.join(' | '));
  console.log('OK bootstrap');
}
// "나중에": the clash stays pending, everything else keeps uploading, new signs after it reach the cloud, the choice is applied when it is finally made
{
  // same as pendingPush in index.html: this device keeps its own choice, the upload takes the cloud's value for every clash, the base stays the old ancestor
  const partial = (d, cloud) => {
    const base = B.baseFor(d.base, d.lastAt), keep = merge(base, d.data, cloud.row.data), up = merge(base, d.data, cloud.row.data);
    keep.conflicts.forEach((c) => c.set('mine')); up.conflicts.forEach((c) => c.set('theirs'));
    if (!keep.conflicts.length) return 0;
    if (cloud.row.at !== d.lastAt) d.data = keep.data;
    const at = tick(cloud); cloud.row = { at, data: clone(up.data) }; d.base = { at, data: base }; d.lastAt = at; d.dirty = true;
    return keep.conflicts.length;
  };
  const { cloud, phone, ipad } = twoDevices();
  find(ipad, 'e1').memo = 'ipad'; Object.assign(find(ipad, 'e3'), { status: 'done', sign: SIGN }); sync(ipad, cloud);
  find(phone, 'e1').memo = 'phone'; phone.dirty = true;
  assert.equal(sync(phone, cloud), 'ask');                                   // clash on e1's memo; the user picks 나중에
  assert.equal(partial(phone, cloud), 1);
  const ce = (id) => cloud.row.data.events.find((e) => e.id === id);
  assert.equal(ce('e1').memo, 'ipad', 'the clash keeps the cloud value in the upload');
  assert.equal(find(phone, 'e1').memo, 'phone', 'this device keeps its own choice');
  assert.equal(ce('e3').sign, SIGN); assert.equal(find(phone, 'e3').sign, SIGN);   // the iPad's non-clashing change reached the phone
  // a sign made AFTER 나중에 still uploads, and the clash is still there
  Object.assign(find(phone, 'e2'), { status: 'done', sign: SIGN });
  assert.equal(partial(phone, cloud), 1);
  assert.equal(ce('e2').sign, SIGN, 'new sign uploaded'); assert.equal(ce('e1').memo, 'ipad'); assert.equal(find(phone, 'e1').memo, 'phone');
  // the other device keeps working meanwhile
  find(ipad, 'e2').memo = 'z'; ipad.dirty = true; assert.equal(sync(ipad, cloud), 'pushed');
  assert.equal(partial(phone, cloud), 1); assert.equal(find(phone, 'e2').memo, 'z'); assert.equal(ce('e2').sign, SIGN);
  // finally decided: this device's choice wins and reaches the cloud
  assert.equal(sync(phone, cloud, null, true), 'ask'); assert.equal(phone.asked.length, 1);
  assert.equal(sync(phone, cloud, () => 'mine', true), 'pushed'); assert.equal(ce('e1').memo, 'phone'); assert.equal(ce('e2').sign, SIGN);
  // a pending delete-vs-edit: the cloud keeps the edited item, this device keeps its delete until decided
  const t = twoDevices(); Object.assign(find(t.ipad, 'e1'), { status: 'done', sign: SIGN }); sync(t.ipad, t.cloud);
  t.phone.data.events = t.phone.data.events.filter((e) => e.id !== 'e1'); t.phone.dirty = true; sync(t.phone, t.cloud);
  assert.equal(partial(t.phone, t.cloud), 1); assert(t.cloud.row.data.events.some((e) => e.id === 'e1' && e.sign)); assert(!find(t.phone, 'e1'));
  console.log('OK later: partial uploads');
}
console.log('all merge tests passed');
