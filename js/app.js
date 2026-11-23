/*
 * TruthSeek app: wires the model, engine, layout and board to the page.
 */
(function () {
  'use strict';
  const TS = window.TruthSeek;
  const M = TS.model;
  const E = TS.engine;
  const STORE_KEY = 'truthseek.board.v1';

  /* ---------- small helpers ---------- */

  const $ = (s) => document.querySelector(s);
  function h(tag, props, ...kids) {
    const e = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === 'class') e.className = v;
        else if (k === 'style') e.style.cssText = v;
        else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
        else if (k === 'for') e.htmlFor = v;
        else if (['value', 'checked', 'selected', 'disabled', 'title', 'type', 'placeholder', 'min', 'max', 'step', 'rows', 'open', 'id', 'name'].includes(k)) e[k] = v;
        else e.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const c of kids.flat(Infinity)) {
      if (c == null || c === false) continue;
      e.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return e;
  }
  const fmt = (v) => { const r = Math.round(v * 10) / 10; return (r < 0 ? '−' : '') + Math.abs(r).toFixed(1); };
  const fmtS = (v) => { const r = Math.round(v * 10) / 10; return (r > 0 ? '+' : r < 0 ? '−' : '±') + Math.abs(r).toFixed(1); };
  const pct = (v) => `${Math.round(v * 100)}%`;
  const deltaClass = (v) => (v > 0.04 ? 'up' : v < -0.04 ? 'down' : 'flat');

  /* ---------- state ---------- */

  const app = {
    model: null,
    byId: new Map(),
    settings: E.settingsFrom(),
    step: 0,
    since: 0,
    sel: null,
    pathFocus: null,
    tab: 'discover',
    collapsed: new Set(),
    hiddenTypes: new Set(),
    showLabels: true,
    showGhosts: false,
    showGone: true,
    cache: new Map(),
    view: null,
    playTimer: null,
    editOpen: false,
    eventEditOpen: false,
  };

  const layout = new TS.Layout();
  const board = new TS.Board($('#board'), layout, {
    onSelectNode: (id) => select({ kind: 'noun', id }),
    onSelectString: (key) => {
      const s = app.view && app.view.stringByKey.get(key);
      if (s) select({ kind: 'rel', id: s.rels[0] });
    },
    onSelectGhost: (key) => {
      const g = app.view && app.view.ghostByKey.get(key);
      if (g) select({ kind: 'pair', a: g.src.a, b: g.src.b, best: g.src.best, amount: g.src.amount });
    },
    onBackground: () => { if (app.sel || app.pathFocus) select(null); },
    onToggleCollapse: (id) => toggleCollapse(id),
    onLinkCreate: (a, b) => createRelationship(a, b),
    onDrag: () => kick(0.06),
    onDragEnd: () => { kick(0.12); autosave(); },
  });

  /* ---------- analysis ---------- */

  function analysis(step) {
    let a = app.cache.get(step);
    if (!a) { a = E.analyze(app.model, step, app.settings); app.cache.set(step, a); }
    return a;
  }
  function discoveries() {
    const key = `d:${app.step}:${app.since}`;
    let d = app.cache.get(key);
    if (!d) {
      d = E.discover(analysis(app.step), app.since !== app.step ? analysis(app.since) : null, 8);
      app.cache.set(key, d);
    }
    return d;
  }
  function invalidate() {
    app.cache.clear();
    app.byId = new Map(app.model.nouns.map((n) => [n.id, n]));
  }
  const nameOf = (id) => { const n = app.byId.get(id); return n ? n.name : id; };

  /* ---------- view model ---------- */

  function buildView() {
    const m = app.model;
    const a = analysis(app.step);
    const prev = app.step > 0 ? analysis(app.step - 1) : null;
    const st = a.state;
    const parentAt = (id) => { const s = st.nouns.get(id); return s ? s.parent : null; };
    const kids = new Map();
    for (const n of m.nouns) {
      const p = parentAt(n.id);
      if (p) { if (!kids.has(p)) kids.set(p, []); kids.get(p).push(n.id); }
    }
    const shown = (id) => {
      const s = st.nouns.get(id);
      const n = app.byId.get(id);
      if (!s || !n) return false;
      if (!s.exists && !app.showGone) return false;
      return !app.hiddenTypes.has(n.type);
    };
    const repMemo = new Map();
    const rep = (id) => {
      if (repMemo.has(id)) return repMemo.get(id);
      let r = id;
      let p = parentAt(id);
      const seen = new Set([id]);
      while (p && !seen.has(p)) { seen.add(p); if (app.collapsed.has(p)) r = p; p = parentAt(p); }
      repMemo.set(id, r);
      return r;
    };
    const visible = (id) => shown(id) && rep(id) === id;
    const endpoint = (id) => { const r = rep(id); return shown(r) ? r : null; };
    const descendants = (id) => {
      let c = 0;
      const stack = [...(kids.get(id) || [])];
      while (stack.length) { const x = stack.pop(); c++; stack.push(...(kids.get(x) || [])); }
      return c;
    };

    const nodes = [];
    for (const n of m.nouns) {
      if (!visible(n.id)) continue;
      const s = st.nouns.get(n.id);
      const p = a.power.get(n.id);
      const pp = prev ? prev.power.get(n.id) : null;
      const total = p ? p.total : s.base;
      const delta = prev && s.exists ? total - (pp ? pp.total : 0) : 0;
      layout.place(n.id, parentAt(n.id), 170);
      nodes.push({
        id: n.id, name: n.name, type: n.type, total, delta, gone: !s.exists,
        childCount: (kids.get(n.id) || []).length, collapsed: app.collapsed.has(n.id), descendants: descendants(n.id),
      });
    }

    const strings = [];
    const stringByKey = new Map();
    const relToKey = new Map();
    const lanes = new Map();
    for (const r of st.rels.values()) {
      if (!r.exists) continue;
      const ea = endpoint(r.from);
      const eb = endpoint(r.to);
      if (!ea || !eb || ea === eb) continue;
      const aggregated = ea !== r.from || eb !== r.to;
      const key = aggregated ? `agg:${E.pairKey(ea, eb)}` : r.id;
      let s = stringByKey.get(key);
      if (s) { s.rels.push(r.id); s.count++; relToKey.set(r.id, key); continue; }
      const pk = E.pairKey(ea, eb);
      const lane = lanes.get(pk) || 0;
      lanes.set(pk, lane + 1);
      s = {
        key, a: ea, b: eb, type: r.type, strength: r.strength, direction: aggregated ? 'two-way' : r.direction,
        rels: [r.id], count: 1, lane, aggregated, fresh: app.step > 0 && st.touchedRels.has(r.id),
      };
      strings.push(s);
      stringByKey.set(key, s);
      relToKey.set(r.id, key);
    }

    const containment = [];
    for (const nd of nodes) {
      const p = parentAt(nd.id);
      if (p && visible(p)) containment.push({ child: nd.id, parent: p });
    }

    const ghosts = [];
    const ghostByKey = new Map();
    const selPair = app.sel && app.sel.kind === 'pair' ? E.pairKey(app.sel.a, app.sel.b) : null;
    if (app.showGhosts || selPair) {
      for (const g of discoveries().hiddenLinks) {
        if (!app.showGhosts && g.key !== selPair) continue;
        const ea = endpoint(g.a);
        const eb = endpoint(g.b);
        if (!ea || !eb || ea === eb || ea !== g.a || eb !== g.b) continue;
        const key = `ghost:${g.key}`;
        const o = { key, a: ea, b: eb, amount: g.amount, src: g };
        ghosts.push(o);
        ghostByKey.set(key, o);
      }
    }

    const layoutLinks = strings
      .map((s) => ({ a: s.a, b: s.b, len: 250, k: 0.01 + 0.018 * Math.abs(s.strength) }))
      .concat(containment.map((c) => ({ a: c.child, b: c.parent, len: 170, k: 0.045 })));

    return { a, prev, nodes, strings, stringByKey, relToKey, containment, ghosts, ghostByKey, layoutLinks, parentAt, kids, endpoint, visible };
  }

  /* ---------- focus ---------- */

  function focusForPath(p, extraNodes) {
    const v = app.view;
    const nodes = new Set();
    const strings = new Set();
    for (const id of p.nodes) { const e = v.endpoint(id); if (e) nodes.add(e); }
    for (const rid of p.rels) { if (!rid) continue; const k = v.relToKey.get(rid); if (k) strings.add(k); }
    for (const id of extraNodes || []) { const e = v.endpoint(id); if (e) nodes.add(e); }
    const primary = new Set([v.endpoint(p.from), v.endpoint(p.to)].filter(Boolean));
    return { nodes, strings, primary };
  }

  function computeFocus() {
    const v = app.view;
    const sel = app.sel;
    if (!v) return null;
    if (app.pathFocus) return focusForPath(app.pathFocus);
    if (!sel) return null;
    if (sel.kind === 'noun') {
      const id = v.endpoint(sel.id);
      if (!id) return null;
      const nodes = new Set([id]);
      const strings = new Set();
      for (const s of v.strings) if (s.a === id || s.b === id) { strings.add(s.key); nodes.add(s.a); nodes.add(s.b); }
      for (const c of v.containment) if (c.child === id || c.parent === id) { nodes.add(c.child); nodes.add(c.parent); }
      const ghosts = new Set(v.ghosts.filter((g) => g.a === id || g.b === id).map((g) => g.key));
      return { nodes, strings, ghosts, primary: new Set([id]) };
    }
    if (sel.kind === 'rel') {
      const key = v.relToKey.get(sel.id);
      const s = key ? v.stringByKey.get(key) : null;
      if (!s) return null;
      return { nodes: new Set([s.a, s.b]), strings: new Set([key]), primary: new Set(), primaryString: key };
    }
    if (sel.kind === 'pair') {
      const f = sel.best ? focusForPath(sel.best, [sel.a, sel.b]) : { nodes: new Set(), strings: new Set(), primary: new Set() };
      f.ghosts = new Set([`ghost:${E.pairKey(sel.a, sel.b)}`]);
      return f;
    }
    if (sel.kind === 'event') {
      const i = app.model.events.findIndex((e) => e.id === sel.id);
      if (i < 0 || app.step !== i + 1) return null;
      const st = analysis(i + 1).state;
      const nodes = new Set();
      const strings = new Set();
      for (const id of st.touched) { const e = v.endpoint(id); if (e) nodes.add(e); }
      for (const rid of st.touchedRels) { const k = v.relToKey.get(rid); if (k) strings.add(k); }
      return { nodes, strings, primary: new Set(nodes) };
    }
    return null;
  }

  /* ---------- rendering ---------- */

  let running = false;
  function kick(alpha) {
    layout.reheat(alpha);
    if (running) return;
    running = true;
    const frame = () => {
      layout.tick();
      layout.tick();
      board.updatePositions();
      if (layout.alpha > 0) requestAnimationFrame(frame);
      else { running = false; autosave(); }
    };
    requestAnimationFrame(frame);
  }

  function refresh() {
    if (!app.model) return;
    app.view = buildView();
    layout.setActive(app.view.nodes.map((n) => n.id));
    layout.setLinks(app.view.layoutLinks);
    board.showLabels = app.showLabels;
    board.setData(app.view);
    board.setFocus(computeFocus());
    renderPanel();
    renderTimeline();
    renderLegend();
    renderSearchList();
  }

  function select(sel, opts) {
    app.sel = sel;
    app.pathFocus = null;
    if (sel && (sel.kind === 'noun' || sel.kind === 'rel')) app.tab = 'inspect';
    if (sel && sel.kind === 'event') app.tab = 'events';
    refresh();
    if (opts && opts.center && sel && sel.kind === 'noun' && app.view) {
      const id = app.view.endpoint(sel.id);
      if (id) board.centerOn(id);
    }
  }

  function setPathFocus(p) {
    const same = app.pathFocus && p && app.pathFocus.nodes.join('>') === p.nodes.join('>');
    app.pathFocus = same ? null : p;
    board.setFocus(computeFocus());
    renderPanel();
  }

  function setStep(step) {
    if (!app.model) return;
    const s = Math.max(0, Math.min(app.model.events.length, step));
    if (s === app.step) return;
    app.step = s;
    app.pathFocus = null;
    refresh();
    kick(0.12);
  }

  /* ---------- side panel ---------- */

  function renderPanel() {
    for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('active', b.dataset.tab === app.tab);
    const body = $('#panel-body');
    const scroll = body.scrollTop;
    body.replaceChildren();
    if (!app.model) return;
    let content;
    if (app.tab === 'inspect') {
      if (app.sel && app.sel.kind === 'noun' && app.byId.has(app.sel.id)) content = nounPanel(app.sel.id);
      else if (app.sel && app.sel.kind === 'rel') content = relPanel(app.sel.id);
      else content = overviewPanel();
    } else if (app.tab === 'discover') content = discoverPanel();
    else content = eventsPanel();
    body.append(...[].concat(content));
    body.scrollTop = scroll;
  }

  const nounLink = (id, label) => h('button', { class: 'link', type: 'button', onclick: () => select({ kind: 'noun', id }, { center: true }) }, label || nameOf(id));
  const section = (title, ...kids) => h('section', { class: 'sec' }, h('h3', null, title), ...kids);
  const hint = (text) => h('p', { class: 'hint' }, text);
  const typeDot = (type) => h('span', { class: 'dot', style: `background:${TS.colorFor('type', type)}` });

  function relTypeOf(rid) {
    if (!rid) return 'contains';
    const r = app.view.a.state.rels.get(rid);
    return r ? r.type : '?';
  }

  function pathChain(p) {
    const parts = [];
    p.nodes.forEach((id, i) => {
      if (i > 0) parts.push(h('span', { class: 'hop' }, `${relTypeOf(p.rels[i - 1])} →`));
      parts.push(h('span', { class: 'node' }, nameOf(id)));
    });
    return h('span', { class: 'chain' }, parts);
  }

  function pathRow(p) {
    const active = app.pathFocus && app.pathFocus.nodes.join('>') === p.nodes.join('>');
    return h('button', { class: `row path${active ? ' active' : ''}`, type: 'button', title: 'Show this path on the board', onclick: () => setPathFocus(p) },
      pathChain(p), h('span', { class: `num ${deltaClass(p.amount)}` }, fmtS(p.amount)));
  }

  function effectText(ef) {
    switch (ef.kind) {
      case 'power': return `${nameOf(ef.target)} ${fmtS(ef.amount)} power`;
      case 'exists': return ef.value ? `${nameOf(ef.target)} appears` : `${nameOf(ef.target)} is gone`;
      case 'move': return ef.parent ? `${nameOf(ef.target)} moves into ${nameOf(ef.parent)}` : `${nameOf(ef.target)} leaves its group`;
      case 'strength': return `string ${refText(ef.ref)} ${fmtS(ef.amount)}`;
      case 'link': return `new string: ${nameOf(ef.from)} ${ef.direction === 'one-way' ? '→' : '↔'} ${nameOf(ef.to)} (${ef.type})`;
      case 'unlink': return `cut string ${refText(ef.ref)}`;
      default: return '';
    }
  }
  function refText(ref) {
    if (ref.pair) return `${nameOf(ref.pair[0])}–${nameOf(ref.pair[1])}${ref.type ? ` (${ref.type})` : ''}`;
    const r = app.model.relationships.find((x) => x.id === ref.id);
    return r ? `${nameOf(r.from)}–${nameOf(r.to)}` : `"${ref.id}"`;
  }
  function effectMentions(ef, id) {
    if (ef.target === id || ef.from === id || ef.to === id || ef.parent === id) return true;
    if (ef.ref && ef.ref.pair) return ef.ref.pair.includes(id);
    if (ef.ref && ef.ref.id) { const r = app.model.relationships.find((x) => x.id === ef.ref.id); return !!r && (r.from === id || r.to === id); }
    return false;
  }
  function timeLabel(ev) { return ev.time == null ? '—' : String(ev.time); }

  function overviewPanel() {
    const m = app.model;
    const out = [
      h('div', { class: 'eyebrow' }, 'Board'),
      h('input', { class: 'title-input', value: m.title, 'aria-label': 'Board title', onchange: (e) => { m.title = e.target.value || 'Untitled board'; commit(); } }),
      m.description ? h('p', { class: 'context' }, m.description) : null,
      h('div', { class: 'stats' },
        h('div', null, h('b', null, m.nouns.length), ' nouns'),
        h('div', null, h('b', null, m.relationships.length), ' strings'),
        h('div', null, h('b', null, m.events.length), ' events')),
      hint('Click a card to inspect it. Drag cards to arrange them, shift-drag from one card to another to tie a string, and double-click a card to fold its members inside it.'),
    ];
    if (m.warnings.length) {
      out.push(section(`Load warnings (${m.warnings.length})`, h('ul', { class: 'warnings' }, m.warnings.slice(0, 100).map((w) => h('li', null, w)))));
    }
    return out;
  }

  function powerBlock(n, s, p) {
    const fromEvents = s.base - n.weight;
    const rows = [
      ['Own weight', n.weight],
      ['From events', fromEvents],
      ['From members', p.members],
      ['Through strings', p.received],
    ];
    const max = Math.max(1, ...rows.map((r) => Math.abs(r[1])));
    const prev = app.step > 0 ? analysis(app.step - 1).power.get(n.id) : null;
    const since = app.since !== app.step ? analysis(app.since).power.get(n.id) : null;
    return h('div', { class: 'power-block' },
      h('div', { class: 'power-head' },
        h('div', null, h('div', { class: 'label' }, 'Power now'), h('div', { class: 'big' }, fmt(p.total))),
        h('div', { class: 'chips' },
          app.step > 0 ? h('span', { class: `chip ${deltaClass(p.total - (prev ? prev.total : 0))}`, title: 'Change from the last event' }, `${fmtS(p.total - (prev ? prev.total : 0))} last event`) : null,
          app.since !== app.step ? h('span', { class: `chip ${deltaClass(p.total - (since ? since.total : 0))}`, title: 'Change since the comparison point set in Discover' }, `${fmtS(p.total - (since ? since.total : 0))} since ${app.since === 0 ? 'start' : `event ${app.since}`}`) : null)),
      h('div', { class: 'bars' }, rows.map(([label, v]) => h('div', { class: 'bar-row' },
        h('span', { class: 'bar-label' }, label),
        h('span', { class: 'bar-track' }, h('span', { class: `bar ${v < 0 ? 'neg' : ''}`, style: `width:${(Math.abs(v) / max) * 100}%` })),
        h('span', { class: 'num' }, fmt(v))))),
      p.total > 0 && p.received / p.total > 0.5 ? hint(`${pct(p.received / p.total)} of this power is borrowed through strings.`) : null);
  }

  function nounPanel(id) {
    const m = app.model;
    const n = app.byId.get(id);
    const v = app.view;
    const a = v.a;
    const s = a.state.nouns.get(id);
    const p = a.power.get(id);
    const ancestors = [];
    for (let q = v.parentAt(id), guard = 0; q && guard < 50; q = v.parentAt(q), guard++) ancestors.unshift(q);
    const kidIds = v.kids.get(id) || [];

    const out = [];
    out.push(h('div', { class: 'eyebrow' }, typeDot(n.type), n.type, s && !s.exists ? h('span', { class: 'tag gone' }, 'gone at this point') : null));
    out.push(h('h2', { class: 'title' }, n.name));
    if (ancestors.length) out.push(h('div', { class: 'crumbs' }, 'Inside ', ancestors.map((x, i) => [i ? ' › ' : '', nounLink(x)])));
    if (n.tags.length) out.push(h('div', { class: 'tags' }, n.tags.map((t) => h('span', { class: 'tag' }, t))));
    if (n.context) out.push(h('p', { class: 'context' }, n.context));
    if (p) out.push(powerBlock(n, s, p));

    if (p) {
      const ins = a.inPaths.get(id) || [];
      const outs = a.outPaths.get(id) || [];
      out.push(section('Ripples reaching it', ins.length ? h('div', { class: 'rows' }, ins.map(pathRow)) : hint('Nothing reaches it through strings.')));
      out.push(section('Ripples it sends', outs.length ? h('div', { class: 'rows' }, outs.map(pathRow)) : hint('It does not push power anywhere.')));
    }

    const rels = [...a.state.rels.values()].filter((r) => r.exists && (r.from === id || r.to === id));
    out.push(section(`Strings (${rels.length})`,
      rels.length ? h('div', { class: 'rows' }, rels.map((r) => {
        const other = r.from === id ? r.to : r.from;
        const arrow = r.direction === 'two-way' ? '↔' : r.from === id ? '→' : '←';
        return h('button', { class: 'row', type: 'button', onclick: () => select({ kind: 'rel', id: r.id }) },
          h('span', null, h('span', { class: 'muted' }, `${arrow} ${r.type} `), nameOf(other)),
          h('span', { class: `num ${deltaClass(r.strength)}` }, r.strength.toFixed(2)));
      })) : hint('No strings yet.'),
      connectForm(id)));

    if (kidIds.length) {
      out.push(section(`Inside it (${kidIds.length})`,
        h('div', { class: 'chips wrap' }, kidIds.map((k) => nounLink(k))),
        h('button', { class: 'btn small', type: 'button', onclick: () => toggleCollapse(id) }, app.collapsed.has(id) ? 'Unfold members' : 'Fold members into this card')));
    }

    const evRows = [];
    m.events.forEach((ev, i) => {
      const mine = ev.effects.filter((ef) => effectMentions(ef, id));
      if (!mine.length && !ev.involves.includes(id)) return;
      evRows.push(h('button', { class: `row ev${i < app.step ? '' : ' future'}`, type: 'button', onclick: () => goToEvent(i) },
        h('span', null, h('span', { class: 'muted' }, `${timeLabel(ev)} · `), ev.name,
          mine.length ? h('span', { class: 'sub' }, mine.map(effectText).join('; ')) : h('span', { class: 'sub' }, 'involved')),
        i < app.step ? null : h('span', { class: 'muted' }, 'later')));
    });
    out.push(section('Events', evRows.length ? h('div', { class: 'rows' }, evRows) : hint('No events touch it.')));
    out.push(nounEditor(n));
    return out;
  }

  function connectForm(id) {
    const others = app.model.nouns.filter((x) => x.id !== id).sort((x, y) => x.name.localeCompare(y.name));
    const target = h('select', { 'aria-label': 'Connect to' }, h('option', { value: '' }, 'Tie a string to…'), others.map((x) => h('option', { value: x.id }, x.name)));
    return h('div', { class: 'inline-form' }, target,
      h('button', { class: 'btn small', type: 'button', onclick: () => { if (target.value) createRelationship(id, target.value); } }, 'Tie'));
  }

  function isDescendant(candidate, ofId) {
    let p = app.byId.get(candidate) ? app.byId.get(candidate).parent : null;
    for (let guard = 0; p && guard < 100; guard++) { if (p === ofId) return true; p = app.byId.get(p) ? app.byId.get(p).parent : null; }
    return false;
  }

  function nounEditor(n) {
    const types = [...new Set(app.model.nouns.map((x) => x.type))].sort();
    const field = (label, input) => h('label', { class: 'field' }, h('span', null, label), input);
    const parentOptions = app.model.nouns
      .filter((x) => x.id !== n.id && !isDescendant(x.id, n.id))
      .sort((x, y) => x.name.localeCompare(y.name))
      .map((x) => h('option', { value: x.id, selected: x.id === n.parent }, x.name));
    const det = h('details', { class: 'editor', open: app.editOpen, ontoggle: (e) => { app.editOpen = e.target.open; } },
      h('summary', null, 'Edit noun'),
      field('Name', h('input', { id: 'f-name', value: n.name, onchange: (e) => { n.name = e.target.value.trim() || n.id; commit(); } })),
      h('div', { class: 'field-row' },
        field('Type', h('input', { value: n.type, list: 'type-list', onchange: (e) => { n.type = e.target.value.trim() || 'thing'; commit(); } })),
        field('Weight', h('input', { type: 'number', step: '0.5', value: n.weight, onchange: (e) => { const w = Number(e.target.value); if (Number.isFinite(w)) { n.weight = w; commit(); } } }))),
      h('datalist', { id: 'type-list' }, types.map((t) => h('option', { value: t }))),
      field('Inside (at the start)', h('select', { onchange: (e) => { n.parent = e.target.value || null; commit(); } }, h('option', { value: '', selected: !n.parent }, '— nothing (top level) —'), parentOptions)),
      field('Tags (comma separated)', h('input', { value: n.tags.join(', '), onchange: (e) => { n.tags = e.target.value.split(',').map((t) => t.trim()).filter(Boolean); commit(); } })),
      field('Context', h('textarea', { rows: 4, value: n.context, onchange: (e) => { n.context = e.target.value; commit(); } })),
      h('div', { class: 'muted small' }, `id: ${n.id}`),
      h('button', { class: 'btn danger small', type: 'button', onclick: () => deleteNoun(n.id) }, 'Delete noun'));
    return det;
  }

  function relPanel(rid) {
    const a = app.view.a;
    const r = a.state.rels.get(rid);
    const base = app.model.relationships.find((x) => x.id === rid);
    if (!r && !base) return overviewPanel();
    const cur = r || { ...base, exists: false };
    const out = [];
    out.push(h('div', { class: 'eyebrow' }, 'String'));
    out.push(h('h2', { class: 'title rel-title' }, nounLink(cur.from), h('span', { class: 'arrow' }, cur.direction === 'two-way' ? ' ↔ ' : ' → '), nounLink(cur.to)));
    out.push(h('div', { class: 'stats' },
      h('div', null, h('b', null, cur.type), ' type'),
      h('div', null, h('b', { class: deltaClass(cur.strength) }, cur.exists ? cur.strength.toFixed(2) : 'cut'), ' strength now'),
      base && cur.exists && Math.abs(base.strength - cur.strength) > 1e-9 ? h('div', null, h('b', null, base.strength.toFixed(2)), ' at the start') : null));
    out.push(hint(cur.strength < 0
      ? 'A negative string carries opposition: power flowing along it pushes the other side down.'
      : cur.direction === 'one-way' ? `Power flows from ${nameOf(cur.from)} to ${nameOf(cur.to)} only.` : 'Power flows both ways along this string.'));
    if (base && base.context) out.push(h('p', { class: 'context' }, base.context));

    const changes = [];
    app.model.events.forEach((ev, i) => {
      for (const ef of ev.effects) {
        const hits = (ef.ref && (ef.ref.id === rid || (ef.ref.pair && ((ef.ref.pair[0] === cur.from && ef.ref.pair[1] === cur.to) || (ef.ref.pair[0] === cur.to && ef.ref.pair[1] === cur.from)))))
          || (ef.kind === 'link' && (ef.id || `${ef.from}~${ef.type}~${ef.to}`) === rid);
        if (hits) changes.push(h('button', { class: `row ev${i < app.step ? '' : ' future'}`, type: 'button', onclick: () => goToEvent(i) }, h('span', null, h('span', { class: 'muted' }, `${timeLabel(ev)} · `), ev.name, h('span', { class: 'sub' }, effectText(ef)))));
      }
    });
    if (changes.length) out.push(section('Changed by events', h('div', { class: 'rows' }, changes)));

    if (base) {
      const field = (label, input) => h('label', { class: 'field' }, h('span', null, label), input);
      const strengthOut = h('output', null, base.strength.toFixed(2));
      out.push(h('details', { class: 'editor', open: true },
        h('summary', null, 'Edit string'),
        field('Type', h('input', { id: 'f-reltype', value: base.type, onchange: (e) => { base.type = e.target.value.trim() || 'linked'; commit(); } })),
        field(h('span', null, 'Strength at the start ', strengthOut, h('span', { class: 'muted' }, ' (−1 opposes, +1 supports)')),
          h('input', { type: 'range', min: '-1', max: '1', step: '0.05', value: base.strength, oninput: (e) => { strengthOut.textContent = Number(e.target.value).toFixed(2); }, onchange: (e) => { base.strength = Number(e.target.value); commit(); } })),
        field('Direction', h('select', { onchange: (e) => { base.direction = e.target.value; commit(); } },
          h('option', { value: 'two-way', selected: base.direction === 'two-way' }, 'Two-way (both push on each other)'),
          h('option', { value: 'one-way', selected: base.direction === 'one-way' }, `One-way (${nameOf(base.from)} → ${nameOf(base.to)})`))),
        h('button', { class: 'btn small', type: 'button', onclick: () => { const t = base.from; base.from = base.to; base.to = t; commit(); } }, 'Swap ends'),
        field('Context', h('textarea', { rows: 3, value: base.context, onchange: (e) => { base.context = e.target.value; commit(); } })),
        h('button', { class: 'btn danger small', type: 'button', onclick: () => deleteRel(rid) }, 'Cut this string')));
    } else if (r && r.origin) {
      const i = app.model.events.findIndex((e) => e.id === r.origin);
      out.push(hint('This string was tied by an event. Edit it in that event.'));
      if (i >= 0) out.push(h('button', { class: 'btn small', type: 'button', onclick: () => goToEvent(i) }, `Open “${app.model.events[i].name}”`));
    }
    return out;
  }

  function discoverPanel() {
    const m = app.model;
    const d = discoveries();
    const out = [];
    const sinceSel = h('select', { 'aria-label': 'Compare with', onchange: (e) => { app.since = Number(e.target.value); refresh(); } },
      h('option', { value: 0, selected: app.since === 0 }, 'the start (before any event)'),
      m.events.map((ev, i) => h('option', { value: i + 1, selected: app.since === i + 1 }, `after ${timeLabel(ev)} · ${ev.name}`)));
    out.push(h('div', { class: 'eyebrow' }, 'Discover'));
    out.push(h('p', { class: 'lede' }, `What the board looks like ${app.step === 0 ? 'before any event' : `after “${m.events[app.step - 1].name}”`}. Move the timeline to see another moment.`));

    out.push(section('Biggest movers',
      h('label', { class: 'inline-label' }, 'Compared with ', sinceSel),
      app.since === app.step ? hint('Pick a different moment to compare with.')
        : d.movers.length ? h('div', { class: 'rows' }, d.movers.map((x) => h('button', { class: 'row', type: 'button', onclick: () => select({ kind: 'noun', id: x.id }, { center: true }) },
          h('span', null, nameOf(x.id), h('span', { class: 'sub' }, x.gone ? `${fmt(x.from)} → gone` : x.appeared ? `appeared at ${fmt(x.to)}` : `${fmt(x.from)} → ${fmt(x.to)}`)),
          h('span', { class: `num ${deltaClass(x.delta)}` }, fmtS(x.delta))))) : hint('Nothing changed.')));

    out.push(section('Hidden heavyweights',
      hint('Small on their own, strong through who they are tied to.'),
      d.heavyweights.length ? h('div', { class: 'rows' }, d.heavyweights.map((x) => h('button', { class: 'row', type: 'button', onclick: () => select({ kind: 'noun', id: x.id }, { center: true }) },
        h('span', null, nameOf(x.id), h('span', { class: 'sub' }, `own ${fmt(x.base)} → total ${fmt(x.total)}`)),
        h('span', { class: 'num' }, `${pct(x.borrowed)} borrowed`)))) : hint('None found.')));

    out.push(section('Chokepoints',
      hint('Nouns that a lot of ripples have to pass through. Cut one and the board changes.'),
      d.chokepoints.length ? h('div', { class: 'rows' }, d.chokepoints.map((x) => h('button', { class: 'row', type: 'button', onclick: () => select({ kind: 'noun', id: x.id }, { center: true }) },
        h('span', null, nameOf(x.id)),
        h('span', { class: 'num' }, `${pct(x.share)} of ripples`)))) : hint('None found.')));

    out.push(section('Hidden links',
      hint('Pairs with no string between them that still move each other through others. Shown as dotted strings on the board.'),
      d.hiddenLinks.length ? h('div', { class: 'rows' }, d.hiddenLinks.map((x) => {
        const active = app.sel && app.sel.kind === 'pair' && E.pairKey(app.sel.a, app.sel.b) === x.key;
        return h('button', { class: `row${active ? ' active' : ''}`, type: 'button', onclick: () => select(active ? null : { kind: 'pair', a: x.a, b: x.b, best: x.best, amount: x.amount }) },
          h('span', null, `${nameOf(x.a)} ⇢ ${nameOf(x.b)}`, x.best ? h('span', { class: 'sub' }, pathChain(x.best)) : null),
          h('span', { class: `num ${deltaClass(x.amount)}` }, fmtS(x.amount)));
      })) : hint('None found.')));
    return out;
  }

  function eventsPanel() {
    const m = app.model;
    const out = [];
    const selIdx = app.sel && app.sel.kind === 'event' ? m.events.findIndex((e) => e.id === app.sel.id) : -1;
    if (selIdx >= 0) out.push(...eventDetail(selIdx));
    out.push(h('div', { class: 'sec-head' }, h('h3', null, `All events (${m.events.length})`), h('button', { class: 'btn small', type: 'button', onclick: addEvent }, '+ Event')));
    out.push(h('button', { class: `row ev${app.step === 0 ? ' current' : ''}`, type: 'button', onclick: () => { select(null); setStep(0); } }, h('span', null, h('span', { class: 'muted' }, 'Start · '), 'Before any events')));
    out.push(h('div', { class: 'rows' }, m.events.map((ev, i) => h('button', {
      class: `row ev${i + 1 === app.step ? ' current' : ''}${i + 1 > app.step ? ' future' : ''}${i === selIdx ? ' active' : ''}`,
      type: 'button',
      onclick: () => goToEvent(i),
    }, h('span', null, h('span', { class: 'muted' }, `${timeLabel(ev)} · `), ev.name, h('span', { class: 'sub' }, `${ev.effects.length} effect${ev.effects.length === 1 ? '' : 's'}`))))));
    if (!m.events.length) out.push(hint('No events yet. Events change power and strings over time; add one to start a timeline.'));
    return out;
  }

  function eventDetail(i) {
    const m = app.model;
    const ev = m.events[i];
    const imp = E.eventImpact(m, i, analysis(i), analysis(i + 1));
    const out = [];
    out.push(h('div', { class: 'eyebrow' }, `Event ${i + 1} of ${m.events.length} · ${timeLabel(ev)}`));
    out.push(h('h2', { class: 'title' }, ev.name));
    if (ev.description) out.push(h('p', { class: 'context' }, ev.description));
    if (app.step !== i + 1) out.push(h('button', { class: 'btn small', type: 'button', onclick: () => setStep(i + 1) }, 'Show the board right after this event'));
    if (ev.effects.length) out.push(section('What it does', h('ul', { class: 'effects' }, ev.effects.map((ef) => h('li', null, effectText(ef))))));

    out.push(section('Direct hits',
      imp.direct.length ? h('div', { class: 'rows' }, imp.direct.map((r) => h('button', { class: 'row', type: 'button', onclick: () => select({ kind: 'noun', id: r.id }, { center: true }) },
        h('span', null, nameOf(r.id), h('span', { class: 'sub' }, r.gone ? 'gone' : r.appeared ? 'appears' : `${fmt(r.before)} → ${fmt(r.after)}`)),
        h('span', { class: `num ${deltaClass(r.delta)}` }, fmtS(r.delta))))) : hint('It touches no nouns directly.')));

    out.push(section('Ripples',
      hint('Nouns the event never named, but that changed because of it.'),
      imp.ripple.length ? h('div', { class: 'rows' }, imp.ripple.map((r) => {
        let why = null;
        if (r.path) why = pathChain(r.path);
        else if (r.via) why = `${nameOf(r.via.id)} sits inside it`;
        const active = r.path && app.pathFocus && app.pathFocus.nodes.join('>') === r.path.nodes.join('>');
        return h('button', { class: `row${active ? ' active' : ''}`, type: 'button', onclick: () => { if (app.step !== i + 1) setStep(i + 1); if (r.path) setPathFocus(r.path); else select({ kind: 'noun', id: r.id }, { center: true }); } },
          h('span', null, nameOf(r.id), why ? h('span', { class: 'sub' }, why) : null),
          h('span', { class: `num ${deltaClass(r.delta)}` }, fmtS(r.delta)));
      })) : hint('No ripples.')));

    out.push(eventEditor(i));
    out.push(h('hr'));
    return out;
  }

  function eventEditor(i) {
    const m = app.model;
    const ev = m.events[i];
    const field = (label, input) => h('label', { class: 'field' }, h('span', null, label), input);
    const name = h('input', { value: ev.name });
    const time = h('input', { value: ev.time == null ? '' : ev.time, placeholder: 'e.g. 1204 or 2024-03-01' });
    const desc = h('textarea', { rows: 2, value: ev.description });
    const involves = h('input', { value: ev.involves.join(', '), placeholder: 'noun ids, comma separated' });
    const effects = h('textarea', { class: 'code', rows: 10, value: JSON.stringify(ev.effects.map(M.effectToJSON), null, 2), spellcheck: false });
    const err = h('div', { class: 'error', role: 'alert' });
    const save = () => {
      let parsed;
      try { parsed = JSON.parse(effects.value || '[]'); } catch (e) { err.textContent = `Effects are not valid JSON: ${e.message}`; return; }
      if (!Array.isArray(parsed)) { err.textContent = 'Effects must be a JSON list: [ … ].'; return; }
      const warnings = [];
      const taken = new Set(m.events.filter((x) => x !== ev).map((x) => x.id));
      taken.delete(ev.id);
      const t = time.value.trim();
      const raw = {
        id: ev.id, name: name.value, time: t === '' ? null : (/^-?\d+(\.\d+)?$/.test(t) ? Number(t) : t),
        description: desc.value, involves: involves.value.split(',').map((x) => x.trim()).filter(Boolean), effects: parsed,
      };
      const next = M.normalizeEvent(raw, i, taken, app.byId, (w) => warnings.push(w));
      next.extra = ev.extra;
      if (warnings.length) { err.textContent = warnings.join(' '); return; }
      m.events[i] = next;
      M.sortEvents(m.events);
      app.sel = { kind: 'event', id: next.id };
      app.step = m.events.indexOf(next) + 1;
      commit();
      toast('Event saved.');
    };
    return h('details', { class: 'editor', open: app.eventEditOpen, ontoggle: (e) => { app.eventEditOpen = e.target.open; } },
      h('summary', null, 'Edit event'),
      field('Name', name),
      field('Time', time),
      field('Description', desc),
      field('Involves', involves),
      field(h('span', null, 'Effects ', h('button', { class: 'link small', type: 'button', onclick: () => $('#help').showModal() }, 'format help')), effects),
      err,
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn primary small', type: 'button', onclick: save }, 'Save event'),
        h('button', { class: 'btn danger small', type: 'button', onclick: () => deleteEvent(i) }, 'Delete event')));
  }

  /* ---------- timeline, legend, search ---------- */

  function renderTimeline() {
    const m = app.model;
    const n = m ? m.events.length : 0;
    const range = $('#tl-range');
    range.max = String(n);
    range.value = String(app.step);
    range.disabled = !m || n === 0;
    $('#btn-play').disabled = !m || n === 0;
    $('#btn-prev').disabled = !m || app.step === 0;
    $('#btn-next').disabled = !m || app.step >= n;
    const ticks = $('#tl-ticks');
    ticks.replaceChildren();
    if (m) {
      m.events.forEach((ev, i) => {
        const f = n ? (i + 1) / n : 0;
        ticks.appendChild(h('button', {
          class: `tick${i + 1 <= app.step ? ' past' : ''}${i + 1 === app.step ? ' now' : ''}`,
          type: 'button',
          style: `left:calc(9px + (100% - 18px) * ${f})`,
          title: `${timeLabel(ev)} · ${ev.name}`,
          'aria-label': `Go to ${ev.name}`,
          onclick: () => goToEvent(i),
        }));
      });
    }
    const label = $('#tl-label');
    if (!m) label.textContent = '';
    else if (!n) label.textContent = 'No events in this board';
    else if (app.step === 0) label.replaceChildren(h('span', { class: 'muted' }, `0 / ${n} · `), 'Before any events');
    else {
      const ev = m.events[app.step - 1];
      label.replaceChildren(h('span', { class: 'muted' }, `${app.step} / ${n} · ${timeLabel(ev)} · `), ev.name);
    }
    $('#btn-play').textContent = app.playTimer ? '❚❚' : '▶';
    $('#btn-play').setAttribute('aria-label', app.playTimer ? 'Pause' : 'Play the timeline');
  }

  function renderLegend() {
    const lg = $('#legend');
    lg.replaceChildren();
    if (!app.model) return;
    const counts = new Map();
    for (const n of app.model.nouns) counts.set(n.type, (counts.get(n.type) || 0) + 1);
    const types = [...counts.keys()].sort();
    lg.append(
      h('div', { class: 'legend-title' }, 'Types'),
      ...types.map((t) => h('button', {
        class: `legend-item${app.hiddenTypes.has(t) ? ' off' : ''}`,
        type: 'button',
        title: app.hiddenTypes.has(t) ? `Show ${t}` : `Hide ${t}`,
        onclick: () => { if (app.hiddenTypes.has(t)) app.hiddenTypes.delete(t); else app.hiddenTypes.add(t); refresh(); kick(0.3); },
      }, typeDot(t), t, h('span', { class: 'muted' }, counts.get(t)))),
      h('div', { class: 'legend-key' },
        h('div', null, h('span', { class: 'swatch yarn' }), 'supports'),
        h('div', null, h('span', { class: 'swatch oppose' }), 'opposes'),
        app.showGhosts ? h('div', null, h('span', { class: 'swatch ghost' }), 'hidden link') : null));
  }

  function renderSearchList() {
    const dl = $('#noun-list');
    dl.replaceChildren(...app.model.nouns.map((n) => h('option', { value: n.name })));
  }

  /* ---------- edits ---------- */

  let saveTimer = null;
  function autosave() {
    if (!app.model) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { localStorage.setItem(STORE_KEY, JSON.stringify(currentJSON())); } catch (_) { /* storage unavailable */ }
    }, 600);
  }

  function currentJSON() {
    app.model.settings = { ...app.model.settings, ...app.settings };
    return M.toJSON(app.model, layout.positions());
  }

  function commit() {
    invalidate();
    if (app.step > app.model.events.length) app.step = app.model.events.length;
    if (app.since > app.model.events.length) app.since = 0;
    refresh();
    kick(0.15);
    autosave();
  }

  function addNoun() {
    if (!app.model) return;
    const taken = new Set(app.model.nouns.map((n) => n.id));
    const id = M.uniqueId('new_noun', taken);
    const n = { id, name: 'New noun', type: 'thing', weight: 1, parent: null, context: '', tags: [], exists: true, x: null, y: null, extra: {} };
    app.model.nouns.push(n);
    const c = board.center();
    layout.set(id, c.x, c.y, true);
    app.editOpen = true;
    invalidate();
    select({ kind: 'noun', id });
    autosave();
    setTimeout(() => { const f = $('#f-name'); if (f) { f.focus(); f.select(); } }, 0);
  }

  function createRelationship(a, b) {
    const taken = new Set(app.model.relationships.map((r) => r.id));
    const id = M.uniqueId(`${a}~linked~${b}`, taken);
    app.model.relationships.push({ id, from: a, to: b, type: 'linked', strength: 0.5, direction: 'two-way', context: '', extra: {} });
    invalidate();
    select({ kind: 'rel', id });
    kick(0.2);
    autosave();
    toast(`Tied ${nameOf(a)} to ${nameOf(b)}. Name the string on the right.`);
    setTimeout(() => { const f = $('#f-reltype'); if (f) { f.focus(); f.select(); } }, 0);
  }

  function deleteNoun(id) {
    const m = app.model;
    const n = app.byId.get(id);
    if (!n) return;
    const relCount = m.relationships.filter((r) => r.from === id || r.to === id).length;
    if (!window.confirm(`Delete “${n.name}”? This also cuts ${relCount} string(s) and removes it from any events. Its members move up a level.`)) return;
    m.nouns = m.nouns.filter((x) => x.id !== id);
    for (const x of m.nouns) if (x.parent === id) x.parent = n.parent;
    const goneRels = new Set(m.relationships.filter((r) => r.from === id || r.to === id).map((r) => r.id));
    m.relationships = m.relationships.filter((r) => !goneRels.has(r.id));
    for (const ev of m.events) {
      ev.involves = ev.involves.filter((x) => x !== id);
      ev.effects = ev.effects.filter((ef) => !(ef.target === id || ef.from === id || ef.to === id || ef.parent === id
        || (ef.ref && ef.ref.pair && ef.ref.pair.includes(id)) || (ef.ref && ef.ref.id && goneRels.has(ef.ref.id))));
    }
    app.collapsed.delete(id);
    layout.remove(id);
    app.sel = null;
    commit();
  }

  function deleteRel(rid) {
    const m = app.model;
    m.relationships = m.relationships.filter((r) => r.id !== rid);
    for (const ev of m.events) ev.effects = ev.effects.filter((ef) => !(ef.ref && ef.ref.id === rid));
    app.sel = null;
    commit();
  }

  function addEvent() {
    const m = app.model;
    const last = m.events[m.events.length - 1];
    const lastKey = last ? M.timeKey(last.time) : null;
    const time = last ? (typeof last.time === 'number' ? last.time + 1 : last.time) : 1;
    const taken = new Set(m.events.map((e) => e.id));
    const ev = M.normalizeEvent({ name: 'New event', time: lastKey == null && last ? null : time, effects: [] }, m.events.length, taken, app.byId, () => {});
    m.events.push(ev);
    M.sortEvents(m.events);
    app.sel = { kind: 'event', id: ev.id };
    app.step = m.events.indexOf(ev) + 1;
    app.tab = 'events';
    app.eventEditOpen = true;
    commit();
  }

  function deleteEvent(i) {
    const ev = app.model.events[i];
    if (!window.confirm(`Delete the event “${ev.name}”?`)) return;
    app.model.events.splice(i, 1);
    app.sel = null;
    commit();
  }

  function goToEvent(i) {
    app.sel = { kind: 'event', id: app.model.events[i].id };
    app.tab = 'events';
    app.pathFocus = null;
    app.step = i + 1;
    refresh();
    kick(0.12);
  }

  function toggleCollapse(id) {
    const v = app.view;
    if (!v || !(v.kids.get(id) || []).length) return;
    if (app.collapsed.has(id)) {
      app.collapsed.delete(id);
      const p = layout.pos(id);
      const stack = [...v.kids.get(id)];
      while (stack.length) {
        const k = stack.pop();
        const kp = layout.pos(k);
        if (p && kp && !kp.fixed) layout.set(k, p.x + (Math.random() - 0.5) * 160, p.y + 60 + Math.random() * 80, false);
        if (!app.collapsed.has(k)) stack.push(...(v.kids.get(k) || []));
      }
    } else {
      app.collapsed.add(id);
    }
    refresh();
    kick(0.4);
  }

  /* ---------- load & save ---------- */

  function load(raw, opts) {
    let model;
    try { model = M.normalize(raw); } catch (err) { toast(err.message, 'error'); return false; }
    stopPlaying();
    app.model = model;
    app.settings = E.settingsFrom(model.settings);
    app.step = model.events.length;
    app.since = 0;
    app.sel = null;
    app.pathFocus = null;
    app.collapsed = new Set();
    app.hiddenTypes = new Set();
    app.tab = model.warnings.length ? 'inspect' : 'discover';
    layout.clear();
    invalidate();

    const depth = (id) => { let d = 0; let p = app.byId.get(id).parent; while (p && d < 60) { d++; p = app.byId.get(p) ? app.byId.get(p).parent : null; } return d; };
    const order = [...model.nouns].sort((x, y) => depth(x.id) - depth(y.id));
    const spread = 160 + Math.sqrt(model.nouns.length) * 110;
    let free = 0;
    for (const n of order) {
      if (n.x != null && n.y != null) layout.set(n.id, n.x, n.y, true);
      else { layout.place(n.id, n.parent, n.parent ? 200 : spread); free++; }
    }

    $('#empty').hidden = true;
    document.body.classList.add('has-board');
    refresh();
    if (free) {
      layout.alpha = 1;
      const ticks = model.nouns.length > 600 ? 120 : 360;
      for (let i = 0; i < ticks && layout.alpha > 0; i++) layout.tick();
      board.updatePositions();
    }
    board.fit();
    syncSettingsUI();
    if (!(opts && opts.quiet)) {
      toast(model.warnings.length ? `Loaded “${model.title}” with ${model.warnings.length} warning(s). See the Inspect tab.` : `Loaded “${model.title}”.`, model.warnings.length ? 'warn' : '');
    }
    autosave();
    return true;
  }

  function readFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      let raw;
      try { raw = JSON.parse(reader.result); } catch (e) { toast(`${file.name} is not valid JSON: ${e.message}`, 'error'); return; }
      load(raw);
    };
    reader.onerror = () => toast(`Could not read ${file.name}.`, 'error');
    reader.readAsText(file);
  }

  function exportJSON() {
    if (!app.model) return;
    const data = currentJSON();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = h('a', { href: url, download: `${M.slug(app.model.title)}.json` });
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Exported board with card positions.');
  }

  /* ---------- playback ---------- */

  function stopPlaying() {
    if (app.playTimer) { clearInterval(app.playTimer); app.playTimer = null; }
  }
  function togglePlay() {
    if (!app.model || !app.model.events.length) return;
    if (app.playTimer) { stopPlaying(); renderTimeline(); return; }
    if (app.step >= app.model.events.length) setStep(0);
    app.playTimer = setInterval(() => {
      if (app.step >= app.model.events.length) { stopPlaying(); renderTimeline(); return; }
      setStep(app.step + 1);
    }, 1500);
    renderTimeline();
  }

  /* ---------- settings ---------- */

  const SETTINGS = [
    { key: 'decay', label: 'Ripple falloff per hop', min: 0, max: 1, step: 0.05, help: 'How much of a ripple survives each extra hop.' },
    { key: 'maxHops', label: 'How far ripples travel (hops)', min: 1, max: 5, step: 1, help: 'Longer is slower on big boards.' },
    { key: 'upShare', label: 'Members → container', min: 0, max: 1, step: 0.05, help: 'Share of a member’s power its container gains.' },
    { key: 'downShare', label: 'Container → members', min: 0, max: 1, step: 0.05, help: 'Share of a container’s own power each member receives.' },
  ];
  function syncSettingsUI() {
    const box = $('#settings-fields');
    box.replaceChildren(...SETTINGS.map((s) => {
      const out = h('output', null, String(app.settings[s.key]));
      return h('label', { class: 'field' },
        h('span', null, s.label, ' ', out),
        h('input', {
          type: 'range', min: s.min, max: s.max, step: s.step, value: app.settings[s.key],
          oninput: (e) => { out.textContent = e.target.value; },
          onchange: (e) => {
            app.settings = E.settingsFrom({ ...app.settings, [s.key]: Number(e.target.value) });
            if (app.model) { app.model.settings = { ...app.model.settings, ...app.settings }; commit(); }
          },
        }),
        h('span', { class: 'muted small' }, s.help));
    }));
  }

  /* ---------- toast ---------- */

  let toastTimer = null;
  function toast(msg, kind) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = `show ${kind || ''}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = ''; }, kind === 'error' ? 6000 : 3200);
  }

  /* ---------- wiring ---------- */

  function loadSample() {
    if (TS.SAMPLE) load(JSON.parse(JSON.stringify(TS.SAMPLE)));
    else toast('Sample not found. Open samples/salt-coast.json with the Open button.', 'error');
  }

  $('#btn-open').addEventListener('click', () => $('#file-input').click());
  $('#empty-open').addEventListener('click', () => $('#file-input').click());
  $('#file-input').addEventListener('change', (e) => { readFile(e.target.files[0]); e.target.value = ''; });
  $('#btn-sample').addEventListener('click', loadSample);
  $('#empty-sample').addEventListener('click', loadSample);
  $('#btn-export').addEventListener('click', exportJSON);
  $('#btn-add').addEventListener('click', addNoun);
  $('#btn-fit').addEventListener('click', () => board.fit());
  $('#btn-relayout').addEventListener('click', () => {
    if (!app.model) return;
    layout.unfixAll();
    layout.alpha = 1;
    for (let i = 0; i < 300 && layout.alpha > 0.05; i++) layout.tick();
    board.updatePositions();
    board.fit();
    kick(0.2);
  });
  $('#btn-help').addEventListener('click', () => $('#help').showModal());
  $('#help-close').addEventListener('click', () => $('#help').close());
  $('#btn-settings').addEventListener('click', (e) => {
    const pop = $('#settings-pop');
    pop.hidden = !pop.hidden;
    e.currentTarget.setAttribute('aria-expanded', String(!pop.hidden));
  });
  $('#settings-reset').addEventListener('click', () => {
    app.settings = E.settingsFrom();
    syncSettingsUI();
    if (app.model) { app.model.settings = { ...app.settings }; commit(); }
  });
  document.addEventListener('pointerdown', (e) => {
    const pop = $('#settings-pop');
    if (!pop.hidden && !pop.contains(e.target) && e.target.id !== 'btn-settings') { pop.hidden = true; $('#btn-settings').setAttribute('aria-expanded', 'false'); }
  });

  $('#tg-labels').addEventListener('change', (e) => { app.showLabels = e.target.checked; refresh(); });
  $('#tg-ghosts').addEventListener('change', (e) => { app.showGhosts = e.target.checked; refresh(); });
  $('#tg-gone').addEventListener('change', (e) => { app.showGone = e.target.checked; refresh(); kick(0.2); });

  $('#search').addEventListener('change', (e) => {
    const q = e.target.value.trim().toLowerCase();
    if (!q || !app.model) return;
    const hit = app.model.nouns.find((n) => n.name.toLowerCase() === q)
      || app.model.nouns.find((n) => n.name.toLowerCase().includes(q))
      || app.model.nouns.find((n) => n.id.toLowerCase().includes(q) || n.tags.some((t) => t.toLowerCase() === q));
    if (hit) { select({ kind: 'noun', id: hit.id }, { center: true }); e.target.value = ''; } else toast(`No noun matches “${e.target.value}”.`);
  });

  for (const b of document.querySelectorAll('.tabs button')) {
    b.addEventListener('click', () => { app.tab = b.dataset.tab; renderPanel(); });
  }

  $('#tl-range').addEventListener('input', (e) => { stopPlaying(); setStep(Number(e.target.value)); });
  $('#btn-play').addEventListener('click', togglePlay);
  $('#btn-prev').addEventListener('click', () => { stopPlaying(); setStep(app.step - 1); });
  $('#btn-next').addEventListener('click', () => { stopPlaying(); setStep(app.step + 1); });

  document.addEventListener('keydown', (e) => {
    const tag = (e.target && e.target.tagName) || '';
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || e.target.isContentEditable) return;
    if ($('#help').open) return;
    if (!app.model) return;
    if (e.key === 'Escape') select(null);
    else if (e.key === 'ArrowRight') { stopPlaying(); setStep(app.step + 1); }
    else if (e.key === 'ArrowLeft') { stopPlaying(); setStep(app.step - 1); }
    else if (e.key === 'f' || e.key === 'F') board.fit();
    else if (e.key === ' ') { e.preventDefault(); togglePlay(); }
    else if (e.key === '+' || e.key === '=') board.zoomBy(1.2);
    else if (e.key === '-') board.zoomBy(1 / 1.2);
    else if ((e.key === 'Delete' || e.key === 'Backspace') && app.sel) {
      if (app.sel.kind === 'noun') deleteNoun(app.sel.id);
      else if (app.sel.kind === 'rel' && app.model.relationships.some((r) => r.id === app.sel.id)) {
        if (window.confirm('Cut this string?')) deleteRel(app.sel.id);
      }
    }
  });

  // Drag a file anywhere onto the page.
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { dragDepth++; document.body.classList.add('dropping'); } });
  window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) document.body.classList.remove('dropping'); });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dropping');
    const f = e.dataTransfer && e.dataTransfer.files[0];
    if (f) readFile(f);
  });

  window.addEventListener('resize', () => { if (app.model) board.updatePositions(); });
  window.addEventListener('beforeunload', () => {
    if (!app.model) return;
    try { localStorage.setItem(STORE_KEY, JSON.stringify(currentJSON())); } catch (_) { /* storage unavailable */ }
  });

  // Offer to resume the last board.
  let saved = null;
  try { saved = localStorage.getItem(STORE_KEY); } catch (_) { saved = null; }
  if (saved) {
    let title = 'your last board';
    try { title = `“${JSON.parse(saved).title}”`; } catch (_) { saved = null; }
    if (saved) {
      const btn = $('#empty-resume');
      btn.hidden = false;
      btn.textContent = `Resume ${title}`;
      btn.addEventListener('click', () => { try { load(JSON.parse(saved), { quiet: true }); } catch (e) { toast('Could not restore the saved board.', 'error'); } });
    }
  }
  syncSettingsUI();
  renderTimeline();

  // Allow ?sample in the URL to open straight into the sample (handy for demos).
  if (/[?&]sample\b/.test(window.location.search)) loadSample();

  TS.app = { load, analysis: (s) => analysis(s == null ? app.step : s), state: app, board, layout };
})();
