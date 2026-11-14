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
        if (it.kind === 'task' || it.kind === 'note') {
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
    document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('on', a.dataset.nav === (v === 'note' || v === 'plan' ? 'notes' : v)));
    document.body.className = document.body.className.replace(/\bview-\S+/g, '').trim() + ' view-' + v;
    renderToolbar();
  }

  function cleanup(keepId) {
    for (const it of [...Store.items.values()]) {
      if (it.id === keepId) continue;
      if (it.kind === 'task' && !it.strokes.length) Store.remove(it.id);
      if (it.kind === 'note' && !it.strokes.length && !it.subject) Store.remove(it.id);
      if (it.kind === 'class' && !it.status && !hasNotes(it) && !it.gMoved && !it.gCancelled && (it.eventId || !it.title)) Store.remove(it.id);
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
    renderRoutineCard('morning');
    renderRoutineCard('night');
    renderCalendar();
    renderClassCard();
    renderStudyCard();
    renderTasks();
    renderDayNotes();
  }

  function renderTasks() {
    unmountAll();
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
          onclick: async () => { if (await ask('Delete this task?', 'Delete')) { Store.remove(t.id); renderTasks(); } },
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

  const pageCount = n => { const k = Math.max(1, Math.round(n.h / NOTE_H)); return k + (k === 1 ? ' page' : ' pages'); };
  function noteCard(n, showDate) {
    const c = el('canvas', { class: 'thumb' });
    const card = el('a', { class: 'note-card', href: '#note/' + n.id }, c,
      el('div', { class: 'meta' },
        el('strong', {}, n.subject || 'No subject'),
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
  const DEFAULT_ROUTINES = {
    morning: [
      { id: 'm1', label: 'Drink a glass of water' }, { id: 'm2', label: 'Make the bed' },
      { id: 'm3', label: 'Stretch for 5 minutes' }, { id: 'm4', label: "Look over today's tasks" },
    ],
    night: [
      { id: 'n1', label: 'Tidy up my desk' }, { id: 'n2', label: "Get tomorrow's things ready" },
      { id: 'n3', label: 'Review my study notes' }, { id: 'n4', label: 'Screens off and read' },
    ],
  };
  const RT = {
    morning: { title: 'Morning routine', icon: '☀︎', cls: 'sun' },
    night: { title: 'Night routine', icon: '☾', cls: 'moon' },
  };
  const routines = () => Config.get('routines', DEFAULT_ROUTINES);
  const logOf = date => Store.items.get('rt-' + date);
  const isDone = (date, id) => { const l = logOf(date); return !!(l && l.done[id]); };
  const doneCount = (which, date) => routines()[which].filter(i => isDone(date, i.id)).length;
  const fullDay = (which, date) => { const it = routines()[which]; return it.length > 0 && doneCount(which, date) === it.length; };

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
    const items = routines()[which], date = state.date, info = RT[which];
    const done = doneCount(which, date);
    const week = [];
    for (let i = 6; i >= 0; i--) {
      const d = addDays(date, -i), c = doneCount(which, d);
      week.push(el('a', { href: '#day/' + d, class: d === date ? 'cur' : '', title: fmt(d, { weekday: 'long', month: 'short', day: 'numeric' }) },
        el('span', { class: 'pip' + (items.length && c === items.length ? ' full' : c ? ' part' : '') }),
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
          }, el('span', { class: 'box' }), el('span', { class: 'label' }, i.label)))))
        : el('p', { class: 'muted small' }, 'No steps yet. Tap Edit to add some.'),
      el('div', { class: 'routine-foot' },
        el('div', { class: 'week' }, week),
        el('span', { class: 'streak' + (s ? ' hot' : '') }, streakText(s)),
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
    all[editing.which] = editing.steps.map(s => ({ id: s.id, label: s.label.trim() })).filter(s => s.label);
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
      const pct = items.length ? Math.round(100 * dates.reduce((a, d) => a + doneCount(which, d), 0) / (items.length * N)) : 0;
      const grid = el('div', { class: 'track-grid', style: `grid-template-columns:${cols}` });
      grid.append(el('span'), ...dates.map(d => el('span', { class: 'dh' + (d === t ? ' today' : '') },
        fmt(d, { weekday: 'narrow' }), el('br'), String(parse(d).getDate()))));
      for (const it of items) {
        grid.append(el('span', { class: 'lbl', title: it.label }, it.label));
        for (const d of dates) {
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
          const c = doneCount(which, d);
          grid.append(el('span', { class: 'cell' + (c === items.length ? ' on' : c ? ' part' : '') }));
        }
      }
      return el('section', { class: 'card track-card ' + which },
        el('div', { class: 'card-head' },
          el('h2', {}, el('span', { class: 'ico ' + info.cls }, info.icon), info.title),
          el('button', { class: 'mini', onclick: () => editRoutine(which) }, 'Edit steps')),
        el('div', { class: 'stats' },
          el('span', {}, el('b', {}, String(streak(which))), 'day streak'),
          el('span', {}, el('b', {}, `${fullLast(7)}/7`), 'full days this week'),
          el('span', {}, el('b', {}, `${fullLast(30)}/30`), 'full days this month'),
          el('span', {}, el('b', {}, pct + '%'), 'of steps done')),
        items.length ? el('div', { class: 'track' }, grid) : el('p', { class: 'muted small' }, 'No steps yet.'));
    }));
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
            title: ev.title || '', onclick: () => { if (!ev.allDay) openClassFor(ev); else if (EMBED && ev.id) openEventEditor(ev); else go('day/' + iso(new Date(ev.start))); } },
          ev.allDay ? '' : el('b', {}, timeOf(ev.start).replace(/:00(?=\D|$)/, '')), ev.title || '(No title)')),
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
    let pageToken;
    for (let page = 0; page < 5; page++) {
      const input = { startTime: from + 'T00:00:00', endTime: to + 'T00:00:00', orderBy: 'startTime', pageSize: 250 };
      if (calendarId) input.calendarId = calendarId;
      if (pageToken) input.pageToken = pageToken;
      const res = await mcp.callTool('Google Calendar', 'list_events', input, force ? { cache: false } : undefined);
      const pl = (res && res.payload) || {};
      if (Array.isArray(pl.events)) list.push(...pl.events);
      pageToken = typeof pl.nextPageToken === 'string' && pl.nextPageToken ? pl.nextPageToken : null;
      if (!pageToken) break;
    }
    return list.filter(e => e && e.status !== 'cancelled').map(e => {
      const s = e.start || {}, f = e.end || {};
      const allDay = !s.dateTime;
      const start = allDay ? (isDate(s.date) ? parse(s.date).getTime() : 0) : Date.parse(s.dateTime);
      const end = allDay ? (isDate(f.date) ? parse(f.date).getTime() : start + 864e5) : (f.dateTime ? Date.parse(f.dateTime) : start);
      return { id: typeof e.id === 'string' ? e.id : '', title: e.summary || '', allDay, location: e.location || '', description: typeof e.description === 'string' ? e.description : '', start, end };
    }).sort((a, b) => (b.allDay - a.allDay) || (a.start - b.start));
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
    const cals = out.filter(c => c && typeof c.id === 'string').map(c => ({ id: c.id, name: String(c.summary || c.id) }));
    cals.sort((a, b) => isHolidayCal(a.id) - isHolidayCal(b.id)); // your own calendars first, holidays last
    cals.forEach((c, i) => {
      c.color = CAL_COLORS[i % CAL_COLORS.length];
      c.label = isHolidayCal(c.id) ? c.name.replace(/^Holidays in /, '') + ' holidays' : c.name;
      c.writable = !isHolidayCal(c.id);
    });
    Cals.list = cals.length ? cals : [{ id: '', name: 'My calendar', label: 'My calendar', color: CAL_COLORS[0], writable: true }];
    return Cals.list;
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
      if (r.status === 'fulfilled') r.value.forEach(e => events.push({ ...e, calId: c.id, color: c.color }));
      else { failed.push(c.label); firstErr = firstErr || r.reason; }
    });
    if (cals.length && failed.length === cals.length) throw firstErr;
    events.sort((a, b) => (b.allDay - a.allDay) || (a.start - b.start));
    events.failed = failed;
    return events;
  }
  const visibleEvents = events => { const h = hiddenCals(); return events.filter(e => !h.has(e.calId)); };

  // Buttons to switch each calendar on and off
  async function renderCalChips(box, onChange) {
    let cals;
    try { cals = await calendarList(); } catch { fill(box); return; }
    if (cals.length < 2) { fill(box); return; }
    const h = hiddenCals();
    fill(box,
      cals.map(c => el('button', {
        class: 'calchip' + (h.has(c.id) ? '' : ' on'), style: `--ec:${c.color}`, 'aria-pressed': String(!h.has(c.id)),
        title: (h.has(c.id) ? 'Show ' : 'Hide ') + c.label,
        onclick: () => { setCalHidden(c.id, !hiddenCals().has(c.id)); onChange(); },
      }, el('span', { class: 'sw' }), c.label)),
      h.size ? el('button', { class: 'calchip all', onclick: () => { Config.set('hiddenCals', []); onChange(); } }, 'Show all') : null);
  }

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

  function drawEvents(body, events) {
    if (!events.length) { fill(body, el('p', { class: 'muted small' }, 'Nothing on your calendar this day.')); return; }
    const now = Date.now();
    fill(body, el('ul', { class: 'events' }, events.map(ev => {
      const color = /^#[0-9a-f]{3,8}$/i.test(ev.color || '') ? ev.color : null;
      const canEdit = EMBED && ev.id;
      const rec = !ev.allDay ? Store.items.get(classKey(ev)) : null;
      const what = [el('strong', {}, ev.title || '(No title)'),
        el('span', {}, [ev.allDay || !ev.end ? null : `until ${timeOf(ev.end)}`, ev.location || null].filter(Boolean).join(' · '))];
      return el('li', { class: (!ev.allDay && ev.end && ev.end < now ? 'past' : '') + (canEdit ? ' editable' : '') },
        el('span', { class: 'cdot', style: color ? `background:${color}` : null }),
        el('span', { class: 'when' }, ev.allDay ? 'All day' : timeOf(ev.start)),
        !ev.allDay ? el('button', { class: 'what', title: 'Open this event', onclick: () => openClassFor(ev) }, what)
          : canEdit ? el('button', { class: 'what', title: 'Edit this event', onclick: () => openEventEditor(ev) }, what) : el('span', { class: 'what' }, what),
        ev.allDay ? null : el('button', { class: 'recbtn' + (rec && (rec.status || hasNotes(rec)) ? ' done' : ''), title: 'Open this event', onclick: () => openClassFor(ev) },
          rec && rec.status ? statusLabel(rec.status) : rec && hasNotes(rec) ? 'Notes ✓' : 'Open ›'),
        ev.allDay ? null : el('div', { class: 'evnotes', 'data-start': String(ev.start), 'data-title': ev.title || '' },
          rec ? classSummary(rec) : null));
    })));
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
        el('h2', {}, el('span', { class: 'dot', style: 'background:#b22133' }), 'Classes & notes'),
        el('span', { class: 'head-actions' },
          el('button', { class: 'mini', onclick: () => newClass(date) }, '● Record a class'),
          EMBED ? el('button', { class: 'icon-btn sm', title: 'Refresh Granola notes', 'aria-label': 'Refresh Granola notes', onclick: () => renderClassCard(true) }, '↻') : null)),
      recs.length ? el('ul', { class: 'classlist' }, recs.map(c => el('li', {},
        el('a', { href: '#class/' + c.id },
          el('span', { class: 'when' }, timeOf(c.start)),
          el('strong', {}, c.title || 'Class'),
          c.status ? el('span', { class: 'st st-' + c.status }, statusLabel(c.status)) : null,
          c.transcript ? el('span', { class: 'muted small' }, 'recorded') : null,
          c.granola && c.granola.url ? el('span', { class: 'muted small' }, '· in Granola') : null)))) :
        el('p', { class: 'muted small' }, 'Tap Record on a class in your calendar, or Record a class, to keep its notes, homework and recording here.'),
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
    const btn = $('#recBtn');
    btn.hidden = !Dict;
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
    $('#granolaSend').hidden = !EMBED;
    $('#granolaSend').disabled = !c.transcript.trim();
    $('#granolaSend').textContent = sent ? 'Send to Granola again' : 'Send recording to Granola';
    fill($('#granolaSent'), sent ? el('a', { href: c.granola.url, target: '_blank', rel: 'noopener' }, 'Saved in Granola — open it ↗') : null);
  }
  async function findGranolaFor(c) {
    const box = $('#granolaMatch');
    if (!EMBED) { fill(box, el('p', { class: 'muted small' }, 'Granola notes show up when you open the planner inside Claude.')); return; }
    fill(box, el('p', { class: 'muted small' }, 'Looking for this class in Granola…'));
    try {
      const list = await granolaDay(c.date);
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
  const isoOffset = ms => {
    const d = new Date(ms), off = -d.getTimezoneOffset(), a = Math.abs(off);
    return `${iso(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:00${off >= 0 ? '+' : '-'}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
  };
  function granolaTranscript(text) {
    const out = [];
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      const m = /^\[(\d{1,2}:\d\d(?::\d\d)?)\]\s*(.*)$/.exec(line);
      if (m) out.push(`Class recording [${m[1].split(':').length === 2 ? '00:' + m[1] : m[1]}]: ${m[2]}`);
      else out.push(out.length ? line : `Class recording [00:00]: ${line}`);
    }
    return out.join('\n');
  }
  $('#granolaSend').addEventListener('click', async () => {
    const c = recClass, msg = $('#granolaMsg');
    if (!c || !c.transcript.trim()) return;
    const transcript = granolaTranscript(c.transcript);
    if (transcript.length > 100000) { msg.textContent = 'This recording is too long to send in one go. Split it into two classes.'; return; }
    const input = { title: c.title || 'Class', meeting_started_at: isoOffset(c.start || Date.now()), transcript, meeting_platform: 'in person' };
    if (c.end > c.start) input.meeting_ended_at = isoOffset(c.end);
    const withEvent = c.eventId && c.calId ? { ...input, calendar_event: { provider: 'google', calendar_id: c.calId, event_id: c.eventId } } : null;
    $('#granolaSend').disabled = true;
    msg.textContent = 'Sending to Granola…';
    const send = inp => granolaCall('create_meeting_note_from_transcript', inp);
    try {
      let res;
      try { res = await send(withEvent || input); }
      catch (e) { if (withEvent && /calendar_event_unavailable/.test((e && e.message) || '')) res = await send(input); else throw e; }
      const text = typeof res === 'string' ? res : JSON.stringify(res || {});
      const url = granolaUrl(((res && res.url) || (/https:\/\/notes\.granola\.ai\/[\w\-/]+/.exec(text) || [''])[0]));
      c.granola = { url, at: Date.now() };
      Store.save(c);
      msg.textContent = 'Sent. Granola writes the summary in a minute or two.';
      granolaCache.delete(c.date);
    } catch (err) {
      console.warn(err);
      const m = (err && err.message) || '';
      msg.textContent = /import_limit_reached/.test(m) ? 'Granola\'s daily import limit is reached. Try again tomorrow.'
        : (err && (err.code === 'server_unavailable' || err.code === 'upstream_error')) ? 'Granola didn\'t answer, so it may or may not have saved this. Check Granola before sending again.'
          : connectorProblem(err, 'Granola', 'Granola')[0];
    } finally { drawGranolaSend(); }
  });

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
    const check = (p, it) => el('li', {}, el('button', {
      class: 'rcheck' + (it.done ? ' on' : ''), 'aria-pressed': String(!!it.done),
      onclick: () => { toggleItem(p, it); renderStudyCard(); },
    }, el('span', { class: 'box' }), el('span', { class: 'label' }, it.title)));
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
        el('button', { class: 'mini primary', onclick: () => openPlanMaker() }, '+ New study plan')),
      all.length ? el('div', { class: 'plancards' }, all.map(p => {
        const s = planStats(p);
        return el('a', { class: 'plancard', href: '#plan/' + p.id, style: `--sc:${p.color}` },
          el('strong', {}, p.name),
          p.goal ? el('span', { class: 'muted small' }, p.goal) : null,
          el('div', { class: 'sbar' }, el('span', { style: `width:${s.total ? (s.n / s.total * 100).toFixed(1) : 0}%` })),
          el('span', { class: 'small' }, `${s.n} of ${s.total} done` + (s.end ? ` · ends ${fmt(s.end, { day: 'numeric', month: 'short' })}` : '')),
          s.next ? el('span', { class: 'small muted' }, 'Next: ' + s.next.title + (s.next.date ? ' · ' + fmt(s.next.date, { weekday: 'short', day: 'numeric', month: 'short' }) : '')) : el('span', { class: 'small' }, 'Finished!'),
          s.behind ? el('span', { class: 'st st-noshow' }, `${s.behind} behind`) : null);
      })) : el('p', { class: 'muted small' }, 'No study plans yet. Tap New study plan, paste or photograph what you need to study, and Claude organizes it into days.'));
  }

  // ---- one plan: overdue, next topics, all topics, notes ----
  const planNotes = p => Store.list('note').filter(n => (n.strokes.length || n.subject) && (n.planId === p.id || (n.subject || '').trim().toLowerCase() === p.name.trim().toLowerCase()))
    .sort((a, b) => b.date.localeCompare(a.date) || b.created - a.created);
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
      el('button', { class: 'rcheck' + (it.done ? ' on' : ''), 'aria-pressed': String(!!it.done), onclick: () => { toggleItem(p, it); showPlan(p); } },
        el('span', { class: 'box' }), el('span', { class: 'label' }, it.title, opts.group && it.group ? el('small', {}, ' · ' + it.group) : null)),
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
          el('button', { class: 'mini', onclick: () => openPlanMaker(p) }, '✦ Reorganize with Claude'),
          el('button', { class: 'mini', onclick: () => addPlanItem(p) }, '+ Add topic'),
          el('button', { class: 'mini', onclick: () => { replanPlan(p, t); showPlan(p); toast('Plan laid out again from today'); } }, 'Replan from today'))),
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
            notes.length ? el('button', { class: 'mini', onclick: () => notesToPdf(notes, p.name) }, '⤓ Download PDF') : null,
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
            doc.text(`${n.subject || 'Study note'} · ${fmt(n.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}`, M, M + 8);
          }
          const img = renderSlice(n, top, h, 1.6).toDataURL('image/jpeg', 0.85);
          const y0 = top === 0 ? M + 20 : M, avail = H - y0 - M;
          const w = Math.min(W - 2 * M, avail * LW / h);
          doc.addImage(img, 'JPEG', (W - w) / 2, y0, w, w * h / LW);
        }
      }
      const blob = doc.output('blob');
      const filename = `${(title || 'Study notes').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80)} notes.pdf`;
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

  // ---------- routing ----------
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
    const [view, arg] = currentPath().split('/');
    History.clear();
    $('.menu').open = false;
    if (view === 'note' && Store.items.has(arg)) { cleanup(arg); showNote(Store.items.get(arg)); return; }
    if (view === 'class' && Store.items.has(arg)) { cleanup(arg); showClass(Store.items.get(arg)); return; }
    if (view === 'plan' && Store.items.has(arg)) { cleanup(); showPlan(Store.items.get(arg)); return; }
    if (recClass && Dict && Dict.active()) Dict.stop().catch(() => {});
    recClass = null;
    cleanup();
    if (view === 'notes') showLibrary();
    else if (view === 'routines') showRoutines();
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

  Store.init().then(() => { seedStudyPlan(); migrateStudy(); route(); });
})();
