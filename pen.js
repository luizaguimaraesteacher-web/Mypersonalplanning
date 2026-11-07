/* Pen Planner — handwritten daily tasks and study notes.
   Everything is stored in this browser (IndexedDB). Use the ••• menu to back up. */
(() => {
  'use strict';

  const LW = 1000;            // every surface is 1000 units wide, whatever the screen size
  const TASK_H = 120;
  const NOTE_H = 1400, NOTE_GROW = 700, NOTE_MAX = 9000;
  const PEN_COLORS = ['#1f2328', '#2856c8', '#c8372d', '#1d8a5a', '#8a4fd6'];
  const HL_COLORS = ['#ffd43b', '#8ce99a', '#ffa8d0', '#a5d8ff'];
  const SIZES = [2.4, 3.8, 6.5];

  // ---------- small helpers ----------
  const $ = (s, root = document) => root.querySelector(s);
  const el = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null) e.append(kid.nodeType ? kid : document.createTextNode(kid));
    return e;
  };
  const pad = n => String(n).padStart(2, '0');
  const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const today = () => iso(new Date());
  const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); };
  const fmt = (s, o) => parse(s).toLocaleDateString(undefined, o);
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const isDate = s => /^\d{4}-\d\d-\d\d$/.test(s || '');
  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };

  let toastTimer;
  function toast(msg, ms = 2200) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), ms);
  }

  // ---------- storage (IndexedDB) ----------
  const Store = {
    items: new Map(), db: null, timers: new Map(),
    async init() {
      try {
        this.db = await new Promise((res, rej) => {
          const r = indexedDB.open('pen-planner', 1);
          r.onupgradeneeded = () => r.result.createObjectStore('items', { keyPath: 'id' });
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        });
        const all = await this.tx('readonly', s => s.getAll());
        for (const it of all || []) this.items.set(it.id, it);
      } catch (e) {
        console.warn(e);
        this.db = null;
        toast('This browser is not letting the planner save. Your writing will be lost when you close it.', 6000);
      }
      try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch { /* ignore */ }
    },
    tx(mode, fn) {
      return new Promise((res, rej) => {
        const t = this.db.transaction('items', mode);
        const req = fn(t.objectStore('items'));
        t.oncomplete = () => res(req && req.result);
        t.onerror = () => rej(t.error);
        t.onabort = () => rej(t.error);
      });
    },
    save(item) {
      item.updated = Date.now();
      this.items.set(item.id, item);
      clearTimeout(this.timers.get(item.id));
      this.timers.set(item.id, setTimeout(() => this.flush(item.id), 300));
    },
    flush(id) {
      this.timers.delete(id);
      const it = this.items.get(id);
      if (!this.db || !it) return;
      this.tx('readwrite', s => s.put(it)).catch(e => toast('Could not save: ' + (e && e.message), 5000));
    },
    flushAll() { for (const id of [...this.timers.keys()]) { clearTimeout(this.timers.get(id)); this.flush(id); } },
    remove(id) {
      clearTimeout(this.timers.get(id));
      this.timers.delete(id);
      this.items.delete(id);
      if (this.db) this.tx('readwrite', s => s.delete(id)).catch(() => {});
    },
    list(kind) { return [...this.items.values()].filter(i => i.kind === kind); },
  };
  addEventListener('pagehide', () => Store.flushAll());
  document.addEventListener('visibilitychange', () => { if (document.hidden) Store.flushAll(); });

  // ---------- tools ----------
  const Tools = Object.assign({ tool: 'pen', pen: 0, hl: 0, size: 1, finger: false }, lsGet('pp-tools', {}));
  const saveTools = () => lsSet('pp-tools', { tool: Tools.tool, pen: Tools.pen, hl: Tools.hl, size: Tools.size, finger: Tools.finger });

  // ---------- drawing ----------
  const penWidth = (w, p) => w * (0.45 + 0.85 * p);

  function drawPaper(ctx, kind, h) {
    ctx.fillStyle = '#fffdf8';
    ctx.fillRect(0, 0, LW, h);
    ctx.lineWidth = 1.2;
    if (kind === 'task') {
      ctx.strokeStyle = '#ece7dc';
      ctx.setLineDash([6, 8]);
      ctx.beginPath(); ctx.moveTo(10, h * 0.74); ctx.lineTo(LW - 10, h * 0.74); ctx.stroke();
      ctx.setLineDash([]);
    } else if (kind === 'lines') {
      ctx.strokeStyle = '#dfe6f1';
      ctx.beginPath();
      for (let y = 100; y < h; y += 44) { ctx.moveTo(0, y); ctx.lineTo(LW, y); }
      ctx.stroke();
      ctx.strokeStyle = '#f2c9c4';
      ctx.beginPath(); ctx.moveTo(80, 0); ctx.lineTo(80, h); ctx.stroke();
    } else if (kind === 'grid') {
      ctx.strokeStyle = '#e7ebf1';
      ctx.beginPath();
      for (let y = 40; y < h; y += 40) { ctx.moveTo(0, y); ctx.lineTo(LW, y); }
      for (let x = 40; x < LW; x += 40) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
      ctx.stroke();
    } else if (kind === 'dots') {
      ctx.fillStyle = '#c9c4b9';
      for (let y = 40; y < h; y += 40) for (let x = 40; x < LW; x += 40) ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
    }
  }

  function drawStroke(ctx, s) {
    const p = s.pts, n = p.length / 3;
    if (!n) return;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = s.c;
    if (s.t === 'hl') {
      ctx.globalAlpha = 0.35;
      ctx.globalCompositeOperation = 'multiply';
      ctx.lineWidth = s.w * 5;
      ctx.beginPath();
      ctx.moveTo(p[0], p[1]);
      if (n === 1) ctx.lineTo(p[0] + 0.1, p[1]);
      for (let i = 1; i < n; i++) ctx.lineTo(p[3 * i], p[3 * i + 1]);
      ctx.stroke();
    } else if (n === 1) {
      ctx.fillStyle = s.c;
      ctx.beginPath();
      ctx.arc(p[0], p[1], penWidth(s.w, p[2]) / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      let px = p[0], py = p[1];
      for (let i = 1; i < n - 1; i++) {
        const mx = (p[3 * i] + p[3 * i + 3]) / 2, my = (p[3 * i + 1] + p[3 * i + 4]) / 2;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.quadraticCurveTo(p[3 * i], p[3 * i + 1], mx, my);
        ctx.lineWidth = penWidth(s.w, p[3 * i + 2]);
        ctx.stroke();
        px = mx; py = my;
      }
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(p[3 * n - 3], p[3 * n - 2]);
      ctx.lineWidth = penWidth(s.w, p[3 * n - 1]);
      ctx.stroke();
    }
    ctx.restore();
  }

  function strokeHit(s, x, y, r) {
    const p = s.pts, rr = r + (s.t === 'hl' ? s.w * 2.5 : s.w * 0.6);
    for (let i = 0; i < p.length; i += 3) {
      const ax = p[i], ay = p[i + 1];
      const bx = i + 3 < p.length ? p[i + 3] : ax, by = i + 3 < p.length ? p[i + 4] : ay;
      const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
      const t = L ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L)) : 0;
      const cx = ax + t * dx - x, cy = ay + t * dy - y;
      if (cx * cx + cy * cy <= rr * rr) return true;
    }
    return false;
  }

  // ---------- undo / redo ----------
  const History = {
    undo: [], redo: [],
    push(a) { this.undo.push(a); this.redo = []; renderToolbar(); },
    clear() { this.undo = []; this.redo = []; renderToolbar(); },
    back() {
      const a = this.undo.pop(); if (!a) return;
      const S = a.surface.model.strokes;
      if (a.type === 'add') { const i = S.indexOf(a.stroke); if (i >= 0) S.splice(i, 1); }
      else for (const { stroke, index } of [...a.items].reverse()) S.splice(Math.min(index, S.length), 0, stroke);
      this.redo.push(a); a.surface.changed(true);
    },
    forward() {
      const a = this.redo.pop(); if (!a) return;
      const S = a.surface.model.strokes;
      if (a.type === 'add') S.push(a.stroke);
      else for (const { stroke } of a.items) { const i = S.indexOf(stroke); if (i >= 0) S.splice(i, 1); }
      this.undo.push(a); a.surface.changed(true);
    },
  };

  // ---------- a writable surface ----------
  let mounted = [];
  const unmountAll = () => { mounted.forEach(s => s.destroy()); mounted = []; };

  class Surface {
    constructor(wrap, model, opts) {
      this.wrap = wrap; this.model = model; this.opts = opts;
      if (!model.strokes) model.strokes = [];
      wrap.classList.add('surface');
      this.base = el('canvas');
      this.live = el('canvas');
      wrap.append(this.base, this.live);
      this.active = null;
      this.ro = new ResizeObserver(() => this.layout());
      this.ro.observe(wrap);
      this.bind();
      mounted.push(this);
    }
    get h() { return this.model.h || this.opts.h; }
    paper() { return typeof this.opts.paper === 'function' ? this.opts.paper() : this.opts.paper; }
    destroy() { this.ro.disconnect(); }
    layout(force) {
      const cssW = this.wrap.clientWidth;
      if (!cssW) return;
      if (!force && cssW === this.cssW && this.h === this.lastH) return;
      this.cssW = cssW; this.lastH = this.h;
      this.scale = cssW / LW;
      const cssH = this.h * this.scale;
      this.wrap.style.height = cssH + 'px';
      const dpr = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(16e6 / (cssW * cssH)));
      this.k = this.scale * dpr;
      for (const c of [this.base, this.live]) {
        c.width = Math.round(cssW * dpr);
        c.height = Math.round(cssH * dpr);
        c.style.width = cssW + 'px';
        c.style.height = cssH + 'px';
      }
      this.render();
    }
    ctx(c) { const x = c.getContext('2d'); x.setTransform(this.k, 0, 0, this.k, 0, 0); return x; }
    render() {
      if (!this.k) return;
      const x = this.ctx(this.base);
      x.clearRect(0, 0, LW, this.h);
      drawPaper(x, this.paper(), this.h);
      for (const s of this.model.strokes) drawStroke(x, s);
      this.wrap.classList.toggle('inked', this.model.strokes.length > 0);
    }
    changed(rerender) { if (rerender) this.render(); this.opts.onChange && this.opts.onChange(); }
    pos(e) {
      const r = this.wrap.getBoundingClientRect();
      return [(e.clientX - r.left) / this.scale, (e.clientY - r.top) / this.scale];
    }
    bind() {
      const w = this.wrap;
      // Apple Pencil touches must not scroll the page; finger touches still scroll.
      const stopStylus = e => {
        if (Tools.finger) { e.preventDefault(); return; }
        for (const t of e.changedTouches) if (t.touchType === 'stylus') { e.preventDefault(); return; }
      };
      w.addEventListener('touchstart', stopStylus, { passive: false });
      w.addEventListener('touchmove', stopStylus, { passive: false });
      w.addEventListener('contextmenu', e => e.preventDefault());
      w.addEventListener('pointerdown', e => this.down(e));
      w.addEventListener('pointermove', e => this.move(e));
      w.addEventListener('pointerup', e => this.up(e));
      w.addEventListener('pointercancel', e => this.up(e));
    }
    down(e) {
      if (e.pointerType === 'touch' && !Tools.finger) return;   // finger scrolls
      if (this.active != null || e.button > 0 || !this.k) return;
      e.preventDefault();
      this.active = e.pointerId;
      try { this.wrap.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      if (Tools.tool === 'eraser') { this.erased = []; this.eraseAt(e); return; }
      const hl = Tools.tool === 'hl';
      this.cur = { t: hl ? 'hl' : 'pen', c: hl ? HL_COLORS[Tools.hl] : PEN_COLORS[Tools.pen], w: SIZES[Tools.size], pts: [] };
      this.addPts(e);
      this.drawLive();
    }
    move(e) {
      if (e.pointerId !== this.active) return;
      e.preventDefault();
      if (Tools.tool === 'eraser' && !this.cur) { this.eraseAt(e); return; }
      this.addPts(e);
      if (!this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; this.drawLive(); });
    }
    up(e) {
      if (e.pointerId !== this.active) return;
      this.active = null;
      if (!this.cur) {
        if (this.erased && this.erased.length) { History.push({ type: 'erase', surface: this, items: this.erased }); this.changed(false); }
        this.erased = null;
        return;
      }
      if (e.type === 'pointerup') this.addPts(e);
      const s = this.cur; this.cur = null;
      cancelAnimationFrame(this.raf); this.raf = 0;
      this.ctx(this.live).clearRect(0, 0, LW, this.h);
      if (!s.pts.length) return;
      this.model.strokes.push(s);
      drawStroke(this.ctx(this.base), s);
      this.wrap.classList.add('inked');
      History.push({ type: 'add', surface: this, stroke: s });
      if (this.opts.onStroke) this.opts.onStroke(s);
      if (this.opts.grow) {
        let maxY = 0;
        for (let i = 1; i < s.pts.length; i += 3) maxY = Math.max(maxY, s.pts[i]);
        if (maxY > this.h - 250 && this.h < NOTE_MAX) { this.model.h = Math.min(NOTE_MAX, this.h + NOTE_GROW); this.layout(true); }
      }
      this.changed(false);
    }
    addPts(e) {
      const list = (e.getCoalescedEvents && e.getCoalescedEvents()) || [];
      for (const ev of list.length ? list : [e]) {
        const [x, y] = this.pos(ev);
        let p = ev.pointerType === 'pen' ? ev.pressure : 0.5;
        if (ev.pointerType === 'pen' && !p) p = 0.3;
        const P = this.cur.pts, n = P.length;
        if (n && Math.abs(P[n - 3] - x) < 0.4 && Math.abs(P[n - 2] - y) < 0.4) continue;
        P.push(Math.round(x * 10) / 10, Math.round(y * 10) / 10, Math.round(p * 100) / 100);
      }
    }
    drawLive() {
      if (!this.cur) return;
      const x = this.ctx(this.live);
      x.clearRect(0, 0, LW, this.h);
      drawStroke(x, this.cur);
    }
    eraseAt(e) {
      const [x, y] = this.pos(e);
      const S = this.model.strokes;
      let hit = false;
      for (let i = S.length - 1; i >= 0; i--) {
        if (strokeHit(S[i], x, y, 6 + SIZES[Tools.size] * 2)) { this.erased.push({ stroke: S[i], index: i }); S.splice(i, 1); hit = true; }
      }
      if (hit) this.render();
    }
  }

  function drawThumb(canvas, note) {
    const cssW = canvas.clientWidth || 200, cssH = cssW * 0.7;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    const k = (cssW / LW) * dpr;
    const x = canvas.getContext('2d');
    x.setTransform(k, 0, 0, k, 0, 0);
    drawPaper(x, note.paper, 700);
    for (const s of note.strokes) drawStroke(x, s);
  }

  // ---------- toolbar ----------
  function renderToolbar() {
    document.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === Tools.tool));
    const hl = Tools.tool === 'hl';
    const colors = hl ? HL_COLORS : PEN_COLORS, cur = hl ? Tools.hl : Tools.pen;
    const box = $('#colors');
    box.replaceChildren(...colors.map((c, i) => el('button', {
      class: 'swatch' + (i === cur && Tools.tool !== 'eraser' ? ' on' : ''), style: `--c:${c}`, 'aria-label': 'Colour ' + (i + 1),
      onclick: () => { if (Tools.tool === 'eraser') Tools.tool = 'pen'; Tools[Tools.tool === 'hl' ? 'hl' : 'pen'] = i; saveTools(); renderToolbar(); },
    })));
    box.classList.toggle('dim', Tools.tool === 'eraser');
    $('#sizes').replaceChildren(...SIZES.map((s, i) => el('button', {
      class: 'size' + (i === Tools.size ? ' on' : ''), style: `--s:${5 + i * 4}px`, 'aria-label': ['Thin', 'Medium', 'Thick'][i],
      onclick: () => { Tools.size = i; saveTools(); renderToolbar(); },
    })));
    $('#undoBtn').disabled = !History.undo.length;
    $('#redoBtn').disabled = !History.redo.length;
    $('#fingerBtn').classList.toggle('on', Tools.finger);
    document.body.classList.toggle('finger', Tools.finger);
    document.body.classList.toggle('tool-eraser', Tools.tool === 'eraser');
  }
  document.querySelectorAll('[data-tool]').forEach(b => b.addEventListener('click', () => { Tools.tool = b.dataset.tool; saveTools(); renderToolbar(); }));
  $('#undoBtn').addEventListener('click', () => { History.back(); renderToolbar(); });
  $('#redoBtn').addEventListener('click', () => { History.forward(); renderToolbar(); });
  $('#fingerBtn').addEventListener('click', () => {
    Tools.finger = !Tools.finger; saveTools(); renderToolbar();
    toast(Tools.finger ? 'Finger now writes too. Scroll with two fingers.' : 'Finger scrolls. Write with Apple Pencil.');
  });
  document.addEventListener('keydown', e => {
    if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z' || /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
    e.preventDefault();
    e.shiftKey ? History.forward() : History.back();
    renderToolbar();
  });

  // ---------- views ----------
  const state = { date: today(), note: null, filter: null };

  function setView(v) {
    document.querySelectorAll('.view').forEach(s => s.classList.toggle('active', s.id === 'view-' + v));
    document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('on', a.dataset.nav === (v === 'note' ? 'notes' : v)));
    document.body.className = document.body.className.replace(/\bview-\S+/g, '').trim() + ' view-' + v;
    renderToolbar();
  }

  function cleanup(keepId) {
    for (const it of [...Store.items.values()]) {
      if (it.id === keepId) continue;
      if (it.kind === 'task' && !it.strokes.length) Store.remove(it.id);
      if (it.kind === 'note' && !it.strokes.length && !it.subject) Store.remove(it.id);
    }
  }

  // Daily page
  function showDay(date) {
    state.date = date;
    setView('day');
    const t = today();
    $('#dayName').textContent = fmt(date, { weekday: 'long' });
    $('#dayDate').textContent = fmt(date, { month: 'long', day: 'numeric', year: 'numeric' });
    $('#dayRel').textContent = date === t ? 'Today' : date === addDays(t, -1) ? 'Yesterday' : date === addDays(t, 1) ? 'Tomorrow' : '';
    $('#datePick').value = date;
    renderTasks();
    renderDayNotes();
  }

  function renderTasks() {
    unmountAll();
    const date = state.date, list = $('#taskList'), over = $('#overdue');
    list.replaceChildren();
    over.replaceChildren();
    const tasks = Store.list('task').filter(x => x.strokes.length);
    if (date === today()) {
      const old = tasks.filter(x => !x.done && x.date < date).sort((a, b) => a.date.localeCompare(b.date) || a.created - b.created);
      if (old.length) over.append(el('h3', {}, `Still to do from earlier days (${old.length})`), el('ol', { class: 'tasks' }, old.map(x => taskRow(x, 'overdue'))));
    }
    tasks.filter(x => x.date === date).sort((a, b) => a.created - b.created).forEach(x => list.append(taskRow(x)));
    list.append(ghostRow());
    updateCount();
  }

  function ghostRow() {
    return taskRow({ id: uid(), kind: 'task', date: state.date, strokes: [], done: false, created: Date.now() }, 'ghost');
  }

  function taskRow(t, mode) {
    const li = el('li', { class: 'task' + (t.done ? ' done' : '') + (mode === 'ghost' ? ' ghost' : '') });
    const strip = el('div', { class: 'strip' });
    const check = el('button', {
      class: 'check', 'aria-label': 'Mark done',
      onclick: () => {
        if (li.classList.contains('ghost')) return;
        t.done = !t.done; t.doneAt = t.done ? Date.now() : null;
        li.classList.toggle('done', t.done);
        Store.save(t); updateCount();
      },
    });
    const actions = el('div', { class: 'task-actions' });
    if (mode === 'overdue') {
      actions.append(
        el('span', { class: 'from' }, fmt(t.date, { month: 'short', day: 'numeric' })),
        el('button', { class: 'mini', onclick: () => { t.date = state.date; Store.save(t); renderTasks(); } }, 'Move to today'));
    } else {
      actions.append(
        el('button', {
          class: 'icon-btn', title: 'Move to tomorrow', 'aria-label': 'Move to tomorrow',
          onclick: () => { t.date = addDays(t.date, 1); Store.save(t); renderTasks(); toast('Moved to ' + fmt(t.date, { weekday: 'long', month: 'short', day: 'numeric' })); },
        }, '→'),
        el('button', {
          class: 'icon-btn', title: 'Delete task', 'aria-label': 'Delete task',
          onclick: () => { if (confirm('Delete this task?')) { Store.remove(t.id); renderTasks(); } },
        }, '×'));
    }
    li.append(check, strip, actions);
    new Surface(strip, t, {
      h: TASK_H, paper: 'task',
      onStroke: () => {
        if (mode !== 'ghost' || Store.items.has(t.id)) return;
        t.created = Date.now();
        Store.save(t);
        li.classList.remove('ghost');
        mode = 'new';
        $('#taskList').append(ghostRow());
        updateCount();
      },
      onChange: () => { if (Store.items.has(t.id)) Store.save(t); },
    });
    return li;
  }

  function updateCount() {
    const tasks = Store.list('task').filter(x => x.date === state.date && x.strokes.length);
    const done = tasks.filter(x => x.done).length;
    $('#taskCount').textContent = tasks.length ? `${done} of ${tasks.length} done` : '';
  }

  function noteCard(n, showDate) {
    const c = el('canvas', { class: 'thumb' });
    const card = el('a', { class: 'note-card', href: '#note/' + n.id }, c,
      el('div', { class: 'meta' },
        el('strong', {}, n.subject || 'No subject'),
        el('span', {}, showDate ? fmt(n.date, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
          : `${Math.max(1, Math.round(n.h / NOTE_H))} page${n.h > NOTE_H * 1.5 ? 's' : ''}`)));
    requestAnimationFrame(() => drawThumb(c, n));
    return card;
  }

  function renderDayNotes() {
    const g = $('#dayNotes');
    const notes = Store.list('note').filter(n => n.date === state.date).sort((a, b) => a.created - b.created);
    g.replaceChildren(...notes.map(n => noteCard(n, false)),
      el('button', { class: 'note-card new', onclick: () => newNote(state.date) },
        el('span', { class: 'plus' }, '+'), el('span', {}, 'New study note')));
  }

  function newNote(date) {
    const n = { id: uid(), kind: 'note', date, subject: '', paper: lsGet('pp-paper', 'lines'), h: NOTE_H, strokes: [], created: Date.now() };
    Store.save(n);
    location.hash = '#note/' + n.id;
  }

  const subjects = () => [...new Set(Store.list('note').map(n => (n.subject || '').trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));

  // One study note
  function showNote(n) {
    unmountAll();
    state.note = n.id;
    setView('note');
    $('#noteBack').href = '#day/' + n.date;
    const subj = $('#noteSubject');
    subj.value = n.subject || '';
    subj.oninput = () => { n.subject = subj.value.trim(); Store.save(n); };
    $('#subjectList').replaceChildren(...subjects().map(s => el('option', { value: s })));
    const d = $('#noteDate');
    d.value = n.date;
    d.onchange = () => { if (isDate(d.value)) { n.date = d.value; $('#noteBack').href = '#day/' + n.date; Store.save(n); } };
    const paper = $('#notePaper');
    paper.value = n.paper;
    const wrap = $('#notePage');
    wrap.replaceChildren();
    wrap.style.height = '';
    const surface = new Surface(wrap, n, { paper: () => n.paper, grow: true, onChange: () => Store.save(n) });
    paper.onchange = () => { n.paper = paper.value; lsSet('pp-paper', n.paper); Store.save(n); surface.render(); };
    $('#noteDelete').onclick = () => {
      if (!confirm('Delete this study note?')) return;
      Store.remove(n.id);
      location.hash = '#day/' + n.date;
    };
    $('#addSpace').onclick = () => {
      if (n.h >= NOTE_MAX) { toast('This note is as long as it can be. Start a new note to keep going.'); return; }
      n.h = Math.min(NOTE_MAX, n.h + NOTE_GROW);
      Store.save(n);
      surface.layout(true);
    };
    scrollTo(0, 0);
  }

  // All study notes
  function showLibrary() {
    unmountAll();
    setView('notes');
    const all = Store.list('note').filter(n => n.strokes.length || n.subject);
    const subs = subjects();
    if (state.filter && !subs.includes(state.filter)) state.filter = null;
    const chip = (label, val) => el('button', { class: state.filter === val ? 'on' : '', onclick: () => { state.filter = val; showLibrary(); } }, label);
    $('#subjectChips').replaceChildren(...(subs.length ? [chip('All', null), ...subs.map(s => chip(s, s))] : []));
    const list = all.filter(n => !state.filter || n.subject === state.filter)
      .sort((a, b) => b.date.localeCompare(a.date) || b.created - a.created);
    $('#libGrid').replaceChildren(...list.map(n => noteCard(n, true)));
    $('#libEmpty').hidden = list.length > 0;
  }
  $('#libNew').addEventListener('click', () => newNote(today()));

  // ---------- routing ----------
  function route() {
    const [view, arg] = location.hash.slice(1).split('/');
    History.clear();
    $('.menu').open = false;
    if (view === 'note' && Store.items.has(arg)) { cleanup(arg); showNote(Store.items.get(arg)); return; }
    cleanup();
    if (view === 'notes') showLibrary();
    else showDay(isDate(arg) ? arg : today());
  }
  addEventListener('hashchange', route);
  $('#prevDay').addEventListener('click', () => { location.hash = '#day/' + addDays(state.date, -1); });
  $('#nextDay').addEventListener('click', () => { location.hash = '#day/' + addDays(state.date, 1); });
  $('#todayBtn').addEventListener('click', () => { location.hash = '#day/' + today(); });
  $('#datePick').addEventListener('change', e => { if (isDate(e.target.value)) location.hash = '#day/' + e.target.value; });

  // ---------- backup ----------
  $('#exportBtn').addEventListener('click', () => {
    Store.flushAll();
    const data = { app: 'pen-planner', version: 1, exported: new Date().toISOString(), items: [...Store.items.values()] };
    const a = el('a', { href: URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' })), download: `pen-planner-backup-${today()}.json` });
    document.body.append(a); a.click(); a.remove();
    $('.menu').open = false;
  });
  $('#importInput').addEventListener('change', async e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (data.app !== 'pen-planner' || !Array.isArray(data.items)) throw new Error('This is not a Pen Planner backup file.');
      let n = 0;
      for (const it of data.items) {
        if (!it || !it.id || !Array.isArray(it.strokes) || !isDate(it.date) || !['task', 'note'].includes(it.kind)) continue;
        Store.items.set(it.id, it); Store.flush(it.id); n++;
      }
      toast(`Restored ${n} item${n === 1 ? '' : 's'}.`);
      route();
    } catch (err) { alert('Could not restore: ' + err.message); }
    $('.menu').open = false;
  });

  // ---------- install hint (Safari clears data of sites not used for a while) ----------
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  if (ios && !standalone && !lsGet('pp-hint-done', false)) $('#installHint').hidden = false;
  $('#hintClose').addEventListener('click', () => { $('#installHint').hidden = true; lsSet('pp-hint-done', true); });

  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) navigator.serviceWorker.register('sw.js').catch(() => {});

  Store.init().then(route);
})();
