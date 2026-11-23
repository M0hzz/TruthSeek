/*
 * TruthSeek model: reads a board file, checks it, normalizes it and writes it
 * back out. Works in the browser (window.TruthSeek.model) and in Node (require).
 */
(function (root) {
  'use strict';
  const TS = (root.TruthSeek = root.TruthSeek || {});

  const NOUN_KEYS = ['id', 'name', 'type', 'weight', 'parent', 'context', 'tags', 'exists', 'x', 'y'];
  const REL_KEYS = ['id', 'from', 'to', 'type', 'strength', 'direction', 'context'];
  const EVENT_KEYS = ['id', 'name', 'time', 'description', 'involves', 'effects', 'power'];
  const TOP_KEYS = ['title', 'description', 'nouns', 'relationships', 'relations', 'links', 'events', 'settings'];

  function str(v) { return v == null ? '' : String(v); }
  function slug(s) {
    return str(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'item';
  }
  function num(v, d) {
    if (v == null || (typeof v === 'string' && v.trim() === '')) return d;
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function extras(obj, known) {
    const out = {};
    for (const k of Object.keys(obj)) if (!known.includes(k)) out[k] = obj[k];
    return out;
  }
  function uniqueId(base, taken) {
    let id = base;
    let k = 2;
    while (taken.has(id)) id = `${base}_${k++}`;
    taken.add(id);
    return id;
  }

  function normDirection(d) {
    const s = str(d).toLowerCase().trim().replace(/[\s_]+/g, '-');
    return ['one-way', 'oneway', 'directed', 'forward', '->'].includes(s) ? 'one-way' : 'two-way';
  }

  /** Sort key for an event time: numbers as-is, numeric strings as numbers, other strings as dates. */
  function timeKey(t) {
    if (typeof t === 'number' && Number.isFinite(t)) return t;
    if (typeof t === 'string' && t.trim()) {
      const s = t.trim();
      if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
      const d = Date.parse(s);
      if (!Number.isNaN(d)) return d;
    }
    return null;
  }

  function normRef(r) {
    if (Array.isArray(r)) return { pair: [str(r[0]), str(r[1])], type: r[2] != null ? str(r[2]) : null };
    if (r && typeof r === 'object') return { pair: [str(r.from), str(r.to)], type: r.type != null ? str(r.type) : null };
    return { id: str(r) };
  }

  /** One effect object in the file can carry several changes; returns a list of normalized effects. */
  function normalizeEffect(e, where, warn) {
    if (!e || typeof e !== 'object') { warn(`${where} is not an object; skipped.`); return []; }
    if (e.link && typeof e.link === 'object') {
      const l = e.link;
      return [{
        kind: 'link',
        id: l.id != null ? str(l.id) : null,
        from: str(l.from),
        to: str(l.to),
        type: l.type != null && str(l.type).trim() ? str(l.type).trim() : 'linked',
        strength: clamp(num(l.strength, 0.5), -1, 1),
        direction: normDirection(l.direction),
      }];
    }
    if (e.unlink != null) return [{ kind: 'unlink', ref: normRef(e.unlink) }];
    if (e.relationship != null && e.strength != null) {
      return [{ kind: 'strength', ref: normRef(e.relationship), amount: num(e.strength, 0) }];
    }
    if (e.target != null) {
      const target = str(e.target);
      const out = [];
      if ('exists' in e) out.push({ kind: 'exists', target, value: e.exists !== false });
      if ('parent' in e) out.push({ kind: 'move', target, parent: e.parent == null || e.parent === '' ? null : str(e.parent) });
      const amount = num(e.power != null ? e.power : e.weight, NaN);
      if (Number.isFinite(amount)) out.push({ kind: 'power', target, amount });
      if (out.length) return out;
    }
    warn(`${where} has no effect TruthSeek understands; skipped.`);
    return [];
  }

  function refToJSON(ref) {
    if (ref.id != null) return ref.id;
    return ref.type ? [ref.pair[0], ref.pair[1], ref.type] : [ref.pair[0], ref.pair[1]];
  }

  function effectToJSON(ef) {
    switch (ef.kind) {
      case 'power': return { target: ef.target, power: ef.amount };
      case 'exists': return { target: ef.target, exists: ef.value };
      case 'move': return { target: ef.target, parent: ef.parent };
      case 'strength': return { relationship: refToJSON(ef.ref), strength: ef.amount };
      case 'unlink': return { unlink: refToJSON(ef.ref) };
      case 'link': {
        const l = { from: ef.from, to: ef.to, type: ef.type, strength: ef.strength, direction: ef.direction };
        if (ef.id) l.id = ef.id;
        return { link: l };
      }
      default: return null;
    }
  }

  /**
   * Normalize one event. `eventIds` is the set of ids already taken, `byId` the nouns.
   * Effects that point at unknown nouns are dropped with a warning.
   */
  function normalizeEvent(e, i, eventIds, byId, warn) {
    const name = e.name != null && str(e.name).trim() ? str(e.name) : `Event ${i + 1}`;
    const id = uniqueId(e.id != null && str(e.id).trim() ? str(e.id).trim() : slug(name), eventIds);
    const rawInvolves = Array.isArray(e.involves) ? e.involves : e.involves != null ? [e.involves] : [];
    const involves = [];
    for (const x of rawInvolves.map(str)) {
      if (!byId.has(x)) warn(`Event "${name}" involves unknown noun "${x}"; ignored.`);
      else if (!involves.includes(x)) involves.push(x);
    }
    let effects = [];
    (Array.isArray(e.effects) ? e.effects : []).forEach((ef, j) => {
      effects.push(...normalizeEffect(ef, `Event "${name}" effect ${j + 1}`, warn));
    });
    const shorthand = num(e.power, NaN);
    if (Number.isFinite(shorthand)) for (const t of involves) effects.push({ kind: 'power', target: t, amount: shorthand });

    effects = effects.filter((ef) => {
      if ((ef.kind === 'power' || ef.kind === 'exists' || ef.kind === 'move') && !byId.has(ef.target)) {
        warn(`Event "${name}" changes unknown noun "${ef.target}"; ignored.`);
        return false;
      }
      if (ef.kind === 'move' && ef.parent != null && !byId.has(ef.parent)) {
        warn(`Event "${name}" moves "${ef.target}" into unknown noun "${ef.parent}"; ignored.`);
        return false;
      }
      if (ef.kind === 'link' && (!byId.has(ef.from) || !byId.has(ef.to))) {
        warn(`Event "${name}" ties a string to an unknown noun ("${ef.from}" → "${ef.to}"); ignored.`);
        return false;
      }
      if (ef.ref && ef.ref.pair && ef.ref.pair.some((x) => !byId.has(x))) {
        warn(`Event "${name}" refers to a string between unknown nouns (${ef.ref.pair.join(', ')}); ignored.`);
        return false;
      }
      return true;
    });

    return {
      id,
      name,
      time: e.time != null && e.time !== '' ? e.time : null,
      key: null,
      description: str(e.description),
      involves,
      effects,
      extra: extras(e, EVENT_KEYS),
    };
  }

  /** Stable chronological sort. Events without a readable time stay right after the event before them. */
  function sortEvents(evs) {
    let prev = -Infinity;
    evs.forEach((ev, i) => {
      const k = timeKey(ev.time);
      ev.key = k != null ? k : prev;
      ev._i = i;
      if (k != null) prev = k;
    });
    evs.sort((a, b) => (a.key === b.key ? a._i - b._i : a.key - b.key));
    evs.forEach((ev) => { delete ev._i; });
    return evs;
  }

  function normalize(raw) {
    const warnings = [];
    const warn = (m) => warnings.push(m);
    if (Array.isArray(raw)) raw = { nouns: raw };
    if (!raw || typeof raw !== 'object') throw new Error('The file must contain a JSON object with a "nouns" list.');
    if (!Array.isArray(raw.nouns)) throw new Error('The file has no "nouns" list.');

    const nounIds = new Set();
    const nouns = [];
    raw.nouns.forEach((n, i) => {
      if (!n || typeof n !== 'object') { warn(`nouns[${i}] is not an object; skipped.`); return; }
      const wanted = n.id != null && str(n.id).trim() ? str(n.id).trim() : slug(n.name != null ? n.name : `noun_${i + 1}`);
      if (nounIds.has(wanted)) warn(`Two nouns share the id "${wanted}"; the second was renamed.`);
      const id = uniqueId(wanted, nounIds);
      let tags = [];
      if (Array.isArray(n.tags)) tags = n.tags.map(str).filter(Boolean);
      else if (typeof n.tags === 'string') tags = n.tags.split(',').map((s) => s.trim()).filter(Boolean);
      nouns.push({
        id,
        name: n.name != null && str(n.name).trim() ? str(n.name) : id,
        type: n.type != null && str(n.type).trim() ? str(n.type).trim() : 'thing',
        weight: num(n.weight, 1),
        parent: n.parent != null && str(n.parent).trim() ? str(n.parent).trim() : null,
        context: str(n.context),
        tags,
        exists: n.exists !== false,
        x: Number.isFinite(n.x) ? n.x : null,
        y: Number.isFinite(n.y) ? n.y : null,
        extra: extras(n, NOUN_KEYS),
      });
    });

    const byId = new Map(nouns.map((n) => [n.id, n]));
    for (const n of nouns) {
      if (n.parent === n.id) { warn(`"${n.name}" is listed inside itself; treated as top-level.`); n.parent = null; }
      if (n.parent && !byId.has(n.parent)) { warn(`"${n.name}" sits inside unknown noun "${n.parent}"; treated as top-level.`); n.parent = null; }
    }
    for (const n of nouns) {
      const seen = new Set([n.id]);
      let p = n.parent;
      while (p) {
        if (seen.has(p)) { warn(`Containment loop through "${n.name}"; it was made top-level.`); n.parent = null; break; }
        seen.add(p);
        p = byId.get(p).parent;
      }
    }

    const relIds = new Set();
    const relationships = [];
    const rawRels = raw.relationships || raw.relations || raw.links || [];
    (Array.isArray(rawRels) ? rawRels : []).forEach((r, i) => {
      if (!r || typeof r !== 'object') { warn(`relationships[${i}] is not an object; skipped.`); return; }
      const from = str(r.from);
      const to = str(r.to);
      if (!byId.has(from) || !byId.has(to)) {
        warn(`relationships[${i}] connects unknown noun(s) "${from}" → "${to}"; skipped.`);
        return;
      }
      if (from === to) { warn(`relationships[${i}] ties "${from}" to itself; skipped.`); return; }
      const type = r.type != null && str(r.type).trim() ? str(r.type).trim() : 'linked';
      const id = uniqueId(r.id != null && str(r.id).trim() ? str(r.id).trim() : `${from}~${type}~${to}`, relIds);
      relationships.push({
        id, from, to, type,
        strength: clamp(num(r.strength, 0.5), -1, 1),
        direction: normDirection(r.direction),
        context: str(r.context),
        extra: extras(r, REL_KEYS),
      });
    });

    const eventIds = new Set();
    const events = [];
    (Array.isArray(raw.events) ? raw.events : []).forEach((e, i) => {
      if (!e || typeof e !== 'object') { warn(`events[${i}] is not an object; skipped.`); return; }
      events.push(normalizeEvent(e, i, eventIds, byId, warn));
    });
    sortEvents(events);

    return {
      title: raw.title != null && str(raw.title).trim() ? str(raw.title) : 'Untitled board',
      description: str(raw.description),
      nouns,
      relationships,
      events,
      settings: raw.settings && typeof raw.settings === 'object' ? { ...raw.settings } : {},
      extra: extras(raw, TOP_KEYS),
      warnings,
    };
  }

  /** Serialize back to the file format. `positions` is an optional Map id -> {x, y}. */
  function toJSON(model, positions) {
    const round = (v) => Math.round(v * 10) / 10;
    const out = { title: model.title };
    if (model.description) out.description = model.description;
    Object.assign(out, model.extra);
    if (model.settings && Object.keys(model.settings).length) out.settings = { ...model.settings };
    out.nouns = model.nouns.map((n) => {
      const o = { id: n.id, name: n.name, type: n.type, weight: n.weight };
      if (n.parent) o.parent = n.parent;
      if (n.context) o.context = n.context;
      if (n.tags.length) o.tags = n.tags.slice();
      if (!n.exists) o.exists = false;
      const p = positions && positions.get(n.id);
      if (p) { o.x = round(p.x); o.y = round(p.y); } else if (n.x != null && n.y != null) { o.x = n.x; o.y = n.y; }
      return Object.assign(o, n.extra);
    });
    out.relationships = model.relationships.map((r) => {
      const o = { id: r.id, from: r.from, to: r.to, type: r.type, strength: r.strength, direction: r.direction };
      if (r.context) o.context = r.context;
      return Object.assign(o, r.extra);
    });
    out.events = model.events.map((e) => {
      const o = { id: e.id, name: e.name };
      if (e.time != null) o.time = e.time;
      if (e.description) o.description = e.description;
      if (e.involves.length) o.involves = e.involves.slice();
      o.effects = e.effects.map(effectToJSON).filter(Boolean);
      return Object.assign(o, e.extra);
    });
    return out;
  }

  const api = { normalize, normalizeEvent, normalizeEffect, sortEvents, toJSON, effectToJSON, slug, uniqueId, timeKey, normDirection };
  TS.model = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
