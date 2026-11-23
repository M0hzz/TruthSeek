/*
 * TruthSeek engine: replays events to get the state of the board at any point
 * in time, spreads power through the strings, and finds things worth a look.
 *
 * The model, in short:
 *   base(n)       = weight + every power change events have made so far
 *   structural(n) = base(n) + upShare * sum(structural(member))   (containment pushes power up)
 *   received(n)   = sum over simple paths s -> ... -> n of at most maxHops strings of
 *                   structural(s) * product(string strengths) * decay^(hops - 1)
 *                   A container also passes downShare of its own power to each member.
 *   total(n)      = structural(n) + received(n)
 * Strengths run from -1 (fully opposed) to 1 (fully supportive), so opposition flips the sign.
 */
(function (root) {
  'use strict';
  const TS = (root.TruthSeek = root.TruthSeek || {});

  const DEFAULTS = Object.freeze({ decay: 0.5, maxHops: 3, upShare: 0.25, downShare: 0.25, minFlow: 0.01, topPaths: 6 });

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function pairKey(a, b) { return a < b ? `${a}\u0001${b}` : `${b}\u0001${a}`; }

  function settingsFrom(s) {
    const o = { ...DEFAULTS };
    if (s) for (const k of Object.keys(DEFAULTS)) if (s[k] != null && Number.isFinite(Number(s[k]))) o[k] = Number(s[k]);
    o.maxHops = clamp(Math.round(o.maxHops), 1, 6);
    o.decay = clamp(o.decay, 0, 1);
    o.upShare = clamp(o.upShare, 0, 1);
    o.downShare = clamp(o.downShare, 0, 1);
    o.minFlow = Math.max(0.0001, o.minFlow);
    o.topPaths = clamp(Math.round(o.topPaths), 1, 50);
    return o;
  }

  function findRel(rels, ref) {
    if (ref.id != null) {
      const r = rels.get(ref.id);
      return r && r.exists ? r : null;
    }
    const [a, b] = ref.pair;
    let loose = null;
    for (const r of rels.values()) {
      if (!r.exists || (ref.type && r.type !== ref.type)) continue;
      if (r.from === a && r.to === b) return r;
      if (!loose && r.from === b && r.to === a) loose = r;
    }
    return loose;
  }

  function wouldLoop(nouns, id, parent) {
    const seen = new Set();
    let p = parent;
    while (p) {
      if (p === id || seen.has(p)) return true;
      seen.add(p);
      const n = nouns.get(p);
      p = n ? n.parent : null;
    }
    return false;
  }

  function initialState(model) {
    const nouns = new Map();
    const rels = new Map();
    for (const n of model.nouns) nouns.set(n.id, { id: n.id, base: n.weight, parent: n.parent, exists: n.exists !== false });
    for (const r of model.relationships) {
      rels.set(r.id, { id: r.id, from: r.from, to: r.to, type: r.type, strength: r.strength, direction: r.direction, exists: true, origin: null });
    }
    return { nouns, rels };
  }

  /** Apply one event to a state in place. Returns what it touched. */
  function applyEvent(state, ev) {
    const touched = new Set(ev.involves || []);
    const touchedRels = new Set();
    for (const ef of ev.effects || []) {
      switch (ef.kind) {
        case 'power': {
          const n = state.nouns.get(ef.target);
          if (n) { n.base += ef.amount; touched.add(n.id); }
          break;
        }
        case 'exists': {
          const n = state.nouns.get(ef.target);
          if (n) { n.exists = ef.value; touched.add(n.id); }
          break;
        }
        case 'move': {
          const n = state.nouns.get(ef.target);
          const ok = ef.parent == null || state.nouns.has(ef.parent);
          if (n && ok && !wouldLoop(state.nouns, n.id, ef.parent)) { n.parent = ef.parent; touched.add(n.id); }
          break;
        }
        case 'strength': {
          const r = findRel(state.rels, ef.ref);
          if (r) {
            r.strength = clamp(r.strength + ef.amount, -1, 1);
            touched.add(r.from); touched.add(r.to); touchedRels.add(r.id);
          }
          break;
        }
        case 'link': {
          const id = ef.id || `${ef.from}~${ef.type}~${ef.to}`;
          let r = state.rels.get(id);
          if (r) {
            r.exists = true; r.strength = ef.strength; r.direction = ef.direction;
          } else {
            r = { id, from: ef.from, to: ef.to, type: ef.type, strength: ef.strength, direction: ef.direction, exists: true, origin: ev.id };
            state.rels.set(id, r);
          }
          touched.add(ef.from); touched.add(ef.to); touchedRels.add(id);
          break;
        }
        case 'unlink': {
          const r = findRel(state.rels, ef.ref);
          if (r) { r.exists = false; touched.add(r.from); touched.add(r.to); touchedRels.add(r.id); }
          break;
        }
        default:
          break;
      }
    }
    return { touched, touchedRels };
  }

  /** State after the first `step` events (step 0 = before any event). */
  function stateAt(model, step) {
    const s = initialState(model);
    const n = clamp(step | 0, 0, model.events.length);
    let last = { touched: new Set(), touchedRels: new Set() };
    for (let i = 0; i < n; i++) last = applyEvent(s, model.events[i]);
    s.step = n;
    s.touched = last.touched;
    s.touchedRels = last.touchedRels;
    return s;
  }

  function pushTop(map, key, amount, make, k) {
    let arr = map.get(key);
    if (!arr) map.set(key, (arr = []));
    const mag = Math.abs(amount);
    if (arr.length >= k && mag <= Math.abs(arr[arr.length - 1].amount)) return;
    let i = arr.length;
    while (i > 0 && Math.abs(arr[i - 1].amount) < mag) i--;
    arr.splice(i, 0, make());
    if (arr.length > k) arr.pop();
  }

  /** Full analysis of the board after `step` events. */
  function analyze(model, step, settings) {
    const cfg = settingsFrom(settings);
    const st = stateAt(model, step);

    const ids = [];
    for (const n of st.nouns.values()) if (n.exists) ids.push(n.id);
    const live = new Set(ids);

    // Nearest existing ancestor; a member of a vanished group moves up a level.
    const parent = new Map();
    const children = new Map(ids.map((id) => [id, []]));
    for (const id of ids) {
      let p = st.nouns.get(id).parent;
      const seen = new Set([id]);
      while (p && !live.has(p) && !seen.has(p)) {
        seen.add(p);
        const pn = st.nouns.get(p);
        p = pn ? pn.parent : null;
      }
      const eff = p && live.has(p) ? p : null;
      parent.set(id, eff);
      if (eff) children.get(eff).push(id);
    }

    const structural = new Map();
    const members = new Map();
    const visiting = new Set();
    function struct(id) {
      if (structural.has(id)) return structural.get(id);
      if (visiting.has(id)) return 0;
      visiting.add(id);
      let m = 0;
      for (const c of children.get(id)) m += cfg.upShare * struct(c);
      visiting.delete(id);
      members.set(id, m);
      const v = st.nouns.get(id).base + m;
      structural.set(id, v);
      return v;
    }
    ids.forEach(struct);

    const adj = new Map(ids.map((id) => [id, []]));
    for (const r of st.rels.values()) {
      if (!r.exists || !live.has(r.from) || !live.has(r.to) || r.from === r.to || r.strength === 0) continue;
      adj.get(r.from).push({ to: r.to, s: r.strength, rel: r.id, contains: false });
      if (r.direction === 'two-way') adj.get(r.to).push({ to: r.from, s: r.strength, rel: r.id, contains: false });
    }
    if (cfg.downShare > 0) {
      for (const [c, p] of parent) if (p) adj.get(p).push({ to: c, s: cfg.downShare, rel: null, contains: true });
    }

    const received = new Map(ids.map((id) => [id, 0]));
    const through = new Map(ids.map((id) => [id, 0]));
    const inPaths = new Map();
    const outPaths = new Map();
    const pairFlow = new Map();
    let totalFlow = 0;
    const K = cfg.topPaths;

    for (const src of ids) {
      const P = structural.get(src);
      if (Math.abs(P) < cfg.minFlow) continue;
      const nodes = [src];
      const rels = [];
      const onPath = new Set([src]);

      const record = (target, amount) => {
        received.set(target, received.get(target) + amount);
        const mag = Math.abs(amount);
        totalFlow += mag;
        for (let i = 1; i < nodes.length - 1; i++) through.set(nodes[i], through.get(nodes[i]) + mag);
        let make = null;
        const snapshot = () => make || (make = { from: src, to: target, nodes: nodes.slice(), rels: rels.slice(), amount });
        pushTop(inPaths, target, amount, snapshot, K);
        pushTop(outPaths, src, amount, snapshot, K);
        const key = `${src}\u0001${target}`;
        let f = pairFlow.get(key);
        if (!f) pairFlow.set(key, (f = { from: src, to: target, amount: 0, best: null }));
        f.amount += amount;
        if (!f.best || mag > Math.abs(f.best.amount)) f.best = snapshot();
      };

      const walk = (cur, flow, hop) => {
        for (const e of adj.get(cur)) {
          if (onPath.has(e.to)) continue;
          let next;
          if (hop === 1) {
            // A container does not hand its members' own power back to them.
            const own = e.contains ? P - cfg.upShare * structural.get(e.to) : P;
            next = own * e.s;
          } else {
            next = flow * e.s * cfg.decay;
          }
          if (Math.abs(next) < cfg.minFlow) continue;
          nodes.push(e.to); rels.push(e.rel); onPath.add(e.to);
          record(e.to, next);
          if (hop < cfg.maxHops) walk(e.to, next, hop + 1);
          nodes.pop(); rels.pop(); onPath.delete(e.to);
        }
      };
      walk(src, P, 1);
    }

    const power = new Map();
    for (const id of ids) {
      const s = structural.get(id);
      const rcv = received.get(id);
      power.set(id, { id, base: st.nouns.get(id).base, members: members.get(id), structural: s, received: rcv, total: s + rcv });
    }

    return { step: st.step, cfg, state: st, ids, parent, children, power, inPaths, outPaths, through, pairFlow, totalFlow };
  }

  function isAncestor(parent, anc, id) {
    const seen = new Set();
    let p = parent.get(id);
    while (p && !seen.has(p)) {
      if (p === anc) return true;
      seen.add(p);
      p = parent.get(p);
    }
    return false;
  }

  /** Things worth a look. `baseline` is an analysis to compare against for movers (or null). */
  function discover(a, baseline, limit) {
    const L = limit || 8;
    const P = (id) => a.power.get(id);

    let movers = [];
    if (baseline) {
      const seen = new Set();
      for (const id of a.ids) {
        seen.add(id);
        const b = baseline.power.get(id);
        const from = b ? b.total : 0;
        movers.push({ id, from, to: P(id).total, delta: P(id).total - from, appeared: !b, gone: false });
      }
      for (const id of baseline.ids) {
        if (seen.has(id)) continue;
        const from = baseline.power.get(id).total;
        movers.push({ id, from, to: 0, delta: -from, appeared: false, gone: true });
      }
      movers = movers.filter((m) => Math.abs(m.delta) >= 0.05 || m.gone || m.appeared)
        .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta)).slice(0, L);
    }

    const bases = a.ids.map((id) => P(id).base).sort((x, y) => x - y);
    const median = bases.length ? bases[Math.floor((bases.length - 1) / 2)] : 0;
    const heavyweights = a.ids.map(P)
      .filter((p) => p.received > 0.05 && p.base <= median)
      .map((p) => ({
        id: p.id, base: p.base, received: p.received, total: p.total,
        borrowed: p.total > 0 ? clamp(p.received / p.total, 0, 1) : 1,
        score: p.received / (Math.abs(p.base) + 1),
      }))
      .sort((x, y) => y.score - x.score)
      .slice(0, L);

    const chokepoints = a.ids
      .map((id) => ({ id, flow: a.through.get(id) || 0 }))
      .filter((c) => c.flow > 0.01)
      .map((c) => ({ ...c, share: a.totalFlow ? c.flow / a.totalFlow : 0 }))
      .sort((x, y) => y.flow - x.flow)
      .slice(0, L);

    const direct = new Set();
    for (const r of a.state.rels.values()) if (r.exists) direct.add(pairKey(r.from, r.to));
    for (const [c, p] of a.parent) if (p) direct.add(pairKey(c, p));
    const pairs = new Map();
    for (const f of a.pairFlow.values()) {
      const key = pairKey(f.from, f.to);
      if (direct.has(key) || isAncestor(a.parent, f.from, f.to) || isAncestor(a.parent, f.to, f.from)) continue;
      let e = pairs.get(key);
      if (!e) {
        const [x, y] = f.from < f.to ? [f.from, f.to] : [f.to, f.from];
        pairs.set(key, (e = { key, a: x, b: y, amount: 0, best: null }));
      }
      e.amount += f.amount;
      if (!e.best || Math.abs(f.best.amount) > Math.abs(e.best.amount)) e.best = f.best;
    }
    const hiddenLinks = [...pairs.values()]
      .filter((e) => Math.abs(e.amount) >= 0.1)
      .sort((x, y) => Math.abs(y.amount) - Math.abs(x.amount))
      .slice(0, L);

    return { movers, heavyweights, chokepoints, hiddenLinks };
  }

  /**
   * What event `index` did: compares the analysis before it (`before`, step = index)
   * with the one after it (`after`, step = index + 1).
   */
  function eventImpact(model, index, before, after) {
    const ev = model.events[index];
    const direct = new Set(after.state.touched);
    const ids = new Set([...before.ids, ...after.ids]);
    const rows = [];
    for (const id of ids) {
      const b = before.power.get(id);
      const c = after.power.get(id);
      const delta = (c ? c.total : 0) - (b ? b.total : 0);
      const isDirect = direct.has(id);
      if (!isDirect && Math.abs(delta) < 0.03) continue;
      rows.push({ id, before: b ? b.total : 0, after: c ? c.total : 0, delta, direct: isDirect, appeared: !b && !!c, gone: !!b && !c, path: null, via: null });
    }
    const deltaOf = new Map(rows.map((r) => [r.id, r.delta]));
    for (const row of rows) {
      if (row.direct) continue;
      // 1) the strongest ripple path that starts at something the event touched
      let best = null;
      for (const d of direct) {
        const f = after.pairFlow.get(`${d}\u0001${row.id}`);
        if (f && f.best && (!best || Math.abs(f.best.amount) > Math.abs(best.amount))) best = f.best;
      }
      if (best) { row.path = best; continue; }
      // 2) otherwise it probably moved because one of its members did
      let kid = null;
      for (const k of after.children.get(row.id) || []) {
        if (deltaOf.has(k) && (!kid || Math.abs(deltaOf.get(k)) > Math.abs(deltaOf.get(kid)))) kid = k;
      }
      if (kid) { row.via = { kind: 'member', id: kid }; continue; }
      // 3) or because something upstream of it changed
      let up = null;
      for (const p of after.inPaths.get(row.id) || []) {
        if (deltaOf.has(p.from)) { up = p; break; }
      }
      row.path = up || (after.inPaths.get(row.id) || [])[0] || null;
    }
    const byMag = (x, y) => Math.abs(y.delta) - Math.abs(x.delta);
    return {
      event: ev,
      direct: rows.filter((r) => r.direct).sort(byMag),
      ripple: rows.filter((r) => !r.direct).sort(byMag),
    };
  }

  const api = { DEFAULTS, settingsFrom, stateAt, applyEvent, analyze, discover, eventImpact, pairKey };
  TS.engine = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
