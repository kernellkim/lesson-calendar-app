/* Three-way merge of two devices' data (pure functions, no DOM, no network; tested by `node merge.test.js`).
   merge(base, mine, theirs): base = the data both devices last agreed on, mine = this device, theirs = the cloud copy.
   Each is { events, enrollments, members, settings }.
   Per item (by id) and per field group: only one side changed -> that change wins; both changed the same way -> fine;
   both changed differently -> a conflict. An item missing on one side that was in base = deleted there;
   deleted on one side and edited on the other = conflict (the edited version is the default, never silently dropped).
   No new data fields: a deletion is recognised by comparing with base, so nothing is stored in the items themselves.
   Returns { data, conflicts }. data already holds every conflict's DEFAULT; conflict.set('mine' | 'theirs') switches one. */
(function (root) {
  var WD = ['일', '월', '화', '수', '목', '금', '토'];
  var J = function (v) { return JSON.stringify(v === undefined ? null : v); };   // missing and null are the same
  var SIGNISH = ['sign', 'seal', 'confirm', 'trainerSeal'];
  var LABEL = { date: '날짜', start: '시작 시간', end: '종료 시간', memo: '메모', memberId: '회원', enrollmentId: '신청서', manual: '직접 추가', name: '이름',
    dong: '동', ho: '호', phone: '전화번호', appliedOn: '신청일', instructor: '담당자', label: '구분', plan: '요일·시간표', title: '이름' };
  var GROUP_LABEL = { status: '상태·사인', confirm: '월 확인 사인', seal: '신청서 사인', trainerSeal: '담당자 사인' };
  var EVENT_GROUPS = [['status', 'sign', 'noshow']];
  var ENR_GROUPS = [['confirm', 'confirmCount', 'confirmFee']];
  var MEMBER_GROUPS = [['seal', 'sealAt']];
  // recomputed from the lessons after every merge (syncAllEnrollments), so they never conflict
  var ENR_DERIVED = ['days', 'start', 'end', 'slots', 'periodStart', 'periodEnd', 'count', 'fee'];

  function byId(list) { var m = {}; (list || []).forEach(function (x) { m[x.id] = x; }); return m; }
  function keysOf() { var o = {}, out = []; Array.prototype.forEach.call(arguments, function (x) { Object.keys(x || {}).forEach(function (k) { if (!o[k]) { o[k] = 1; out.push(k); } }); }); return out; }
  function without(o, skip) { var r = {}; Object.keys(o).forEach(function (k) { if (skip.indexOf(k) < 0) r[k] = o[k]; }); return r; }
  // a derived copy (the name is rewritten from the member record): never asks, the changed side wins
  function quiet(b, m, t) { return { value: J(m) === J(b) ? t : m }; }

  function fmt(k, v) {
    if (v === undefined || v === null || v === '') return '(없음)';
    if (SIGNISH.indexOf(k) >= 0) return '사인 있음';
    if (typeof v === 'object') return '(바뀜)';
    return String(v);
  }
  function describe(g, x) {
    if (g.indexOf('status') >= 0) {
      if (x.status === 'done') return x.noshow ? '노쇼' : x.sign ? '사인 완료' : '완료';
      return x.status === 'cancelled' ? '취소' : '예정';
    }
    return g.filter(function (k) { return k !== 'sealAt' && k !== 'confirmCount' && k !== 'confirmFee'; }).map(function (k) { return fmt(k, x[k]); }).join(' · ');
  }
  function groupLabel(g) { return GROUP_LABEL[g[0]] || LABEL[g[0]] || g[0]; }
  function hasSig(g, x) { return g.some(function (k) { return SIGNISH.indexOf(k) >= 0 && x[k]; }); }

  /* one item, field group by field group. b may be {} (both sides created the same id). */
  function mergeItem(b, m, t, o, conflicts, kind, id, label) {
    var out = {}, grouped = {};
    var groups = (o.groups || []).slice();
    groups.forEach(function (g) { g.forEach(function (k) { grouped[k] = 1; }); });
    keysOf(b, m, t).forEach(function (k) {
      if (grouped[k] || (o.derived || []).indexOf(k) >= 0 || (o.custom && o.custom[k])) return;
      groups.push([k]);
    });
    function put(g, src) { g.forEach(function (k) { if (src[k] === undefined) delete out[k]; else out[k] = src[k]; }); }
    groups.forEach(function (g) {
      var pick = function (x) { return J(g.map(function (k) { return x[k]; })); };
      var sb = pick(b), sm = pick(m), st = pick(t);
      if (sm === st || st === sb) return put(g, m);
      if (sm === sb) return put(g, t);
      var def = hasSig(g, m) || !hasSig(g, t) ? 'mine' : 'theirs';   // a side that has a signature wins by default
      put(g, def === 'mine' ? m : t);
      conflicts.push({ kind: kind, id: id, label: label, field: groupLabel(g), mine: describe(g, m), theirs: describe(g, t), def: def,
        set: function (side) { put(g, side === 'mine' ? m : t); } });
    });
    (o.derived || []).forEach(function (k) { var v = J(m[k]) === J(b[k]) ? t[k] : m[k]; if (v === undefined) delete out[k]; else out[k] = v; });
    Object.keys(o.custom || {}).forEach(function (k) {
      var r = o.custom[k](b[k], m[k], t[k]);
      if (r.value === undefined) delete out[k]; else out[k] = r.value;
      if (r.conflict) conflicts.push({ kind: kind, id: id, label: label, field: LABEL[k] || k, mine: r.mine, theirs: r.theirs, def: 'mine',
        set: function (side) { var v = side === 'mine' ? m[k] : t[k]; if (v === undefined) delete out[k]; else out[k] = v; } });
    });
    return out;
  }

  /* a list of items with ids. o.sig(item) = what counts as "edited" for delete-vs-edit; o.label(item); o.blockDelete(id, deleter) = true when a delete must be asked about anyway */
  function mergeColl(kind, b, m, t, o, conflicts) {
    var B = byId(b), M = byId(m), T = byId(t), out = [], ids = [];
    (m || []).forEach(function (x) { ids.push(x.id); });
    (t || []).forEach(function (x) { if (!M[x.id]) ids.push(x.id); });
    ids.forEach(function (id) {
      var bb = B[id], mm = M[id], tt = T[id];
      if (!bb) { out.push(mm && tt ? mergeItem({}, mm, tt, o, conflicts, kind, id, o.label(mm)) : mm || tt); return; }
      if (mm && tt) { out.push(mergeItem(bb, mm, tt, o, conflicts, kind, id, o.label(mm))); return; }
      var alive = mm || tt, deleter = mm ? 'theirs' : 'mine';
      if (o.sig(alive) === o.sig(bb) && !(o.blockDelete && o.blockDelete(id, deleter))) return;   // deleted on one side, untouched on the other: stays deleted
      out.push(alive);
      conflicts.push({ kind: kind, id: id, label: o.label(alive), field: '삭제 / 수정', mine: mm ? '수정함' : '삭제함', theirs: tt ? '수정함' : '삭제함', def: mm ? 'mine' : 'theirs',
        set: function (side) {
          var i = out.indexOf(alive);
          if (side === deleter) { if (i >= 0) out.splice(i, 1); } else if (i < 0) out.push(alive);
        } });
    });
    return out;
  }

  /* weekly plan lines [{ day, start, end, memberId }]: merged line by line (key = weekday + member + start) */
  function planText(p) { return p && p.length ? p.map(function (l) { return WD[l.day] + ' ' + l.start + '-' + l.end; }).join(', ') : '(없음)'; }
  function mergePlan(bp, mp, tp) {
    if (J(mp) === J(tp) || J(tp) === J(bp)) return { value: mp };
    if (J(mp) === J(bp)) return { value: tp };
    var key = function (l) { return l.day + '|' + l.memberId + '|' + l.start; };
    var idx = function (p) { var o = {}; (p || []).forEach(function (l) { o[key(l)] = l; }); return o; };
    var B = idx(bp), M = idx(mp), T = idx(tp), out = [], bad = false;
    keysOf(M, T).forEach(function (k) {
      var b = B[k], m = M[k], t = T[k];
      if (m && t) { if (m.end === t.end || (b && t.end === b.end)) out.push(m); else if (b && m.end === b.end) out.push(t); else { bad = true; out.push(m); } }
      else {
        var only = m || t;
        if (!b) out.push(only);                  // added on one side
        else if (only.end === b.end) { /* deleted on the other side, untouched here: gone */ }
        else { bad = true; out.push(only); }     // edited here, deleted there
      }
    });
    var dm = function (l) { return l.day + '|' + l.memberId; };   // both sides moved the same row somewhere else
    keysOf(M, T).forEach(function (k1) {
      if (B[k1] || !M[k1] || T[k1]) return;
      keysOf(T).forEach(function (k2) {
        if (B[k2] || M[k2] || dm(T[k2]) !== dm(M[k1])) return;
        if (keysOf(B).some(function (kb) { return dm(B[kb]) === dm(M[k1]) && !M[kb] && !T[kb]; })) bad = true;
      });
    });
    if (bad) return { value: mp, conflict: true, mine: planText(mp), theirs: planText(tp) };
    return { value: out.length ? out : undefined };
  }
  function mergeColors(bc, mc, tc) {
    var out = {}, b = bc || {}, m = mc || {}, t = tc || {};
    keysOf(b, m, t).forEach(function (k) {
      var v = J(m[k]) === J(t[k]) || J(m[k]) === J(b[k]) ? t[k] : J(t[k]) === J(b[k]) ? m[k] : t[k];   // colors are cosmetic: a real clash takes the cloud's
      if (v !== undefined) out[k] = v;
    });
    return Object.keys(out).length || mc || tc ? out : undefined;
  }

  function merge(base, mine, theirs) {
    var conflicts = [];
    base = base || {}; mine = mine || {}; theirs = theirs || {};
    var newIn = function (side, bs) { var B = byId(bs); return (side || []).filter(function (e) { return !B[e.id]; }); };
    var newMine = newIn(mine.events, base.events), newTheirs = newIn(theirs.events, base.events);

    var events = mergeColl('event', base.events, mine.events, theirs.events, {
      groups: EVENT_GROUPS, custom: { title: quiet },
      sig: function (e) { return J(without(e, ['title'])); },
      label: function (e) { return (e.title || '') + ' ' + e.date + ' ' + e.start; }
    }, conflicts);

    var enrollments = mergeColl('enrollment', base.enrollments, mine.enrollments, theirs.enrollments, {
      groups: ENR_GROUPS, derived: ENR_DERIVED, custom: { plan: mergePlan, name: quiet },
      sig: function (e) { return J(without(e, ENR_DERIVED)); },
      label: function (e) { return (e.name || '') + ' ' + e.month + ' 신청서'; },
      // one device deleted the 신청서 while the other added new lessons to it: ask
      blockDelete: function (id, deleter) { return (deleter === 'mine' ? newTheirs : newMine).some(function (e) { return e.enrollmentId === id; }); }
    }, conflicts);

    var members = mergeColl('member', base.members, mine.members, theirs.members, {
      groups: MEMBER_GROUPS,
      sig: J,
      label: function (m) { return m.name; }
    }, conflicts);

    var bs = base.settings || {}, ms = mine.settings || {}, ts = theirs.settings || {};
    var settings = mergeItem(bs, ms, ts, { custom: { colors: function (b, m, t) { return { value: mergeColors(b, m, t) }; } } }, conflicts, 'settings', 'settings', '설정');

    // both devices made the same new lesson (the same plan change applied on each): keep one, preferring the signed one
    var idsMine = {}, idsTheirs = {};
    newMine.forEach(function (e) { idsMine[e.id] = 1; }); newTheirs.forEach(function (e) { idsTheirs[e.id] = 1; });
    var seen = {}, drop = {};
    var kk = function (e) { return [e.memberId || e.title, e.date, e.start, e.enrollmentId || ''].join('|'); };
    events.forEach(function (e) { if (idsMine[e.id]) seen[kk(e)] = e; });
    events.forEach(function (e) {
      var a = idsTheirs[e.id] && seen[kk(e)];
      if (!a || a.id === e.id) return;
      var aDone = a.status === 'done', eDone = e.status === 'done';
      if (aDone && eDone) return;
      drop[eDone ? a.id : e.id] = 1;
    });
    for (var i = events.length - 1; i >= 0; i--) if (drop[events[i].id]) events.splice(i, 1);   // in place: a conflict's set() keeps working on this same array

    return { data: { events: events, enrollments: enrollments, members: members, settings: settings }, conflicts: conflicts };
  }

  var api = { merge: merge };
  root.Merge = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
