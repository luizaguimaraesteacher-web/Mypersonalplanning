/* Pen Planner — handwritten daily tasks and study notes.
   Everything is stored in this browser (IndexedDB). Use the ••• menu to back up. */
(() => {
  'use strict';

  const LW = 1000;            // every surface is 1000 units wide, whatever the screen size
  const TASK_H = 120;
  const TASK_NOTE_H = 180;      // the notes strip beside a task is narrower, so it is taller in units
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
  // replaceChildren, skipping empty (null/false) parts
  const fill = (node, ...kids) => node.replaceChildren(...kids.flat().filter(k => k != null && k !== false));
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

  // Running as a Claude artifact? Then data goes to the artifact's database
  // (saved in the user's Claude account) and the calendar comes through the
  // Google Calendar connector. Otherwise (GitHub Pages, a local file) data
  // stays in this browser's IndexedDB.
  const EMBED = !!(window.claude && typeof window.claude.use === 'function');

  // Strokes are stored compactly: [isHighlighter, colour, width, ints...]
  const encStroke = s => {
    const p = s.pts, out = new Array(p.length);
    for (let i = 0; i < p.length; i += 3) { out[i] = Math.round(p[i] * 10); out[i + 1] = Math.round(p[i + 1] * 10); out[i + 2] = Math.round(p[i + 2] * 100); }
    return [s.t === 'hl' ? 1 : 0, s.c, s.w, out];
  };
  const decStroke = a => {
    const q = a[3], pts = new Array(q.length);
    for (let i = 0; i < q.length; i += 3) { pts[i] = q[i] / 10; pts[i + 1] = q[i + 1] / 10; pts[i + 2] = q[i + 2] / 100; }
    return { t: a[0] ? 'hl' : 'pen', c: a[1], w: a[2], pts };
  };
  const CHUNK = 170000; // characters per stored piece; the database allows 256 KiB per document

  const Remote = {
    coll: null, sigs: new Map(), nChunks: new Map(), chains: new Map(), failed: false,
    async connect() {
      const c = window.claude;
      const [db, user] = await Promise.all([c.use('db').catch(() => null), c.use('user').catch(() => null)]);
      const uid = user && await user.id().catch(() => null);
      if (!db || !uid) return false;
      this.coll = db.collection('data/users/' + uid);
      return true;
    },
    async loadAll(items) {
      const docs = [];
      let last = '';
      for (;;) {
        const snap = await this.coll.where('k', '>', last).orderBy('k').limit(500).get();
        for (const d of snap.docs) docs.push(d.data());
        if (snap.size < 500) break;
        last = snap.docs[snap.size - 1].data().k;
      }
      const parts = new Map();
      for (const d of docs) {
        if (d.kind === 'chunk') {
          if (!parts.has(d.part)) parts.set(d.part, []);
          parts.get(d.part).push(d);
          this.sigs.set(d.k, JSON.stringify(d.s));
        }
      }
      for (const d of docs) {
        if (d.kind === 'chunk') continue;
        const it = { ...d };
        delete it.k;
        if (typeof it.chunks === 'number' || it.kind === 'task' || it.kind === 'note') { // anything handwritten
          const ps = (parts.get(it.id) || []).sort((a, b) => a.i - b.i).slice(0, it.chunks || 0);
          it.strokes = ps.flatMap(p => p.s).map(decStroke);
          this.nChunks.set(it.id, it.chunks || 0);
          delete it.chunks;
        }
        this.sigs.set(it.id, JSON.stringify(d));
        items.set(it.id, it);
      }
    },
    queue(id, job) {
      const p = (this.chains.get(id) || Promise.resolve()).then(job).catch(e => this.fail(e));
      this.chains.set(id, p);
      return p;
    },
    fail(e) {
      console.warn(e);
      const code = e && e.code;
      toast(code === 'quota_exceeded'
        ? 'Your planner storage is full. Delete some old notes to keep saving.'
        : code === 'invalid_argument' ? 'This page can only be changed by its owner.'
          : "Couldn't save your last change. Check your internet connection.", 6000);
    },
    write(item) {
      return this.queue(item.id, async () => {
        const id = item.id, meta = { ...item, k: id };
        if (Array.isArray(item.strokes)) {
          delete meta.strokes;
          const chunks = [];
          let cur = [], size = 0;
          for (const s of item.strokes) {
            const e = encStroke(s), n = JSON.stringify(e).length;
            if (cur.length && size + n > CHUNK) { chunks.push(cur); cur = []; size = 0; }
            cur.push(e); size += n;
          }
          if (cur.length) chunks.push(cur);
          for (let i = 0; i < chunks.length; i++) {
            const key = id + '~' + i, sig = JSON.stringify(chunks[i]);
            if (this.sigs.get(key) === sig) continue;
            await this.coll.doc(key).set({ k: key, kind: 'chunk', part: id, i, s: chunks[i] });
            this.sigs.set(key, sig);
          }
          for (let i = chunks.length; i < (this.nChunks.get(id) || 0); i++) {
            await this.coll.doc(id + '~' + i).delete();
            this.sigs.delete(id + '~' + i);
          }
          this.nChunks.set(id, chunks.length);
          meta.chunks = chunks.length;
        }
        const sig = JSON.stringify(meta);
        if (this.sigs.get(id) === sig) return;
        await this.coll.doc(id).set(meta);
        this.sigs.set(id, sig);
      });
    },
    erase(id) {
      return this.queue(id, async () => {
        for (let i = 0; i < (this.nChunks.get(id) || 0); i++) { await this.coll.doc(id + '~' + i).delete(); this.sigs.delete(id + '~' + i); }
        this.nChunks.delete(id);
        await this.coll.doc(id).delete();
        this.sigs.delete(id);
      });
    },
  };

  const Store = {
    items: new Map(), db: null, timers: new Map(), remote: false,
    async init() {
      if (EMBED) {
        try {
          if (await Remote.connect()) {
            await Remote.loadAll(this.items);
            this.remote = true;
            return;
          }
        } catch (e) {
          console.warn(e);
          toast("Couldn't load your saved planner. Check your internet connection and open the page again.", 8000);
          this.remote = true; // keep writing to the account; never fall back silently
          return;
        }
      }
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
      this.timers.set(item.id, setTimeout(() => this.flush(item.id), this.remote ? 700 : 300));
    },
    flush(id) {
      this.timers.delete(id);
      const it = this.items.get(id);
      if (!it) return;
      if (this.remote) { if (Remote.coll) Remote.write(it); return; }
      if (!this.db) return;
      this.tx('readwrite', s => s.put(it)).catch(e => toast('Could not save: ' + (e && e.message), 5000));
    },
    flushAll() { for (const id of [...this.timers.keys()]) { clearTimeout(this.timers.get(id)); this.flush(id); } },
    remove(id) {
      clearTimeout(this.timers.get(id));
      this.timers.delete(id);
      this.items.delete(id);
      if (this.remote) { if (Remote.coll) Remote.erase(id); return; }
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
    } else if (kind === 'gratitude') {
      ctx.strokeStyle = '#e6dcc8';
      ctx.beginPath();
      for (let y = 100; y < h; y += 100) { ctx.moveTo(30, y); ctx.lineTo(LW - 30, y); }
      ctx.stroke();
      ctx.fillStyle = '#c9b48a'; ctx.font = '600 34px -apple-system, sans-serif';
      for (let i = 0; i * 100 + 100 < h; i++) ctx.fillText(String(i + 1) + '.', 30, i * 100 + 88);
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
    fill(box, ...colors.map((c, i) => el('button', {
      class: 'swatch' + (i === cur && Tools.tool !== 'eraser' ? ' on' : ''), style: `--c:${c}`, 'aria-label': 'Colour ' + (i + 1),
      onclick: () => { if (Tools.tool === 'eraser') Tools.tool = 'pen'; Tools[Tools.tool === 'hl' ? 'hl' : 'pen'] = i; saveTools(); renderToolbar(); },
    })));
    box.classList.toggle('dim', Tools.tool === 'eraser');
    fill($('#sizes'), ...SIZES.map((s, i) => el('button', {
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
    $('#loading').hidden = true;
    document.querySelectorAll('.view').forEach(s => s.classList.toggle('active', s.id === 'view-' + v));
    document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('on', a.dataset.nav === (v === 'note' || v === 'plan' || v === 'topic' ? 'notes' : v)));
    document.body.className = document.body.className.replace(/\bview-\S+/g, '').trim() + ' view-' + v;
    renderToolbar();
  }

  function cleanup(keepId) {
    for (const it of [...Store.items.values()]) {
      if (it.id === keepId) continue;
      const inked = Array.isArray(it.strokes) && it.strokes.length > 0;
      if (it.kind === 'task' && !inked) Store.remove(it.id);
      if (it.kind === 'note' && !inked && !it.subject) Store.remove(it.id);
      if (it.kind === 'gratitude' && !inked) Store.remove(it.id);
      if (it.kind === 'tasknote' && (!inked || !Store.items.has(it.taskId))) Store.remove(it.id);
      if (it.kind === 'class' && !it.status && !hasNotes(it) && !it.gMoved && !it.gCancelled && (it.eventId || !it.title)) Store.remove(it.id);
    }
  }

  // Daily page
  function showDay(date) {
    unmountAll();
    state.date = date;
    setView('day');
    const t = today();
    $('#dayName').textContent = fmt(date, { weekday: 'long' });
    $('#dayDate').textContent = fmt(date, { month: 'long', day: 'numeric', year: 'numeric' });
    $('#dayRel').textContent = date === t ? 'Today' : date === addDays(t, -1) ? 'Yesterday' : date === addDays(t, 1) ? 'Tomorrow' : '';
    $('#datePick').value = date;
    renderRoutineCard('morning');
    renderRoutineCard('night');
    renderCalendar();
    renderClassCard();
    renderStudyCard();
    renderTasks();
    renderDayNotes();
    renderDayExtras();
    renderMoneyCard();
  }

  function renderTasks() {
    // only the task lines are redrawn here; other writing areas on the day stay
    mounted = mounted.filter(sf => { if (sf.wrap.closest('#taskList, #overdue')) { sf.destroy(); return false; } return true; });
    const date = state.date, list = $('#taskList'), over = $('#overdue');
    fill(list, );
    fill(over, );
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
          class: 'icon-btn', title: 'Move to another day', 'aria-label': 'Move to another day',
          onclick: () => moveTask(t),
        }, '→'),
        el('button', {
          class: 'icon-btn', title: 'Delete task', 'aria-label': 'Delete task',
          onclick: async () => { if (await ask('Delete this task?', 'Delete')) { Store.remove(t.id); if (Store.items.has('tn-' + t.id)) Store.remove('tn-' + t.id); renderTasks(); } },
        }, '×'));
    }
    // the notes space next to the task (its own handwriting area, saved separately)
    const nid = 'tn-' + t.id;
    const note = Store.items.get(nid) || { id: nid, kind: 'tasknote', taskId: t.id, date: t.date, strokes: [], created: Date.now() };
    const nstrip = el('div', { class: 'nstrip' });
    const body = el('div', { class: 'tbody' + (note.strokes.length ? ' has-note' : '') }, strip, nstrip);
    actions.prepend(el('button', {
      class: 'icon-btn notebtn', title: 'Notes for this task', 'aria-label': 'Notes for this task',
      onclick: () => body.classList.toggle('open'),
    }, '✎'));
    li.append(check, body, actions);
    new Surface(nstrip, note, {
      h: TASK_NOTE_H, paper: 'task',
      onChange: () => {
        note.date = t.date;
        if (note.strokes.length || Store.items.has(nid)) Store.save(note);
        body.classList.toggle('has-note', note.strokes.length > 0);
      },
    });
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

  const pageCount = n => { const k = Math.max(1, Math.round(n.h / NOTE_H)); return k + (k === 1 ? ' page' : ' pages'); };
  function noteCard(n, showDate) {
    const c = el('canvas', { class: 'thumb' });
    const card = el('a', { class: 'note-card', href: '#note/' + n.id }, c,
      el('div', { class: 'meta' },
        el('strong', {}, n.topic ? n.topic : (n.subject || 'No subject')),
        el('span', {}, showDate ? fmt(n.date, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
          : pageCount(n))));
    requestAnimationFrame(() => drawThumb(c, n));
    return card;
  }

  function renderDayNotes() {
    const g = $('#dayNotes');
    const notes = Store.list('note').filter(n => n.date === state.date).sort((a, b) => a.created - b.created);
    fill(g, ...notes.map(n => noteCard(n, false)),
      el('button', { class: 'note-card new', onclick: () => newNote(state.date) },
        el('span', { class: 'plus' }, '+'), el('span', {}, 'New study note')));
  }

  function newNote(date, subject, planId) {
    const n = { id: uid(), kind: 'note', date, subject: subject || '', planId: planId || '', paper: lsGet('pp-paper', 'lines'), h: NOTE_H, strokes: [], created: Date.now() };
    Store.save(n);
    go('note/' + n.id);
  }

  const subjects = () => [...new Set(Store.list('note').map(n => (n.subject || '').trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));

  // One study note
  function showNote(n) {
    if (n.topicId && n.planId && Store.items.has(n.planId)) {
      const pl = Store.items.get(n.planId), it = (pl.items || []).find(i => i.id === n.topicId);
      if (it) { showTopic(pl, it); return; }
    }
    unmountAll();
    state.note = n.id;
    setView('note');
    $('#noteBack').href = '#day/' + n.date;
    const subj = $('#noteSubject');
    subj.value = n.subject || '';
    subj.oninput = () => { n.subject = subj.value.trim(); Store.save(n); };
    fill($('#subjectList'), ...subjects().map(s => el('option', { value: s })));
    const d = $('#noteDate');
    d.value = n.date;
    d.onchange = () => { if (isDate(d.value)) { n.date = d.value; $('#noteBack').href = '#day/' + n.date; Store.save(n); } };
    const paper = $('#notePaper');
    paper.value = n.paper;
    const wrap = $('#notePage');
    fill(wrap, );
    wrap.style.height = '';
    const surface = new Surface(wrap, n, { paper: () => n.paper, grow: true, onChange: () => Store.save(n) });
    paper.onchange = () => { n.paper = paper.value; lsSet('pp-paper', n.paper); Store.save(n); surface.render(); };
    $('#notePdf').onclick = () => { Store.flushAll(); notesToPdf([n], n.subject || 'Study note'); };
    $('#noteDelete').onclick = async () => {
      if (!(await ask('Delete this study note?', 'Delete'))) return;
      Store.remove(n.id);
      go('day/' + n.date);
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
    renderStudyOverview();
    const all = Store.list('note').filter(n => n.strokes.length || n.subject);
    const subs = subjects();
    if (state.filter && !subs.includes(state.filter)) state.filter = null;
    const chip = (label, val) => el('button', { class: state.filter === val ? 'on' : '', onclick: () => { state.filter = val; showLibrary(); } }, label);
    fill($('#subjectChips'), ...(subs.length ? [chip('All', null), ...subs.map(s => chip(s, s))] : []));
    const list = all.filter(n => !state.filter || n.subject === state.filter)
      .sort((a, b) => b.date.localeCompare(a.date) || b.created - a.created);
    fill($('#libGrid'), ...list.map(n => noteCard(n, true)));
    $('#libPdf').hidden = !list.length;
    $('#libPdf').onclick = () => notesToPdf(list, state.filter || 'Study notes');
    $('#libEmpty').hidden = list.length > 0;
  }
  $('#libNew').addEventListener('click', () => newNote(today()));

  // ---------- settings kept with your data ----------
  const Config = {
    get(id, def) { const it = Store.items.get('cfg-' + id); return it ? it.value : def; },
    set(id, value) { Store.save({ id: 'cfg-' + id, kind: 'config', value }); },
  };

  // ---------- morning & night routines ----------
  // Each step can have the minutes it takes (used by "Find a time") and the weekdays it's for (0 = Sunday).
  const DEFAULT_ROUTINES = {
    morning: [
      { id: 'm-water', label: 'Drink a big glass of water', mins: 5 },
      { id: 'm-skin', label: 'Morning skincare: cleanse, moisturiser, sunscreen', mins: 10 },
      { id: 'm-breakfast', label: 'Eat a real breakfast (from my meal prep)', mins: 20 },
      { id: 'm-lunch', label: 'Pack lunch, snacks and a water bottle', mins: 10 },
      { id: 'm-plan', label: "Look over today's calendar and tasks", mins: 5 },
      { id: 'm-study', label: 'Study for 30 minutes', mins: 30 },
    ],
    night: [
      { id: 'n-dinner', label: 'Eat a home-made dinner', mins: 30 },
      { id: 'n-food', label: "Check tomorrow's meals are ready", mins: 10 },
      { id: 'n-mealprep', label: 'Weekly meal prep: plan, shop and cook', mins: 120, days: [0] },
      { id: 'n-skin', label: 'Night skincare: remove makeup, cleanse, treatment, moisturiser', mins: 10 },
      { id: 'n-read', label: 'Read for 20 minutes, no screens', mins: 20 },
      { id: 'n-top3', label: "Pick tomorrow's top 3 tasks", mins: 5 },
    ],
  };
  const OLD_DEFAULT_IDS = 'm1,m2,m3,m4|n1,n2,n3,n4';
  const DAY_SETS = [['', 'Every day'], ['1,2,3,4,5', 'Weekdays'], ['0,6', 'Weekends'], ['0', 'Sundays'], ['6', 'Saturdays'], ['1', 'Mondays']];
  const RT = {
    morning: { title: 'Morning routine', icon: '☀︎', cls: 'sun' },
    night: { title: 'Night routine', icon: '☾', cls: 'moon' },
  };
  const routines = () => Config.get('routines', DEFAULT_ROUTINES);
  const stepOn = (st, date) => !Array.isArray(st.days) || !st.days.length || st.days.includes(parse(date).getDay());
  const stepsOn = (which, date) => routines()[which].filter(st => stepOn(st, date));
  // Once: swap the old sample routines for the skincare / meal prep / reading / study routines.
  function migrateRoutines() {
    if (Config.get('routinesV', 1) >= 2) return;
    Config.set('routines', DEFAULT_ROUTINES);
    Config.set('routinesV', 2);
  }
  const logOf = date => Store.items.get('rt-' + date);
  const isDone = (date, id) => { const l = logOf(date); return !!(l && l.done[id]); };
  const doneCount = (which, date) => stepsOn(which, date).filter(i => isDone(date, i.id)).length;
  const fullDay = (which, date) => { const it = stepsOn(which, date); return it.length > 0 && doneCount(which, date) === it.length; };

  function toggleStep(date, id) {
    const l = logOf(date) || { id: 'rt-' + date, kind: 'routine-day', date, done: {} };
    if (l.done[id]) delete l.done[id]; else l.done[id] = true;
    Store.save(l);
  }

  function streak(which) {
    let d = today();
    if (!fullDay(which, d)) d = addDays(d, -1);
    let n = 0;
    while (n < 3660 && fullDay(which, d)) { n++; d = addDays(d, -1); }
    return n;
  }
  const streakText = n => n ? `🔥 ${n}-day streak` : 'No streak yet';

  function renderRoutineCard(which) {
    const card = $('#' + which + 'Card');
    const date = state.date, items = stepsOn(which, date), info = RT[which];
    const done = doneCount(which, date);
    const week = [];
    for (let i = 6; i >= 0; i--) {
      const d = addDays(date, -i), c = doneCount(which, d), n = stepsOn(which, d).length;
      week.push(el('a', { href: '#day/' + d, class: d === date ? 'cur' : '', title: fmt(d, { weekday: 'long', month: 'short', day: 'numeric' }) },
        el('span', { class: 'pip' + (n && c === n ? ' full' : c ? ' part' : '') }),
        fmt(d, { weekday: 'narrow' })));
    }
    const s = streak(which);
    fill(card, 
      el('div', { class: 'card-head' },
        el('h2', {}, el('span', { class: 'ico ' + info.cls }, info.icon), info.title),
        el('span', { class: 'muted' }, items.length ? `${done} of ${items.length}` : '')),
      items.length
        ? el('ul', { class: 'routine' }, items.map(i => el('li', {},
          el('button', {
            class: 'rcheck' + (isDone(date, i.id) ? ' on' : ''), 'aria-pressed': String(isDone(date, i.id)),
            onclick: () => { toggleStep(date, i.id); renderRoutineCard(which); if (fullDay(which, date)) toast(`${info.title} done! ${streakText(streak(which))}`); },
          }, el('span', { class: 'box' }), el('span', { class: 'label' }, i.label, i.days && i.days.length ? el('small', { class: 'muted' }, ' · ' + daysText(i.days)) : null)))))
        : el('p', { class: 'muted small' }, 'No steps yet. Tap Edit to add some.'),
      el('div', { class: 'routine-foot' },
        el('div', { class: 'week' }, week),
        el('span', { class: 'streak' + (s ? ' hot' : '') }, streakText(s)),
        EMBED && date >= today() && done < items.length ? el('button', { class: 'mini', title: 'Find a free time in your calendar for a step you haven\'t done', onclick: () => openFindTime(which, items.find(i => !isDone(date, i.id)), date) }, '⏱ Find a time') : null,
        el('button', { class: 'mini', onclick: () => editRoutine(which) }, 'Edit')));
  }

  let editing = null;
  function editRoutine(which) {
    editing = { which, steps: routines()[which].map(s => ({ ...s })) };
    $('#routineDlgTitle').textContent = RT[which].title;
    drawSteps();
    $('#routineDlg').showModal();
  }
  function drawSteps() {
    const list = $('#routineSteps');
    fill(list, ...editing.steps.map((s, i) => el('li', {}, el('div', { class: 'row' },
      el('input', { value: s.label, placeholder: 'e.g. Drink water', 'aria-label': 'Step ' + (i + 1), oninput: e => { s.label = e.target.value; } }),
      el('select', { class: 'stepdays', 'aria-label': 'Which days', onchange: e => { s.days = e.target.value ? e.target.value.split(',').map(Number) : undefined; } },
        DAY_SETS.concat(s.days && s.days.length && !DAY_SETS.some(([v]) => v === s.days.join(',')) ? [[s.days.join(','), daysText(s.days)]] : [])
          .map(([v, label]) => el('option', { value: v, selected: v === (s.days || []).join(',') ? true : null }, label))),
      el('input', { class: 'stepmins', type: 'number', min: '5', max: '240', step: '5', value: s.mins || '', placeholder: 'min', title: 'Minutes it takes', 'aria-label': 'Minutes', oninput: e => { s.mins = Math.max(0, Math.min(240, parseInt(e.target.value, 10) || 0)) || undefined; } }),
      el('button', { type: 'button', class: 'icon-btn sm', title: 'Move up', 'aria-label': 'Move up', disabled: i === 0,
        onclick: () => { editing.steps.splice(i - 1, 0, editing.steps.splice(i, 1)[0]); drawSteps(); } }, '↑'),
      el('button', { type: 'button', class: 'icon-btn sm', title: 'Remove', 'aria-label': 'Remove step',
        onclick: () => { editing.steps.splice(i, 1); drawSteps(); } }, '×')))));
  }
  $('#addStep').addEventListener('click', () => {
    editing.steps.push({ id: uid(), label: '' });
    drawSteps();
    const inputs = $('#routineSteps').querySelectorAll('input');
    inputs[inputs.length - 1].focus();
  });
  $('#routineCancel').addEventListener('click', () => $('#routineDlg').close());
  $('#routineSave').addEventListener('click', () => {
    const all = { ...routines() };
    all[editing.which] = editing.steps.map(s => {
      const o = { id: s.id, label: s.label.trim() };
      if (s.mins) o.mins = s.mins;
      if (s.days && s.days.length) o.days = s.days;
      return o;
    }).filter(s => s.label);
    Config.set('routines', all);
    $('#routineDlg').close();
    route();
  });

  function showRoutines() {
    unmountAll();
    setView('routines');
    const N = 30, t = today();
    const dates = Array.from({ length: N }, (_, i) => addDays(t, i - N + 1));
    const cols = `minmax(110px, 180px) repeat(${N}, minmax(14px, 1fr))`;
    const box = $('#routineTrack');
    fill(box, ...['morning', 'night'].map(which => {
      const items = routines()[which], info = RT[which];
      const fullLast = n => dates.slice(-n).filter(d => fullDay(which, d)).length;
      const possible = dates.reduce((a, d) => a + stepsOn(which, d).length, 0);
      const pct = possible ? Math.round(100 * dates.reduce((a, d) => a + doneCount(which, d), 0) / possible) : 0;
      const grid = el('div', { class: 'track-grid', style: `grid-template-columns:${cols}` });
      grid.append(el('span'), ...dates.map(d => el('span', { class: 'dh' + (d === t ? ' today' : '') },
        fmt(d, { weekday: 'narrow' }), el('br'), String(parse(d).getDate()))));
      for (const it of items) {
        grid.append(el('span', { class: 'lbl', title: it.label },
          EMBED ? el('button', { class: 'findbtn', title: 'Find a time for this', 'aria-label': 'Find a time for ' + it.label, onclick: () => openFindTime(which, it, t) }, '⏱') : null,
          el('span', {}, it.label)));
        for (const d of dates) {
          if (!stepOn(it, d)) { grid.append(el('span', { class: 'cell off', title: 'Not a day for this step' })); continue; }
          grid.append(el('button', {
            class: 'cell' + (isDone(d, it.id) ? ' on' : ''), title: `${it.label} · ${fmt(d, { month: 'short', day: 'numeric' })}`,
            'aria-label': `${it.label}, ${fmt(d, { month: 'long', day: 'numeric' })}, ${isDone(d, it.id) ? 'done' : 'not done'}`,
            onclick: () => { toggleStep(d, it.id); showRoutines(); },
          }));
        }
      }
      if (items.length) {
        grid.append(el('span', { class: 'lbl all' }, 'Whole routine'));
        for (const d of dates) {
          const c = doneCount(which, d), n = stepsOn(which, d).length;
          grid.append(el('span', { class: 'cell' + (n && c === n ? ' on' : c ? ' part' : '') }));
        }
      }
      return el('section', { class: 'card track-card ' + which },
        el('div', { class: 'card-head' },
          el('h2', {}, el('span', { class: 'ico ' + info.cls }, info.icon), info.title),
          el('span', { class: 'head-actions' },
            EMBED ? el('button', { class: 'mini', onclick: () => openFindTime(which, stepsOn(which, t).find(i => !isDone(t, i.id)) || items[0], t) }, '⏱ Find a time') : null,
            el('button', { class: 'mini', onclick: () => editRoutine(which) }, 'Edit steps'))),
        el('div', { class: 'stats' },
          el('span', {}, el('b', {}, String(streak(which))), 'day streak'),
          el('span', {}, el('b', {}, `${fullLast(7)}/7`), 'full days this week'),
          el('span', {}, el('b', {}, `${fullLast(30)}/30`), 'full days this month'),
          el('span', {}, el('b', {}, pct + '%'), 'of steps done')),
        items.length ? el('div', { class: 'track' }, grid) : el('p', { class: 'muted small' }, 'No steps yet.'));
    }));
  }


  // ---------- find a time for a habit ----------
  const daysText = days => { const k = days.join(','); const f = DAY_SETS.find(([v]) => v === k); return f ? f[1] : days.map(d => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d]).join(', '); };
  let findCtx = null;
  async function openFindTime(which, step, date) {
    if (!EMBED) return;
    const all = [...routines().morning.map(s => ['morning', s]), ...routines().night.map(s => ['night', s])];
    findCtx = { which, step: step || all[0][1], date: date && date >= today() ? date : today() };
    fill($('#ftStep'), [['morning', 'Morning routine'], ['night', 'Night routine']].map(([w, label]) => el('optgroup', { label },
      routines()[w].map(s => el('option', { value: w + '|' + s.id, selected: s.id === findCtx.step.id ? true : null }, s.label)))));
    $('#ftMins').value = String(findCtx.step.mins || 30);
    $('#ftMsg').textContent = '';
    let cals = [];
    try { cals = await calendarList(); } catch { /* none */ }
    const h = hiddenCals(), ok = cals.filter(c => c.writable && !c.busyOnly && c.role !== 'reader' && c.role !== 'freeBusyReader').sort((a, b) => h.has(a.id) - h.has(b.id));
    const pick = ok.find(c => !h.has(c.id) && c.id === Config.get('lastCal', null)) || ok.find(c => !h.has(c.id)) || ok[0];
    fill($('#ftCal'), ok.map(c => el('option', { value: c.id, selected: pick && c.id === pick.id ? true : null }, c.label)));
    $('#findDlg').showModal();
    drawSlots();
  }
  $('#ftStep').addEventListener('change', e => {
    const [w, id] = e.target.value.split('|');
    const st = routines()[w].find(s => s.id === id);
    if (!st) return;
    findCtx.which = w; findCtx.step = st;
    $('#ftMins').value = String(st.mins || 30);
    drawSlots();
  });
  $('#ftMins').addEventListener('change', () => drawSlots());
  $('#ftClose').addEventListener('click', () => $('#findDlg').close());

  // Free times over the next 3 days: mornings for morning steps, evenings for night steps, never before 6:30 or after 23:00.
  async function drawSlots() {
    const ctx = findCtx, box = $('#ftSlots'), mins = parseInt($('#ftMins').value, 10) || 30, len = mins * 60e3;
    fill(box, el('p', { class: 'muted small' }, 'Looking at your calendar…'));
    let events;
    try { events = visibleEvents(await fetchEvents(ctx.date, addDays(ctx.date, 3))); }
    catch (err) { if (findCtx === ctx) fill(box, el('p', { class: 'small' }, connectorProblem(err)[0])); return; }
    if (findCtx !== ctx) return;
    const busy = events.filter(e => !e.allDay && e.end > e.start).map(e => [e.start - 5 * 60e3, e.end + 5 * 60e3]);
    const win = ctx.which === 'morning' ? [[6, 30], [12, 0]] : [[17, 0], [23, 0]];
    const days = [];
    for (let k = 0; k < 3; k++) {
      const d = addDays(ctx.date, k);
      if (!stepOn(ctx.step, d) && ctx.step.days) continue;
      const at = (hh, mm) => new Date(`${d}T${pad(hh)}:${pad(mm)}:00`).getTime();
      let t = Math.max(at(...win[0]), Math.ceil((Date.now() + 10 * 60e3) / 9e5) * 9e5);
      const end = at(...win[1]), slots = [];
      while (t + len <= end && slots.length < 4) {
        const hit = busy.find(([a, b]) => a < t + len && t < b);
        if (hit) { t = Math.ceil(hit[1] / 9e5) * 9e5; continue; }
        slots.push(t);
        t += Math.max(len, 60 * 60e3); // spread the suggestions out
      }
      days.push([d, slots]);
    }
    if (!days.some(([, sl]) => sl.length)) {
      fill(box, el('p', { class: 'small' }, `No free ${mins} minutes in the ${ctx.which === 'morning' ? 'mornings' : 'evenings'} of the next 3 days. Try a shorter time.`));
      return;
    }
    fill(box, days.filter(([, sl]) => sl.length).map(([d, sl]) => el('div', { class: 'ftday' },
      el('h3', {}, d === today() ? 'Today' : d === addDays(today(), 1) ? 'Tomorrow' : fmt(d, { weekday: 'long', day: 'numeric', month: 'short' })),
      el('div', { class: 'ftslots' }, sl.map(t => el('button', { class: 'mini slot', onclick: () => bookSlot(ctx, t, len) }, `${timeOf(t)} – ${timeOf(t + len)}`))))));
  }
  async function bookSlot(ctx, t, len) {
    const msg = $('#ftMsg'), calId = $('#ftCal').value;
    const local = ms => { const x = new Date(ms); return `${iso(x)}T${pad(x.getHours())}:${pad(x.getMinutes())}:00`; };
    const title = 'Focus: ' + ctx.step.label;
    const input = { summary: title, startTime: local(t), endTime: local(t + len), description: `Time for your ${ctx.which} routine step "${ctx.step.label}". Scheduled from Pen Planner.` };
    if (calId) input.calendarId = calId;
    msg.textContent = 'Adding it to your calendar…';
    $('#ftSlots').querySelectorAll('button').forEach(b => { b.disabled = true; });
    try {
      await calCall('create_event', input);
      Config.set('lastCal', calId || '');
      $('#findDlg').close();
      toast(`Scheduled ${fmt(iso(new Date(t)), { weekday: 'short' })} ${timeOf(t)}: ${ctx.step.label}`, 4000);
      afterEventChange(iso(new Date(t)));
    } catch (err) {
      console.warn(err);
      msg.textContent = eventProblem(err);
      $('#ftSlots').querySelectorAll('button').forEach(b => { b.disabled = false; });
    }
  }

  // ---------- month calendar ----------
  function showMonth(month, force) {
    unmountAll();
    state.month = month;
    setView('calendar');
    const [y, m] = month.split('-').map(Number);
    const first = new Date(y, m - 1, 1), t = today();
    const nextMonth = iso(new Date(y, m, 1)).slice(0, 7), prevMonth = iso(new Date(y, m - 2, 1)).slice(0, 7);
    $('#monthTitle').textContent = first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    $('#prevMonth').onclick = () => go('calendar/' + prevMonth);
    $('#nextMonth').onclick = () => go('calendar/' + nextMonth);
    $('#thisMonth').onclick = () => go('calendar/' + t.slice(0, 7));
    $('#thisMonth').hidden = month === t.slice(0, 7);

    // Sunday-first grid covering the whole month
    const start = iso(new Date(y, m - 1, 1 - first.getDay()));
    const daysInMonth = new Date(y, m, 0).getDate();
    const weeks = Math.ceil((first.getDay() + daysInMonth) / 7);
    const dates = Array.from({ length: weeks * 7 }, (_, i) => addDays(start, i));
    const end = addDays(dates[dates.length - 1], 1);

    const tasks = Store.list('task').filter(x => x.strokes.length && x.date >= start && x.date < end);
    const notes = Store.list('note').filter(n => (n.strokes.length || n.subject) && n.date >= start && n.date < end);
    const R = routines();
    const pip = (which, d) => {
      const n = R[which].length, c = doneCount(which, d);
      return el('span', { class: `rp ${which}` + (n && c === n ? ' full' : c ? ' part' : ''), title: `${RT[which].title}: ${c} of ${n}` });
    };

    const grid = $('#monthGrid');
    const cells = new Map();
    fill(grid, 
      ...Array.from({ length: 7 }, (_, i) => el('span', { class: 'mdow' }, fmt(dates[i], { weekday: 'short' }))),
      ...dates.map(d => {
        const dayTasks = tasks.filter(x => x.date === d);
        const open = dayTasks.filter(x => !x.done).length;
        const nNotes = notes.filter(n => n.date === d).length;
        const sItems = planItemsOn(d).map(r => r.it), sDone = sItems.filter(it => it.done).length;
        const evBox = el('span', { class: 'mev' });
        const marks = el('span', { class: 'mmarks' },
          dayTasks.length ? el('span', { class: 'mt' + (open ? '' : ' alldone'), title: open ? `${open} task${open === 1 ? '' : 's'} to do` : 'All tasks done' },
            open ? `${open} to do` : '✓ done') : null,
          nNotes ? el('span', { class: 'mn', title: `${nNotes} study note${nNotes === 1 ? '' : 's'}` }, `${nNotes} note${nNotes === 1 ? '' : 's'}`) : null,
          sItems.length ? el('span', { class: 'ms' + (sDone === sItems.length ? ' alldone' : ''), title: `Study plan: ${sDone} of ${sItems.length} done` }, sDone === sItems.length ? '✓ study' : `${sItems.length - sDone} study`) : null,
          photoOf(d) ? el('img', { class: 'mphoto', src: photoSrc(photoOf(d)), alt: '' }) : null,
          d <= t ? el('span', { class: 'rps' }, pip('morning', d), pip('night', d)) : null);
        const cell = el('div', {
          class: 'mcell' + (d.slice(0, 7) !== month ? ' out' : '') + (d === t ? ' today' : ''),
          onclick: e => { if (!e.target.closest('.me')) go('day/' + d); },
        }, el('button', { class: 'mnum', 'aria-label': 'Open ' + fmt(d, { weekday: 'long', month: 'long', day: 'numeric' }) }, String(parse(d).getDate())), evBox, marks);
        cells.set(d, evBox);
        return cell;
      }));

    // Google Calendar events, filled in when they arrive
    const status = $('#monthStatus');
    if (!EMBED && !Cal.url()) {
      fill(status, el('span', {}, 'Connect Google Calendar to see your events here. '),
        el('button', { class: 'mini', onclick: openCalSetup }, 'Connect'));
      return;
    }
    fill(status, el('span', { class: 'muted' }, 'Loading your Google calendars…'));
    $('#monthAdd').hidden = !EMBED;
    $('#monthAdd').onclick = () => openEventEditor(null, month === t.slice(0, 7) ? t : month + '-01');
    fetchEvents(start, end, force).then(all => {
      if (state.month !== month || !document.body.classList.contains('view-calendar')) return;
      renderCalChips($('#calChips'), () => showMonth(month));
      const events = visibleEvents(all);
      const byDay = new Map();
      for (const ev of events) for (const d of eventDays(ev)) {
        if (!byDay.has(d)) byDay.set(d, []);
        byDay.get(d).push(ev);
      }
      for (const [d, box] of cells) {
        const list = byDay.get(d) || [];
        fill(box, ...list.slice(0, 3).map(ev => el('button', { class: 'me' + (ev.allDay ? ' allday' : ''), style: `--ec:${ev.color || CAL_COLORS[0]}`,
            title: ev.title || '', onclick: () => { if (ev.busy) go('day/' + iso(new Date(ev.start))); else if (!ev.allDay) openClassFor(ev); else if (EMBED && ev.id) openEventEditor(ev); else go('day/' + iso(new Date(ev.start))); } },
          ev.allDay ? '' : el('b', {}, timeOf(ev.start).replace(/:00(?=\D|$)/, '')), ev.busy ? 'Busy' : ev.title || '(No title)')),
          list.length > 3 ? el('span', { class: 'more' }, `+${list.length - 3} more`) : null,
          list.length ? el('span', { class: 'mcount', 'aria-hidden': 'true' }, String(list.length)) : null);
      }
      const n = events.length;
      fill(status, el('span', { class: 'muted' }, `${n} event${n === 1 ? '' : 's'} this month` + (all.failed && all.failed.length ? ` · couldn't read ${all.failed.join(', ')}` : '')),
        el('button', { class: 'icon-btn sm', title: 'Refresh', 'aria-label': 'Refresh calendar', onclick: () => showMonth(month, true) }, '↻'));
    }).catch(err => {
      if (state.month !== month) return;
      console.warn(err);
      if (EMBED) {
        const [msg, action] = connectorProblem(err);
        fill(status, el('span', {}, msg + ' '),
          action ? el('button', { class: 'mini', onclick: () => showMonth(month, true) }, action[0]) : null);
      } else {
        fill(status, el('span', {}, (err && err.message) || "Couldn't load your calendar."), el('button', { class: 'mini', onclick: openCalSetup }, 'Check connection'));
      }
    });
  }

  // ---------- Google Calendar (through the user's own Apps Script web app) ----------
  const CAL_SCRIPT = `// Pen Planner: sends your Google Calendar events to your planner.
// It only reads your calendars. It never changes them.
function doGet(e) {
  var p = (e && e.parameter) || {};
  var from = new Date(Number(p.from)), to = new Date(Number(p.to));
  if (isNaN(from) || isNaN(to) || to - from > 62 * 864e5) return send({ error: 'Bad dates' });
  var events = [];
  CalendarApp.getAllCalendars().forEach(function (cal) {
    if (cal.isHidden() || !cal.isSelected()) return;
    cal.getEvents(from, to).forEach(function (ev) {
      events.push({
        title: ev.getTitle(), start: ev.getStartTime().getTime(), end: ev.getEndTime().getTime(),
        allDay: ev.isAllDayEvent(), location: ev.getLocation(), calendar: cal.getName(), color: cal.getColor()
      });
    });
  });
  events.sort(function (a, b) { return (b.allDay - a.allDay) || (a.start - b.start); });
  return send({ events: events });
}
function send(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
`;
  const Cal = {
    cache: new Map(),
    url() { return Config.get('calendarUrl', ''); },
    async load(date, url = this.url(), force = false, until = addDays(date, 1)) {
      const key = date + '_' + until;
      if (!force && this.cache.has(key)) return this.cache.get(key);
      const from = parse(date).getTime(), to = parse(until).getTime();
      let res;
      try { res = await fetch(`${url}${url.includes('?') ? '&' : '?'}from=${from}&to=${to}`); }
      catch { throw new Error("Couldn't reach Google. Are you online?"); }
      if (!res.ok) throw new Error(`Google answered with an error (${res.status}).`);
      let data;
      try { data = await res.json(); }
      catch { throw new Error('Google sent a sign-in page instead of your events. In the deployment, set "Who has access" to "Anyone".'); }
      if (data.error || !Array.isArray(data.events)) throw new Error(data.error || 'Unexpected reply from the script.');
      this.cache.set(key, data.events);
      return data.events;
    },
  };
  const timeOf = ms => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

  // Inside Claude: read events through the viewer's Google Calendar connector.
  // Events from `from` (inclusive) to `to` (exclusive), both YYYY-MM-DD.
  async function connectorEvents(from, to, force, calendarId) {
    const mcp = await window.claude.use('mcp').catch(() => null);
    if (!mcp) throw { code: 'no_mcp' };
    const list = [];
    let pageToken, role = '';
    for (let page = 0; page < 5; page++) {
      const input = { startTime: from + 'T00:00:00', endTime: to + 'T00:00:00', orderBy: 'startTime', pageSize: 250 };
      if (calendarId) input.calendarId = calendarId;
      if (pageToken) input.pageToken = pageToken;
      const res = await mcp.callTool('Google Calendar', 'list_events', input, force ? { cache: false } : undefined);
      const pl = (res && res.payload) || {};
      if (Array.isArray(pl.events)) list.push(...pl.events);
      if (typeof pl.accessRole === 'string') role = pl.accessRole;
      pageToken = typeof pl.nextPageToken === 'string' && pl.nextPageToken ? pl.nextPageToken : null;
      if (!pageToken) break;
    }
    const out = list.filter(e => e && e.status !== 'cancelled').map(e => {
      const s = e.start || {}, f = e.end || {};
      const allDay = !s.dateTime;
      const start = allDay ? (isDate(s.date) ? parse(s.date).getTime() : 0) : Date.parse(s.dateTime);
      const end = allDay ? (isDate(f.date) ? parse(f.date).getTime() : start + 864e5) : (f.dateTime ? Date.parse(f.dateTime) : start);
      return { id: typeof e.id === 'string' ? e.id : '', title: e.summary || '', allDay, location: e.location || '', description: typeof e.description === 'string' ? e.description : '', start, end };
    }).sort((a, b) => (b.allDay - a.allDay) || (a.start - b.start));
    out.accessRole = role;
    return out;
  }
  // The days (YYYY-MM-DD) an event shows on. All-day events end the day before `end`.
  function eventDays(ev) {
    const first = iso(new Date(ev.start));
    if (!ev.allDay) return [first];
    const last = ev.end > ev.start ? iso(new Date(ev.end - 1)) : first;
    const days = [];
    for (let d = first; d <= last && days.length < 62; d = addDays(d, 1)) days.push(d);
    return days;
  }
  // ---- several Google calendars ----
  const CAL_COLORS = ['#3f6fd8', '#2e9b6a', '#c2453d', '#8a4fd6', '#d08a12', '#0e8a9a', '#c2489a', '#5b6778'];
  const Cals = { list: null, seen: new Map() };
  const hiddenCals = () => new Set(Config.get('hiddenCals', []));
  function setCalHidden(id, hide) {
    const h = hiddenCals();
    if (hide) h.add(id); else h.delete(id);
    Config.set('hiddenCals', [...h]);
  }
  const isHolidayCal = id => /#holiday@group\.v\.calendar\.google\.com$/.test(id || '');

  // The viewer's calendars (inside Claude: from the connector; on GitHub: the ones events came from).
  async function calendarList(force) {
    if (!EMBED) return [...Cals.seen.values()];
    if (Cals.list && !force) return Cals.list;
    const mcp = await window.claude.use('mcp').catch(() => null);
    if (!mcp) throw { code: 'no_mcp' };
    const out = [];
    let pageToken;
    try {
      for (let page = 0; page < 4; page++) {
        const res = await mcp.callTool('Google Calendar', 'list_calendars', pageToken ? { pageToken } : {}, force ? { cache: false } : undefined);
        const pl = (res && res.payload) || {};
        if (Array.isArray(pl.calendars)) out.push(...pl.calendars);
        pageToken = typeof pl.nextPageToken === 'string' && pl.nextPageToken ? pl.nextPageToken : null;
        if (!pageToken) break;
      }
    } catch (err) {
      // Can't list calendars: fall back to the main calendar (and try the list again next time).
      console.warn(err);
      return [{ id: '', name: 'My calendar', label: 'My calendar', color: CAL_COLORS[0], writable: true }];
    }
    const cals = out.filter(c => c && typeof c.id === 'string').map(c => ({ id: c.id, name: String(c.summary || c.id), busyOnly: c.accessRole === 'freeBusyReader' }));
    // calendars added by their address (shared with this Google account but not in its list)
    for (const x of Config.get('extraCals', [])) if (x && x.id && !cals.some(c => c.id === x.id)) cals.push({ id: x.id, name: x.name || x.id, added: true });
    cals.sort((a, b) => isHolidayCal(a.id) - isHolidayCal(b.id)); // your own calendars first, holidays last
    cals.forEach((c, i) => {
      c.color = CAL_COLORS[i % CAL_COLORS.length];
      c.label = isHolidayCal(c.id) ? c.name.replace(/^Holidays in /, '') + ' holidays' : c.name;
      c.writable = !isHolidayCal(c.id);
    });
    Cals.list = cals.length ? cals : [{ id: '', name: 'My calendar', label: 'My calendar', color: CAL_COLORS[0], writable: true }];
    applyCalSeed(Cals.list);
    return Cals.list;
  }

  // A private list of calendars to show (added to the published page only): everything else starts hidden.
  function applyCalSeed(cals) {
    const tag = document.getElementById('calSeed');
    if (!tag) return;
    let seed;
    try { seed = JSON.parse(tag.textContent); } catch { return; }
    if (!seed || !Array.isArray(seed.show) || Config.get('calSeeded', 0) >= (seed.version || 1)) return;
    const want = seed.show.map(x => String(x).toLowerCase());
    const match = c => want.some(w => (c.name + ' ' + c.id).toLowerCase().includes(w));
    if (!cals.some(match)) return; // not this account's calendars: leave as is
    Config.set('hiddenCals', cals.filter(c => !match(c)).map(c => c.id));
    Config.set('calSeeded', seed.version || 1);
  }

  // Events from every calendar. Hidden calendars are filtered when drawing, so switching is instant.
  // `events.failed` lists calendars that couldn't be read.
  async function fetchEvents(from, to, force) {
    if (!EMBED) {
      const evs = await Cal.load(from, Cal.url(), force, to);
      return evs.map(e => {
        const id = e.calendar || 'Calendar';
        if (!Cals.seen.has(id)) Cals.seen.set(id, { id, name: id, label: id, color: /^#[0-9a-f]{3,8}$/i.test(e.color || '') ? e.color : CAL_COLORS[Cals.seen.size % CAL_COLORS.length] });
        return { ...e, calId: id, color: Cals.seen.get(id).color };
      });
    }
    const cals = await calendarList(force);
    const results = await Promise.allSettled(cals.map(c => connectorEvents(from, to, force, c.id || undefined)));
    const events = [], failed = [];
    let firstErr = null;
    results.forEach((r, i) => {
      const c = cals[i];
      if (r.status === 'fulfilled') {
        // a calendar shared as "free/busy only" gives times without names
        if (r.value.accessRole) c.role = r.value.accessRole;
        if (r.value.accessRole === 'freeBusyReader') c.busyOnly = true;
        else if (r.value.accessRole) c.busyOnly = false;
        else if (r.value.length && r.value.every(e => !e.title && !e.description && !e.location)) c.busyOnly = true;
        else if (r.value.some(e => e.title)) c.busyOnly = false;
        r.value.forEach(e => events.push({ ...e, calId: c.id, color: c.color, busy: !!c.busyOnly && !e.title }));
      }
      else { failed.push(c.label); firstErr = firstErr || r.reason; }
    });
    if (cals.length && failed.length === cals.length) throw firstErr;
    events.sort((a, b) => (b.allDay - a.allDay) || (a.start - b.start));
    events.failed = failed;
    return events;
  }
  // Hidden calendars are left out, and the same event on two calendars (same name and time) shows once.
  const visibleEvents = events => {
    const h = hiddenCals(), seen = new Set(), out = [];
    for (const e of events) {
      if (h.has(e.calId)) continue;
      const key = (e.title || '').trim().toLowerCase() + '|' + e.start + '|' + e.end;
      if (e.title && seen.has(key)) continue;
      seen.add(key);
      out.push(e);
    }
    return out;
  };

  // Buttons to switch each calendar on and off
  async function renderCalChips(box, onChange) {
    let cals;
    try { cals = await calendarList(); } catch { fill(box); return; }
    const h = hiddenCals();
    const manage = EMBED ? el('button', { class: 'calchip all', title: 'Add or remove calendars', onclick: () => openCalendars(onChange) }, '+ Calendars') : null;
    const busyHint = EMBED && cals.some(c => c.busyOnly && !h.has(c.id)) ? el('button', { class: 'calchip all', onclick: () => openCalendars(onChange) }, 'Only seeing "Busy"? How to fix') : null;
    if (cals.length < 2) { fill(box, manage, busyHint); return; }
    fill(box,
      cals.filter(c => !h.has(c.id)).map(c => el('button', {
        class: 'calchip' + (h.has(c.id) ? '' : ' on'), style: `--ec:${c.color}`, 'aria-pressed': String(!h.has(c.id)),
        title: (h.has(c.id) ? 'Show ' : 'Hide ') + c.label,
        onclick: () => { setCalHidden(c.id, !hiddenCals().has(c.id)); onChange(); },
      }, el('span', { class: 'sw' }), c.label, c.busyOnly ? el('small', { class: 'busytag' }, ' busy only') : null)),
      manage, busyHint);
  }

  // ---- add calendars by their address ----
  let calsChanged = null;
  async function openCalendars(onChange) {
    calsChanged = onChange;
    $('#acId').value = ''; $('#acName').value = ''; $('#acMsg').textContent = '';
    await drawCalendarList();
    $('#calsDlg').showModal();
  }
  async function drawCalendarList() {
    let cals = [];
    try { cals = await calendarList(); } catch { /* shown as empty */ }
    const h = hiddenCals();
    $('#busyHelp').open = cals.some(c => c.busyOnly);
    fill($('#calsList'), cals.map(c => el('li', { style: `--ec:${c.color}` },
      el('label', { class: 'inline-check' },
        el('input', { type: 'checkbox', checked: h.has(c.id) ? null : true, onchange: e => { setCalHidden(c.id, !e.target.checked); if (calsChanged) calsChanged(); } }),
        el('span', { class: 'sw' }), el('span', {}, c.label, c.added ? el('small', { class: 'muted' }, ' · added by you') : null, c.busyOnly ? el('small', { class: 'busytag' }, ' · shares only busy times') : null)),
      c.added ? el('button', { class: 'mini', onclick: () => removeExtraCal(c.id) }, 'Remove') : null)));
  }
  function removeExtraCal(id) {
    Config.set('extraCals', Config.get('extraCals', []).filter(x => x.id !== id));
    Cals.list = null;
    drawCalendarList();
    if (calsChanged) calsChanged();
  }
  $('#acAdd').addEventListener('click', async () => {
    const id = $('#acId').value.trim(), name = $('#acName').value.trim(), msg = $('#acMsg');
    if (!/^[^\s@]+@[^\s@]+$/.test(id)) { msg.textContent = 'Type the calendar\'s address, like name@gmail.com.'; return; }
    if ((Cals.list || []).some(c => c.id === id)) { msg.textContent = 'That calendar is already in your planner.'; return; }
    msg.textContent = 'Checking that the planner can read it…';
    try {
      await connectorEvents(today(), addDays(today(), 1), true, id);
    } catch (err) {
      console.warn(err);
      msg.textContent = err && err.code === 'tool_error'
        ? 'Google says this calendar isn\'t shared with your connected account. Share it first (see the steps above), then try again.'
        : connectorProblem(err)[0];
      return;
    }
    Config.set('extraCals', Config.get('extraCals', []).concat([{ id, name: name || id }]));
    Cals.list = null;
    $('#acId').value = ''; $('#acName').value = '';
    msg.textContent = 'Added.';
    await drawCalendarList();
    if (calsChanged) calsChanged();
  });
  $('#acClose').addEventListener('click', () => $('#calsDlg').close());

  // ---- add, change and delete Google Calendar events ----
  const hm = ms => { const d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
  let editingEvent = null;
  async function openEventEditor(ev, date) {
    if (!EMBED) return;
    editingEvent = ev;
    const f = $('#eventForm');
    $('#eventDlgTitle').textContent = ev ? 'Edit event' : 'New event';
    $('#evMsg').textContent = '';
    $('#evDelete').hidden = !ev;
    $('#evHub').hidden = !(ev && /Hello Pro Hub/.test(ev.description || ''));
    let cals = [];
    try { cals = (await calendarList()).filter(c => c.writable); } catch { /* use the main calendar */ }
    const sel = $('#evCal');
    fill(sel, (cals.length ? cals : [{ id: '', label: 'My calendar' }]).map(c => el('option', { value: c.id }, c.label)));
    sel.disabled = !!ev; // Google can't move an event to another calendar here
    if (ev) {
      sel.value = ev.calId || '';
      if (sel.value !== (ev.calId || '')) fill(sel, el('option', { value: ev.calId || '' }, 'Its calendar'));
      $('#evTitle').value = ev.title;
      $('#evDate').value = iso(new Date(ev.start));
      $('#evAllDay').checked = ev.allDay;
      $('#evStart').value = ev.allDay ? '09:00' : hm(ev.start);
      $('#evEnd').value = ev.allDay ? '10:00' : hm(ev.end || ev.start + 36e5);
      $('#evLocation').value = ev.location || '';
      $('#evNotes').value = ev.description || '';
    } else {
      const last = Config.get('lastCal', '');
      if ([...sel.options].some(o => o.value === last)) sel.value = last;
      $('#evTitle').value = ''; $('#evDate').value = date || state.date || today(); $('#evAllDay').checked = false;
      $('#evStart').value = '09:00'; $('#evEnd').value = '10:00'; $('#evLocation').value = ''; $('#evNotes').value = '';
    }
    syncAllDay();
    $('#eventDlg').showModal();
    if (!ev) $('#evTitle').focus();
  }
  function syncAllDay() { $('#evTimes').hidden = $('#evAllDay').checked; }
  $('#evAllDay').addEventListener('change', syncAllDay);
  $('#evCancel').addEventListener('click', () => $('#eventDlg').close());

  async function calCall(tool, input) {
    const mcp = await window.claude.use('mcp').catch(() => null);
    if (!mcp) throw { code: 'no_mcp' };
    return mcp.callTool('Google Calendar', tool, input);
  }
  function eventProblem(err) {
    if (err && (err.code === 'not_in_manifest' || err.code === 'approval_required' || err.code === 'consent_required'))
      return 'The planner needs your OK to change your calendar. Tap Save again and choose Allow.';
    if (err && (err.code === 'server_unavailable' || err.code === 'upstream_error'))
      return 'Google Calendar didn\'t answer, so this may or may not have been saved. Refresh the calendar to check before trying again.';
    if (err && err.code === 'tool_error') return 'Google Calendar refused this change' + (err.message && err.message.length < 200 ? ': ' + err.message : '.');
    return connectorProblem(err)[0];
  }
  async function afterEventChange(date) {
    try { const mcp = await window.claude.use('mcp'); if (mcp) await mcp.invalidate('Google Calendar'); } catch { /* nothing cached */ }
    if (document.body.classList.contains('view-calendar')) showMonth(state.month, true);
    else if (document.body.classList.contains('view-day')) renderCalendar(true);
  }
  $('#evSave').addEventListener('click', async () => {
    const f = $('#eventForm'), msg = $('#evMsg');
    const title = $('#evTitle').value.trim(), date = $('#evDate').value, allDay = $('#evAllDay').checked;
    if (!title) { msg.textContent = 'Give the event a name.'; $('#evTitle').focus(); return; }
    if (!isDate(date)) { msg.textContent = 'Choose a date.'; return; }
    if (!allDay && !($('#evEnd').value > $('#evStart').value)) { msg.textContent = 'The end time has to be after the start time.'; return; }
    const input = allDay
      ? { allDay: true, startTime: date + 'T00:00:00', endTime: addDays(date, 1) + 'T00:00:00' }
      : { startTime: `${date}T${$('#evStart').value}:00`, endTime: `${date}T${$('#evEnd').value}:00` };
    input.summary = title;
    input.location = $('#evLocation').value.trim();
    input.description = $('#evNotes').value;
    const ev = editingEvent;
    const calId = ev ? ev.calId : $('#evCal').value;
    if (calId) input.calendarId = calId;
    $('#evSave').disabled = true;
    msg.textContent = 'Saving…';
    try {
      if (ev) {
        if (!ev.allDay && allDay === false) delete input.allDay;
        await calCall('update_event', { ...input, eventId: ev.id });
      } else {
        await calCall('create_event', input);
        Config.set('lastCal', calId || '');
      }
      $('#eventDlg').close();
      toast(ev ? 'Event updated' : 'Event added to Google Calendar');
      if (ev && recClass && recClass.eventId === ev.id && document.body.classList.contains('view-class')) {
        const c = recClass, start = allDay ? parse(date).getTime() : new Date(`${date}T${$('#evStart').value}:00`).getTime();
        Object.assign(c, { gTitle: title.replace(/^Cancelled: /, ''), location: input.location, gDescription: input.description });
        if (!c.gMoved) { c.start = start; c.end = allDay ? start + 864e5 : new Date(`${date}T${$('#evEnd').value}:00`).getTime(); c.date = date; }
        else c.gMovedTo = start;
        Store.save(c);
        renderEventInfo(c);
      }
      afterEventChange(date);
    } catch (err) {
      console.warn(err);
      msg.textContent = eventProblem(err);
    } finally { $('#evSave').disabled = false; }
  });
  $('#evDelete').addEventListener('click', () => {
    const ev = editingEvent;
    if (!ev) return;
    $('#eventDlg').close();
    deleteEventFlow(ev, true);
  });
  async function deleteEventFlow(ev, reopen) {
    if (!(await ask(`Delete "${ev.title || 'this event'}" from Google Calendar?`, 'Delete'))) { if (reopen) $('#eventDlg').showModal(); return; }
    try {
      await calCall('delete_event', { eventId: ev.id, ...(ev.calId ? { calendarId: ev.calId } : {}) });
      toast('Event deleted');
      if (recClass && recClass.eventId === ev.id && document.body.classList.contains('view-class')) {
        const c = recClass;
        c.eventId = ''; c.calId = '';
        Store.save(c);
        go('day/' + c.date);
      }
      afterEventChange(iso(new Date(ev.start)));
    } catch (err) {
      console.warn(err);
      toast(eventProblem(err), 7000);
    }
  }

  // ---- move a task to any day ----
  let onMovePick = null;
  function openMove(suggested, pick) {
    onMovePick = pick;
    $('#moveDate').value = suggested;
    $('#moveDlg').showModal();
  }
  function moveTask(t) {
    openMove(addDays(t.date, 1), date => {
      if (date === t.date) return;
      t.date = date;
      Store.save(t);
      renderTasks();
      toast('Moved to ' + fmt(date, { weekday: 'long', month: 'short', day: 'numeric' }));
    });
  }
  function doMove(date) {
    $('#moveDlg').close();
    const pick = onMovePick;
    onMovePick = null;
    if (pick && isDate(date)) pick(date);
  }
  $('#moveTomorrow').addEventListener('click', () => doMove(addDays(today(), 1)));
  $('#moveNextWeek').addEventListener('click', () => doMove(addDays(today(), 7)));
  $('#moveGo').addEventListener('click', () => doMove($('#moveDate').value));
  $('#moveCancel').addEventListener('click', () => $('#moveDlg').close());

  function connectorProblem(err, server = 'Google Calendar', what = 'your calendar') {
    const retry = ['Try again', true];
    switch (err && err.code) {
      case 'needs_reauth': return [`${server} needs to be reconnected: in claude.ai go to Settings → Connectors → ${server}.`, retry];
      case 'server_not_connected': case 'server_not_found': return [`${server} isn't connected to your Claude account. Add it in claude.ai Settings → Connectors, then try again.`, retry];
      case 'selection_required': return [`Choose which ${server} connection to use when Claude asks, then try again.`, retry];
      case 'not_in_manifest': case 'approval_required': case 'consent_required': return [`The planner needs your OK to use ${what}.`, ['Allow', true]];
      case 'blocked_by_policy': return [`Your organization doesn't allow this page to use ${server}.`, null];
      case 'no_mcp': case 'not_granted': case 'capability_disabled': case 'capability_removed':
        return [`${server} shows up when you open the planner inside Claude.`, null];
      case 'tool_error': return [`${server} said: ${String((err && err.message) || 'something went wrong').slice(0, 200)}`, retry];
      default: return [`${server} didn't answer just now.`, retry];
    }
  }

  // The notes kept for a class, shown inside its calendar event
  function classSummary(rec) {
    const line = (label, text) => text && text.trim() ? el('p', { class: 'evline' }, el('b', {}, label + ': '), text.trim().length > 220 ? text.trim().slice(0, 220) + '…' : text.trim()) : null;
    const parts = [line('Covered', rec.covered), line('Homework', rec.homework), line('Notes', rec.notes)].filter(Boolean);
    if (!parts.length && rec.transcript && rec.transcript.trim()) parts.push(el('p', { class: 'evline muted' }, 'Recording saved.'));
    if (rec.gMoved && rec.gMovedTo) parts.unshift(el('p', { class: 'evline muted' }, 'Moved to ' + dayTime(rec.gMovedTo)));
    return parts.length ? el('div', { class: 'evrec' }, parts) : null;
  }
  // Granola notes that belong to each event (same time, or the event's name in the note title)
  async function attachEventNotes(body, date) {
    if (!EMBED) return;
    let list;
    try { list = await granolaDay(date); } catch { return; }
    if (state.date !== date || !body.isConnected) return;
    const used = new Set();
    body.querySelectorAll('.evnotes').forEach(box => {
      const start = Number(box.dataset.start), title = (box.dataset.title || '').toLowerCase();
      const m = list.find(g => !used.has(g.id) && !g.upcoming && (Math.abs(g.at - start) < 45 * 60e3 || (title.length > 2 && className(g.title).includes(className(title)))));
      if (!m) return;
      used.add(m.id);
      const sum = el('div', { class: 'gsum', hidden: true });
      const btn = el('button', { class: 'evgranola', 'aria-expanded': 'false' }, '📝 Granola notes' + (m.headers.length ? ': ' + m.headers.slice(0, 3).join(' · ') : ''));
      btn.onclick = async () => {
        const open = sum.hidden;
        sum.hidden = !open;
        btn.setAttribute('aria-expanded', String(open));
        if (!open || sum.dataset.loaded) return;
        fill(sum, el('p', { class: 'muted small' }, 'Loading…'));
        try {
          const md = await granolaSummary(m.id);
          sum.dataset.loaded = '1';
          fill(sum, md ? renderMarkdown(md) : el('p', { class: 'muted small' }, 'Granola hasn\'t written a summary for this one yet.'),
            m.url ? el('a', { class: 'mini', href: m.url, target: '_blank', rel: 'noopener' }, 'Open in Granola ↗') : null);
        } catch (err) { fill(sum, el('p', { class: 'small' }, connectorProblem(err, 'Granola', 'your Granola notes')[0])); }
      };
      box.append(btn, sum);
    });
  }

  const EVENTS_NEXT = 3;
  function drawEvents(body, events) {
    if (!events.length) { fill(body, el('p', { class: 'muted small' }, 'Nothing on your calendar this day.')); return; }
    const now = Date.now();
    const okColor = c => /^#[0-9a-f]{3,8}$/i.test(c || '') ? c : null;
    // all-day events: one row of small labels
    const allDay = events.filter(ev => ev.allDay), timed = events.filter(ev => !ev.allDay);
    const dayRow = allDay.length ? el('div', { class: 'allday-row' }, el('span', { class: 'when' }, 'All day'),
      allDay.map(ev => {
        const style = okColor(ev.color) ? `--ec:${ev.color}` : null, label = ev.busy ? 'Busy' : ev.title || '(No title)';
        return EMBED && ev.id && !ev.busy
          ? el('button', { class: 'adchip', style, title: 'Edit this event', onclick: () => openEventEditor(ev) }, label)
          : el('span', { class: 'adchip', style }, label);
      })) : null;
    // what already happened: smaller; the next three: bigger; the rest behind the arrow
    const past = timed.filter(ev => ev.end && ev.end < now), rest = timed.filter(ev => !(ev.end && ev.end < now));
    const next = new Set(rest.slice(0, EVENTS_NEXT));
    const shown = new Set([...past, ...next]);
    // events that overlap in time
    const clash = new Map();
    timed.forEach((a, x) => timed.forEach((b, y) => {
      if (x === y) return;
      const aEnd = a.end > a.start ? a.end : a.start + 1, bEnd = b.end > b.start ? b.end : b.start + 1;
      if (a.start < bEnd && b.start < aEnd) { if (!clash.has(a)) clash.set(a, []); clash.get(a).push(b); }
    }));
    const calName = id => { const c = (Cals.list || []).find(c => c.id === id); return c ? c.label : ''; };
    const items = timed.map(ev => {
      const color = okColor(ev.color);
      const rec = Store.items.get(classKey(ev));
      const others = clash.get(ev);
      const sub = [ev.end > ev.start ? `until ${timeOf(ev.end)}` : null, ev.location || null, Cals.list && Cals.list.length > 1 ? calName(ev.calId) : null].filter(Boolean).join(' · ');
      const what = [
        el('span', { class: 'evtitle' },
          el('strong', { class: ev.busy ? 'busyname' : null }, ev.busy ? 'Busy' : ev.title || '(No title)'),
          rec && rec.status ? el('span', { class: 'st st-' + rec.status }, statusLabel(rec.status)) : rec && hasNotes(rec) ? el('span', { class: 'st st-notes' }, 'Notes ✓') : null),
        sub ? el('span', { class: 'evsub' }, sub) : null,
        others ? el('span', { class: 'clashtag' }, '⚠ Same time as ' + others.map(o => o.busy ? 'a busy slot' : `"${o.title || 'another event'}"`).join(', ')) : null];
      return el('li', { class: (ev.end && ev.end < now ? 'past' : next.has(ev) ? 'next' : '') + (others ? ' clash' : '') + (shown.has(ev) ? '' : ' more'), hidden: shown.has(ev) ? null : true },
        el('span', { class: 'cdot', style: color ? `background:${color}` : null }),
        el('span', { class: 'when' }, timeOf(ev.start)),
        ev.busy ? el('span', { class: 'what', title: 'This calendar only shares when you are busy' }, what)
          : el('button', { class: 'what', title: 'Open this event', onclick: () => openClassFor(ev) }, what, el('span', { class: 'chev', 'aria-hidden': 'true' }, '›')),
        ev.busy ? null : el('div', { class: 'evnotes', 'data-start': String(ev.start), 'data-title': ev.title || '' },
          rec ? classSummary(rec) : null));
    });
    const clashCount = [...clash.keys()].filter(e => !(e.end && e.end < now)).length;
    const later = timed.length - shown.size;
    const list = timed.length ? el('ul', { class: 'events timed' }, items) : null;
    const moreBtn = later ? el('button', {
      class: 'mini evmore', onclick: e => {
        const open = e.currentTarget.classList.toggle('open');
        list.querySelectorAll('li.more').forEach(li => { li.hidden = !open; });
        e.currentTarget.textContent = open ? '▴ Show less' : moreText;
      },
    }) : null;
    const moreText = `▾ ${later} more event${later === 1 ? '' : 's'}`;
    if (moreBtn) moreBtn.textContent = moreText;
    const clashNote = clashCount ? el('p', { class: 'clashnote' }, `⚠ ${clashCount} events at the same time: check the ones marked below.`) : null;
    fill(body, clashNote, dayRow, list, moreBtn);
  }

  async function renderCalendar(force) {
    const card = $('#calCard'), date = state.date, url = Cal.url();
    const head = el('div', { class: 'card-head' }, el('h2', {}, el('span', { class: 'dot', style: 'background:var(--accent)' }), 'Calendar'));
    if (EMBED) {
      head.append(el('span', { class: 'head-actions' },
        el('button', { class: 'mini', onclick: () => openEventEditor(null, date) }, '+ Event'),
        el('button', { class: 'icon-btn sm', title: 'Refresh', 'aria-label': 'Refresh calendar', onclick: () => renderCalendar(true) }, '↻')));
      const body = el('div', {}, el('p', { class: 'muted small' }, 'Loading your calendar…'));
      const chips = el('div', { class: 'calchips small-chips' });
      fill(card, head, body, chips);
      try {
        const events = await fetchEvents(date, addDays(date, 1), force);
        if (state.date !== date) return;
        drawEvents(body, visibleEvents(events));
        attachEventNotes(body, date);
        if (events.failed && events.failed.length) body.append(el('p', { class: 'muted small' }, `Couldn't read: ${events.failed.join(', ')}.`));
        renderCalChips(chips, () => renderCalendar());
      } catch (err) {
        if (state.date !== date) return;
        console.warn(err);
        const [msg, action] = connectorProblem(err);
        fill(body, el('p', { class: 'small' }, msg),
          action ? el('button', { class: 'mini', onclick: () => renderCalendar(true) }, action[0]) : null);
      }
      return;
    }
    if (!url) {
      fill(card, head,
        el('p', { class: 'muted small' }, "See this day's Google Calendar events here, next to your tasks."),
        el('button', { class: 'mini primary', onclick: openCalSetup }, 'Connect Google Calendar'));
      return;
    }
    head.append(el('button', { class: 'icon-btn sm', title: 'Refresh', 'aria-label': 'Refresh calendar', onclick: () => renderCalendar(true) }, '↻'));
    const body = el('div', {}, el('p', { class: 'muted small' }, 'Loading your calendar…'));
    fill(card, head, body);
    try {
      const events = await fetchEvents(date, addDays(date, 1), force);
      if (state.date !== date) return;
      drawEvents(body, visibleEvents(events));
    } catch (err) {
      if (state.date !== date) return;
      fill(body, el('p', { class: 'small', style: 'color:var(--danger)' }, err.message),
        el('button', { class: 'mini', onclick: openCalSetup }, 'Check connection'));
    }
  }

  function openCalSetup() {
    $('.menu').open = false;
    $('#calScript').value = CAL_SCRIPT;
    $('#calUrl').value = Cal.url();
    $('#calMsg').textContent = '';
    $('#calMsg').className = 'small';
    $('#calDisconnect').hidden = !Cal.url();
    $('#calDlg').showModal();
  }
  $('#calSetupBtn').addEventListener('click', openCalSetup);
  if (EMBED) $('#calSetupBtn').hidden = true;
  $('#calClose').addEventListener('click', () => $('#calDlg').close());
  $('#copyScript').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(CAL_SCRIPT); $('#copyMsg').textContent = 'Copied!'; }
    catch { const t = $('#calScript'); t.focus(); t.select(); $('#copyMsg').textContent = 'Selected: now copy it.'; }
  });
  $('#calConnect').addEventListener('click', async () => {
    const url = $('#calUrl').value.trim(), msg = $('#calMsg');
    if (!/^https:\/\/script\.google(usercontent)?\.com\/.+/.test(url)) {
      msg.className = 'small err'; msg.textContent = 'Paste the Web app URL. It starts with https://script.google.com/macros/s/';
      return;
    }
    msg.className = 'small'; msg.textContent = 'Checking…';
    try {
      const events = await Cal.load(today(), url, true);
      Config.set('calendarUrl', url);
      Cal.cache.clear();
      msg.className = 'small ok';
      msg.textContent = `Connected! ${events.length} event${events.length === 1 ? '' : 's'} on your calendar today.`;
      $('#calDisconnect').hidden = false;
      if (document.body.classList.contains('view-day')) renderCalendar();
    } catch (err) { msg.className = 'small err'; msg.textContent = err.message; }
  });
  $('#calDisconnect').addEventListener('click', async () => {
    if (!(await ask('Disconnect Google Calendar from the planner?', 'Disconnect'))) return;
    Store.remove('cfg-calendarUrl');
    Cal.cache.clear();
    $('#calDlg').close();
    if (document.body.classList.contains('view-day')) renderCalendar();
  });

  // ---------- Granola notes ----------
  async function granolaCall(tool, input, force) {
    const mcp = await window.claude.use('mcp').catch(() => null);
    if (!mcp) throw { code: 'no_mcp' };
    const r = await mcp.callTool('Granola', tool, input, force ? { cache: false } : undefined);
    if (r && typeof r.payload === 'string') return r.payload;
    if (r && r.payload && typeof r.payload === 'object') return r.payload;
    return ((r && r.content) || []).filter(c => c && c.type === 'text').map(c => c.text).join('\n');
  }
  const granolaUrl = u => /^https:\/\/notes\.granola\.ai\/[\w\-/]+$/.test(u || '') ? u : '';
  // Granola answers with tagged text; read it as HTML (never shown as HTML, only via textContent).
  function parseGranolaMeetings(text) {
    if (typeof text !== 'string') return [];
    const doc = new DOMParser().parseFromString(text, 'text/html');
    return [...doc.querySelectorAll('meeting, upcoming_meeting')].map(m => {
      const at = Date.parse(m.getAttribute('meeting_at') || '') || 0;
      const sum = m.querySelector('summary');
      return {
        id: m.getAttribute('id') || '', title: m.getAttribute('title') || 'Untitled meeting', at,
        end: Date.parse(m.getAttribute('ends_at') || '') || 0, url: granolaUrl(m.getAttribute('url')),
        upcoming: m.tagName.toLowerCase() === 'upcoming_meeting',
        headers: ((m.querySelector('note_headers') || {}).textContent || '').split('\n').map(x => x.trim()).filter(Boolean),
        summary: sum ? sum.textContent.trim() : '',
      };
    }).filter(m => m.id);
  }
  const granolaCache = new Map();
  async function granolaDay(date, force) {
    if (!force && granolaCache.has(date)) return granolaCache.get(date);
    const text = await granolaCall('search_meetings', { from_date: date, to_date: date, limit: 30, max_participants: 3, include_shared: false }, force);
    const list = parseGranolaMeetings(text).sort((a, b) => a.at - b.at);
    granolaCache.set(date, list);
    return list;
  }
  async function granolaSummary(id) {
    const text = await granolaCall('get_meetings', { meeting_ids: [id], attachments: 'none', max_participants: 3 });
    const m = parseGranolaMeetings(text)[0];
    return m ? m.summary : '';
  }
  // Small Markdown reader for Granola summaries (headings, bullets, numbers, paragraphs).
  function renderMarkdown(md) {
    const box = el('div', { class: 'md' });
    let list = null;
    for (const raw of String(md || '').split('\n')) {
      const line = raw.replace(/\s+$/, '');
      if (!line.trim()) { list = null; continue; }
      const h = /^(#{1,4})\s+(.*)$/.exec(line);
      const b = /^(\s*)(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
      if (h) { list = null; box.append(el(h[1].length <= 1 ? 'h4' : 'h5', {}, h[2])); }
      else if (b) {
        if (!list) { list = el('ul'); box.append(list); }
        list.append(el('li', { style: `margin-left:${Math.min(4, Math.floor(b[1].length / 2)) * 16}px` }, b[2]));
      } else { list = null; box.append(el('p', {}, line.trim())); }
    }
    return box;
  }

  // ---------- recorded classes ----------
  const classes = () => Store.list('class');
  const classKey = ev => 'cls-' + String(ev.id || ('t' + ev.start)).replace(/[^A-Za-z0-9_.~:@+-]/g, '-').slice(0, 150);
  const STATUSES = [['happened', 'Happened'], ['noshow', 'Student missed'], ['cancelled', 'Cancelled'], ['moved', 'Rescheduled']];
  const statusLabel = s => (STATUSES.find(x => x[0] === s) || [, ''])[1];

  const hasNotes = c => !!(c && ((c.covered || c.homework || c.notes || c.transcript || '').trim() || (c.granola && c.granola.url)));
  function openClassFor(ev) {
    const id = classKey(ev);
    let c = Store.items.get(id);
    if (!c) {
      c = { id, kind: 'class', date: iso(new Date(ev.start)), title: ev.title || '', start: ev.start, end: ev.end || 0,
        eventId: ev.id || '', calId: ev.calId || '', gTitle: ev.title || '', status: '', transcript: '', covered: '', homework: '', notes: '', created: Date.now() };
    }
    // keep the Google details up to date (a moved class keeps its original time here)
    Object.assign(c, { calId: ev.calId || c.calId || '', location: ev.location || '', gDescription: ev.description || '', allDayEv: false });
    if (!c.gCancelled) c.gTitle = ev.title || c.gTitle;
    if (!c.gMoved) { c.start = ev.start; c.end = ev.end || c.end; c.date = iso(new Date(ev.start)); }
    Store.save(c);
    go('class/' + id);
  }
  // The Google event behind a class, as the editor needs it
  const eventOf = c => ({
    id: c.eventId, calId: c.calId, title: c.gCancelled ? 'Cancelled: ' + (c.gTitle || c.title) : (c.gTitle || c.title), allDay: false,
    start: c.gMoved && c.gMovedTo ? c.gMovedTo : c.start,
    end: (c.gMoved && c.gMovedTo ? c.gMovedTo : c.start) + (c.end > c.start ? c.end - c.start : 36e5),
    location: c.location || '', description: c.gDescription || '',
  });
  function newClass(date) {
    const now = new Date(), d = parse(date);
    d.setHours(now.getHours(), now.getMinutes() - now.getMinutes() % 5, 0, 0);
    const id = 'cls-' + uid();
    Store.save({ id, kind: 'class', date, title: '', start: d.getTime(), end: d.getTime() + 36e5, eventId: '', calId: '', status: '', transcript: '', covered: '', homework: '', notes: '', created: Date.now() });
    go('class/' + id);
  }

  // Day card: classes recorded in the planner + Granola notes for the day
  async function renderClassCard(force) {
    const card = $('#classCard'), date = state.date;
    const recs = classes().filter(c => c.date === date).sort((a, b) => a.start - b.start);
    const granolaBox = el('div', {});
    fill(card,
      el('div', { class: 'card-head' },
        el('h2', {}, el('span', { class: 'dot', style: 'background:#b22133' }), 'Events & notes'),
        el('span', { class: 'head-actions' },
          el('button', { class: 'mini', onclick: () => newClass(date) }, '+ Notes'),
          EMBED ? el('button', { class: 'icon-btn sm', title: 'Refresh Granola notes', 'aria-label': 'Refresh Granola notes', onclick: () => renderClassCard(true) }, '↻') : null)),
      recs.length ? el('ul', { class: 'classlist' }, recs.map(c => el('li', {},
        el('a', { href: '#class/' + c.id },
          el('span', { class: 'when' }, timeOf(c.start)),
          el('strong', {}, c.title || 'Class'),
          c.status ? el('span', { class: 'st st-' + c.status }, statusLabel(c.status)) : null,
          c.granola && c.granola.url ? el('span', { class: 'muted small' }, '· in Granola') : null)))) :
        el('p', { class: 'muted small' }, 'Tap an event in your calendar (or + Notes) to keep how it went, what you covered and what comes next. Record it in Granola: its notes show up here.'),
      EMBED ? granolaBox : null);
    if (!EMBED) return;
    fill(granolaBox, el('h3', { class: 'subhead' }, 'Granola notes'), el('p', { class: 'muted small' }, 'Loading your Granola notes…'));
    try {
      const list = await granolaDay(date, force);
      if (state.date !== date) return;
      if (!list.length) { fill(granolaBox, el('h3', { class: 'subhead' }, 'Granola notes'), el('p', { class: 'muted small' }, 'No Granola notes this day.')); return; }
      fill(granolaBox, el('h3', { class: 'subhead' }, 'Granola notes'), el('ul', { class: 'glist' }, list.map(m => granolaItem(m))));
    } catch (err) {
      if (state.date !== date) return;
      console.warn(err);
      const [msg, action] = connectorProblem(err, 'Granola', 'your Granola notes');
      fill(granolaBox, el('h3', { class: 'subhead' }, 'Granola notes'), el('p', { class: 'small' }, msg + ' '),
        action ? el('button', { class: 'mini', onclick: () => renderClassCard(true) }, action[0]) : null);
    }
  }
  function granolaItem(m) {
    const body = el('div', { class: 'gsum', hidden: true });
    const toggle = el('button', { class: 'mini', 'aria-expanded': 'false' }, 'Summary');
    toggle.onclick = async () => {
      const open = body.hidden;
      body.hidden = !open;
      toggle.setAttribute('aria-expanded', String(open));
      toggle.textContent = open ? 'Hide' : 'Summary';
      if (!open || body.dataset.loaded) return;
      fill(body, el('p', { class: 'muted small' }, 'Loading…'));
      try {
        const md = await granolaSummary(m.id);
        body.dataset.loaded = '1';
        fill(body, md ? renderMarkdown(md) : el('p', { class: 'muted small' }, 'Granola hasn\'t written a summary for this one yet.'));
      } catch (err) { fill(body, el('p', { class: 'small' }, connectorProblem(err, 'Granola', 'your Granola notes')[0])); }
    };
    return el('li', {},
      el('div', { class: 'grow' },
        el('span', { class: 'when' }, m.at ? timeOf(m.at) : ''),
        el('strong', {}, m.title),
        m.upcoming ? el('span', { class: 'muted small' }, 'not started yet') : (m.headers.length ? el('span', { class: 'muted small' }, m.headers.slice(0, 3).join(' · ')) : null)),
      el('span', { class: 'head-actions' }, m.upcoming ? null : toggle,
        m.url ? el('a', { class: 'mini', href: m.url, target: '_blank', rel: 'noopener' }, 'Open ↗') : null),
      body);
  }

  // ---- the student's previous classes ----
  const className = t => String(t || '').toLowerCase().replace(/\b(class|lesson|aula)\s+(with|com)\b/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const sameStudent = (a, b) => {
    const x = className(a), y = className(b);
    return !!x && !!y && (x === y || x.split(' ').some(w => w.length > 2 && y.split(' ').includes(w)));
  };
  let lastTimer = 0;
  function renderLastClass(c) {
    clearTimeout(lastTimer);
    const box = $('#lastClass');
    if (!className(c.title)) {
      fill(box, el('p', { class: 'muted small' }, 'Type the student\'s name or class at the top to see their last class here.'));
      return;
    }
    const earlier = classes().filter(x => x.id !== c.id && x.start < c.start && sameStudent(x.title, c.title)).sort((a, b) => b.start - a.start);
    const prev = earlier[0];
    const field = (label, text, cls) => text && text.trim() ? el('div', { class: 'lc-field ' + (cls || '') }, el('h4', {}, label), el('p', {}, text.trim())) : null;
    const granolaBox = el('div', {});
    fill(box,
      prev ? el('div', { class: 'lc' },
        el('div', { class: 'lc-head' },
          el('strong', {}, fmt(prev.date, { weekday: 'long', month: 'long', day: 'numeric' })),
          el('span', { class: 'muted small' }, timeOf(prev.start) + ' · ' + (prev.title || 'Class')),
          prev.status ? el('span', { class: 'st st-' + prev.status }, statusLabel(prev.status)) : null,
          el('a', { class: 'mini', href: '#class/' + prev.id }, 'Open')),
        field('Homework to check', prev.homework, 'hw'),
        field('What we covered', prev.covered),
        field('Notes', prev.notes),
        !(prev.homework || prev.covered || prev.notes || '').trim() && prev.transcript
          ? field('From the recording', prev.transcript.length > 600 ? prev.transcript.slice(0, 600) + '…' : prev.transcript) : null,
        !(prev.homework || prev.covered || prev.notes || prev.transcript || '').trim() ? el('p', { class: 'muted small' }, 'Nothing was written for that class.') : null)
        : el('p', { class: 'muted small' }, 'No earlier class with this name in the planner yet.'),
      earlier.length > 1 ? el('details', { class: 'lc-more' },
        el('summary', {}, `Earlier classes (${earlier.length - 1})`),
        el('ul', { class: 'classlist' }, earlier.slice(1, 30).map(x => el('li', {}, el('a', { href: '#class/' + x.id },
          el('span', { class: 'when' }, fmt(x.date, { month: 'short', day: 'numeric' })),
          el('strong', {}, x.title || 'Class'),
          x.status ? el('span', { class: 'st st-' + x.status }, statusLabel(x.status)) : null,
          x.homework ? el('span', { class: 'muted small' }, 'Homework: ' + x.homework.slice(0, 60)) : null))))) : null,
      EMBED ? granolaBox : null);
    if (!EMBED) return;
    // the student's earlier Granola notes (search by name over the last 4 months)
    fill(granolaBox, el('h3', { class: 'subhead' }, 'Earlier Granola notes'), el('p', { class: 'muted small' }, 'Looking in Granola…'));
    const words = className(c.title).split(' ').filter(w => w.length > 2);
    lastTimer = setTimeout(async () => {
      try {
        const text = await granolaCall('search_meetings', {
          keywords: words.length ? words.slice(0, 5) : [className(c.title)], from_date: addDays(c.date, -120), to_date: c.date, limit: 10, max_participants: 3,
        });
        if (recClass !== c) return;
        const list = parseGranolaMeetings(text).filter(m => !m.upcoming && m.at && m.at < c.start - 20 * 60e3).sort((a, b) => b.at - a.at).slice(0, 4);
        fill(granolaBox, el('h3', { class: 'subhead' }, 'Earlier Granola notes'),
          list.length ? el('ul', { class: 'glist' }, list.map(m => {
            const li = granolaItem(m);
            const when = li.querySelector('.when');
            if (when) when.textContent = fmt(iso(new Date(m.at)), { month: 'short', day: 'numeric' });
            return li;
          })) : el('p', { class: 'muted small' }, 'No earlier Granola notes found for this name.'));
      } catch (err) {
        if (recClass !== c) return;
        fill(granolaBox, el('h3', { class: 'subhead' }, 'Earlier Granola notes'), el('p', { class: 'small' }, connectorProblem(err, 'Granola', 'your Granola notes')[0]));
      }
    }, 400);
  }

  // ---- the class page ----
  let Dict = null;            // dictation namespace (desktop app / Chrome only)
  let recClass = null;        // class being recorded into
  let lastFinalAt = 0;
  if (EMBED) {
    window.claude.use('dictation').then(d => {
      Dict = d || null;
      if (!Dict) return;
      Dict.onPartial(({ text }) => { $('#recPartial').textContent = text || ''; });
      Dict.onFinal(({ text }) => appendTranscript(text));
      Dict.onState(({ state: st, reason }) => drawRecState(st, reason));
    }).catch(() => { Dict = null; });
  }
  const mmss = s => { s = Math.max(0, Math.floor(s)); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60; return (h ? h + ':' + pad(m) : pad(m)) + ':' + pad(s % 60); };
  function appendTranscript(text) {
    const c = recClass;
    if (!c || !text) return;
    const ta = $('#classTranscript');
    const now = Date.now();
    if (!c.recStartedAt) c.recStartedAt = now;
    let add = text;
    if (!ta.value || now - lastFinalAt > 8000) add = (ta.value ? '\n' : '') + `[${mmss((now - c.recStartedAt) / 1000)}] ` + text.replace(/^\s+/, '');
    lastFinalAt = now;
    ta.value += add;
    c.transcript = ta.value;
    Store.save(c);
    drawGranolaSend();
    ta.scrollTop = ta.scrollHeight;
  }
  function drawRecState(st, reason) {
    const btn = $('#recBtn'), lab = $('#recState');
    const on = st !== 'idle';
    btn.classList.toggle('on', on);
    btn.textContent = st === 'listening' ? '■ Stop recording' : st === 'starting' ? 'Starting…' : st === 'finishing' ? 'Finishing…' : '● Start recording';
    lab.textContent = st === 'listening' ? 'Listening…' : '';
    if (st === 'idle') {
      $('#recPartial').textContent = '';
      const why = { time_limit: 'Recording stops after 60 minutes. Tap Start to keep going.', hidden: 'Recording paused because the page was hidden. Tap Start to continue.',
        not_granted: 'The planner isn\'t allowed to use your microphone. You can change that in this page\'s Permissions menu.',
        unavailable: 'Recording isn\'t available here.', rate_limited: 'Too many recordings at once. Try again in a moment.',
        upstream_error: 'The microphone or speech service stopped working. Tap Start to try again.' }[reason];
      if (why) toast(why, 6000);
    }
  }

  function showClass(c) {
    unmountAll();
    recClass = c;
    setView('class');
    $('#classBack').href = '#day/' + c.date;
    const bind = (sel, key, after) => {
      const f = $(sel);
      f.value = c[key] || '';
      f.oninput = () => { c[key] = f.value; Store.save(c); if (after) after(); };
    };
    bind('#classTitle', 'title', () => renderLastClass(c));
    bind('#classTranscript', 'transcript', drawGranolaSend);
    bind('#classCovered', 'covered');
    bind('#classHomework', 'homework');
    bind('#classNotes', 'notes');
    $('#classDate').value = c.date;
    $('#classTime').value = c.start ? hm(c.start) : '';
    const moveTime = () => {
      const d = $('#classDate').value, t = $('#classTime').value || '00:00';
      if (!isDate(d)) return;
      const len = c.end > c.start ? c.end - c.start : 36e5;
      c.date = d;
      c.start = new Date(`${d}T${t}:00`).getTime();
      c.end = c.start + len;
      $('#classBack').href = '#day/' + c.date;
      Store.save(c);
      renderLastClass(c);
    };
    $('#classDate').onchange = moveTime;
    $('#classTime').onchange = moveTime;
    $('#classWhen').textContent = c.eventId ? 'From your calendar' : '';
    fill($('#classStatus'), STATUSES.map(([k, label]) => el('button', {
      class: 'st st-' + k + (c.status === k ? ' on' : ''), 'aria-pressed': String(c.status === k),
      onclick: () => {
        c.status = c.status === k ? '' : k;
        if (c.status === 'moved' && !c.newStart) { showClassStatus(c); Store.save(c); $('#moveDay').focus(); syncClassToGoogle(c); return; }
        Store.save(c); showClassStatus(c); syncClassToGoogle(c);
      },
    }, label)));
    $('#classDelete').onclick = async () => {
      if (!(await ask('Delete this class record? Anything you recorded or wrote here is removed (Granola keeps its own copy).', 'Delete'))) return;
      if (Dict && Dict.active()) Dict.stop().catch(() => {});
      Store.remove(c.id);
      go('day/' + c.date);
    };
    // recording
    // Classes are recorded in the Granola app; old text typed or dictated here still shows if there is any.
    $('#recCard').hidden = !(c.transcript || '').trim();
    const btn = $('#recBtn');
    btn.hidden = true;
    $('#recHint').textContent = Dict
      ? 'Your words appear below as you speak. You can fix anything by typing.'
      : 'On iPad: tap the box below, then tap the microphone 🎤 on the keyboard and speak — iPad writes down what you say. You can also write in the box with Apple Pencil.';
    btn.onclick = () => {
      if (!Dict) return;
      if (Dict.active()) { Dict.stop().catch(() => {}); return; }
      Dict.start().catch(e => {
        const m = { not_granted: 'The planner isn\'t allowed to use your microphone. You can change that in this page\'s Permissions menu.', dismissed: 'Recording needs your OK. Tap Start again and choose Allow.', unavailable: 'Recording isn\'t available here. Use the keyboard microphone instead.' }[e && e.code];
        if (m) toast(m, 6000);
      });
    };
    renderEventInfo(c);
    showClassStatus(c);
    drawRecState(Dict && Dict.active() ? 'listening' : 'idle');
    drawGranolaSend();
    findGranolaFor(c);
    renderLastClass(c);
    scrollTo(0, 0);
  }
  function renderEventInfo(c) {
    const box = $('#classEventInfo');
    const linked = !!c.eventId;
    const cal = (Cals.list || []).find(x => x.id === c.calId);
    const when = c.gMoved && c.gMovedTo ? c.gMovedTo : c.start;
    const end = when + (c.end > c.start ? c.end - c.start : 36e5);
    const desc = (c.gDescription || '').replace(/\n*— Class notes \(Pen Planner\) —[\s\S]*$/, '').trim();
    fill(box,
      el('div', { class: 'evinfo-head' },
        el('span', { class: 'cdot', style: `background:${(cal && cal.color) || 'var(--accent)'}` }),
        el('span', { class: 'muted small' }, linked ? (cal ? cal.label : 'Google Calendar') : 'Not on Google Calendar'),
        c.gCancelled ? el('span', { class: 'st st-cancelled' }, 'Cancelled') : null,
        c.gMoved ? el('span', { class: 'st st-moved' }, 'Rescheduled') : null),
      el('h1', { class: 'evinfo-title' }, (c.gTitle || c.title || 'Class')),
      el('p', { class: 'evinfo-when' }, fmt(iso(new Date(when)), { weekday: 'long', month: 'long', day: 'numeric' }) + ` · ${timeOf(when)} – ${timeOf(end)}`,
        c.gMoved ? el('span', { class: 'muted small' }, ` (was ${dayTime(c.start)})`) : null),
      c.location ? el('p', { class: 'small' }, '📍 ' + c.location) : null,
      desc ? el('details', { class: 'evinfo-desc' }, el('summary', {}, 'Event description'), el('p', {}, desc)) : null,
      el('div', { class: 'evinfo-actions' },
        linked && EMBED ? el('button', { class: 'mini', onclick: () => openEventEditor(eventOf(c)) }, 'Edit event') : null,
        linked && EMBED ? el('button', { class: 'mini', onclick: () => saveNotesToGoogle(c) }, 'Save notes to Google Calendar') : null,
        linked && EMBED ? el('button', { class: 'mini danger', onclick: () => deleteEventFlow(eventOf(c), false) }, 'Delete event') : null),
      el('p', { id: 'evinfoMsg', class: 'small muted' }));
  }
  // Writes the class notes into the Google event's description (keeps what was there, replaces an older copy)
  async function saveNotesToGoogle(c) {
    const msg = $('#evinfoMsg');
    const lines = [['What we covered', c.covered], ['Homework', c.homework], ['Notes', c.notes]].filter(([, v]) => v && v.trim());
    if (c.status) lines.unshift(['Status', statusLabel(c.status)]);
    if (c.granola && c.granola.url) lines.push(['Granola', c.granola.url]);
    if (!lines.length) { msg.textContent = 'Write what you covered, the homework or a note first.'; return; }
    const base = (c.gDescription || '').replace(/\n*— Class notes \(Pen Planner\) —[\s\S]*$/, '').trim();
    const description = (base ? base + '\n\n' : '') + '— Class notes (Pen Planner) —\n' + lines.map(([k, v]) => `${k}: ${v.trim()}`).join('\n');
    msg.textContent = 'Saving to Google Calendar…';
    try {
      await calCall('update_event', { eventId: c.eventId, notificationLevel: 'NONE', description, ...(c.calId ? { calendarId: c.calId } : {}) });
      c.gDescription = description;
      Store.save(c);
      msg.textContent = 'Saved in the Google Calendar event. Guests aren\'t emailed.';
      try { const mcp = await window.claude.use('mcp'); if (mcp) await mcp.invalidate('Google Calendar'); } catch { /* nothing cached */ }
    } catch (err) {
      console.warn(err);
      msg.textContent = eventProblem(err);
    }
  }

  function showClassStatus(c) {
    document.querySelectorAll('#classStatus .st').forEach((b, i) => {
      const on = c.status === STATUSES[i][0];
      b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on));
    });
    // Reschedule: pick the new day and time
    const moving = c.status === 'moved';
    $('#moveBox').hidden = !moving;
    if (moving) {
      const at = c.newStart || c.start || Date.now();
      $('#moveDay').value = iso(new Date(at));
      $('#moveTime').value = hm(at);
    }
    drawGcalLine(c);
    if ($('#classEventInfo').isConnected) renderEventInfo(c);
  }

  // Keep Google Calendar in step with the class, like Hello Pro Hub does. Guests are never emailed.
  const localStamp = ms => { const d = new Date(ms); return `${iso(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`; };
  const dayTime = ms => fmt(iso(new Date(ms)), { weekday: 'short', month: 'short', day: 'numeric' }) + ' at ' + timeOf(ms);
  function drawGcalLine(c, text, retry) {
    const box = $('#classGcal');
    if (!text) {
      if (c.gCancelled) text = 'Marked as cancelled on Google Calendar (the time shows as free). Guests aren\'t emailed.';
      else if (c.gMoved && c.gMovedTo) text = `Moved on Google Calendar to ${dayTime(c.gMovedTo)}. Guests aren't emailed.`;
      else if ((c.status === 'cancelled' || (c.status === 'moved' && c.newStart)) && !c.eventId) text = 'This class isn\'t on Google Calendar, so nothing changed there.';
      else if (c.status === 'moved' && !c.newStart) text = 'Choose the new day and time, then tap Move class.';
    }
    fill(box, text ? el('span', {}, text) : null, retry ? el('button', { class: 'mini', onclick: () => syncClassToGoogle(c) }, 'Try again') : null);
  }
  let syncing = Promise.resolve();
  function syncClassToGoogle(c) {
    syncing = syncing.then(() => doSync(c)).catch(() => {});
    return syncing;
  }
  async function doSync(c) {
    const want = c.status === 'moved' && c.newStart ? 'move' : c.status === 'cancelled' ? 'cancel' : 'none';
    if (!EMBED || !c.eventId) { drawGcalLine(c); return; }
    const work = (c.gMoved && want !== 'move') || (c.gCancelled && want !== 'cancel') || (want === 'cancel' && !c.gCancelled) || (want === 'move' && c.gMovedTo !== c.newStart);
    if (!work) { drawGcalLine(c); return; }
    const base = { eventId: c.eventId, notificationLevel: 'NONE', ...(c.calId ? { calendarId: c.calId } : {}) };
    const dur = c.end > c.start ? c.end - c.start : 36e5;
    const times = ms => ({ startTime: localStamp(ms), endTime: localStamp(ms + dur) });
    const title = c.gTitle || c.title || 'Class';
    drawGcalLine(c, 'Updating Google Calendar…');
    try {
      if (c.gMoved && want !== 'move') { await calCall('update_event', { ...base, ...times(c.start) }); c.gMoved = false; c.gMovedTo = 0; Store.save(c); }
      if (c.gCancelled && want !== 'cancel') { await calCall('update_event', { ...base, summary: title, availability: 'AVAILABILITY_BUSY' }); c.gCancelled = false; Store.save(c); }
      if (want === 'cancel' && !c.gCancelled) { await calCall('update_event', { ...base, summary: 'Cancelled: ' + title, availability: 'AVAILABILITY_FREE' }); c.gCancelled = true; Store.save(c); }
      if (want === 'move' && c.gMovedTo !== c.newStart) { await calCall('update_event', { ...base, ...times(c.newStart) }); c.gMoved = true; c.gMovedTo = c.newStart; Store.save(c); }
      try { const mcp = await window.claude.use('mcp'); if (mcp) await mcp.invalidate('Google Calendar'); } catch { /* nothing cached */ }
      if (recClass === c) { drawGcalLine(c); renderEventInfo(c); }
    } catch (err) {
      console.warn(err);
      if (recClass === c) drawGcalLine(c, 'Google Calendar didn\'t update (your class notes are saved). ' + eventProblem(err), true);
    }
  }
  $('#moveGoBtn').addEventListener('click', () => {
    const c = recClass;
    if (!c) return;
    const d = $('#moveDay').value, t = $('#moveTime').value;
    if (!isDate(d) || !/^\d\d:\d\d$/.test(t)) { drawGcalLine(c, 'Choose the new day and time first.'); return; }
    c.status = 'moved';
    c.newStart = new Date(`${d}T${t}:00`).getTime();
    Store.save(c);
    showClassStatus(c);
    syncClassToGoogle(c);
  });

  // Granola section on the class page
  function drawGranolaSend() {
    const c = recClass;
    if (!c) return;
    const sent = c.granola && c.granola.url;
    fill($('#granolaSent'), sent ? el('a', { href: c.granola.url, target: '_blank', rel: 'noopener' }, 'Saved in Granola — open it ↗') : null);
  }
  async function findGranolaFor(c, force) {
    const box = $('#granolaMatch');
    if (!EMBED) { fill(box, el('p', { class: 'muted small' }, 'Granola notes show up when you open the planner inside Claude.')); return; }
    fill(box, el('p', { class: 'muted small' }, 'Looking for this class in Granola…'));
    try {
      const list = await granolaDay(c.date, force);
      if (recClass !== c) return;
      const title = (c.title || '').toLowerCase();
      const near = list.filter(m => !m.upcoming && (Math.abs(m.at - c.start) < 45 * 60e3 || (title && m.title.toLowerCase().includes(title))));
      if (!near.length) { fill(box, el('p', { class: 'muted small' }, list.length ? 'No Granola note matches this class yet.' : 'No Granola notes this day yet.')); return; }
      fill(box, el('ul', { class: 'glist' }, near.map(m => granolaItem(m))));
    } catch (err) {
      if (recClass !== c) return;
      fill(box, el('p', { class: 'small' }, connectorProblem(err, 'Granola', 'your Granola notes')[0]));
    }
  }
  $('#granolaLook').addEventListener('click', () => { if (recClass) findGranolaFor(recClass, true); });

  // ---------- study plan ----------
  // A plan has two kinds of course: "gp" (topics, 2 per weekday, 3 on Fridays, 1 a day for the first 3 days)
  // and "pg" (subjects: a whole subject each Saturday while gp runs, then 1 class per weekday + a review/exam day).
  // Sundays and holidays are free. Unfinished items can be replanned from any day with the same rules.
  const studyPlan = () => Config.get('studyPlan', null);
  const studyDone = () => Config.get('studyDone', {});
  const studySched = () => Config.get('studySched', { sched: {}, weeks: {} });
  const dow = d => parse(d).getDay(); // 0 Sun … 6 Sat
  const mondayOf = d => addDays(d, -((dow(d) + 6) % 7));

  function studyItems(plan) {
    const items = [];
    if (!plan) return items;
    if (plan.gp) plan.gp.modules.forEach((m, mi) => m.topics.forEach((t, ti) => {
      const closing = t.startsWith('*');
      items.push({ id: `gp-${mi}-${ti}`, course: 'gp', group: m.name, gi: mi, title: closing ? t.slice(1) : t, closing });
    }));
    if (plan.pg) plan.pg.discs.forEach((dsc, di) => {
      dsc.aulas.forEach((a, ai) => items.push({ id: `pg-${di}-${ai}`, course: 'pg', group: dsc.name, gi: di, title: a, n: ai + 1 }));
      items.push({ id: `pg-${di}-p`, course: 'pg', group: dsc.name, gi: di, title: 'Demais aulas, revisão e prova (aba Provas)', exam: true });
    });
    return items;
  }
  const studyExtras = plan => (plan && plan.gp && plan.gp.extras || []).map(x => ({ ...x, id: 'x-' + x.id, course: 'gp' }));

  function buildStudySchedule(plan, from, done) {
    const hol = plan.holidays || {};
    const free = d => dow(d) === 0 || !!hol[d];
    const weekday = d => dow(d) >= 1 && dow(d) <= 5 && !hol[d];
    const items = studyItems(plan).filter(it => !done[it.id]);
    const gp = items.filter(it => it.course === 'gp');
    const anyGpDone = studyItems(plan).some(it => it.course === 'gp' && done[it.id]);
    const sched = {}, weeks = {};
    // topic course ("gp") on weekdays
    let lastGp = null, days = 0;
    for (let d = from, i = 0; i < gp.length; d = addDays(d, 1)) {
      if (!weekday(d)) continue;
      const n = !anyGpDone && days < 3 ? 1 : dow(d) === 5 ? 3 : 2;
      for (let k = 0; k < n && i < gp.length; k++) sched[gp[i++].id] = d;
      days++; lastGp = d;
    }
    // subject course ("pg"): whole subjects on Saturdays while "gp" runs (through the Saturday of its last week)
    const discs = [];
    items.filter(it => it.course === 'pg').forEach(it => { (discs[it.gi] = discs[it.gi] || []).push(it); });
    const queue = discs.filter(Boolean);
    let phaseB = from;
    if (lastGp) {
      const lastSat = addDays(lastGp, 6 - dow(lastGp));
      let s = addDays(from, (6 - dow(from) + 7) % 7);
      while (s <= lastSat && queue.length) {
        if (!hol[s]) queue.shift().forEach(it => { sched[it.id] = s; });
        s = addDays(s, 7);
      }
      phaseB = addDays(lastSat, 2);
    }
    // then one class a day on weekdays, the exam/review day closing each subject
    let d = phaseB;
    for (const disc of queue) for (const it of disc) {
      while (!weekday(d)) d = addDays(d, 1);
      sched[it.id] = d;
      d = addDays(d, 1);
    }
    // extras: the week a module starts ("when": module index) or the week "gp" ends
    for (const x of studyExtras(plan)) {
      if (done[x.id]) continue;
      let at = lastGp;
      if (typeof x.when === 'number') {
        const first = studyItems(plan).find(it => it.course === 'gp' && it.gi === x.when && sched[it.id]);
        at = first ? sched[first.id] : lastGp;
      }
      if (at) weeks[x.id] = mondayOf(at);
    }
    return { sched, weeks, from, built: Date.now() };
  }

  // Seed: the plan that ships with this page, the first time it opens
  function seedStudyPlan() {
    if (studyPlan() || Config.get('studySeeded', false)) return;
    const tag = document.getElementById('studySeed');
    if (!tag) return;
    try {
      const plan = JSON.parse(tag.textContent);
      Config.set('studyPlan', plan);
      Config.set('studySeeded', true);
      Config.set('studySched', buildStudySchedule(plan, plan.start || today(), {}));
    } catch (e) { console.warn(e); }
  }

  // ---------- study plans (each plan on its own) ----------
  // A plan: { id, kind:'plan', name, color, goal, days:[weekday numbers], items:[{id,title,group,date,done}], extras:[{id,title,week,done}] }
  // The Nov–Jan plan's two courses keep their own rules (rule:'novjan'); other plans move forward day by day.
  const PLAN_COLORS = ['#2f6fd6', '#c2571a', '#9b3fb5', '#0e8a7a', '#b22133', '#5b4b9a', '#8a5c17'];
  const plans = () => Store.list('plan').filter(p => !p.archived).sort((a, b) => (a.created || 0) - (b.created || 0));
  const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  function migrateStudy() {
    const def = studyPlan();
    if (!def || Config.get('studyMigrated', false)) return;
    const sched = studySched(), done = studyDone();
    const mk = (course, id, n) => ({
      id, kind: 'plan', date: def.start || today(), created: Date.now() + n, name: def[course].name, color: def[course].color,
      goal: def.name || '', rule: 'novjan', course, days: course === 'gp' ? [1, 2, 3, 4, 5] : [1, 2, 3, 4, 5, 6],
      items: studyItems(def).filter(it => it.course === course).map(it => ({
        id: it.id, title: it.title + (it.closing ? ' (fechamento)' : ''), group: it.group, date: (sched.sched || {})[it.id] || '', done: done[it.id] || null,
      })),
      extras: course === 'gp' ? studyExtras(def).map(x => ({ id: x.id, title: x.name, week: (sched.weeks || {})[x.id] || '', done: done[x.id] || null })) : [],
    });
    if (def.gp) Store.save(mk('gp', 'plan-novjan-gp', 0));
    if (def.pg) Store.save(mk('pg', 'plan-novjan-pg', 1));
    Config.set('studyMigrated', true);
  }

  function planStats(p) {
    const t = today(), items = p.items || [];
    const n = items.filter(i => i.done).length;
    const next = items.filter(i => !i.done).sort((a, b) => (a.date || '9').localeCompare(b.date || '9'))[0];
    const dates = items.map(i => i.date).filter(Boolean).sort();
    return { n, total: items.length, next, end: dates[dates.length - 1], behind: items.filter(i => !i.done && i.date && i.date < t).length };
  }
  function planItemsOn(date) {
    const out = [];
    for (const p of plans()) for (const it of p.items || []) if (it.date === date) out.push({ p, it });
    return out;
  }
  function toggleItem(p, it) { it.done = it.done ? null : today(); Store.save(p); }

  // Replan: the Nov–Jan courses with their rules; any other plan keeps its order and day groups, moved onto its study days from `from`
  function replanPlan(p, from) {
    if (p.rule === 'novjan') {
      const def = studyPlan();
      if (!def) return;
      const pair = plans().filter(x => x.rule === 'novjan');
      const done = {};
      pair.forEach(x => { (x.items || []).forEach(i => { if (i.done) done[i.id] = i.done; }); (x.extras || []).forEach(i => { if (i.done) done[i.id] = i.done; }); });
      const r = buildStudySchedule(def, from, done);
      pair.forEach(x => {
        (x.items || []).forEach(i => { if (!i.done && r.sched[i.id]) i.date = r.sched[i.id]; });
        (x.extras || []).forEach(i => { if (!i.done && r.weeks[i.id]) i.week = r.weeks[i.id]; });
        Store.save(x);
      });
      return;
    }
    const days = (p.days && p.days.length ? p.days : [1, 2, 3, 4, 5]);
    const left = (p.items || []).filter(i => !i.done).sort((a, b) => (a.date || '9').localeCompare(b.date || '9'));
    const groups = [];
    for (const it of left) { const g = groups[groups.length - 1]; if (g && g.key === (it.date || '') && it.date) g.items.push(it); else groups.push({ key: it.date || '', items: [it] }); }
    let d = from;
    for (const g of groups) {
      let guard = 0;
      while (!days.includes(dow(d)) && guard++ < 14) d = addDays(d, 1);
      g.items.forEach(i => { i.date = d; });
      d = addDays(d, 1);
    }
    Store.save(p);
  }
  function replanAll(from) { const done = new Set(); for (const p of plans()) { if (p.rule === 'novjan' && done.has('novjan')) continue; if (p.rule === 'novjan') done.add('novjan'); if (planStats(p).behind || p.rule === 'novjan') replanPlan(p, from); } }

  // ---- day card ----
  function renderStudyCard() {
    const card = $('#studyCard'), date = state.date, all = plans();
    if (!all.length) { card.hidden = true; return; }
    card.hidden = false;
    const rows = planItemsOn(date);
    const behind = date === today() ? all.reduce((a, p) => a + planStats(p).behind, 0) : 0;
    const groups = [];
    for (const { p, it } of rows) {
      const last = groups[groups.length - 1];
      if (last && last.p === p && last.group === (it.group || '')) last.items.push(it); else groups.push({ p, group: it.group || '', items: [it] });
    }
    const extras = [];
    all.forEach(p => (p.extras || []).forEach(x => { if (x.week === mondayOf(date) && !x.done) extras.push({ p, x }); }));
    const check = (p, it) => el('li', { class: 'pitem' + (it.done ? ' ok' : '') },
      el('button', { class: 'tick' + (it.done ? ' on' : ''), 'aria-pressed': String(!!it.done), 'aria-label': (it.done ? 'Not done: ' : 'Done: ') + it.title, onclick: () => { toggleItem(p, it); renderStudyCard(); } }, el('span', { class: 'box' })),
      String(it.id).startsWith('x-') ? el('span', { class: 'ptitle' }, it.title)
        : el('button', { class: 'ptitle', title: 'Open this topic: notes and recording', onclick: () => openTopic(p, it) }, el('span', {}, it.title), el('span', { class: 'marks' }, topicMarks(it) || '›')));
    const hol = (studyPlan() && studyPlan().holidays || {})[date];
    const nDone = rows.filter(r => r.it.done).length;
    fill(card,
      el('div', { class: 'card-head' },
        el('h2', {}, el('span', { class: 'dot', style: 'background:#9b3fb5' }), 'Study plan'),
        el('span', { class: 'head-actions' }, rows.length ? el('span', { class: 'muted' }, `${nDone} of ${rows.length}`) : null,
          el('a', { class: 'mini', href: '#notes' }, 'All plans ›'))),
      behind ? el('div', { class: 'behind' },
        el('span', {}, `${behind} item${behind === 1 ? '' : 's'} from earlier days ${behind === 1 ? 'isn\'t' : 'aren\'t'} done.`),
        el('button', { class: 'mini primary', onclick: () => { replanAll(today()); renderStudyCard(); toast('Moved forward from today'); } }, 'Replan from today')) : null,
      groups.length ? groups.map(g => el('div', { class: 'sgroup', style: `--sc:${g.p.color}` },
        el('div', { class: 'sghead' },
          el('a', { class: 'sgname', href: '#plan/' + g.p.id }, g.p.name), g.group ? el('span', { class: 'muted small' }, g.group) : null,
          el('span', { class: 'head-actions' },
            el('button', { class: 'mini', onclick: () => newNote(date, g.p.name, g.p.id) }, '+ Note'),
            el('button', { class: 'mini', onclick: () => movePlanItems(g.p, g.items, renderStudyCard) }, 'Move…'))),
        el('ul', { class: 'routine' }, g.items.map(it => check(g.p, it)))))
        : el('p', { class: 'muted small' }, hol ? `${hol}: no studying planned.` : 'Nothing planned for this day.'),
      extras.length ? el('div', { class: 'sgroup extra', style: `--sc:${extras[0].p.color}` },
        el('div', { class: 'sghead' }, el('span', { class: 'sgname' }, 'This week, when you can')),
        el('ul', { class: 'routine' }, extras.map(({ p, x }) => check(p, x)))) : null);
  }
  function movePlanItems(p, items, after) {
    openMove(addDays(items[0].date || today(), 1), date => {
      items.forEach(it => { it.date = date; });
      Store.save(p);
      after();
      toast('Moved to ' + fmt(date, { weekday: 'long', month: 'short', day: 'numeric' }));
    });
  }

  // ---- Studies tab: one card per plan ----
  function renderStudyOverview() {
    const box = $('#studyOverview'), all = plans();
    fill(box,
      el('div', { class: 'card-head' }, el('h2', {}, el('span', { class: 'dot', style: 'background:#9b3fb5' }), 'Study plans'),
        el('span', { class: 'head-actions' },
          el('button', { class: 'mini', onclick: allNotesPdf }, '⤓ All notes PDF'),
          el('button', { class: 'mini primary', onclick: () => openPlanMaker() }, '+ New study plan'))),
      all.length ? el('div', { class: 'plancards' }, all.map(p => {
        const s = planStats(p);
        const nWritten = planPdfNotes(p).length;
        return el('div', { class: 'plancard-wrap' }, el('a', { class: 'plancard', href: '#plan/' + p.id, style: `--sc:${p.color}` },
          el('strong', {}, p.name),
          p.goal ? el('span', { class: 'muted small' }, p.goal) : null,
          el('div', { class: 'sbar' }, el('span', { style: `width:${s.total ? (s.n / s.total * 100).toFixed(1) : 0}%` })),
          el('span', { class: 'small' }, `${s.n} of ${s.total} done` + (s.end ? ` · ends ${fmt(s.end, { day: 'numeric', month: 'short' })}` : '')),
          s.next ? el('span', { class: 'small muted' }, 'Next: ' + s.next.title + (s.next.date ? ' · ' + fmt(s.next.date, { weekday: 'short', day: 'numeric', month: 'short' }) : '')) : el('span', { class: 'small' }, 'Finished!'),
          s.behind ? el('span', { class: 'st st-noshow' }, `${s.behind} behind`) : null),
          el('button', { class: 'mini plancard-pdf', disabled: nWritten ? null : true, title: nWritten ? 'Download this plan\'s written notes as a PDF' : 'No written notes yet', onclick: () => planPdf(p) },
            nWritten ? `⤓ Notes PDF (${nWritten})` : '⤓ Notes PDF'));
      })) : el('p', { class: 'muted small' }, 'No study plans yet. Tap New study plan, paste or photograph what you need to study, and Claude organizes it into days.'));
  }

  // ---- one plan: overdue, next topics, all topics, notes ----
  const planNotes = p => Store.list('note').filter(n => (n.strokes.length || n.subject) && (n.planId === p.id || (n.subject || '').trim().toLowerCase() === p.name.trim().toLowerCase()))
    .sort((a, b) => b.date.localeCompare(a.date) || b.created - a.created);
  function planPdfNotes(p) {
    const order = new Map((p.items || []).map((it, i) => [it.id, i]));
    const notes = planNotes(p).filter(n => n.strokes.length);
    const topicNotes = notes.filter(n => n.topicId && order.has(n.topicId)).sort((a, b) => order.get(a.topicId) - order.get(b.topicId));
    const others = notes.filter(n => !topicNotes.includes(n)).sort((a, b) => a.date.localeCompare(b.date) || a.created - b.created);
    return topicNotes.concat(others);
  }
  function planPdf(p) {
    const list = planPdfNotes(p);
    if (!list.length) { toast('No written notes in this plan yet. Open a topic and write with Apple Pencil.', 5000); return; }
    Store.flushAll();
    notesToPdf(list, p.name);
  }

  function allNotesPdf() {
    const list = [], used = new Set();
    for (const p of plans()) {
      const ns = planPdfNotes(p);
      if (!ns.length) continue;
      const st = planStats(p);
      list.push({ section: p.name, sub: `${ns.length} page${ns.length === 1 ? '' : 's'} of notes · ${st.n} of ${st.total} topics done` });
      ns.forEach(n => { list.push(n); used.add(n.id); });
    }
    const rest = Store.list('note').filter(n => n.strokes.length && !used.has(n.id)).sort((a, b) => a.date.localeCompare(b.date) || a.created - b.created);
    if (rest.length) { list.push({ section: 'Other study notes', sub: `${rest.length} note${rest.length === 1 ? '' : 's'}` }); list.push(...rest); }
    if (!list.length) { toast('No written notes yet.', 4000); return; }
    Store.flushAll();
    notesToPdf(list, 'All study notes');
  }

  function showPlan(p) {
    unmountAll();
    setView('plan');
    const box = $('#planPage');
    const s = planStats(p), t = today();
    const items = p.items || [];
    const overdue = items.filter(i => !i.done && i.date && i.date < t).sort((a, b) => a.date.localeCompare(b.date));
    const next = items.filter(i => !i.done && (!i.date || i.date >= t)).sort((a, b) => (a.date || '9').localeCompare(b.date || '9')).slice(0, 8);
    const groups = new Map();
    items.forEach(i => { const g = i.group || 'Topics'; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(i); });
    const notes = planNotes(p);
    const nameIn = el('input', { class: 'plan-name', value: p.name, 'aria-label': 'Plan name' });
    nameIn.oninput = () => {
      const old = p.name;
      p.name = nameIn.value.trim() || 'Study plan';
      // notes that used the old name follow the plan
      Store.list('note').forEach(n => { if ((n.subject || '').trim().toLowerCase() === old.trim().toLowerCase()) { n.subject = p.name; n.planId = p.id; Store.save(n); } });
      Store.save(p);
    };
    const dateLabel = it => it.date ? fmt(it.date, { weekday: 'short', day: 'numeric', month: 'short' }) : 'no date';
    const itemRow = (it, opts = {}) => el('li', { class: 'pitem' + (it.done ? ' ok' : '') + (!it.done && it.date && it.date < t ? ' late' : '') },
      el('button', { class: 'tick' + (it.done ? ' on' : ''), 'aria-pressed': String(!!it.done), 'aria-label': (it.done ? 'Not done: ' : 'Done: ') + it.title, onclick: () => { toggleItem(p, it); showPlan(p); } }, el('span', { class: 'box' })),
      el('button', { class: 'ptitle', title: 'Open this topic', onclick: () => openTopic(p, it) },
        el('span', {}, it.title, opts.group && it.group ? el('small', {}, ' · ' + it.group) : null),
        topicMarks(it) ? el('span', { class: 'marks' }, topicMarks(it)) : null),
      el('button', { class: 'pdate', title: 'Change the day', onclick: () => movePlanItems(p, [it], () => showPlan(p)) }, it.done ? '✓ ' + fmt(it.done, { day: 'numeric', month: 'short' }) : dateLabel(it)),
      opts.remove ? el('button', { class: 'icon-btn sm', title: 'Remove', 'aria-label': 'Remove ' + it.title, onclick: async () => { if (await ask(`Remove "${it.title}" from the plan?`, 'Remove')) { p.items = p.items.filter(x => x !== it); Store.save(p); showPlan(p); } } }, '×') : null);
    fill(box,
      el('div', { class: 'notehead' },
        el('a', { class: 'mini', href: '#notes' }, '‹ Studies'),
        nameIn,
        el('input', { type: 'color', value: p.color, 'aria-label': 'Colour', oninput: e => { p.color = e.target.value; Store.save(p); } }),
        el('button', { class: 'mini danger', onclick: async () => { if (await ask(`Delete the plan "${p.name}"? Its study notes stay.`, 'Delete')) { Store.remove(p.id); go('notes'); } } }, 'Delete plan')),
      el('section', { class: 'card plan-top', style: `--sc:${p.color}` },
        el('div', { class: 'scourse' },
          p.goal ? el('span', { class: 'muted' }, p.goal) : null,
          el('div', { class: 'sbar' }, el('span', { style: `width:${s.total ? (s.n / s.total * 100).toFixed(1) : 0}%` })),
          el('span', { class: 'small' }, `${s.n} of ${s.total} topics done` + (s.end ? ` · ends ${fmt(s.end, { weekday: 'short', day: 'numeric', month: 'short' })}` : '') + ` · studies on ${(p.days || []).map(n => DOW_SHORT[n]).join(', ') || 'any day'}`)),
        el('div', { class: 'evinfo-actions' },
          el('button', { class: 'mini primary', onclick: () => planPdf(p) }, '⤓ Notes PDF'),
          el('button', { class: 'mini', onclick: () => openPlanMaker(p) }, '✦ Reorganize with Claude'),
          el('button', { class: 'mini', onclick: () => addPlanItem(p) }, '+ Add topic'),
          el('button', { class: 'mini', onclick: () => { replanPlan(p, t); showPlan(p); toast('Plan laid out again from today'); } }, 'Replan from today'),
          EMBED ? el('button', { class: 'mini', onclick: async e => {
            const b = e.currentTarget; b.disabled = true; b.textContent = 'Syncing…';
            try { const r = await syncGranola(p); toast(r.linked ? `Linked ${r.linked} Granola note${r.linked === 1 ? '' : 's'} to topics` : 'No new Granola notes matched a topic', 5000); showPlan(p); }
            catch (err) { toast(connectorProblem(err, 'Granola', 'your Granola notes')[0], 6000); b.disabled = false; b.textContent = '⟳ Sync with Granola'; }
          } }, '⟳ Sync with Granola') : null)),
      el('div', { class: 'duo' },
        el('section', { class: 'card plan-sec overdue-sec' },
          el('div', { class: 'card-head' }, el('h2', {}, 'Overdue'), overdue.length ? el('span', { class: 'st st-noshow' }, String(overdue.length)) : null),
          overdue.length ? [el('ul', { class: 'routine' }, overdue.map(it => itemRow(it, { group: true }))),
            el('button', { class: 'mini primary', onclick: () => { replanPlan(p, t); showPlan(p); toast('Moved forward from today'); } }, 'Move these forward from today')]
            : el('p', { class: 'muted small' }, 'Nothing overdue. Well done!')),
        el('section', { class: 'card plan-sec' },
          el('div', { class: 'card-head' }, el('h2', {}, 'Next topics')),
          next.length ? el('ul', { class: 'routine' }, next.map(it => itemRow(it, { group: true }))) : el('p', { class: 'muted small' }, s.total ? 'Everything is done!' : 'No topics yet.'))),
      el('section', { class: 'card plan-sec' },
        el('div', { class: 'card-head' }, el('h2', {}, 'All topics'), el('span', { class: 'muted small' }, `${s.n} of ${s.total} done`)),
        items.length ? [...groups].map(([g, list]) => {
          const done = list.filter(i => i.done).length;
          return el('details', { class: 'tgroup', open: list.some(i => !i.done && i.date && i.date <= addDays(t, 7)) ? true : null },
            el('summary', {}, el('span', {}, g), el('span', { class: 'muted small' }, `${done}/${list.length}`)),
            el('ul', { class: 'routine' }, list.map(it => itemRow(it, { remove: true }))));
        }) : el('p', { class: 'muted small' }, 'No topics yet. Tap Reorganize with Claude or Add topic.'),
        (p.extras || []).length ? el('details', { class: 'tgroup' }, el('summary', {}, el('span', {}, 'Extras'), el('span', { class: 'muted small' }, `${p.extras.filter(x => x.done).length}/${p.extras.length}`)),
          el('ul', { class: 'routine' }, p.extras.map(x => el('li', {},
            el('button', { class: 'rcheck' + (x.done ? ' on' : ''), onclick: () => { toggleItem(p, x); showPlan(p); } }, el('span', { class: 'box' }),
              el('span', { class: 'label' }, x.title, x.week ? el('small', {}, ' · week of ' + fmt(x.week, { day: 'numeric', month: 'short' })) : null)))))) : null),
      el('section', { class: 'card plan-sec' },
        el('div', { class: 'card-head' }, el('h2', {}, 'Notes'),
          el('span', { class: 'head-actions' },
            notes.length ? el('button', { class: 'mini', onclick: () => planPdf(p) }, '⤓ Notes PDF') : null,
            el('button', { class: 'mini primary', onclick: () => newNote(t, p.name, p.id) }, '+ New note'))),
        notes.length ? el('div', { class: 'note-grid' }, notes.map(n => noteCard(n, true))) : el('p', { class: 'muted small' }, 'No notes for this plan yet. Tap New note to write with Apple Pencil.')));
    scrollTo(0, 0);
  }

  // ---- handwritten notes to PDF ----
  let pdfLib = null;
  function loadPdfLib() {
    if (window.jspdf) return Promise.resolve(window.jspdf);
    if (pdfLib) return pdfLib;
    pdfLib = new Promise((res, rej) => {
      const sc = document.createElement('script');
      sc.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
      sc.onload = () => window.jspdf ? res(window.jspdf) : rej(new Error('PDF tool missing'));
      sc.onerror = () => { pdfLib = null; rej(new Error('Could not load the PDF tool')); };
      document.head.append(sc);
    });
    return pdfLib;
  }
  const PAGE_H = Math.round(LW * 297 / 210); // A4 proportions in note units
  function renderSlice(note, top, h, scale) {
    const c = document.createElement('canvas');
    c.width = Math.round(LW * scale); c.height = Math.round(h * scale);
    const x = c.getContext('2d');
    x.setTransform(scale, 0, 0, scale, 0, -top * scale);
    drawPaper(x, note.paper, note.h || NOTE_H);
    for (const st of note.strokes) drawStroke(x, st);
    return c;
  }
  async function notesToPdf(notes, title) {
    toast('Making the PDF…', 4000);
    try {
      const { jsPDF } = await loadPdfLib();
      const doc = new jsPDF({ unit: 'pt', format: 'a4', compress: true });
      const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M = 28;
      let first = true;
      for (const n of notes) {
        if (n.section) { // a title page for a plan
          if (!first) doc.addPage();
          first = false;
          doc.setFontSize(26); doc.setTextColor(43, 42, 40);
          doc.text(doc.splitTextToSize(n.section, W - 2 * M), M, H / 2 - 20);
          doc.setFontSize(12); doc.setTextColor(119, 115, 107);
          if (n.sub) doc.text(n.sub, M, H / 2 + 14);
          continue;
        }
        // only as many pages as the writing needs
        let bottom = 0;
        n.strokes.forEach(st => { for (let i = 1; i < st.pts.length; i += 3) bottom = Math.max(bottom, st.pts[i]); });
        const used = Math.min(n.h || NOTE_H, Math.max(PAGE_H * 0.5, bottom + 80));
        for (let top = 0; top < used; top += PAGE_H) {
          if (!first) doc.addPage();
          first = false;
          const h = Math.min(PAGE_H, (n.h || NOTE_H) - top);
          if (top === 0) {
            doc.setFontSize(13); doc.setTextColor(43, 42, 40);
            doc.text(doc.splitTextToSize(n.topic || n.subject || 'Study note', W - 2 * M)[0], M, M + 8);
            doc.setFontSize(9); doc.setTextColor(119, 115, 107);
            doc.text([n.topic ? n.subject : '', fmt(n.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })].filter(Boolean).join(' · '), M, M + 21);
          }
          const img = renderSlice(n, top, h, 1.6).toDataURL('image/jpeg', 0.85);
          const y0 = top === 0 ? M + 32 : M, avail = H - y0 - M;
          const w = Math.min(W - 2 * M, avail * LW / h);
          doc.addImage(img, 'JPEG', (W - w) / 2, y0, w, w * h / LW);
        }
      }
      const blob = doc.output('blob');
      const base = (title || 'Study notes').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80);
      const filename = /notes$/i.test(base) ? base + '.pdf' : base + ' notes.pdf';
      if (EMBED) {
        const dl = await window.claude.use('downloads').catch(() => null);
        if (!dl) { toast('Downloading isn\'t available here.', 5000); return; }
        await dl.save({ filename, data: blob });
        toast('PDF saved');
      } else {
        const a = el('a', { href: URL.createObjectURL(blob), download: filename });
        document.body.append(a); a.click(); a.remove();
      }
    } catch (e) {
      console.warn(e);
      if (!e || e.code !== 'declined') toast('Couldn\'t make the PDF. Check your internet connection and try again.', 6000);
    }
  }
  function addPlanItem(p) {
    $('#addItemTitle').value = '';
    $('#addItemDate').value = today();
    $('#addItemDlg').showModal();
    $('#addItemGo').onclick = () => {
      const title = $('#addItemTitle').value.trim(), date = $('#addItemDate').value;
      if (!title) { $('#addItemTitle').focus(); return; }
      p.items.push({ id: 'i-' + uid(), title, group: '', date: isDate(date) ? date : '', done: null });
      Store.save(p);
      $('#addItemDlg').close();
      showPlan(p);
    };
  }
  $('#addItemCancel').addEventListener('click', () => $('#addItemDlg').close());

  // ---- making a plan: Claude organizes it (or a simple spread when Claude isn't available) ----
  let Sample = null;
  if (EMBED) window.claude.use('sample').then(s => { Sample = s || null; }).catch(() => { Sample = null; });
  let maker = null; // { plan (when reorganizing), draft }
  function openPlanMaker(existing) {
    maker = { plan: existing || null, draft: null, photo: null };
    $('#pmTitle').textContent = existing ? `Reorganize “${existing.name}”` : 'New study plan';
    $('#pmName').value = existing ? existing.name : '';
    $('#pmName').closest('label').hidden = !!existing;
    $('#pmMaterial').value = '';
    $('#pmMaterialLabel').firstChild.textContent = existing ? 'What should change? (for example: I can only study on weekends now, finish by 20 Dec)' : 'What do you need to study?';
    $('#pmMaterial').placeholder = existing ? 'Tell Claude what to change' : 'Paste the course content, a list of topics or chapters, or describe it. You can also add a photo.';
    $('#pmStart').value = today();
    $('#pmEnd').value = '';
    $('#pmMinutes').value = '60';
    document.querySelectorAll('#pmDays input').forEach(cb => { cb.checked = (existing && existing.days ? existing.days : [1, 2, 3, 4, 5]).includes(Number(cb.value)); });
    $('#pmPhoto').value = '';
    fill($('#pmPreview'));
    $('#pmMsg').textContent = Sample ? '' : 'Claude can organize plans when the planner is open inside Claude. Without it, “Spread it out” puts one line per day.';
    $('#pmClaude').hidden = !Sample;
    $('#pmSpread').hidden = !!existing;
    $('#pmSave').hidden = true;
    $('#planDlg').showModal();
  }
  $('#pmCancel').addEventListener('click', () => $('#planDlg').close());
  $('#pmPhoto').addEventListener('change', e => { maker.photo = e.target.files[0] || null; });
  const pmDays = () => [...document.querySelectorAll('#pmDays input:checked')].map(cb => Number(cb.value));

  function cleanDraft(raw, fallbackName) {
    const days = Array.isArray(raw && raw.days) ? raw.days.filter(n => Number.isInteger(n) && n >= 0 && n <= 6) : pmDays();
    const items = (raw && Array.isArray(raw.items) ? raw.items : []).slice(0, 400).map(i => ({
      id: 'i-' + uid(), title: String(i && i.title || '').slice(0, 300), group: String(i && i.group || '').slice(0, 200),
      date: isDate(i && i.date) ? i.date : '', done: null,
    })).filter(i => i.title);
    return { name: String(raw && raw.name || fallbackName || 'Study plan').slice(0, 120), goal: String(raw && raw.goal || '').slice(0, 300), days: days.length ? days : [1, 2, 3, 4, 5], items, note: String(raw && raw.note || '').slice(0, 600) };
  }
  function drawDraft(d) {
    const byDate = new Map();
    d.items.forEach(i => { const k = i.date || ''; if (!byDate.has(k)) byDate.set(k, []); byDate.get(k).push(i); });
    const keys = [...byDate.keys()].sort((a, b) => (a || '9').localeCompare(b || '9'));
    fill($('#pmPreview'),
      el('h3', { class: 'subhead' }, `${d.name} · ${d.items.length} items` + (keys.filter(Boolean).length ? ` · ${fmt(keys.filter(Boolean)[0], { day: 'numeric', month: 'short' })} – ${fmt(keys.filter(Boolean).pop(), { day: 'numeric', month: 'short' })}` : '')),
      d.note ? el('p', { class: 'small' }, d.note) : null,
      el('div', { class: 'pm-list' }, keys.map(k => el('div', { class: 'pday' },
        el('div', { class: 'pday-head' }, el('b', {}, k ? fmt(k, { weekday: 'short', day: 'numeric', month: 'short' }) : 'No date')),
        el('ul', {}, byDate.get(k).map(i => el('li', {}, i.title, i.group ? el('span', { class: 'muted small' }, ' · ' + i.group) : null)))))));
    $('#pmSave').hidden = false;
    $('#pmSave').textContent = maker.plan ? 'Use this plan' : 'Save plan';
    $('#pmMaterialLabel').firstChild.textContent = 'Want something different? Tell Claude and ask again:';
    $('#pmMaterial').value = '';
  }
  const sampleProblem = e => ({
    not_granted: 'Claude needs your OK to organize plans. Tap the button again and choose Allow.',
    rate_limited: 'Claude is busy right now. Wait a minute and try again.',
    images_unavailable: 'Photos can\'t be sent to Claude here. Paste the text instead.',
  })[e && e.code] || 'Claude couldn\'t make the plan this time. Try again, or shorten what you pasted.';

  $('#pmClaude').addEventListener('click', async () => {
    const msg = $('#pmMsg'), btn = $('#pmClaude');
    const material = $('#pmMaterial').value.trim();
    const p = maker.plan;
    if (!material && !maker.photo && !maker.draft && !p) { msg.textContent = 'Paste or describe what you need to study first (or add a photo).'; return; }
    const start = isDate($('#pmStart').value) ? $('#pmStart').value : today();
    const end = isDate($('#pmEnd').value) ? $('#pmEnd').value : '';
    const days = pmDays();
    const current = maker.draft || (p ? { name: p.name, goal: p.goal, days: p.days, items: (p.items || []).map(i => ({ title: i.title, group: i.group, date: i.date, done: !!i.done })) } : null);
    const holidays = (studyPlan() && studyPlan().holidays) || {};
    const prompt = [
      'You organize a personal study plan for a teacher who studies alongside work. Answer with JSON only, no other text.',
      `Today is ${today()} (${DOW_SHORT[dow(today())]}). Plan from ${start}${end ? ' and finish by ' + end : ''}.`,
      `Study only on these weekdays: ${days.map(n => DOW_SHORT[n]).join(', ') || 'Mon–Fri'}. About ${$('#pmMinutes').value || 60} minutes per study day.`,
      Object.keys(holidays).length ? `No studying on: ${Object.entries(holidays).map(([d, n]) => d + ' (' + n + ')').join(', ')}.` : '',
      'Other study already planned on the same days (balance around it): ' + JSON.stringify(plans().filter(x => !p || x.id !== p.id).flatMap(x => (x.items || []).filter(i => !i.done && i.date >= start).map(i => i.date)).reduce((a, d) => { a[d] = (a[d] || 0) + 1; return a; }, {})),
      'Rules: keep the order of the material; split big chapters into study sessions that fit the time per day; add review sessions before tests or deadlines; give every item a date (YYYY-MM-DD) on an allowed weekday; keep titles short; write in the same language as the material.',
      current ? 'Current plan (items marked done stay done and keep their date):\n' + JSON.stringify(current) : '',
      material ? (current ? 'Change requested: ' : 'What to study:\n') + material : '',
      'JSON shape: {"name": string, "goal": string, "days": [weekday numbers 0=Sun..6=Sat], "items": [{"title": string, "group": string (module, chapter or subject), "date": "YYYY-MM-DD", "done": boolean}], "note": string (one or two sentences about how you organized it)}',
    ].filter(Boolean).join('\n\n');
    btn.disabled = true;
    msg.textContent = 'Claude is organizing your plan… this can take up to a minute.';
    try {
      const opts = { modelTier: 'default' };
      if (maker.photo) opts.images = [maker.photo];
      const raw = await Sample.json(prompt, opts);
      const d = cleanDraft(raw, $('#pmName').value.trim() || (p && p.name));
      if (!d.items.length) throw { code: 'empty' };
      // keep what's already done
      if (raw && Array.isArray(raw.items)) raw.items.forEach((r, i) => { if (r && r.done && d.items[i]) d.items[i].done = today(); });
      if (p) (p.items || []).filter(i => i.done).forEach(old => { const m = d.items.find(n => n.title === old.title); if (m) { m.done = old.done; m.date = old.date; } });
      maker.draft = d;
      msg.textContent = '';
      drawDraft(d);
    } catch (e) {
      console.warn(e);
      msg.textContent = sampleProblem(e);
    } finally { btn.disabled = false; btn.textContent = maker.draft ? '✦ Ask Claude again' : '✦ Organize with Claude'; }
  });

  // Without Claude: one non-empty line per item, lines ending in ":" start a group, spread over the chosen days
  $('#pmSpread').addEventListener('click', () => {
    const lines = $('#pmMaterial').value.split('\n').map(l => l.replace(/^[-*•\d.)\s]+/, '').trim()).filter(Boolean);
    if (!lines.length) { $('#pmMsg').textContent = 'Write one topic per line first.'; return; }
    const days = pmDays().length ? pmDays() : [1, 2, 3, 4, 5];
    const start = isDate($('#pmStart').value) ? $('#pmStart').value : today();
    const end = isDate($('#pmEnd').value) ? $('#pmEnd').value : '';
    let group = '';
    const items = [];
    for (const l of lines) { if (/:$/.test(l)) { group = l.slice(0, -1); continue; } items.push({ id: 'i-' + uid(), title: l, group, date: '', done: null }); }
    let slots = 0;
    if (end) for (let d = start; d <= end && slots < 400; d = addDays(d, 1)) if (days.includes(dow(d))) slots++;
    const perDay = end && slots ? Math.max(1, Math.ceil(items.length / slots)) : 1;
    let d = start, k = 0;
    for (const it of items) {
      while (!days.includes(dow(d))) d = addDays(d, 1);
      it.date = d;
      if (++k >= perDay) { k = 0; d = addDays(d, 1); }
    }
    maker.draft = { name: $('#pmName').value.trim() || 'Study plan', goal: '', days, items, note: '' };
    drawDraft(maker.draft);
  });

  $('#pmSave').addEventListener('click', () => {
    const d = maker.draft;
    if (!d) return;
    if (maker.plan) {
      const p = maker.plan;
      Object.assign(p, { goal: d.goal || p.goal, days: d.days, items: d.items, rule: '' });
      Store.save(p);
      $('#planDlg').close();
      showPlan(p);
      toast('Plan reorganized');
      return;
    }
    const used = plans().map(x => x.color);
    const p = { id: 'plan-' + uid(), kind: 'plan', date: today(), created: Date.now(), name: $('#pmName').value.trim() || d.name, goal: d.goal,
      color: PLAN_COLORS.find(c => !used.includes(c)) || PLAN_COLORS[0], days: d.days, items: d.items, extras: [] };
    Store.save(p);
    $('#planDlg').close();
    go('plan/' + p.id);
    toast('Study plan saved');
  });

  // ---------- one topic: written notes + Granola recording ----------
  const topicMarks = it => [it.noteId && Store.items.has(it.noteId) && Store.items.get(it.noteId).strokes.length ? '✎' : '', it.granola && it.granola.length ? '🎙' : ''].filter(Boolean).join(' ');
  const openTopic = (p, it) => go(`topic/${p.id}/${it.id}`);

  // Granola notes in a date range, one search
  async function granolaRange(from, to, force) {
    const text = await granolaCall('search_meetings', { from_date: from, to_date: to, limit: 100, max_participants: 2, include_shared: false }, force);
    return parseGranolaMeetings(text).filter(m => !m.upcoming);
  }
  const topicWords = s => className(s).split(' ').filter(w => w.length > 3);
  function topicScore(it, m) {
    const words = topicWords(it.title);
    if (!words.length) return 0;
    const hay = ' ' + className(m.title + ' ' + m.headers.join(' ')) + ' ';
    return words.filter(w => hay.includes(' ' + w)).length / words.length;
  }
  const keepMeeting = m => ({ id: m.id, title: m.title, url: m.url, at: m.at, headers: m.headers.slice(0, 6) });
  function linkGranola(it, m) {
    it.granola = it.granola || [];
    if (!it.granola.some(g => g.id === m.id)) it.granola.push(keepMeeting(m));
  }
  // Sync: look through Granola from the plan's first day to today and link notes whose title or headings match a topic
  async function syncGranola(p, onlyItem) {
    const items = onlyItem ? [onlyItem] : (p.items || []);
    const dates = items.map(i => i.date).filter(Boolean).sort();
    const t = today();
    const from = addDays([dates[0] || t, p.date || t].sort()[0], -7);
    const meetings = await granolaRange(from < t ? from : addDays(t, -30), t, true);
    let linked = 0;
    for (const it of items) {
      const before = (it.granola || []).length;
      meetings.filter(m => topicScore(it, m) >= 0.6).forEach(m => linkGranola(it, m));
      linked += (it.granola || []).length - before;
    }
    p.lastSync = Date.now();
    Store.save(p);
    return { linked, meetings };
  }

  function showTopic(p, it) {
    unmountAll();
    setView('topic');
    const box = $('#topicPage');
    // the topic's handwritten page (created when you first write on it)
    let note = it.noteId && Store.items.get(it.noteId);
    if (!note) note = { id: uid(), kind: 'note', date: it.date || today(), subject: p.name, planId: p.id, topicId: it.id, topic: it.title, paper: lsGet('pp-paper', 'lines'), h: NOTE_H, strokes: [], created: Date.now() };
    const wrap = el('div', {});
    const granolaBox = el('div', {});
    const syncMsg = el('span', { class: 'muted small' }, p.lastSync ? 'Last synced ' + new Date(p.lastSync).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '');
    const paperSel = el('select', { 'aria-label': 'Paper' }, [['lines', 'Lined'], ['grid', 'Grid'], ['dots', 'Dots'], ['blank', 'Blank']].map(([v, l]) => el('option', { value: v, selected: note.paper === v ? true : null }, l)));
    fill(box,
      el('div', { class: 'notehead' },
        el('a', { class: 'mini', href: '#plan/' + p.id }, '‹ ' + p.name),
        el('span', { class: 'grow' }),
        el('button', { class: 'pdate', title: 'Change the day', onclick: () => movePlanItems(p, [it], () => showTopic(p, it)) }, it.date ? fmt(it.date, { weekday: 'short', day: 'numeric', month: 'short' }) : 'No date'),
        el('button', { class: 'mini' + (it.done ? ' primary' : ''), onclick: () => { toggleItem(p, it); showTopic(p, it); } }, it.done ? '✓ Done' : 'Mark as done')),
      el('section', { class: 'card topic-head', style: `--sc:${p.color}` },
        el('span', { class: 'sgname' }, p.name + (it.group ? ' · ' + it.group : '')),
        el('h1', { class: 'evinfo-title' }, it.title)),
      el('section', { class: 'card' },
        el('div', { class: 'card-head' }, el('h2', {}, '✎ Written notes'),
          el('span', { class: 'head-actions' }, paperSel,
            el('button', { class: 'mini', onclick: () => { if (!note.strokes.length) { toast('Write something first.'); return; } Store.flushAll(); notesToPdf([note], it.title); } }, '⤓ PDF'))),
        el('div', { class: 'page' }, wrap),
        el('button', { class: 'mini more-space', onclick: () => { note.h = Math.min(NOTE_MAX, note.h + NOTE_GROW); if (Store.items.has(note.id)) Store.save(note); surface.layout(true); } }, '+ More space')),
      el('section', { class: 'card' },
        el('div', { class: 'card-head' }, el('h2', {}, '🎙 Granola recording'),
          el('span', { class: 'head-actions' }, syncMsg, EMBED ? el('button', { class: 'mini primary', id: 'topicSync' }, '⟳ Sync with Granola') : null)),
        el('p', { class: 'small muted' }, 'Record this study session in the Granola app. Give the note this topic\'s name (or say it at the start) and tap Sync: the recording\'s notes show up here.'),
        el('div', { class: 'rec-controls' },
          el('code', { class: 'copyname' }, it.title),
          el('button', { class: 'mini', onclick: async () => { try { await navigator.clipboard.writeText(it.title); toast('Name copied. Paste it as the Granola note title.'); } catch { toast('Copy didn\'t work here: type the name in Granola.'); } } }, 'Copy name')),
        granolaBox));
    const surface = new Surface(wrap, note, {
      paper: () => note.paper, grow: true,
      onStroke: () => {
        if (Store.items.has(note.id)) return;
        Store.save(note);
        it.noteId = note.id;
        Store.save(p);
      },
      onChange: () => { if (Store.items.has(note.id)) Store.save(note); },
    });
    paperSel.onchange = () => { note.paper = paperSel.value; lsSet('pp-paper', note.paper); if (Store.items.has(note.id)) Store.save(note); surface.render(); };
    drawTopicGranola(p, it, granolaBox);
    const sb = box.querySelector('#topicSync');
    if (sb) sb.onclick = async () => {
      sb.disabled = true;
      syncMsg.textContent = 'Syncing…';
      try {
        const r = await syncGranola(p, it);
        syncMsg.textContent = r.linked ? `Found ${r.linked} new Granola note${r.linked === 1 ? '' : 's'}` : 'No new Granola notes for this topic';
        drawTopicGranola(p, it, granolaBox, r.meetings);
      } catch (err) {
        console.warn(err);
        syncMsg.textContent = connectorProblem(err, 'Granola', 'your Granola notes')[0];
      } finally { sb.disabled = false; }
    };
    scrollTo(0, 0);
  }
  // Linked Granola notes, plus that day's other notes to link by hand
  async function drawTopicGranola(p, it, box, meetings) {
    const linked = it.granola || [];
    const row = (m, extra) => {
      const li = granolaItem({ upcoming: false, headers: [], ...m });
      const when = li.querySelector('.when');
      if (when && m.at) when.textContent = fmt(iso(new Date(m.at)), { day: 'numeric', month: 'short' });
      if (extra) li.querySelector('.head-actions').append(extra);
      return li;
    };
    fill(box,
      linked.length ? el('ul', { class: 'glist' }, linked.map(m => row(m, el('button', { class: 'mini', title: 'Unlink', onclick: () => { it.granola = it.granola.filter(g => g.id !== m.id); Store.save(p); drawTopicGranola(p, it, box, meetings); } }, 'Unlink'))))
        : el('p', { class: 'muted small' }, EMBED ? 'No Granola recording linked yet.' : 'Granola shows up when you open the planner inside Claude.'),
      el('div', { class: 'gmore' }));
    if (!EMBED) return;
    const more = box.querySelector('.gmore');
    try {
      const day = it.date || today();
      const list = meetings || await granolaDay(day);
      if (!box.isConnected) return;
      const others = list.filter(m => !m.upcoming && !linked.some(g => g.id === m.id) && (meetings ? topicScore(it, m) > 0 || iso(new Date(m.at)) === day : true)).slice(0, 8);
      if (!others.length) return;
      fill(more, el('h3', { class: 'subhead' }, meetings ? 'Other Granola notes that might belong here' : 'Granola notes from ' + fmt(day, { day: 'numeric', month: 'short' })),
        el('ul', { class: 'glist' }, others.map(m => row(m, el('button', { class: 'mini primary', onclick: () => { linkGranola(it, m); Store.save(p); drawTopicGranola(p, it, box, meetings); } }, 'Link')))));
    } catch { /* the sync button shows problems */ }
  }

  // ---------- picture of the day & gratitude ----------
  const photoOf = date => Store.items.get('photo-' + date);
  const photoSrc = ph => ph ? (ph.assetId ? '/_blob/' + ph.assetId : ph.dataUrl || '') : '';
  let Assets;
  const assetsNs = () => Assets !== undefined ? Promise.resolve(Assets)
    : (EMBED ? window.claude.use('assets').catch(() => null) : Promise.resolve(null)).then(a => (Assets = a || null));

  // Shrink a photo before saving it (and turn iPhone/iPad photos into JPEG)
  async function shrinkPhoto(file, max, quality) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('That photo couldn\'t be opened.')); i.src = url; });
      const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      const blob = await new Promise(res => c.toBlob(res, 'image/jpeg', quality));
      return { blob, dataUrl: c.toDataURL('image/jpeg', quality) };
    } finally { URL.revokeObjectURL(url); }
  }
  async function setPhoto(date, file) {
    const old = photoOf(date);
    toast('Saving your picture…', 3000);
    try {
      const a = await assetsNs();
      let rec;
      if (a) {
        const { blob } = await shrinkPhoto(file, 1600, 0.82);
        const up = await a.upload(blob);
        rec = { id: 'photo-' + date, kind: 'photo', date, assetId: up.id, caption: old ? old.caption || '' : '' };
      } else {
        const { dataUrl } = await shrinkPhoto(file, 1000, 0.75);
        rec = { id: 'photo-' + date, kind: 'photo', date, dataUrl, caption: old ? old.caption || '' : '' };
      }
      Store.save(rec);
      if (old && old.assetId && a) a.delete(old.assetId).catch(() => {});
      toast('Picture saved');
    } catch (e) {
      console.warn(e);
      toast(e && e.code === 'too_large' ? 'That photo is too big. Try a smaller one.' : (e && e.message && !e.code ? e.message : 'Couldn\'t save the picture. Try again.'), 6000);
    }
    renderDayExtras();
  }
  async function removePhoto(date) {
    const ph = photoOf(date);
    if (!ph || !(await ask('Remove the picture of the day?', 'Remove'))) return;
    Store.remove(ph.id);
    if (ph.assetId) { const a = await assetsNs(); if (a) a.delete(ph.assetId).catch(() => {}); }
    renderDayExtras();
  }

  function renderDayExtras() {
    const date = state.date;
    // picture
    const pc = $('#photoCard'), ph = photoOf(date);
    const input = el('input', { type: 'file', accept: 'image/*', hidden: true, onchange: e => { const f = e.target.files[0]; if (f) setPhoto(date, f); } });
    const caption = el('input', { class: 'caption', placeholder: 'Say something about it (optional)', value: ph ? ph.caption || '' : '', 'aria-label': 'Caption' });
    caption.oninput = () => { const cur = photoOf(date); if (cur) { cur.caption = caption.value; Store.save(cur); } };
    fill(pc,
      el('div', { class: 'card-head' }, el('h2', {}, '📷 Picture of the day'),
        ph ? el('span', { class: 'head-actions' },
          el('button', { class: 'mini', onclick: () => input.click() }, 'Change'),
          el('button', { class: 'icon-btn sm', title: 'Remove picture', 'aria-label': 'Remove picture', onclick: () => removePhoto(date) }, '×')) : null),
      input,
      ph ? [el('img', { class: 'dayphoto', src: photoSrc(ph), alt: ph.caption || 'Picture of the day' }), caption]
        : el('button', { class: 'photo-empty', onclick: () => input.click() }, el('span', { class: 'plus' }, '+'), el('span', {}, 'Add a picture'), el('span', { class: 'muted small' }, 'Take a photo or choose one')));
    // gratitude (handwritten)
    const gc = $('#gratCard');
    let g = Store.items.get('grat-' + date);
    if (!g) g = { id: 'grat-' + date, kind: 'gratitude', date, strokes: [], created: Date.now() };
    const strip = el('div', { class: 'gratpage' });
    fill(gc, el('div', { class: 'card-head' }, el('h2', {}, '🙏 Gratitude')),
      el('p', { class: 'muted small' }, 'Today I\'m grateful for…'), strip);
    new Surface(strip, g, {
      h: 330, paper: 'gratitude',
      onStroke: () => { if (!Store.items.has(g.id)) Store.save(g); },
      onChange: () => { if (Store.items.has(g.id)) Store.save(g); },
    });
  }

  // ---------- routing ----------

  // ---------- money: expenses and income ----------
  // Stored as kind 'expense' with type 'income' for money coming in (older items have no type = expense).
  const CURRENCIES = ['BRL', 'USD', 'EUR', 'GBP'];
  const BASE_CATS = {
    expense: ['Food', 'Groceries', 'Transport', 'Home', 'Bills', 'Health', 'Education', 'Work', 'Shopping', 'Leisure', 'Travel', 'Gifts', 'Other'],
    income: ['Classes', 'Salary', 'Freelance', 'Sales', 'Refund', 'Gift', 'Other'],
  };
  const METHODS = ['Pix', 'Credit card', 'Debit card', 'Cash', 'Transfer', 'Other'];
  const isIncome = x => x.type === 'income';
  const catsFor = type => [...new Set([...BASE_CATS[type], ...((Config.get('moneyCats', {})[type]) || [])])];
  const money = (n, cur) => { try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur }).format(n); } catch { return cur + ' ' + n.toFixed(2); } };
  // "1.234,56", "1,234.56", "12,5" and "12.5" all read as numbers
  function readAmount(raw) {
    let v = String(raw || '').replace(/[^\d.,-]/g, '');
    if (!v) return NaN;
    if (/^\d{1,3}([.,]\d{3})+$/.test(v) && !(v.includes('.') && v.includes(','))) v = v.replace(/[.,]/g, ''); // 3.500 or 3,500 = three thousand five hundred
    const lc = v.lastIndexOf(','), ld = v.lastIndexOf('.');
    if (lc > ld) v = v.replace(/\./g, '').replace(',', '.');
    else v = v.replace(/,/g, '');
    return Math.round(parseFloat(v) * 100) / 100;
  }
  const moneyItems = month => Store.list('expense').filter(x => !month || x.date.startsWith(month)).sort((a, b) => b.date.localeCompare(a.date) || b.created - a.created);
  const totals = list => { const t = {}; for (const x of list) t[x.currency] = (t[x.currency] || 0) + x.amount; return t; };
  const totalText = list => { const t = totals(list); const k = Object.keys(t); return k.length ? k.map(c => money(t[c], c)).join(' + ') : money(0, Config.get('currency', 'BRL')); };
  const sumIn = (list, cur) => list.filter(x => x.currency === cur).reduce((a, x) => a + x.amount, 0);
  const monthName = m => parse(m + '-01').toLocaleDateString(undefined, { month: 'long' });
  const shiftMonth = (m, n) => { const d = parse(m + '-01'); d.setMonth(d.getMonth() + n); return iso(d).slice(0, 7); };

  // ---- the add / edit dialog ----
  let editingMoney = null, moneyDone = null, moneyType = 'expense';
  const opts = (sel, list, val) => fill(sel, list.map(v => el('option', { value: v, selected: v === val ? true : null }, v)));
  function setMoneyType(type, keepCat) {
    moneyType = type;
    $('#exTypeOut').classList.toggle('on', type === 'expense');
    $('#exTypeIn').classList.toggle('on', type === 'income');
    $('#exDlgTitle').textContent = (editingMoney ? 'Edit ' : 'New ') + (type === 'income' ? 'income' : 'expense');
    $('#exDescLabel b').textContent = type === 'income' ? 'Where is it from?' : 'What was it?';
    $('#exDesc').placeholder = type === 'income' ? 'e.g. Classes with Ana, salary' : 'e.g. Lunch, Uber, books';
    $('#exMethodLabel b').textContent = type === 'income' ? 'Received by' : 'Paid with';
    const cats = catsFor(type), cur = keepCat && cats.includes(keepCat) ? keepCat : cats[0];
    fill($('#exCategory'), cats.map(v => el('option', { value: v, selected: v === cur ? true : null }, v)), el('option', { value: '__new' }, '+ New category…'));
    $('#exNewCatLabel').hidden = true;
  }
  function openMoney(x, date, after, type) {
    editingMoney = x; moneyDone = after;
    $('#exAmount').value = x ? String(x.amount).replace('.', (1.5).toLocaleString().charAt(1)) : '';
    opts($('#exCurrency'), CURRENCIES, x ? x.currency : Config.get('currency', 'BRL'));
    opts($('#exMethod'), METHODS, x ? x.method : Config.get('method', 'Pix'));
    setMoneyType(x ? (isIncome(x) ? 'income' : 'expense') : (type || 'expense'), x && x.category);
    $('#exNewCat').value = '';
    $('#exDesc').value = x ? x.desc : '';
    $('#exNote').value = x ? x.note || '' : '';
    $('#exDate').value = x ? x.date : (date || today());
    $('#exMsg').textContent = '';
    $('#exDelete').hidden = !x;
    $('#expenseDlg').showModal();
    if (!x) setTimeout(() => $('#exAmount').focus(), 50);
  }
  $('#exTypeOut').addEventListener('click', () => setMoneyType('expense'));
  $('#exTypeIn').addEventListener('click', () => setMoneyType('income'));
  $('#exCategory').addEventListener('change', e => {
    const isNew = e.target.value === '__new';
    $('#exNewCatLabel').hidden = !isNew;
    if (isNew) setTimeout(() => $('#exNewCat').focus(), 30);
  });
  $('#exCancel').addEventListener('click', () => $('#expenseDlg').close());
  $('#exSave').addEventListener('click', () => {
    const amount = readAmount($('#exAmount').value), date = $('#exDate').value;
    if (!(amount > 0)) { $('#exMsg').textContent = 'Type how much it was, like 25,90.'; return; }
    if (!isDate(date)) { $('#exMsg').textContent = 'Pick a date.'; return; }
    let category = $('#exCategory').value;
    if (category === '__new') {
      category = $('#exNewCat').value.trim().slice(0, 40);
      if (!category) { $('#exMsg').textContent = 'Type a name for the new category.'; return; }
      const all = { ...Config.get('moneyCats', {}) };
      all[moneyType] = [...new Set([...(all[moneyType] || []), category])];
      Config.set('moneyCats', all);
    }
    const x = editingMoney || { id: 'x-' + uid(), kind: 'expense', created: Date.now() };
    Object.assign(x, { type: moneyType, amount, date, currency: $('#exCurrency').value, category, method: $('#exMethod').value,
      desc: $('#exDesc').value.trim().slice(0, 200), note: $('#exNote').value.trim().slice(0, 500) });
    Config.set('currency', x.currency);
    if (moneyType === 'expense') Config.set('method', x.method);
    Store.save(x);
    $('#expenseDlg').close();
    toast((editingMoney ? 'Updated' : 'Added') + (moneyType === 'income' ? ' income.' : ' expense.'));
    if (moneyDone) moneyDone();
  });
  $('#exDelete').addEventListener('click', async () => {
    const x = editingMoney;
    $('#expenseDlg').close();
    if (!x) return;
    if (await ask(`Delete "${x.desc || x.category}" (${money(x.amount, x.currency)})?`, 'Delete')) { Store.remove(x.id); if (moneyDone) moneyDone(); }
    else $('#expenseDlg').showModal();
  });

  function moneyRow(x, after) {
    const inc = isIncome(x);
    return el('li', {},
      el('button', { class: 'xrow' + (inc ? ' income' : ''), onclick: () => openMoney(x, null, after) },
        el('span', { class: 'xcat' }, x.category),
        el('span', { class: 'xwhat' }, el('strong', {}, x.desc || x.category),
          el('span', { class: 'muted small' }, el('span', { class: 'xcat-inline' }, x.category + ' · '), [x.method, x.note || null].filter(Boolean).join(' · '))),
        el('span', { class: 'xamt' }, (inc ? '+ ' : '− ') + money(x.amount, x.currency))));
  }

  // ---- the day's Money card ----
  function renderMoneyCard() {
    const card = $('#moneyCard'), date = state.date, list = moneyItems().filter(x => x.date === date);
    const again = () => { if (state.date === date) renderMoneyCard(); };
    const out = list.filter(x => !isIncome(x)), inc = list.filter(isIncome);
    fill(card,
      el('div', { class: 'card-head' },
        el('h2', {}, el('span', { class: 'dot', style: 'background:var(--money)' }), 'Money'),
        el('span', { class: 'head-actions' },
          el('button', { class: 'mini', onclick: () => openMoney(null, date, again, 'expense') }, '− Expense'),
          el('button', { class: 'mini', onclick: () => openMoney(null, date, again, 'income') }, '+ Income'),
          el('a', { class: 'mini linkbtn', href: '#money' }, 'Month ›'))),
      list.length ? el('p', { class: 'xtotal small' },
        out.length ? el('span', {}, 'Spent ', el('b', {}, totalText(out))) : null,
        inc.length ? el('span', {}, 'Received ', el('b', {}, totalText(inc))) : null)
        : el('p', { class: 'muted small' }, 'Nothing added for this day.'),
      list.length ? el('ul', { class: 'xlist' }, list.map(x => moneyRow(x, again))) : null);
  }

  // ---- the Money tab ----
  let moneyFilter = 'all';
  function categoryTable(list, prevList, cur, kind) {
    const by = {}, prevBy = {}, count = {};
    for (const x of list) if (x.currency === cur) { by[x.category] = (by[x.category] || 0) + x.amount; count[x.category] = (count[x.category] || 0) + 1; }
    for (const x of prevList) if (x.currency === cur) prevBy[x.category] = (prevBy[x.category] || 0) + x.amount;
    const rows = Object.entries(by).sort((a, b) => b[1] - a[1]);
    if (!rows.length) return null;
    const total = rows.reduce((a, r) => a + r[1], 0), max = rows[0][1];
    const hasPrev = Object.keys(prevBy).length > 0;
    return el('table', { class: 'cattable' + (kind === 'income' ? ' income' : '') },
      el('thead', {}, el('tr', {}, el('th', {}, 'Category'), el('th', { class: 'barcol' }, ''), el('th', {}, 'Total'), el('th', {}, '%'),
        hasPrev ? el('th', {}, 'vs last month') : null)),
      el('tbody', {}, rows.map(([c, v]) => {
        const pct = Math.round(v / total * 100), prev = prevBy[c] || 0, diff = v - prev;
        return el('tr', { title: `${c}: ${money(v, cur)} in ${count[c]} item${count[c] === 1 ? '' : 's'}` },
          el('td', { class: 'catname' }, c, el('small', { class: 'muted' }, ` ${count[c]}×`)),
          el('td', { class: 'barcol' }, el('span', { class: 'btrack' }, el('span', { class: 'bfill', style: `width:${Math.max(2, v / max * 100)}%` }))),
          el('td', { class: 'num' }, money(v, cur)),
          el('td', { class: 'num muted' }, pct + '%'),
          hasPrev ? el('td', { class: 'num small' + (Math.abs(diff) < 0.005 ? ' muted' : '') },
            !prev ? 'new' : Math.abs(diff) < 0.005 ? 'same' : (diff > 0 ? '▲ ' : '▼ ') + money(Math.abs(diff), cur)) : null);
      })),
      el('tfoot', {}, el('tr', {}, el('td', {}, 'Total'), el('td', { class: 'barcol' }), el('td', { class: 'num' }, money(total, cur)), el('td', {}), hasPrev ? el('td', {}) : null)));
  }

  function showMoney(month) {
    unmountAll();
    state.moneyMonth = month;
    setView('money');
    const d = parse(month + '-01');
    $('#moneyTitle').textContent = d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    const ended = month < today().slice(0, 7);
    $('#moneySub').textContent = ended ? 'Month summary' : month === today().slice(0, 7) ? 'This month so far' : 'Planned';
    const list = moneyItems(month), prev = moneyItems(shiftMonth(month, -1)), again = () => showMoney(month);
    const out = list.filter(x => !isIncome(x)), inc = list.filter(isIncome);
    const cur = Config.get('currency', 'BRL');
    const spent = sumIn(out, cur), got = sumIn(inc, cur), bal = got - spent;
    const others = [...new Set(list.map(x => x.currency))].filter(c => c !== cur);
    const budget = Config.get('budget', {})[cur] || 0;

    const tile = (label, value, sub, cls) => el('div', { class: 'stat ' + (cls || '') }, el('span', { class: 'slabel' }, label), el('strong', {}, value), sub ? el('span', { class: 'ssub' }, sub) : null);
    const stats = el('div', { class: 'xstats' },
      tile('Income', money(got, cur), `${inc.length} item${inc.length === 1 ? '' : 's'}`, 'in'),
      tile('Spent', money(spent, cur), budget ? (spent > budget ? `${money(spent - budget, cur)} over budget` : `${money(budget - spent, cur)} left of ${money(budget, cur)}`) : `${out.length} item${out.length === 1 ? '' : 's'}`, 'out' + (budget && spent > budget ? ' over' : '')),
      tile(bal >= 0 ? 'Left over' : 'Overspent', money(Math.abs(bal), cur), got ? `${Math.round(Math.max(0, bal) / got * 100)}% of income saved` : 'Add income to see your balance', 'bal' + (bal < 0 ? ' neg' : '')));
    const budgetRow = el('details', { class: 'xbudget' + (budget ? ' set' : '') },
      el('summary', {}, budget ? `Monthly budget: ${money(budget, cur)}` : 'Set a monthly budget'),
      el('label', { class: 'small' }, `Budget for spending (${cur})`,
        el('input', { inputmode: 'decimal', placeholder: 'No budget', value: budget ? String(budget) : '',
          onchange: e => { const v = readAmount(e.target.value); const b = { ...Config.get('budget', {}) }; if (v > 0) b[cur] = v; else delete b[cur]; Config.set('budget', b); again(); } })));
    const meter = budget ? el('div', { class: 'meter' + (spent > budget ? ' over' : ''), role: 'img', 'aria-label': `${Math.round(spent / budget * 100)}% of budget used` },
      el('span', { style: `width:${Math.min(100, spent / budget * 100)}%` })) : null;

    const catOut = categoryTable(out, prev.filter(x => !isIncome(x)), cur, 'expense');
    const catIn = categoryTable(inc, prev.filter(isIncome), cur, 'income');
    fill($('#moneySummary'),
      el('section', { class: 'card' }, stats, meter, budgetRow,
        others.length ? el('p', { class: 'muted small' }, `Also in other currencies: ${others.map(c => `${money(sumIn(inc, c), c)} in, ${money(sumIn(out, c), c)} out`).join(' · ')}.`) : null),
      el('section', { class: 'card' },
        el('div', { class: 'card-head' }, el('h2', {}, el('span', { class: 'dot', style: 'background:var(--money)' }),
          `Spending by category${ended ? '' : ' so far'}`), el('span', { class: 'muted small' }, monthName(month))),
        catOut || el('p', { class: 'muted small' }, 'Add expenses and you will see here how much goes to each category.')),
      catIn ? el('section', { class: 'card' },
        el('div', { class: 'card-head' }, el('h2', {}, el('span', { class: 'dot', style: 'background:var(--money)' }), 'Income by source')), catIn) : null);

    // everything, grouped by day
    const shownList = moneyFilter === 'income' ? inc : moneyFilter === 'expense' ? out : list;
    fill($('#moneyFilter'), [['all', 'All'], ['expense', 'Expenses'], ['income', 'Income']].map(([k, label]) =>
      el('button', { class: moneyFilter === k ? 'on' : null, onclick: () => { moneyFilter = k; again(); } }, label)));
    $('#moneyCount').textContent = shownList.length ? `${shownList.length} item${shownList.length === 1 ? '' : 's'}` : '';
    const days = [...new Set(shownList.map(x => x.date))];
    fill($('#moneyList'), shownList.length ? days.map(day => {
      const xs = shownList.filter(x => x.date === day), o = xs.filter(x => !isIncome(x)), n = xs.filter(isIncome);
      return el('div', { class: 'xday' },
        el('h3', {}, el('a', { href: '#day/' + day }, fmt(day, { weekday: 'long', day: 'numeric', month: 'short' })),
          el('span', {}, [n.length ? '+ ' + totalText(n) : null, o.length ? '− ' + totalText(o) : null].filter(Boolean).join('  '))),
        el('ul', { class: 'xlist' }, xs.map(x => moneyRow(x, again))));
    }) : el('p', { class: 'muted small' }, moneyFilter === 'income' ? 'No income this month yet.' : 'Nothing added this month yet. Tap − Expense or + Income.'));
  }
  const newMoneyDate = m => today().startsWith(m) ? today() : m + '-01';
  $('#addExpenseBtn').addEventListener('click', () => { const m = state.moneyMonth || today().slice(0, 7); openMoney(null, newMoneyDate(m), () => showMoney(m), 'expense'); });
  $('#addIncomeBtn').addEventListener('click', () => { const m = state.moneyMonth || today().slice(0, 7); openMoney(null, newMoneyDate(m), () => showMoney(m), 'income'); });
  $('#prevMonthX').addEventListener('click', () => go('money/' + shiftMonth(state.moneyMonth, -1)));
  $('#nextMonthX').addEventListener('click', () => go('money/' + shiftMonth(state.moneyMonth, 1)));
  $('#csvBtn').addEventListener('click', async () => {
    const m = state.moneyMonth, list = moneyItems(m).reverse();
    if (!list.length) { toast('Nothing this month.'); return; }
    const q = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const csv = [['Date', 'Type', 'Description', 'Category', 'Method', 'Amount', 'Currency', 'Note'].map(q).join(',')]
      .concat(list.map(x => [x.date, isIncome(x) ? 'Income' : 'Expense', x.desc, x.category, x.method, (isIncome(x) ? x.amount : -x.amount).toFixed(2), x.currency, x.note].map(q).join(','))).join('\n');
    const filename = `money-${m}.csv`;
    if (EMBED) {
      const dl = await window.claude.use('downloads').catch(() => null);
      if (!dl) { toast('Downloading isn\'t available here.', 4000); return; }
      try { await dl.save({ filename, data: csv }); toast('Saved ' + filename); } catch (e) { if (!e || e.code !== 'declined') toast('Could not save the file.', 4000); }
      return;
    }
    const a = el('a', { href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })), download: filename });
    document.body.append(a); a.click(); a.remove();
  });

  // On GitHub Pages the address bar keeps the view (#day/2026-11-07), so Back works.
  // Inside Claude the hash can only hold plain names, so the view lives in memory.
  let embedPath = /^[a-z]+$/.test(location.hash.slice(1)) ? location.hash.slice(1) : 'day';
  const currentPath = () => EMBED ? embedPath : location.hash.slice(1);
  function go(path) {
    if (EMBED) { embedPath = path; route(); return; }
    if (location.hash.slice(1) === path) route(); else location.hash = '#' + path;
  }

  // In-page yes/no question (Claude pages can't show the browser's confirm box).
  function ask(message, yes) {
    const d = $('#askDlg');
    $('#askText').textContent = message;
    $('#askYes').textContent = yes || 'OK';
    d.showModal();
    return new Promise(res => {
      const done = v => { d.close(); $('#askYes').onclick = $('#askNo').onclick = null; d.oncancel = null; res(v); };
      $('#askYes').onclick = () => done(true);
      $('#askNo').onclick = () => done(false);
      d.oncancel = () => done(false);
    });
  }

  function route() {
    const [view, arg, arg2] = currentPath().split('/');
    History.clear();
    $('.menu').open = false;
    if (view === 'note' && Store.items.has(arg)) { cleanup(arg); showNote(Store.items.get(arg)); return; }
    if (view === 'class' && Store.items.has(arg)) { cleanup(arg); showClass(Store.items.get(arg)); return; }
    if (view === 'plan' && Store.items.has(arg)) { cleanup(); showPlan(Store.items.get(arg)); return; }
    if (view === 'topic' && Store.items.has(arg)) {
      const pl = Store.items.get(arg), it = (pl.items || []).find(i => i.id === arg2);
      if (it) { cleanup(); showTopic(pl, it); return; }
    }
    if (recClass && Dict && Dict.active()) Dict.stop().catch(() => {});
    recClass = null;
    cleanup();
    if (view === 'notes') showLibrary();
    else if (view === 'routines') showRoutines();
    else if (view === 'money') showMoney(/^\d{4}-\d\d$/.test(arg || '') ? arg : (state.moneyMonth || today().slice(0, 7)));
    else if (view === 'calendar') showMonth(/^\d{4}-\d\d$/.test(arg || '') ? arg : (state.month || today().slice(0, 7)));
    else showDay(isDate(arg) ? arg : today());
  }
  addEventListener('hashchange', () => { if (!EMBED) route(); });
  // Links inside the page (#day/2026-11-07, #note/abc) are handled here.
  document.addEventListener('click', e => {
    const a = e.target.closest && e.target.closest('a[href^="#"]');
    if (!a) return;
    e.preventDefault();
    go(a.getAttribute('href').slice(1));
  });
  $('#prevDay').addEventListener('click', () => { go('day/' + addDays(state.date, -1)); });
  $('#nextDay').addEventListener('click', () => { go('day/' + addDays(state.date, 1)); });
  $('#todayBtn').addEventListener('click', () => { go('day/' + today()); });
  $('#datePick').addEventListener('change', e => { if (isDate(e.target.value)) go('day/' + e.target.value); });

  // ---------- backup ----------
  $('#exportBtn').addEventListener('click', async () => {
    Store.flushAll();
    $('.menu').open = false;
    const data = { app: 'pen-planner', version: 1, exported: new Date().toISOString(), items: [...Store.items.values()] };
    const filename = `pen-planner-backup-${today()}.json`;
    if (EMBED) {
      const dl = await window.claude.use('downloads').catch(() => null);
      if (!dl) { toast('Downloading a backup isn\'t available here. Your planner is saved in your Claude account.', 5000); return; }
      try { await dl.save({ filename, data: JSON.stringify(data) }); toast('Backup saved.'); }
      catch (e) { if (!e || e.code !== 'declined') toast('Could not save the backup. Try again in a moment.', 5000); }
      return;
    }
    const a = el('a', { href: URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' })), download: filename });
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
        const ok = it && typeof it.id === 'string' && (
          (['task', 'note'].includes(it.kind) && Array.isArray(it.strokes) && isDate(it.date)) ||
          (it.kind === 'routine-day' && isDate(it.date) && it.done && typeof it.done === 'object') ||
          (it.kind === 'class' && isDate(it.date)) ||
          (['gratitude', 'tasknote'].includes(it.kind) && isDate(it.date) && Array.isArray(it.strokes)) ||
          (it.kind === 'expense' && isDate(it.date) && typeof it.amount === 'number') ||
          (it.kind === 'photo' && isDate(it.date)) ||
          (it.kind === 'plan' && isDate(it.date) && Array.isArray(it.items)) ||
          (it.kind === 'config' && it.id.startsWith('cfg-')));
        if (!ok) continue;
        Store.items.set(it.id, it); Store.flush(it.id); n++;
      }
      toast(`Restored ${n} item${n === 1 ? '' : 's'}.`);
      route();
    } catch (err) { toast('Could not restore: ' + err.message, 6000); }
    $('.menu').open = false;
  });

  // ---------- install hint (Safari clears data of sites not used for a while) ----------
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  if (!EMBED && ios && !standalone && !lsGet('pp-hint-done', false)) $('#installHint').hidden = false;
  $('#hintClose').addEventListener('click', () => { $('#installHint').hidden = true; lsSet('pp-hint-done', true); });

  if (!EMBED && 'serviceWorker' in navigator && /^https?:$/.test(location.protocol)) navigator.serviceWorker.register('sw.js').catch(() => {});

  Store.init().then(() => { seedStudyPlan(); migrateStudy(); migrateRoutines(); route(); });
})();
