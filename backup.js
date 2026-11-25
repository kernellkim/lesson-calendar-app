/* Cloud backup logic as pure functions (no DOM, no network), so it can be tested in node.
   - state:  { loggedIn, dirty, phase: 'idle'|'saving'|'error'|'offline', seq, savingSeq, lastBackupAt (ISO), error }
   - status: 'local-only' | 'dirty' | 'saving' | 'saved' | 'error' | 'offline'  (derived, never stored)
   - guard:  what to do on launch with the cloud copy: 'push' | 'pull' | 'ask' | 'none'
   - verify: compares a pushed row read back from the cloud with what was sent */
(function (root) {
  function init(o) {
    o = o || {};
    return { loggedIn: !!o.loggedIn, dirty: !!o.dirty, phase: 'idle', seq: 0, savingSeq: 0, lastBackupAt: o.lastBackupAt || '', error: '' };
  }
  // events: login, logout, edit, start, ok(at), fail(msg, offline), clean(at)  -- returns a new state
  function next(st, ev, arg, arg2) {
    var s = Object.assign({}, st);
    if (ev === 'login') { s.loggedIn = true; s.phase = 'idle'; s.error = ''; }
    else if (ev === 'logout') { s.loggedIn = false; s.phase = 'idle'; s.error = ''; }
    else if (ev === 'edit') { s.dirty = true; s.seq = st.seq + 1; }
    else if (ev === 'start') { s.phase = 'saving'; s.savingSeq = st.seq; }
    // an edit made while the push was running keeps the state dirty
    else if (ev === 'ok') { s.phase = 'idle'; s.error = ''; s.lastBackupAt = arg; if (st.savingSeq === st.seq) s.dirty = false; }
    else if (ev === 'fail') { s.phase = arg2 ? 'offline' : 'error'; s.error = arg || ''; }
    // local data was just replaced by the cloud copy (or confirmed equal): nothing unbacked
    else if (ev === 'clean') { s.phase = 'idle'; s.error = ''; s.dirty = false; s.lastBackupAt = arg; }
    // a push was refused because the cloud has a newer copy: nothing was written, local data is still unbacked
    else if (ev === 'conflict') { s.phase = 'idle'; s.error = ''; }
    return s;
  }
  function status(st) {
    if (!st.loggedIn) return 'local-only';
    if (st.phase === 'saving') return 'saving';
    if (st.phase === 'error') return 'error';
    if (st.phase === 'offline') return 'offline';
    return st.dirty ? 'dirty' : 'saved';
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function when(iso, now) {
    var d = new Date(iso), n = now || new Date();
    if (!iso || isNaN(d)) return '';
    var day = function (x) { return new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime(); };
    var diff = Math.round((day(n) - day(d)) / 86400000);
    var hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
    return (diff === 0 ? '오늘' : diff === 1 ? '어제' : (d.getMonth() + 1) + '/' + d.getDate()) + ' ' + hm;
  }
  function text(st, now) {
    var w = when(st.lastBackupAt, now);
    switch (status(st)) {
      case 'local-only': return '로그인하면 클라우드에 백업돼요';
      case 'saving': return '백업 중…';
      case 'error': return '백업 실패 · 탭하면 다시 시도';
      case 'offline': return '오프라인 · 연결되면 다시 백업해요';
      case 'dirty': return '백업 대기 중 (변경 있음)';
      default: return w ? '클라우드에 백업됨 · ' + w : '클라우드에 백업됨';
    }
  }
  var ms = function (iso) { return iso ? new Date(iso).getTime() : 0; };
  // Launch guard. c = { cloudAt (null = no cloud row), lastBackupAt, dirty (unbacked edits from before this launch), pendingAt (a push that may have landed before the app was closed) }
  function guard(c) {
    if (!c.cloudAt) return 'push';
    // our own push landed but the app closed before it was confirmed: not a foreign copy
    var cloudNewer = ms(c.cloudAt) > ms(c.lastBackupAt) && !(c.pendingAt && ms(c.pendingAt) === ms(c.cloudAt));
    if (cloudNewer) return c.dirty ? 'ask' : 'pull';
    return c.dirty ? 'push' : 'none';
  }
  // Push guard: true when the cloud row is neither the one this device last synced (lastBackupAt) nor its own unconfirmed push (pendingAt)
  function foreign(cloudAt, lastBackupAt, pendingAt) {
    if (!cloudAt) return false;
    return ms(cloudAt) !== ms(lastBackupAt) && !(pendingAt && ms(pendingAt) === ms(cloudAt));
  }
  // sent = { at, events, enrollments } (what we pushed); row = the row read back. Returns null when equal, else a message
  function verify(sent, row) {
    if (!row) return '클라우드에서 백업을 찾지 못했어요';
    if (ms(row.updated_at) !== ms(sent.at)) return '클라우드 백업 시각이 맞지 않아요';
    var d = row.data || {};
    var ev = (d.events || []).length, en = (d.enrollments || []).length;
    if (ev !== sent.events || en !== sent.enrollments) return '클라우드 개수가 달라요 (수업 ' + ev + '/' + sent.events + ', 신청서 ' + en + '/' + sent.enrollments + ')';
    return null;
  }
  // true when the app has been dirty for over 24h (dirtySince = ISO of the first unbacked edit)
  function stale(dirtySince, now) { return !!dirtySince && ((now || Date.now()) - ms(dirtySince)) > 86400000; }
  // trainer signature in settings: take a valid incoming one, else keep the current valid one, else ''. `valid` is the app's validSign.
  function pickSeal(incoming, current, valid) { return valid(incoming) ? incoming : valid(current) ? current : ''; }
  /* The merge base = the cloud data this device last agreed on. It is stored as { at, data } and is only trusted while `at` is exactly
     this device's lastBackupAt, so a crash between writing the two (or any other mismatch) can never leave a stale base in use: it is ignored and the old dialog runs. */
  function baseFor(stored, lastBackupAt) {
    return stored && stored.data && stored.at && lastBackupAt && ms(stored.at) === ms(lastBackupAt) ? stored.data : null;
  }
  // No base yet (right after this feature shipped): this device is fully synced when it has no unbacked edits and its last sync is the cloud's current copy
  function canBootstrap(hasBase, dirty, cloudAt, lastBackupAt) {
    return !hasBase && !dirty && !!cloudAt && !!lastBackupAt && ms(cloudAt) === ms(lastBackupAt);
  }
  /* Single-flight token refresh. o = { read() -> session|null, write(json) saves the new session, call(refreshToken) -> json, now() }.
     Parallel callers share one request; the new tokens are written before anyone is handed the access token.
     "already used" -> re-read the stored session once (another window/call may have saved it); if still unusable, throw an error with .expired = true and never retry. */
  var USED = /already used|invalid refresh token|refresh_token_not_found/i, EXPIRED = '로그인이 만료됐어요 · 다시 로그인';
  function refresher(o) {
    var inflight = null, now = o.now || Date.now;
    function dead(e) { var x = new Error(EXPIRED); x.expired = true; x.cause = e; return x; }
    async function run(s) {
      try { o.write(await o.call(s.refresh)); }
      catch (e) {
        if (!USED.test(e.message)) throw e;
        var s2 = o.read();
        if (!s2 || s2.refresh === s.refresh) throw dead(e);
        if (now() <= s2.exp) return s2.access;
        try { o.write(await o.call(s2.refresh)); } catch (e2) { throw USED.test(e2.message) ? dead(e2) : e2; }
      }
      var n = o.read(); return n && n.access;
    }
    return async function get() {
      var s = o.read(); if (!s) return null;
      if (now() <= s.exp) return s.access;
      if (!inflight) inflight = run(s).finally(function () { inflight = null; });
      return inflight;
    };
  }
  var api = { refresher: refresher, EXPIRED: EXPIRED, baseFor: baseFor, canBootstrap: canBootstrap, pickSeal: pickSeal, init: init, next: next, status: status, text: text, guard: guard, foreign: foreign, verify: verify, stale: stale, when: when };
  root.Backup = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
