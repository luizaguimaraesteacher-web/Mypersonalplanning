/* My Daily Planner — all data lives in localStorage (use Export/Import for backups). */
(() => {
  'use strict';

  const STORAGE_KEY = 'daily-planner-v1';
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const esc = (s = '') => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const pad = n => String(n).padStart(2, '0');
  const toISO = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const fromISO = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (iso, n) => { const d = fromISO(iso); d.setDate(d.getDate() + n); return toISO(d); };
  const fmtLong = iso => fromISO(iso).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  const fmtShort = iso => fromISO(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  const TYPE_LABEL = { lesson: 'Lesson', study: 'Study', other: 'Event' };

  // ---------- State ----------
  const empty = () => ({ events: [], students: [], plans: [], dayNotes: {} });
  let db = load();
  let currentDate = toISO(new Date());
  let selectedStudentId = null;
  let selectedPlanId = null;

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return { ...empty(), ...JSON.parse(raw) };
    } catch (e) { console.warn('Could not load saved data', e); }
    return empty();
  }
  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(db)); }
    catch (e) { alert('Could not save — your browser storage may be full or disabled.'); }
  }

  const byId = (list, id) => list.find(x => x.id === id);
  const sortKey = e => `${e.date}T${e.start || '99:99'}`;
  const studentName = id => byId(db.students, id)?.name || 'Unknown student';
  const planTitle = id => byId(db.plans, id)?.title || 'Study';

  function eventTitle(e) {
    if (e.title) return e.title;
    if (e.type === 'lesson') return `Lesson with ${studentName(e.studentId)}`;
    if (e.type === 'study') return e.planId ? planTitle(e.planId) : 'Study session';
    return 'Event';
  }

  /** The most recent lesson for a student before the given date/time (excluding one event id). */
  function lastLessonFor(studentId, date, start, excludeId) {
    const key = `${date}T${start || '99:99'}`;
    return db.events
      .filter(e => e.type === 'lesson' && e.studentId === studentId && e.id !== excludeId && sortKey(e) < key)
      .sort((a, b) => sortKey(b).localeCompare(sortKey(a)))[0] || null;
  }

  // ---------- Tabs ----------
  $$('.tab').forEach(btn => btn.addEventListener('click', () => showView(btn.dataset.view)));
  function showView(name) {
    $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === name));
    $$('.view').forEach(v => v.classList.toggle('active', v.id === `view-${name}`));
    render();
  }

  // ---------- Day view ----------
  $('#prevDay').onclick = () => { currentDate = addDays(currentDate, -1); renderDay(); };
  $('#nextDay').onclick = () => { currentDate = addDays(currentDate, 1); renderDay(); };
  $('#todayBtn').onclick = () => { currentDate = toISO(new Date()); renderDay(); };
  $('#datePicker').onchange = e => { if (e.target.value) { currentDate = e.target.value; renderDay(); } };
  $$('[data-new]').forEach(b => b.onclick = () => openEvent(null, { type: b.dataset.new }));
  $('#dayNotes').addEventListener('input', e => {
    const v = e.target.value;
    if (v.trim()) db.dayNotes[currentDate] = v; else delete db.dayNotes[currentDate];
    save();
  });

  function renderDay() {
    $('#dayLabel').textContent = fmtLong(currentDate);
    $('#datePicker').value = currentDate;
    $('#dayNotes').value = db.dayNotes[currentDate] || '';

    const events = db.events.filter(e => e.date === currentDate).sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
    const list = $('#eventList');
    if (!events.length) {
      list.innerHTML = `<li class="empty">Nothing planned for this day yet. Add a lesson, a study session or another event.</li>`;
    } else {
      list.innerHTML = events.map(e => {
        const time = e.start ? `${e.start}${e.end ? '<br>' + e.end : ''}` : 'Any time';
        let meta = '';
        if (e.type === 'lesson') {
          meta = [e.objectives && `🎯 ${e.objectives}`, e.homework && `📝 Homework: ${e.homework}`].filter(Boolean).join('\n');
        } else if (e.type === 'study') {
          const plan = byId(db.plans, e.planId);
          const topics = (e.topicIds || []).map(id => plan?.topics.find(t => t.id === id)?.text).filter(Boolean);
          meta = [topics.length && `📚 ${topics.join(', ')}`, e.goal && `🎯 ${e.goal}`].filter(Boolean).join('\n');
        }
        return `<li class="event ${e.type} ${e.done ? 'done' : ''}" data-id="${e.id}">
          <div class="ev-time">${time}</div>
          <div>
            <div><span class="ev-tag">${TYPE_LABEL[e.type]}</span><span class="ev-title">${esc(eventTitle(e))}</span></div>
            ${meta ? `<div class="ev-meta">${esc(meta)}</div>` : ''}
            ${e.notes ? `<div class="ev-notes">${esc(e.notes)}</div>` : ''}
          </div>
          <input type="checkbox" class="ev-check" title="Mark as completed" ${e.done ? 'checked' : ''} />
        </li>`;
      }).join('');
    }
    $$('.event', list).forEach(li => {
      const ev = byId(db.events, li.dataset.id);
      li.onclick = () => openEvent(ev);
      $('.ev-check', li).onclick = evt => { evt.stopPropagation(); ev.done = evt.target.checked; save(); renderDay(); };
    });

    renderSide();
  }

  function renderSide() {
    $('#sideStudy').innerHTML = db.plans.length
      ? db.plans.map(p => {
          const done = p.topics.filter(t => t.done).length, total = p.topics.length;
          const pct = total ? Math.round(done / total * 100) : 0;
          return `<div class="prog-label"><span>${esc(p.title)}</span><span class="muted">${done}/${total}</span></div>
                  <div class="progress"><span style="width:${pct}%"></span></div>`;
        }).join('')
      : `<p class="muted">No study plans yet.</p>`;

    const today = toISO(new Date());
    const upcoming = db.events
      .filter(e => e.type === 'lesson' && e.date >= today && !e.done)
      .sort((a, b) => sortKey(a).localeCompare(sortKey(b))).slice(0, 6);
    $('#sideUpcoming').innerHTML = upcoming.length
      ? upcoming.map(e => `<li><span>${esc(studentName(e.studentId))}</span><span class="when">${fmtShort(e.date)}${e.start ? ' · ' + e.start : ''}</span></li>`).join('')
      : `<li class="muted">No upcoming lessons.</li>`;
  }

  // ---------- Event dialog ----------
  const evDialog = $('#eventDialog');
  const evForm = $('#eventForm');
  let editingEventId = null;

  function fillSelect(sel, items, placeholder, selected) {
    sel.innerHTML = `<option value="">${placeholder}</option>` +
      items.map(i => `<option value="${i.id}" ${i.id === selected ? 'selected' : ''}>${esc(i.label)}</option>`).join('');
  }

  function openEvent(ev, defaults = {}) {
    editingEventId = ev?.id || null;
    const e = ev || { type: 'other', date: currentDate, ...defaults };
    $('#eventDialogTitle').textContent = ev ? 'Edit event' : 'New event';
    $('#deleteEventBtn').hidden = !ev;

    const f = evForm.elements;
    f.type.value = e.type;
    f.date.value = e.date;
    f.start.value = e.start || '';
    f.end.value = e.end || '';
    f.title.value = e.title || '';
    f.notes.value = e.notes || '';
    f.done.checked = !!e.done;
    ['review', 'objectives', 'activities', 'materials', 'homework', 'nextSteps', 'goal'].forEach(k => f[k].value = e[k] || '');

    fillSelect(f.studentId, db.students.map(s => ({ id: s.id, label: s.name })), db.students.length ? '— choose a student —' : 'Add students in the Students tab', e.studentId);
    fillSelect(f.planId, db.plans.map(p => ({ id: p.id, label: p.title })), db.plans.length ? '— choose a plan —' : 'Add plans in the Study Plans tab', e.planId);
    renderPlanTopics(e.topicIds || []);
    toggleTypeFields();
    renderLastClass();
    evDialog.showModal();
  }

  function toggleTypeFields() {
    const type = evForm.elements.type.value;
    $$('fieldset[data-for]', evForm).forEach(fs => fs.hidden = fs.dataset.for !== type);
  }

  function renderLastClass() {
    const f = evForm.elements;
    const box = $('#lastClassBox');
    if (!f.studentId.value) { box.innerHTML = ''; return; }
    const last = lastLessonFor(f.studentId.value, f.date.value || currentDate, f.start.value, editingEventId);
    if (!last) { box.innerHTML = `<h4>First class with ${esc(studentName(f.studentId.value))}</h4><span class="muted">No previous lessons recorded.</span>`; return; }
    const rows = [['Objectives', last.objectives], ['Activities', last.activities], ['Homework', last.homework], ['Next steps', last.nextSteps], ['Notes', last.notes]]
      .filter(([, v]) => v).map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('');
    box.innerHTML = `<h4>Last class · ${fmtLong(last.date)}</h4>
      ${rows ? `<dl>${rows}</dl>` : '<p class="muted">No details were recorded for the last class.</p>'}
      <button type="button" class="btn primary small" id="useLastBtn">Build this lesson from last class</button>`;
    $('#useLastBtn').onclick = () => {
      const review = [last.homework && `Check homework: ${last.homework}`, last.objectives && `Quick review of: ${last.objectives}`].filter(Boolean).join('\n');
      if (review && !f.review.value.trim()) f.review.value = review;
      if (last.nextSteps && !f.objectives.value.trim()) f.objectives.value = last.nextSteps;
      if (last.materials && !f.materials.value.trim()) f.materials.value = last.materials;
      if (!f.start.value && last.start) f.start.value = last.start;
      if (!f.end.value && last.end) f.end.value = last.end;
      f.activities.focus();
    };
  }

  function renderPlanTopics(selectedIds) {
    const plan = byId(db.plans, evForm.elements.planId.value);
    const box = $('#planTopicsBox');
    if (!plan || !plan.topics.length) { box.innerHTML = ''; return; }
    box.innerHTML = `<label>Topics for this session</label><ul class="topics">` +
      plan.topics.map(t => `<li class="${t.done ? 'done' : ''}"><label><input type="checkbox" value="${t.id}" ${selectedIds.includes(t.id) ? 'checked' : ''}/><span>${esc(t.text)}</span></label></li>`).join('') +
      `</ul>`;
  }

  evForm.elements.type.onchange = toggleTypeFields;
  evForm.elements.studentId.onchange = renderLastClass;
  evForm.elements.date.onchange = renderLastClass;
  evForm.elements.start.onchange = renderLastClass;
  evForm.elements.planId.onchange = () => renderPlanTopics([]);

  evForm.onsubmit = evt => {
    evt.preventDefault();
    const f = evForm.elements;
    if (f.type.value === 'lesson' && !f.studentId.value) { alert('Please choose a student for this lesson.'); return; }
    const data = {
      type: f.type.value, date: f.date.value, start: f.start.value, end: f.end.value,
      title: f.title.value.trim(), notes: f.notes.value.trim(), done: f.done.checked,
    };
    if (data.type === 'lesson') {
      Object.assign(data, { studentId: f.studentId.value });
      ['review', 'objectives', 'activities', 'materials', 'homework', 'nextSteps'].forEach(k => data[k] = f[k].value.trim());
    } else if (data.type === 'study') {
      data.planId = f.planId.value;
      data.topicIds = $$('#planTopicsBox input:checked').map(i => i.value);
      data.goal = f.goal.value.trim();
      // Completing a study session marks its topics as covered.
      const plan = byId(db.plans, data.planId);
      if (plan && data.done) plan.topics.forEach(t => { if (data.topicIds.includes(t.id)) t.done = true; });
    }
    if (editingEventId) {
      const i = db.events.findIndex(e => e.id === editingEventId);
      db.events[i] = { id: editingEventId, ...data };
    } else {
      db.events.push({ id: uid(), ...data });
    }
    save();
    evDialog.close();
    render();
  };

  $('#deleteEventBtn').onclick = () => {
    if (!confirm('Delete this event?')) return;
    db.events = db.events.filter(e => e.id !== editingEventId);
    save(); evDialog.close(); render();
  };

  $$('[data-close]').forEach(b => b.onclick = () => b.closest('dialog').close());

  // ---------- Students ----------
  const stDialog = $('#studentDialog');
  const stForm = $('#studentForm');
  let editingStudentId = null;

  $('#newStudentBtn').onclick = () => openStudent(null);
  function openStudent(s) {
    editingStudentId = s?.id || null;
    $('#deleteStudentBtn').hidden = !s;
    ['name', 'level', 'goals', 'notes'].forEach(k => stForm.elements[k].value = s?.[k] || '');
    stDialog.showModal();
  }
  stForm.onsubmit = evt => {
    evt.preventDefault();
    const data = Object.fromEntries(['name', 'level', 'goals', 'notes'].map(k => [k, stForm.elements[k].value.trim()]));
    if (editingStudentId) Object.assign(byId(db.students, editingStudentId), data);
    else { const s = { id: uid(), ...data }; db.students.push(s); selectedStudentId = s.id; }
    db.students.sort((a, b) => a.name.localeCompare(b.name));
    save(); stDialog.close(); render();
  };
  $('#deleteStudentBtn').onclick = () => {
    const n = db.events.filter(e => e.studentId === editingStudentId).length;
    if (!confirm(`Delete this student${n ? ` and their ${n} lesson(s)` : ''}?`)) return;
    db.students = db.students.filter(s => s.id !== editingStudentId);
    db.events = db.events.filter(e => e.studentId !== editingStudentId);
    selectedStudentId = null;
    save(); stDialog.close(); render();
  };

  function renderStudents() {
    if (!byId(db.students, selectedStudentId)) selectedStudentId = db.students[0]?.id || null;
    $('#studentList').innerHTML = db.students.length
      ? db.students.map(s => `<li data-id="${s.id}" class="${s.id === selectedStudentId ? 'active' : ''}">${esc(s.name)}${s.level ? `<small>${esc(s.level)}</small>` : ''}</li>`).join('')
      : `<li class="muted">No students yet.</li>`;
    $$('#studentList li[data-id]').forEach(li => li.onclick = () => { selectedStudentId = li.dataset.id; renderStudents(); });

    const s = byId(db.students, selectedStudentId);
    const detail = $('#studentDetail');
    if (!s) { detail.innerHTML = `<p class="muted">Add your first student to start planning their lessons.</p>`; return; }

    const lessons = db.events.filter(e => e.type === 'lesson' && e.studentId === s.id).sort((a, b) => sortKey(b).localeCompare(sortKey(a)));
    const today = toISO(new Date());
    detail.innerHTML = `
      <div class="detail-head">
        <div><h2>${esc(s.name)}</h2><span class="muted">${esc(s.level || '')}</span></div>
        <div class="add-row">
          <button class="btn ghost small" id="editStudentBtn">Edit</button>
          <button class="btn primary small" id="planNextBtn">+ Plan next lesson</button>
        </div>
      </div>
      <dl class="kv">
        <dt>Goals</dt><dd>${esc(s.goals || '—')}</dd>
        <dt>Notes</dt><dd>${esc(s.notes || '—')}</dd>
        <dt>Lessons</dt><dd>${lessons.length}</dd>
      </dl>
      <h3>Lesson history</h3>
      ${lessons.length ? `<ul class="history">${lessons.map(l => `
        <li data-id="${l.id}">
          <div class="h-date">${fmtLong(l.date)}${l.start ? ' · ' + l.start : ''}${l.date > today ? ' <span class="muted">(planned)</span>' : ''}</div>
          <div class="h-body">${esc([l.objectives && '🎯 ' + l.objectives, l.homework && '📝 ' + l.homework, l.nextSteps && '➡️ ' + l.nextSteps, l.notes && '🗒️ ' + l.notes].filter(Boolean).join('\n') || 'No details')}</div>
        </li>`).join('')}</ul>` : `<p class="muted">No lessons yet.</p>`}`;
    $('#editStudentBtn').onclick = () => openStudent(s);
    $('#planNextBtn').onclick = () => openEvent(null, { type: 'lesson', studentId: s.id, date: currentDate < today ? today : currentDate });
    $$('.history li', detail).forEach(li => li.onclick = () => openEvent(byId(db.events, li.dataset.id)));
  }

  // ---------- Study plans ----------
  const plDialog = $('#planDialog');
  const plForm = $('#planForm');
  let editingPlanId = null;

  $('#newPlanBtn').onclick = () => openPlan(null);
  function openPlan(p) {
    editingPlanId = p?.id || null;
    $('#deletePlanBtn').hidden = !p;
    plForm.elements.title.value = p?.title || '';
    plForm.elements.goal.value = p?.goal || '';
    plForm.elements.targetDate.value = p?.targetDate || '';
    plForm.elements.topics.value = (p?.topics || []).map(t => t.text).join('\n');
    plDialog.showModal();
  }
  plForm.onsubmit = evt => {
    evt.preventDefault();
    const f = plForm.elements;
    const old = byId(db.plans, editingPlanId);
    const lines = f.topics.value.split('\n').map(l => l.trim()).filter(Boolean);
    // Keep ids/done state for topics whose text didn't change.
    const topics = lines.map(text => old?.topics.find(t => t.text === text) || { id: uid(), text, done: false });
    const data = { title: f.title.value.trim(), goal: f.goal.value.trim(), targetDate: f.targetDate.value, topics };
    if (old) Object.assign(old, data);
    else { const p = { id: uid(), ...data }; db.plans.push(p); selectedPlanId = p.id; }
    save(); plDialog.close(); render();
  };
  $('#deletePlanBtn').onclick = () => {
    if (!confirm('Delete this study plan? Study sessions linked to it will be kept.')) return;
    db.plans = db.plans.filter(p => p.id !== editingPlanId);
    db.events.forEach(e => { if (e.planId === editingPlanId) { e.planId = ''; e.topicIds = []; } });
    selectedPlanId = null;
    save(); plDialog.close(); render();
  };

  function renderPlans() {
    if (!byId(db.plans, selectedPlanId)) selectedPlanId = db.plans[0]?.id || null;
    $('#planList').innerHTML = db.plans.length
      ? db.plans.map(p => {
          const done = p.topics.filter(t => t.done).length;
          return `<li data-id="${p.id}" class="${p.id === selectedPlanId ? 'active' : ''}">${esc(p.title)}<small>${done}/${p.topics.length} topics</small></li>`;
        }).join('')
      : `<li class="muted">No study plans yet.</li>`;
    $$('#planList li[data-id]').forEach(li => li.onclick = () => { selectedPlanId = li.dataset.id; renderPlans(); });

    const p = byId(db.plans, selectedPlanId);
    const detail = $('#planDetail');
    if (!p) { detail.innerHTML = `<p class="muted">Create a study plan with the topics you want to cover, then schedule study sessions for it.</p>`; return; }

    const done = p.topics.filter(t => t.done).length;
    const pct = p.topics.length ? Math.round(done / p.topics.length * 100) : 0;
    const sessions = db.events.filter(e => e.type === 'study' && e.planId === p.id).sort((a, b) => sortKey(b).localeCompare(sortKey(a)));
    const daysLeft = p.targetDate ? Math.ceil((fromISO(p.targetDate) - fromISO(toISO(new Date()))) / 864e5) : null;

    detail.innerHTML = `
      <div class="detail-head">
        <div><h2>${esc(p.title)}</h2>
          <span class="muted">${p.targetDate ? `Target: ${fmtLong(p.targetDate)} (${daysLeft >= 0 ? daysLeft + ' days left' : 'past due'})` : ''}</span></div>
        <div class="add-row">
          <button class="btn ghost small" id="editPlanBtn">Edit</button>
          <button class="btn study small" id="schedStudyBtn">+ Schedule session</button>
        </div>
      </div>
      ${p.goal ? `<p>${esc(p.goal)}</p>` : ''}
      <div class="prog-label"><span>Progress</span><span class="muted">${done}/${p.topics.length} · ${pct}%</span></div>
      <div class="progress"><span style="width:${pct}%"></span></div>
      <h3>Topics</h3>
      ${p.topics.length ? `<ul class="topics">${p.topics.map(t => `<li class="${t.done ? 'done' : ''}"><label><input type="checkbox" data-topic="${t.id}" ${t.done ? 'checked' : ''}/><span>${esc(t.text)}</span></label></li>`).join('')}</ul>` : '<p class="muted">No topics — click Edit to add some.</p>'}
      <h3>Study sessions</h3>
      ${sessions.length ? `<ul class="history">${sessions.map(s => `
        <li class="study" data-id="${s.id}">
          <div class="h-date">${fmtLong(s.date)}${s.start ? ' · ' + s.start : ''}${s.done ? ' ✓' : ''}</div>
          <div class="h-body">${esc([s.goal && '🎯 ' + s.goal, s.notes && '🗒️ ' + s.notes].filter(Boolean).join('\n') || 'No details')}</div>
        </li>`).join('')}</ul>` : '<p class="muted">No sessions scheduled yet.</p>'}`;

    $('#editPlanBtn').onclick = () => openPlan(p);
    $('#schedStudyBtn').onclick = () => openEvent(null, { type: 'study', planId: p.id });
    $$('[data-topic]', detail).forEach(cb => cb.onchange = () => { p.topics.find(t => t.id === cb.dataset.topic).done = cb.checked; save(); renderPlans(); });
    $$('.history li', detail).forEach(li => li.onclick = () => openEvent(byId(db.events, li.dataset.id)));
  }

  // ---------- Export / Import ----------
  $('#exportBtn').onclick = () => {
    const blob = new Blob([JSON.stringify(db, null, 2)], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `planner-backup-${toISO(new Date())}.json` });
    a.click();
    URL.revokeObjectURL(a.href);
  };
  $('#importInput').onchange = async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data.events) || !Array.isArray(data.students) || !Array.isArray(data.plans)) throw new Error('bad format');
      if (!confirm('Replace all current planner data with this backup?')) return;
      db = { ...empty(), ...data };
      save(); render();
    } catch { alert('That file is not a valid planner backup.'); }
    finally { e.target.value = ''; }
  };

  // ---------- Render ----------
  function render() {
    renderDay();
    renderStudents();
    renderPlans();
  }
  render();
})();
