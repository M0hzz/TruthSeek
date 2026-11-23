/*
 * TruthSeek board: draws the corkboard in SVG (cards, pins, yarn, containment
 * threads, hidden-link "ghost" strings) and turns pointer input into callbacks.
 * It knows nothing about the engine; app.js hands it a ready-made view.
 */
(function (root) {
  'use strict';
  const TS = (root.TruthSeek = root.TruthSeek || {});
  const NS = 'http://www.w3.org/2000/svg';

  const TYPE_COLORS = ['#d9480f', '#2f6db5', '#2b8a57', '#c98a0b', '#7c4dbd', '#13868c', '#c2416f', '#6b7a1f', '#9a5b2e', '#4d5f8f'];
  const YARN_COLORS = ['#c0302b', '#2a64b0', '#23845a', '#c27a06', '#7445b5', '#0f7f86', '#b83a6a', '#5f6e18'];
  const KNOWN_TYPES = { person: 0, faction: 1, place: 2, artifact: 3, event: 4, region: 5, thing: 9, organization: 1, location: 2, object: 3 };

  function hash(s) { return TS.hash ? TS.hash(s) : 0; }
  function colorFor(kind, key) {
    const k = String(key).toLowerCase();
    if (kind === 'type') return TYPE_COLORS[k in KNOWN_TYPES ? KNOWN_TYPES[k] : hash(k) % TYPE_COLORS.length];
    return YARN_COLORS[hash(k) % YARN_COLORS.length];
  }
  TS.colorFor = colorFor;

  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    if (attrs) for (const k of Object.keys(attrs)) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  function trunc(s, n) { return s.length > n ? `${s.slice(0, n - 1)}…` : s; }
  function fmt(v) { const r = Math.round(v * 10) / 10; return (r < 0 ? '−' : '') + Math.abs(r).toFixed(1); }
  function fmtS(v) { const r = Math.round(v * 10) / 10; return (r > 0 ? '+' : r < 0 ? '−' : '±') + Math.abs(r).toFixed(1); }

  class Board {
    constructor(svg, layout, handlers) {
      this.svg = svg;
      this.layout = layout;
      this.h = handlers || {};
      this.view = { x: 0, y: 0, k: 1 };
      this.cards = new Map();
      this.strings = new Map();
      this.threads = new Map();
      this.ghosts = new Map();
      this.data = { nodes: [], strings: [], containment: [], ghosts: [] };
      this.focus = null;
      this.showLabels = true;

      const defs = el('defs', null, svg);
      const f = el('filter', { id: 'ts-card-shadow', x: '-20%', y: '-20%', width: '140%', height: '160%' }, defs);
      el('feDropShadow', { dx: '0', dy: '2', stdDeviation: '2.2', 'flood-color': '#000', 'flood-opacity': '0.28' }, f);
      const pf = el('filter', { id: 'ts-pin-shadow', x: '-50%', y: '-50%', width: '200%', height: '200%' }, defs);
      el('feDropShadow', { dx: '1.2', dy: '1.6', stdDeviation: '1', 'flood-color': '#000', 'flood-opacity': '0.35' }, pf);

      this.root = el('g', { class: 'viewport' }, svg);
      this.layers = {
        threads: el('g', { class: 'layer-threads' }, this.root),
        strings: el('g', { class: 'layer-strings' }, this.root),
        ghosts: el('g', { class: 'layer-ghosts' }, this.root),
        cards: el('g', { class: 'layer-cards' }, this.root),
        overlay: el('g', { class: 'layer-overlay' }, this.root),
      };
      this.preview = el('path', { class: 'link-preview', d: '' }, this.layers.overlay);
      this._bind();
      this._applyView();
    }

    /* ---------- data ---------- */

    setData(d) {
      this.data = d;
      this.svg.classList.toggle('hide-labels', !this.showLabels);

      const seen = new Set();
      for (const n of d.nodes) {
        seen.add(n.id);
        const c = this.cards.get(n.id) || this._makeCard(n);
        this._updateCard(c, n);
      }
      for (const [id, c] of this.cards) if (!seen.has(id)) { c.g.remove(); this.cards.delete(id); }

      this._sync(this.strings, d.strings, (s) => s.key, (s) => this._makeString(s), (o, s) => this._updateString(o, s));
      this._sync(this.threads, d.containment, (t) => t.child, () => ({ g: el('path', { class: 'thread' }, this.layers.threads) }), (o, t) => { o.d = t; });
      this._sync(this.ghosts, d.ghosts, (g) => g.key, (g) => this._makeGhost(g), (o, g) => { o.d = g; o.label.textContent = `≈ ${fmtS(g.amount)}`; });

      // keep card order stable: bigger cards underneath smaller ones
      this.updatePositions();
      this._applyFocus();
    }

    _sync(map, list, keyOf, make, update) {
      const seen = new Set();
      for (const item of list) {
        const k = keyOf(item);
        seen.add(k);
        let o = map.get(k);
        if (!o) { o = make(item); map.set(k, o); }
        update(o, item);
      }
      for (const [k, o] of map) if (!seen.has(k)) { o.g.remove(); map.delete(k); }
    }

    _makeCard(n) {
      const g = el('g', { class: 'card', 'data-id': n.id, tabindex: '-1' }, this.layers.cards);
      const body = el('g', { class: 'card-body' }, g);
      const c = {
        g, body,
        paper: el('rect', { class: 'paper', rx: '2' }, body),
        stripe: el('rect', { class: 'stripe' }, body),
        title: el('text', { class: 'title' }, body),
        sub: el('text', { class: 'sub' }, body),
        power: el('text', { class: 'power' }, body),
        delta: el('text', { class: 'delta' }, body),
        stack: el('rect', { class: 'stack' }, null),
        pin: el('circle', { class: 'pin', r: '6.5', filter: 'url(#ts-pin-shadow)' }, g),
        pinShine: el('circle', { class: 'pin-shine', r: '2' }, g),
        w: 140, h: 64, scale: 1, pinY: -26,
      };
      body.insertBefore(c.stack, c.paper);
      c.rot = ((hash(n.id) % 7) - 3) * 0.6;
      this.cards.set(n.id, c);
      return c;
    }

    _updateCard(c, n) {
      const name = trunc(n.name, 28);
      const w = Math.max(132, Math.min(240, name.length * 7.4 + 30));
      const h = 64;
      c.w = w; c.h = h;
      const color = colorFor('type', n.type);
      c.paper.setAttribute('x', -w / 2); c.paper.setAttribute('y', -h / 2);
      c.paper.setAttribute('width', w); c.paper.setAttribute('height', h);
      c.stack.setAttribute('x', -w / 2 + 5); c.stack.setAttribute('y', -h / 2 + 5);
      c.stack.setAttribute('width', w); c.stack.setAttribute('height', h);
      c.stripe.setAttribute('x', -w / 2); c.stripe.setAttribute('y', -h / 2);
      c.stripe.setAttribute('width', w); c.stripe.setAttribute('height', 5);
      c.stripe.setAttribute('fill', color);
      c.title.setAttribute('x', -w / 2 + 12); c.title.setAttribute('y', -h / 2 + 27);
      c.title.textContent = name;
      c.sub.setAttribute('x', -w / 2 + 12); c.sub.setAttribute('y', -h / 2 + 42);
      const inside = n.collapsed ? ` · ${n.descendants} hidden inside` : n.childCount ? ` · ${n.childCount} inside` : '';
      c.sub.textContent = n.type.toUpperCase() + inside;
      c.power.setAttribute('x', w / 2 - 10); c.power.setAttribute('y', h / 2 - 9);
      c.power.textContent = n.gone ? 'gone' : `power ${fmt(n.total)}`;
      c.delta.setAttribute('x', -w / 2 + 12); c.delta.setAttribute('y', h / 2 - 9);
      const showDelta = !n.gone && Math.abs(n.delta) >= 0.25;
      c.delta.textContent = showDelta ? fmtS(n.delta) : '';
      c.delta.setAttribute('class', `delta ${n.delta > 0 ? 'up' : 'down'}`);
      c.scale = Math.max(0.8, Math.min(1.55, 0.78 + 0.1 * Math.sqrt(Math.max(0, n.total))));
      c.body.style.transform = `rotate(${c.rot}deg) scale(${c.scale})`;
      c.pinY = (-h / 2) * c.scale + 7;
      c.pin.setAttribute('cy', c.pinY);
      c.pin.setAttribute('fill', color);
      c.pinShine.setAttribute('cx', -2); c.pinShine.setAttribute('cy', c.pinY - 2);
      c.g.classList.toggle('gone', !!n.gone);
      c.g.classList.toggle('collapsed', !!n.collapsed);
      c.g.classList.toggle('has-children', n.childCount > 0);
      c.g.classList.toggle('pulse-up', showDelta && n.delta > 0);
      c.g.classList.toggle('pulse-down', showDelta && n.delta < 0);
      c.g.setAttribute('aria-label', `${n.name}, ${n.type}, power ${fmt(n.total)}`);
      c.data = n;
    }

    _makeString(s) {
      const g = el('g', { class: 'string', 'data-key': s.key }, this.layers.strings);
      return {
        g,
        hit: el('path', { class: 'hit' }, g),
        yarn: el('path', { class: 'yarn' }, g),
        arrow: el('path', { class: 'arrow', d: 'M-7,-4.5 L6,0 L-7,4.5 Z' }, g),
        label: el('text', { class: 'label', 'text-anchor': 'middle' }, g),
        d: s,
      };
    }

    _updateString(o, s) {
      o.d = s;
      const color = colorFor('yarn', s.type);
      o.yarn.setAttribute('stroke', s.strength < 0 ? 'var(--yarn-oppose)' : color);
      o.yarn.setAttribute('stroke-width', (1.4 + 2.6 * Math.abs(s.strength)).toFixed(2));
      o.arrow.setAttribute('fill', s.strength < 0 ? 'var(--yarn-oppose)' : color);
      o.arrow.style.display = s.direction === 'one-way' ? '' : 'none';
      o.g.classList.toggle('neg', s.strength < 0);
      o.g.classList.toggle('fresh', !!s.fresh);
      o.g.classList.toggle('aggregated', !!s.aggregated);
      o.label.textContent = s.aggregated ? `${s.count} string${s.count > 1 ? 's' : ''}` : `${s.type} ${s.strength < 0 ? '−' : ''}${Math.abs(s.strength).toFixed(2).replace(/^0/, '')}`;
    }

    _makeGhost(g) {
      const grp = el('g', { class: 'ghost', 'data-key': g.key }, this.layers.ghosts);
      return {
        g: grp,
        hit: el('path', { class: 'hit' }, grp),
        line: el('path', { class: 'ghost-line' }, grp),
        label: el('text', { class: 'label', 'text-anchor': 'middle' }, grp),
        d: g,
      };
    }

    /* ---------- geometry ---------- */

    anchor(id) {
      const p = this.layout.pos(id);
      if (!p) return null;
      const c = this.cards.get(id);
      return { x: p.x, y: p.y + (c ? c.pinY : -24) };
    }

    _curve(A, B, lane, sagBase) {
      const dx = B.x - A.x;
      const dy = B.y - A.y;
      const dist = Math.hypot(dx, dy) || 1;
      const sag = Math.min(90, dist * 0.16) + sagBase + lane * 24;
      const C = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 + sag };
      const M = { x: 0.25 * A.x + 0.5 * C.x + 0.25 * B.x, y: 0.25 * A.y + 0.5 * C.y + 0.25 * B.y };
      return { d: `M${A.x.toFixed(1)},${A.y.toFixed(1)} Q${C.x.toFixed(1)},${C.y.toFixed(1)} ${B.x.toFixed(1)},${B.y.toFixed(1)}`, M, angle: (Math.atan2(dy, dx) * 180) / Math.PI };
    }

    updatePositions() {
      for (const [id, c] of this.cards) {
        const p = this.layout.pos(id);
        if (p) c.g.setAttribute('transform', `translate(${p.x.toFixed(1)},${p.y.toFixed(1)})`);
      }
      for (const o of this.strings.values()) {
        const A = this.anchor(o.d.a);
        const B = this.anchor(o.d.b);
        if (!A || !B) continue;
        const cv = this._curve(A, B, o.d.lane || 0, 8);
        o.yarn.setAttribute('d', cv.d);
        o.hit.setAttribute('d', cv.d);
        o.arrow.setAttribute('transform', `translate(${cv.M.x.toFixed(1)},${cv.M.y.toFixed(1)}) rotate(${cv.angle.toFixed(1)})`);
        o.label.setAttribute('x', cv.M.x.toFixed(1));
        o.label.setAttribute('y', (cv.M.y + 15).toFixed(1));
      }
      for (const o of this.threads.values()) {
        const pc = this.layout.pos(o.d.child);
        const pp = this.layout.pos(o.d.parent);
        if (!pc || !pp) continue;
        o.g.setAttribute('d', `M${pc.x.toFixed(1)},${pc.y.toFixed(1)} L${pp.x.toFixed(1)},${pp.y.toFixed(1)}`);
      }
      for (const o of this.ghosts.values()) {
        const A = this.anchor(o.d.a);
        const B = this.anchor(o.d.b);
        if (!A || !B) continue;
        const cv = this._curve(A, B, 0, -40);
        o.line.setAttribute('d', cv.d);
        o.hit.setAttribute('d', cv.d);
        o.label.setAttribute('x', cv.M.x.toFixed(1));
        o.label.setAttribute('y', (cv.M.y - 8).toFixed(1));
      }
    }

    /* ---------- focus & selection ---------- */

    setFocus(focus) {
      this.focus = focus;
      this._applyFocus();
    }

    _applyFocus() {
      const f = this.focus;
      for (const [id, c] of this.cards) {
        c.g.classList.toggle('dim', !!f && !f.nodes.has(id));
        c.g.classList.toggle('selected', !!f && !!f.primary && f.primary.has(id));
      }
      for (const [key, o] of this.strings) {
        o.g.classList.toggle('dim', !!f && !f.strings.has(key));
        o.g.classList.toggle('lit', !!f && f.strings.has(key));
        o.g.classList.toggle('selected', !!f && f.primaryString === key);
      }
      for (const [key, o] of this.ghosts) {
        o.g.classList.toggle('dim', !!f && !(f.ghosts && f.ghosts.has(key)));
        o.g.classList.toggle('lit', !!f && !!f.ghosts && f.ghosts.has(key));
      }
      for (const [, o] of this.threads) {
        o.g.classList.toggle('dim', !!f && !(f.nodes.has(o.d.child) && f.nodes.has(o.d.parent)));
      }
      // Bring focused cards to the front so a highlighted path is readable.
      if (f) for (const id of f.nodes) { const c = this.cards.get(id); if (c) this.layers.cards.appendChild(c.g); }
    }

    /* ---------- camera ---------- */

    _applyView() {
      const { x, y, k } = this.view;
      this.root.setAttribute('transform', `translate(${x.toFixed(1)},${y.toFixed(1)}) scale(${k.toFixed(4)})`);
      this.svg.classList.toggle('far', k < 0.55);
    }

    toWorld(clientX, clientY) {
      const r = this.svg.getBoundingClientRect();
      return { x: (clientX - r.left - this.view.x) / this.view.k, y: (clientY - r.top - this.view.y) / this.view.k };
    }

    center() {
      const r = this.svg.getBoundingClientRect();
      return this.toWorld(r.left + r.width / 2, r.top + r.height / 2);
    }

    zoomBy(factor, cx, cy) {
      const r = this.svg.getBoundingClientRect();
      const px = cx == null ? r.width / 2 : cx - r.left;
      const py = cy == null ? r.height / 2 : cy - r.top;
      const k = Math.max(0.15, Math.min(3, this.view.k * factor));
      const f = k / this.view.k;
      this.view.x = px - (px - this.view.x) * f;
      this.view.y = py - (py - this.view.y) * f;
      this.view.k = k;
      this._applyView();
    }

    fit(ids) {
      const list = ids && ids.length ? ids : [...this.cards.keys()];
      const r = this.svg.getBoundingClientRect();
      if (!list.length || !r.width || !r.height) return;
      let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
      for (const id of list) {
        const p = this.layout.pos(id);
        if (!p) continue;
        const c = this.cards.get(id);
        const hw = ((c ? c.w : 140) / 2) * (c ? c.scale : 1);
        const hh = ((c ? c.h : 64) / 2) * (c ? c.scale : 1);
        x0 = Math.min(x0, p.x - hw); x1 = Math.max(x1, p.x + hw);
        y0 = Math.min(y0, p.y - hh - 10); y1 = Math.max(y1, p.y + hh + 30);
      }
      if (!Number.isFinite(x0)) return;
      const pad = 40;
      const k = Math.max(0.15, Math.min(1.25, Math.min((r.width - pad * 2) / (x1 - x0 || 1), (r.height - pad * 2) / (y1 - y0 || 1))));
      this.view.k = k;
      this.view.x = r.width / 2 - ((x0 + x1) / 2) * k;
      this.view.y = r.height / 2 - ((y0 + y1) / 2) * k;
      this._applyView();
    }

    centerOn(id) {
      const p = this.layout.pos(id);
      const r = this.svg.getBoundingClientRect();
      if (!p || !r.width) return;
      this.view.x = r.width / 2 - p.x * this.view.k;
      this.view.y = r.height / 2 - p.y * this.view.k;
      this._applyView();
    }

    /* ---------- input ---------- */

    _bind() {
      const svg = this.svg;
      let mode = null;
      let id = null;
      let start = null;
      let moved = false;
      let off = null;
      let last = null;
      let lastClick = null;

      svg.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        const cardEl = e.target.closest('.card');
        const strEl = e.target.closest('.string');
        const ghostEl = e.target.closest('.ghost');
        start = { x: e.clientX, y: e.clientY };
        moved = false;
        try { svg.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
        if (cardEl) {
          id = cardEl.dataset.id;
          if (e.shiftKey || e.altKey) {
            mode = 'link';
            svg.classList.add('linking');
          } else {
            mode = 'drag';
            const w = this.toWorld(e.clientX, e.clientY);
            const p = this.layout.pos(id);
            off = { x: p.x - w.x, y: p.y - w.y };
          }
        } else if (strEl) {
          mode = 'string'; id = strEl.dataset.key;
        } else if (ghostEl) {
          mode = 'ghost'; id = ghostEl.dataset.key;
        } else {
          mode = 'pan';
          last = { vx: this.view.x, vy: this.view.y };
          svg.classList.add('panning');
        }
      });

      svg.addEventListener('pointermove', (e) => {
        if (!mode) return;
        const dx = e.clientX - start.x;
        const dy = e.clientY - start.y;
        if (!moved && Math.hypot(dx, dy) > 4) moved = true;
        if (!moved) return;
        if (mode === 'drag') {
          const w = this.toWorld(e.clientX, e.clientY);
          this.layout.set(id, w.x + off.x, w.y + off.y, true);
          this.updatePositions();
          if (this.h.onDrag) this.h.onDrag(id);
        } else if (mode === 'link') {
          const A = this.anchor(id);
          const w = this.toWorld(e.clientX, e.clientY);
          this.preview.setAttribute('d', `M${A.x},${A.y} L${w.x},${w.y}`);
          const over = document.elementFromPoint(e.clientX, e.clientY);
          const target = over && over.closest ? over.closest('.card') : null;
          for (const c of this.cards.values()) c.g.classList.toggle('link-target', !!target && c.g === target && target.dataset.id !== id);
        } else if (mode === 'pan') {
          this.view.x = last.vx + dx;
          this.view.y = last.vy + dy;
          this._applyView();
        }
      });

      const end = (e) => {
        if (!mode) return;
        const m = mode;
        mode = null;
        svg.classList.remove('panning', 'linking');
        if (m === 'drag') {
          if (!moved) {
            // Double-click is detected here: selecting a card re-orders the DOM, which breaks native dblclick.
            const now = Date.now();
            const dbl = lastClick && lastClick.id === id && now - lastClick.t < 400;
            lastClick = dbl ? null : { id, t: now };
            if (dbl) { if (this.h.onToggleCollapse) this.h.onToggleCollapse(id); } else if (this.h.onSelectNode) this.h.onSelectNode(id);
          } else if (this.h.onDragEnd) this.h.onDragEnd(id);
        } else if (m === 'link') {
          this.preview.setAttribute('d', '');
          for (const c of this.cards.values()) c.g.classList.remove('link-target');
          const over = e && e.type === 'pointerup' ? document.elementFromPoint(e.clientX, e.clientY) : null;
          const target = over && over.closest ? over.closest('.card') : null;
          if (target && target.dataset.id !== id) { if (this.h.onLinkCreate) this.h.onLinkCreate(id, target.dataset.id); } else if (!moved && this.h.onSelectNode) this.h.onSelectNode(id);
        } else if (m === 'string') {
          if (!moved && this.h.onSelectString) this.h.onSelectString(id);
        } else if (m === 'ghost') {
          if (!moved && this.h.onSelectGhost) this.h.onSelectGhost(id);
        } else if (m === 'pan') {
          if (!moved && this.h.onBackground) this.h.onBackground();
        }
      };
      svg.addEventListener('pointerup', end);
      svg.addEventListener('pointercancel', end);

      svg.addEventListener('wheel', (e) => {
        e.preventDefault();
        const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
        this.zoomBy(Math.exp(-dy * 0.0015), e.clientX, e.clientY);
      }, { passive: false });
    }
  }

  TS.Board = Board;
})(typeof globalThis !== 'undefined' ? globalThis : this);
