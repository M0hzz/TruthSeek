/*
 * TruthSeek layout: a small force simulation that keeps cards apart, pulls
 * strung cards together and keeps members near the noun they sit inside.
 * Cards that were dragged (or loaded with x/y) stay where they were put.
 */
(function (root) {
  'use strict';
  const TS = (root.TruthSeek = root.TruthSeek || {});

  function hash(s) {
    let h = 2166136261;
    const t = String(s);
    for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function rand(id, salt) { return (hash(`${id}:${salt}`) % 100000) / 100000; }

  class Layout {
    constructor() {
      this.nodes = new Map();
      this.active = [];
      this.links = [];
      this.alpha = 0;
    }

    pos(id) { return this.nodes.get(id) || null; }

    /** Make sure a node exists; new ones land near `near` (if placed) or around the origin. */
    place(id, near, spread) {
      let n = this.nodes.get(id);
      if (n) return n;
      const base = near ? this.nodes.get(near) : null;
      const r = spread || 300;
      const ang = rand(id, 'a') * Math.PI * 2;
      const dist = (0.3 + 0.7 * Math.sqrt(rand(id, 'r'))) * r;
      n = { id, x: (base ? base.x : 0) + Math.cos(ang) * dist, y: (base ? base.y : 0) + Math.sin(ang) * dist, vx: 0, vy: 0, fixed: false };
      this.nodes.set(id, n);
      return n;
    }

    set(id, x, y, fixed) {
      const n = this.nodes.get(id) || this.place(id);
      n.x = x; n.y = y; n.vx = 0; n.vy = 0; n.fixed = !!fixed;
      return n;
    }

    remove(id) { this.nodes.delete(id); }
    clear() { this.nodes.clear(); this.active = []; this.links = []; }
    unfixAll() { for (const n of this.nodes.values()) n.fixed = false; }
    reheat(a) { this.alpha = Math.max(this.alpha, a); }

    setActive(ids) { this.active = ids.map((id) => this.nodes.get(id)).filter(Boolean); }

    setLinks(links) {
      this.links = links
        .map((l) => ({ a: this.nodes.get(l.a), b: this.nodes.get(l.b), len: l.len, k: l.k }))
        .filter((l) => l.a && l.b && l.a !== l.b);
    }

    positions() {
      const out = new Map();
      for (const [id, n] of this.nodes) out.set(id, { x: n.x, y: n.y });
      return out;
    }

    tick() {
      const a = this.alpha;
      if (a <= 0) return;
      const ns = this.active;
      const N = ns.length;
      for (let i = 0; i < N; i++) {
        const p = ns[i];
        for (let j = i + 1; j < N; j++) {
          const q = ns[j];
          let dx = q.x - p.x;
          let dy = q.y - p.y;
          let d2 = dx * dx + dy * dy;
          if (d2 > 1.4e6) continue;
          if (d2 < 1) { dx = rand(p.id + q.id, 'x') - 0.5; dy = rand(p.id + q.id, 'y') - 0.5; d2 = dx * dx + dy * dy || 0.25; }
          const d = Math.sqrt(d2);
          let f = 70000 / d2;
          // Cards are wide and short, so measure overlap on a squashed ellipse.
          const de = Math.sqrt(dx * dx + dy * dy * 4.4);
          if (de < 230) f += (230 - de) * 0.09;
          f *= a;
          const fx = (dx / d) * f;
          const fy = (dy / d) * f;
          p.vx -= fx; p.vy -= fy; q.vx += fx; q.vy += fy;
        }
      }
      for (const l of this.links) {
        const dx = l.b.x - l.a.x;
        const dy = l.b.y - l.a.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const f = (d - l.len) * l.k * a;
        const fx = (dx / d) * f;
        const fy = (dy / d) * f;
        l.a.vx += fx; l.a.vy += fy; l.b.vx -= fx; l.b.vy -= fy;
      }
      for (const p of ns) {
        if (p.fixed) { p.vx = 0; p.vy = 0; continue; }
        p.vx -= p.x * 0.0025 * a;
        p.vy -= p.y * 0.004 * a;
        p.vx *= 0.6; p.vy *= 0.6;
        const sp = Math.hypot(p.vx, p.vy);
        if (sp > 45) { p.vx *= 45 / sp; p.vy *= 45 / sp; }
        p.x += p.vx; p.y += p.vy;
      }
      this.alpha *= 0.985;
      if (this.alpha < 0.006) this.alpha = 0;
    }
  }

  TS.Layout = Layout;
  TS.hash = hash;
  if (typeof module !== 'undefined' && module.exports) module.exports = { Layout, hash };
})(typeof globalThis !== 'undefined' ? globalThis : this);
