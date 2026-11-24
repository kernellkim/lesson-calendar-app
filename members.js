/* Members: a stable id per person, so a rename never has to touch individual lessons.
   Pure functions over plain data d = { events, enrollments, members, colors, newId? } (mutated in place), so they can be tested in node.

   - members:      [{ id, name }]            the single place a person's name lives
   - events / enrollments carry memberId     title / name are a derived copy, rewritten from the member by applyNames()
   - colors (settings.colors) are keyed by household "동|호", or "m:<memberId>" when there is no 동/호 */
(function (root) {
  var clean = function (s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); };          // trim + collapse spaces
  var norm = function (s) { return clean(s).normalize('NFC').toLowerCase().replace(/\s+/g, ''); };       // for comparing names: case and all spacing ignored ("박 이안" = "박이안")
  var hhOf = function (enr) { return enr && enr.dong && enr.ho ? enr.dong + '|' + enr.ho : ''; };
  var rid = function (d) { return d.newId ? d.newId() : 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); };

  function byId(list) { var m = {}; list.forEach(function (x) { m[x.id] = x; }); return m; }

  /* Give every event / enrollment without a (valid) memberId a member. Idempotent: a second run changes nothing.
     Same name + same household = same member; same name in another household = another member;
     names differing only in case or spacing are the same person. Returns true when something changed. */
  function migrate(d) {
    d.members = Array.isArray(d.members) ? d.members.filter(function (m) { return m && typeof m.id === 'string' && clean(m.name); }) : [];
    d.colors = d.colors || {};
    var changed = false, members = byId(d.members), enrById = byId(d.enrollments), idsByKey = {};
    var key = function (name, hh) { return norm(name) + '#' + hh; };
    function remember(name, hh, id) { var k = key(name, hh); if (!idsByKey[k]) idsByKey[k] = id; }
    // reuse the ids already in use (a partly migrated or merged data set)
    d.enrollments.forEach(function (e) { if (e.memberId && members[e.memberId]) remember(members[e.memberId].name, hhOf(e), e.memberId); });
    d.events.forEach(function (e) {
      if (e.memberId && members[e.memberId]) remember(members[e.memberId].name, hhOf(enrById[e.enrollmentId]), e.memberId);
    });
    function resolve(name, hh) {
      var k = key(name, hh);
      if (idsByKey[k]) return idsByKey[k];
      var m = { id: rid(d), name: clean(name) };
      d.members.push(m); members[m.id] = m; idsByKey[k] = m.id; changed = true;
      return m.id;
    }
    var valid = function (e) { return e.memberId && members[e.memberId]; };
    // enrollments first (oldest month first, so the first spelling wins as the display name)
    d.enrollments.slice().sort(function (a, b) { return a.month < b.month ? -1 : a.month > b.month ? 1 : 0; }).forEach(function (e) {
      if (!valid(e) && clean(e.name)) { e.memberId = resolve(e.name, hhOf(e)); changed = true; }
    });
    d.events.forEach(function (e) {
      if (valid(e)) return;
      var enr = enrById[e.enrollmentId];
      if (enr) { e.memberId = resolve(e.title, hhOf(enr)); changed = true; return; }
      // not linked to a 신청서: the member of the same-named 신청서 in that month, when that is unambiguous
      var ids = {};
      d.enrollments.forEach(function (x) { if (x.month === e.date.slice(0, 7) && norm(x.name) === norm(e.title) && x.memberId) ids[x.memberId] = 1; });
      var keys = Object.keys(ids);
      if (keys.length !== 1) {   // no 신청서 that month: join the member of the same name when that is unambiguous (otherwise a duplicate person appears)
        var any = {};
        d.enrollments.forEach(function (x) { if (norm(x.name) === norm(e.title) && x.memberId) any[x.memberId] = 1; });
        var all = Object.keys(any);
        if (all.length === 1) keys = all;
      }
      e.memberId = keys.length === 1 ? keys[0] : resolve(e.title, '');
      changed = true;
    });
    // colors of members without 동/호 were keyed by "n:<name>"
    Object.keys(d.colors).forEach(function (k) {
      if (k.slice(0, 2) !== 'n:') return;
      var id = idsByKey[key(k.slice(2), '')];
      if (id && !(('m:' + id) in d.colors)) { d.colors['m:' + id] = d.colors[k]; delete d.colors[k]; changed = true; }
    });
    return changed;
  }

  /* title / name follow the member record. Returns true when a copy was out of date. */
  function applyNames(d) {
    var members = byId(d.members || []), n = 0;
    [d.events, d.enrollments].forEach(function (list, i) {
      var field = i === 0 ? 'title' : 'name';
      list.forEach(function (x) { var m = x.memberId && members[x.memberId]; if (m && x[field] !== m.name) { x[field] = m.name; n++; } });
    });
    return n > 0;
  }

  /* The member for a typed name, created when there is none (never a bare string).
     opts.anyHousehold: take a same-named member even from another household (lesson form); otherwise the household must match. */
  function ensure(d, name, hh, opts) {
    var nm = clean(name), cands = d.members.filter(function (m) { return norm(m.name) === norm(nm); });
    var enrById = byId(d.enrollments), hhs = function (m) {
      var set = {};
      d.enrollments.forEach(function (e) { if (e.memberId === m.id) set[hhOf(e)] = 1; });
      d.events.forEach(function (e) { if (e.memberId === m.id && enrById[e.enrollmentId]) set[hhOf(enrById[e.enrollmentId])] = 1; });
      return set;
    };
    var hit = cands.filter(function (m) { var s = hhs(m); return hh ? s[hh] : (s[''] || !Object.keys(s).length); })[0];
    // the same name typed for a lesson means the person who has a 신청서 (동/호): never a leftover duplicate without one
    var weight = function (m) { return d.enrollments.filter(function (e) { return e.memberId === m.id; }).length * 10000 + d.events.filter(function (e) { return e.memberId === m.id; }).length; };
    if (!hit && opts && opts.anyHousehold) hit = cands.sort(function (a, b) { return weight(b) - weight(a); })[0];
    if (!hit && hh && cands.length) hit = cands.filter(function (m) { return !Object.keys(hhs(m)).some(function (k) { return k; }); })[0];   // member without any 동/호 yet
    if (hit) return hit;
    hit = { id: rid(d), name: nm };
    d.members.push(hit);
    return hit;
  }

  /* Seal = the member's FIRST confirmation signature, printed once on the 신청서 next to 성명 (인). Fields on a member: seal (SVG path), sealAt (date, for "older wins").
     seal === '' means "cleared on purpose": the backfill leaves it alone. `valid` is the app's validSign. */
  function cleanMember(m, valid) {
    var o = { id: m.id, name: m.name };
    if (valid(m.seal)) { o.seal = m.seal; if (typeof m.sealAt === 'string') o.sealAt = m.sealAt; } else if (m.seal === '') o.seal = '';
    return o;
  }
  /* First sign only: stores `sign` as the member's seal when there is none yet. Returns true when stored. Never overwrites. */
  function captureSeal(m, sign, at, valid) {
    if (!m || valid(m.seal) || !valid(sign)) return false;
    m.seal = sign; m.sealAt = at; return true;
  }
  /* Members without a seal (never cleared) take the confirm signature of their earliest month. Idempotent. Returns how many were filled. */
  function backfillSeals(d, valid) {
    var n = 0;
    d.members.forEach(function (m) {
      if (m.seal !== undefined) return;
      var e = d.enrollments.filter(function (x) { return x.memberId === m.id && valid(x.confirm); }).sort(function (a, b) { return a.month < b.month ? -1 : a.month > b.month ? 1 : 0; })[0];
      if (e) { m.seal = e.confirm; m.sealAt = e.month; n++; }
    });
    return n;
  }

  function lessonCount(d, id) { return d.events.filter(function (e) { return e.memberId === id; }).length; }

  /* Rename. Returns { ok: true }, { ok: false, reason: 'empty' }, or { conflict: otherMember } when another member already has that name. */
  function rename(d, id, newName) {
    var nm = clean(newName), m = d.members.filter(function (x) { return x.id === id; })[0];
    if (!m) return { ok: false, reason: 'missing' };
    if (!nm) return { ok: false, reason: 'empty' };
    var other = d.members.filter(function (x) { return x.id !== id && norm(x.name) === norm(nm); })[0];
    if (other) return { conflict: other };
    m.name = nm;
    applyNames(d);
    return { ok: true };
  }

  /* Move everything of member `fromId` to `toId` (whose name and color stay), then drop `fromId`. Returns how many lessons moved. */
  function merge(d, fromId, toId) {
    var n = lessonCount(d, fromId);
    var from = d.members.filter(function (m) { return m.id === fromId; })[0], to = d.members.filter(function (m) { return m.id === toId; })[0];
    if (from && to && typeof from.seal === 'string' && from.seal && (!to.seal || (from.sealAt && (!to.sealAt || from.sealAt < to.sealAt)))) { to.seal = from.seal; to.sealAt = from.sealAt; }
    d.events.forEach(function (e) { if (e.memberId === fromId) e.memberId = toId; });
    d.enrollments.forEach(function (e) {
      if (e.memberId === fromId) e.memberId = toId;
      (e.plan || []).forEach(function (p) { if (p.memberId === fromId) p.memberId = toId; });
    });
    d.members = d.members.filter(function (m) { return m.id !== fromId; });
    delete d.colors['m:' + fromId];
    applyNames(d);
    return n;
  }

  /* The 신청서 a member is known from: their own, plus the ones their lessons sit on (a family member on a shared 신청서 has no own one). */
  function knownEnrollments(d, toId, moving) {
    var enrById = {}, seen = {}, list = [];
    d.enrollments.forEach(function (x) { enrById[x.id] = x; });
    function add(x) { if (x && !seen[x.id]) { seen[x.id] = true; list.push(x); } }
    d.enrollments.forEach(function (x) { if (x.memberId === toId) add(x); });
    d.events.forEach(function (x) { if (x.memberId === toId && !(moving && moving[x.id])) add(enrById[x.enrollmentId]); });
    return list;
  }

  /* Which 신청서 a moved lesson belongs to afterwards: the new member's own 신청서 of that month, else the 신청서 of that month of a household
     the member is already known from (a shared family 신청서), else none. A member with a 신청서 anywhere is never treated as new. */
  function enrollmentFor(d, e, toId, moving) {
    var month = e.date.slice(0, 7), cur = d.enrollments.filter(function (x) { return x.id === e.enrollmentId; })[0];
    var known = knownEnrollments(d, toId, moving), hhs = {};
    known.forEach(function (x) { if (hhOf(x)) hhs[hhOf(x)] = true; });
    var own = d.enrollments.filter(function (x) { return x.memberId === toId && x.month === month; });
    var pick = own.filter(function (x) { return cur && hhOf(x) === hhOf(cur); })[0] || own[0];
    if (pick) return pick.id;
    pick = known.filter(function (x) { return x.month === month; })[0] || d.enrollments.filter(function (x) { return x.month === month && hhs[hhOf(x)]; })[0];
    return pick ? pick.id : null;
  }

  /* Give the lessons `ids` to member `toId`: memberId + title, and the 신청서 link follows the member (sheets, color and counts derive from it).
     Returns { moved, enrollmentIds } where enrollmentIds are the 신청서 whose lessons changed (old and new). */
  function moveLessons(d, ids, toId) {
    var to = d.members.filter(function (m) { return m.id === toId; })[0], moving = {}, touched = {}, moved = 0;
    if (!to) return { moved: 0, enrollmentIds: [] };
    ids.forEach(function (id) { moving[id] = true; });
    d.events.forEach(function (e) {
      if (!moving[e.id]) return;
      if (e.enrollmentId) touched[e.enrollmentId] = true;
      var link = enrollmentFor(d, e, toId, moving);
      e.memberId = toId; e.title = to.name;
      if (link) { e.enrollmentId = link; touched[link] = true; } else delete e.enrollmentId;
      moved++;
    });
    return { moved: moved, enrollmentIds: Object.keys(touched) };
  }

  /* After moveLessons: every moved lesson that still has no 신청서 (the member has none that month) gets one, so sheets, color and
     copy-last-month work for that member. It copies 동/호, phone and time from the member's nearest other 신청서, or stays blank for a brand-new member
     (days, period and time are then filled from the lessons by the app's sync). Returns the created enrollments. */
  function ensureEnrollments(d, ids, toId) {
    var to = d.members.filter(function (m) { return m.id === toId; })[0], want = {}, made = [];
    if (!to) return made;
    ids.forEach(function (id) { want[id] = true; });
    d.events.forEach(function (e) {
      if (!want[e.id] || e.enrollmentId) return;
      var month = e.date.slice(0, 7), enr = made.filter(function (x) { return x.month === month; })[0];
      if (!enr) {
        var mine = knownEnrollments({ enrollments: d.enrollments.concat(made), events: d.events }, toId, null);
        var src = mine.filter(function (x) { return x.month <= month; }).sort(function (a, b) { return a.month < b.month ? 1 : -1; })[0] ||
          mine.sort(function (a, b) { return a.month < b.month ? -1 : 1; })[0];
        var y = +month.slice(0, 4), m = +month.slice(5), last = new Date(y, m, 0).getDate();
        enr = { id: d.newId ? d.newId() : 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7), memberId: toId, month: month, name: to.name,
          dong: src ? src.dong : 'X', ho: src ? src.ho : '000', phone: src ? src.phone : '', periodStart: month + '-01', periodEnd: month + '-' + (last < 10 ? '0' : '') + last,
          days: [], count: 0, start: src ? src.start : '10:00', end: src ? src.end : '10:50', fee: 0, appliedOn: '' };
        made.push(enr);
      }
      e.enrollmentId = enr.id;
    });
    made.forEach(function (x) { d.enrollments.push(x); });
    return made;
  }

  /* Leftover duplicates: a member named like an enrolled member but with no 신청서 of their own is the same person (lessons added before the 신청서,
     or lessons of a month without one). Old name-based matching treated them as one, so merge them into the enrolled member.
     Skipped when several enrolled members share the name (different households: ambiguous). Returns how many members were merged. */
  function dedupe(d) {
    var groups = {}, merged = 0;
    d.members.forEach(function (m) { (groups[norm(m.name)] = groups[norm(m.name)] || []).push(m); });
    Object.keys(groups).forEach(function (k) {
      var g = groups[k]; if (g.length < 2) return;
      var enrolled = g.filter(function (m) { return d.enrollments.some(function (e) { return e.memberId === m.id; }); });
      if (enrolled.length !== 1) return;
      g.forEach(function (m) { if (m !== enrolled[0] && !d.enrollments.some(function (e) { return e.memberId === m.id; })) { merge(d, m.id, enrolled[0].id); merged++; } });
    });
    return merged;
  }

  /* Household key from the 동 and 호 fields: "101동" = "101", "1203호" = "1203"; spaces, "-" and "/" ignored, case ignored.
     Missing 동 or 호 gives '' (never grouped). */
  function householdOf(dong, ho) {
    var f = function (v) { return String(v == null ? '' : v).normalize('NFC').toLowerCase().replace(/[\s\-\/.,]+/g, '').replace(/동|호/g, ''); };
    var a = f(dong), b = f(ho);
    return a && b ? a + '|' + b : '';
  }

  /* Ids of everyone known in a household (동/호): members with a 신청서 of it in any month, plus members whose lessons sit on such a 신청서. */
  function householdMemberIds(d, dong, ho) {
    var key = householdOf(dong, ho), inHh = {}, ids = {};
    if (!key) return [];
    d.enrollments.forEach(function (e) { if (householdOf(e.dong, e.ho) === key) { inHh[e.id] = true; if (e.memberId) ids[e.memberId] = true; } });
    d.events.forEach(function (e) { if (e.memberId && inHh[e.enrollmentId]) ids[e.memberId] = true; });
    return Object.keys(ids);
  }

  /* Names of the OTHER members of this 신청서's household (display only, computed from the current records, never stored):
     everyone with a 신청서 of that household in any month, plus members whose lessons sit on such a 신청서 (a shared family 신청서). */
  function familyNames(d, enr) {
    var key = householdOf(enr.dong, enr.ho);
    if (!key) return [];
    var inHh = {}, ids = {}, names = {};
    d.enrollments.forEach(function (e) { if (householdOf(e.dong, e.ho) === key) { inHh[e.id] = true; if (e.memberId) ids[e.memberId] = true; } });
    d.events.forEach(function (e) { if (e.memberId && inHh[e.enrollmentId]) ids[e.memberId] = true; });
    delete ids[enr.memberId];
    d.members.forEach(function (m) { if (ids[m.id] && norm(m.name) !== norm(enr.name)) names[m.name] = true; });
    return Object.keys(names).sort(function (a, b) { return a.localeCompare(b, 'ko'); });
  }

  /* The one weekday/time shown for a member: among `lessons` count each (weekday, start) pair and take the most frequent.
     Ties: the earlier weekday in the week (weekStart = first day, 0 Sunday / 1 Monday), then the earlier time.
     Returns { day, start, end } (end = the pair's most common end), or null without lessons. Pure: lessons need { date: "YYYY-MM-DD", start, end }. */
  /* ---- plan: one 신청서's weekly schedule, [{ day, start, end, memberId }]; one weekday may have several rows (family members at different times).
     Old data has only days/start/end/slots: planFromSlots reads that (every row belongs to the 신청서's own member).
     days/start/end/slots stay written alongside (legacyFields) so an older app still shows the right weekdays and times. */
  var TIME = /^\d{2}:\d{2}$/;
  var dayOf = function (date) { var p = date.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]).getDay(); };
  function sortPlan(pl) { return pl.slice().sort(function (a, b) { return a.day - b.day || (a.start < b.start ? -1 : a.start > b.start ? 1 : 0) || (a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0); }); }
  function cleanPlan(pl) {
    var out = (Array.isArray(pl) ? pl : []).filter(function (p) {
      return p && p.day >= 0 && p.day <= 6 && p.day === Math.floor(p.day) && TIME.test(p.start || '') && TIME.test(p.end || '') && typeof p.memberId === 'string' && p.memberId;
    }).map(function (p) { return { day: p.day, start: p.start, end: p.end, memberId: p.memberId }; });
    return out.length ? sortPlan(out) : null;
  }
  function planFromSlots(enr) {
    return (enr.days || []).map(function (day) {
      var t = (enr.slots && enr.slots[day]) || { start: enr.start, end: enr.end };
      return { day: day, start: t.start, end: t.end, memberId: enr.memberId || '' };
    });
  }
  // Pattern of a month's lessons: per (weekday, member) the time of the latest time group that happened at least twice. One-off lessons are not a pattern.
  function planFromLessons(lessons) {
    var g = {}, order = [], best = {};
    lessons.forEach(function (l) {
      if (!l.memberId || l.status === 'cancelled') return;
      var day = dayOf(l.date), k = day + '|' + l.memberId + '|' + l.start + '|' + l.end;
      if (!g[k]) { g[k] = { day: day, memberId: l.memberId, start: l.start, end: l.end, n: 0, last: '' }; order.push(k); }
      g[k].n++; if (l.date > g[k].last) g[k].last = l.date;
    });
    order.map(function (k) { return g[k]; }).filter(function (x) { return x.n >= 2; }).forEach(function (x) {
      var k = x.day + '|' + x.memberId, b = best[k];
      if (!b || x.last > b.last || (x.last === b.last && x.n > b.n)) best[k] = x;
    });
    return sortPlan(Object.keys(best).map(function (k) { var x = best[k]; return { day: x.day, start: x.start, end: x.end, memberId: x.memberId }; }));
  }
  /* The plan to store for an enrollment. No plan yet (first migration, or an older app stripped it): the lessons' pattern, plus the old slots
     for weekdays the lessons do not show. With a plan the plan is the owner's setting and is never rebuilt, added to or shortened from the lessons.
     The one exception: a row's time follows the calendar when ALL remaining scheduled lessons (today or later, in the 신청서's month, at least 2) of
     that (weekday, member) were moved to the same new time. One edited lesson (a makeup, a date change) never changes the plan. lessons = this 신청서's lessons. */
  function syncPlan(enr, lessons, today) {
    var cur = cleanPlan(enr.plan), key = function (p) { return p.day + '|' + p.memberId; };
    if (!cur) {
      var fresh = planFromLessons(lessons), covered = {};
      fresh.forEach(function (p) { covered[p.day] = 1; });
      return sortPlan(fresh.concat(planFromSlots(enr).filter(function (p) { return p.memberId && !covered[p.day]; })));
    }
    var plan = cur.map(function (p) { return Object.assign({}, p); }), cnt = {}, left = {};
    plan.forEach(function (p) { cnt[key(p)] = (cnt[key(p)] || 0) + 1; });
    lessons.forEach(function (l) {
      if (l.status !== 'scheduled' || l.date < today || l.date.slice(0, 7) !== enr.month || !l.memberId) return;
      var k = dayOf(l.date) + '|' + l.memberId;
      (left[k] = left[k] || []).push(l);
    });
    plan.forEach(function (p) {
      var ls = left[key(p)];
      if (cnt[key(p)] !== 1 || !ls || ls.length < 2) return;
      var t = ls[0];
      if (ls.every(function (l) { return l.start === t.start && l.end === t.end; })) { p.start = t.start; p.end = t.end; }
    });
    return sortPlan(plan);
  }
  /* Which future lessons a plan change may delete and regenerate: unsigned (scheduled), today or later, of this 신청서 and of the given members,
     made by the plan (same weekday, member and start as a row of the OLD plan) and never moved/added by hand (manual). Everything else is kept. */
  function regenSplit(events, enrId, memberIds, oldPlan, today) {
    var rows = {}, del = [], keep = [];
    oldPlan.forEach(function (p) { rows[p.day + '|' + p.memberId + '|' + p.start] = 1; });
    events.forEach(function (e) {
      if (e.enrollmentId !== enrId || e.status !== 'scheduled' || e.date < today || !memberIds[e.memberId]) return;
      (e.manual || !rows[dayOf(e.date) + '|' + e.memberId + '|' + e.start] ? keep : del).push(e);
    });
    return { del: del, keep: keep };
  }
  // days/start/end/slots (the pre-plan fields) for a plan: per weekday the 신청서's own member's row, else the earliest; start/end = the first weekday's time
  function legacyFields(plan, mainId) {
    if (!plan || !plan.length) return null;
    var pick = {};
    sortPlan(plan).forEach(function (p) { var c = pick[p.day]; if (!c || (p.memberId === mainId && c.memberId !== mainId)) pick[p.day] = p; });
    var days = Object.keys(pick).map(Number).sort(function (a, b) { return a - b; }), base = pick[days[0]], slots = {}, n = 0;
    days.forEach(function (d) { var p = pick[d]; if (p.start !== base.start || p.end !== base.end) { slots[d] = { start: p.start, end: p.end }; n++; } });
    return { days: days, start: base.start, end: base.end, slots: n ? slots : null };
  }

  function representative(lessons, weekStart) {
    var pairs = {}, order = [];
    lessons.forEach(function (l) {
      var p = l.date.split('-'), day = new Date(+p[0], +p[1] - 1, +p[2]).getDay(), k = day + '|' + l.start;
      if (!pairs[k]) { pairs[k] = { day: day, start: l.start, n: 0, ends: {} }; order.push(k); }
      pairs[k].n++; pairs[k].ends[l.end] = (pairs[k].ends[l.end] || 0) + 1;
    });
    if (!order.length) return null;
    var ws = weekStart || 0, pos = function (x) { return (x.day - ws + 7) % 7; };
    var best = order.map(function (k) { return pairs[k]; }).sort(function (a, b) { return b.n - a.n || pos(a) - pos(b) || (a.start < b.start ? -1 : a.start > b.start ? 1 : 0); })[0];
    var end = Object.keys(best.ends).sort(function (a, b) { return best.ends[b] - best.ends[a] || (a < b ? -1 : 1); })[0];
    return { day: best.day, start: best.start, end: end };
  }

  var api = { cleanMember: cleanMember, captureSeal: captureSeal, backfillSeals: backfillSeals, householdOf: householdOf, householdMemberIds: householdMemberIds, familyNames: familyNames, representative: representative, cleanPlan: cleanPlan, planFromSlots: planFromSlots, planFromLessons: planFromLessons, syncPlan: syncPlan, regenSplit: regenSplit, legacyFields: legacyFields, dedupe: dedupe, ensureEnrollments: ensureEnrollments, moveLessons: moveLessons, clean: clean, norm: norm, migrate: migrate, applyNames: applyNames, ensure: ensure, rename: rename, merge: merge, lessonCount: lessonCount };
  root.Members = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
