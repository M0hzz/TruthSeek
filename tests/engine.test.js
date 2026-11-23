'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const M = require('../js/model.js');
const E = require('../js/engine.js');

const near = (actual, expected, msg) => assert.ok(Math.abs(actual - expected) < 1e-9, `${msg || ''} expected ${expected}, got ${actual}`);
const noContain = { upShare: 0, downShare: 0 };

test('two-way string spreads power both ways', () => {
  const m = M.normalize({
    nouns: [{ id: 'a', weight: 4 }, { id: 'b', weight: 2 }],
    relationships: [{ from: 'a', to: 'b', strength: 0.5 }],
  });
  const a = E.analyze(m, 0, noContain);
  near(a.power.get('b').received, 2);
  near(a.power.get('a').received, 1);
  near(a.power.get('a').total, 5);
});

test('ripples decay per hop, respect maxHops, and mark chokepoints', () => {
  const m = M.normalize({
    nouns: [{ id: 'a', weight: 4 }, { id: 'b', weight: 0 }, { id: 'c', weight: 0 }, { id: 'd', weight: 0 }],
    relationships: [
      { from: 'a', to: 'b', strength: 1, direction: 'one-way' },
      { from: 'b', to: 'c', strength: 1, direction: 'one-way' },
      { from: 'c', to: 'd', strength: 1, direction: 'one-way' },
    ],
  });
  const a = E.analyze(m, 0, { ...noContain, decay: 0.5, maxHops: 2 });
  near(a.power.get('b').received, 4);
  near(a.power.get('c').received, 2);
  near(a.power.get('d').received, 0, 'beyond maxHops');
  near(a.through.get('b'), 2);
  const d = E.discover(a, null);
  assert.equal(d.chokepoints[0].id, 'b');
  assert.ok(d.hiddenLinks.some((h) => h.a === 'a' && h.b === 'c'), 'a and c are linked only through b');
});

test('negative strength carries opposition', () => {
  const m = M.normalize({
    nouns: [{ id: 'a', weight: 4 }, { id: 'b', weight: 1 }],
    relationships: [{ from: 'a', to: 'b', strength: -0.5, direction: 'one-way' }],
  });
  near(E.analyze(m, 0, noContain).power.get('b').received, -2);
});

test('containment pushes power up and passes a share down without echo', () => {
  const m = M.normalize({ nouns: [{ id: 'p', weight: 2 }, { id: 'c', weight: 4, parent: 'p' }] });
  const a = E.analyze(m, 0, { upShare: 0.25, downShare: 0.25 });
  near(a.power.get('p').structural, 3);
  near(a.power.get('p').members, 1);
  near(a.power.get('c').received, 0.5, 'child gets 25% of the parent\'s own 2');
});

test('events replay in time order and change power, strings, membership and existence', () => {
  const m = M.normalize({
    nouns: [{ id: 'a', weight: 1 }, { id: 'b', weight: 1 }, { id: 'g', weight: 1 }],
    relationships: [{ id: 'ab', from: 'a', to: 'b', strength: 0.5 }],
    events: [
      { id: 'late', time: '2024-03-01', effects: [{ unlink: 'ab' }, { target: 'b', exists: false }] },
      { id: 'early', time: '2023-01-01', effects: [{ target: 'a', power: 3 }, { relationship: ['a', 'b'], strength: 0.25 }, { target: 'a', parent: 'g' }] },
      { id: 'mid', time: '2023-06-01', effects: [{ link: { from: 'b', to: 'g', type: 'joins', strength: 1 } }] },
    ],
  });
  assert.deepEqual(m.events.map((e) => e.id), ['early', 'mid', 'late']);

  const s1 = E.stateAt(m, 1);
  near(s1.nouns.get('a').base, 4);
  near(s1.rels.get('ab').strength, 0.75);
  assert.equal(s1.nouns.get('a').parent, 'g');
  assert.deepEqual([...s1.touched].sort(), ['a', 'b']);

  const s2 = E.stateAt(m, 2);
  assert.ok(s2.rels.get('b~joins~g').exists);
  assert.equal(s2.rels.get('b~joins~g').origin, 'mid');

  const a3 = E.analyze(m, 3);
  assert.equal(a3.state.rels.get('ab').exists, false);
  assert.ok(!a3.ids.includes('b'));
  near(E.stateAt(m, 0).nouns.get('a').base, 1, 'step 0 is untouched');
});

test('event impact separates direct hits from ripples and explains them', () => {
  const m = M.normalize({
    nouns: [{ id: 'a', weight: 1 }, { id: 'b', weight: 0 }, { id: 'c', weight: 0 }],
    relationships: [{ from: 'a', to: 'b', strength: 1, direction: 'one-way' }, { from: 'b', to: 'c', strength: 1, direction: 'one-way' }],
    events: [{ id: 'boost', time: 1, effects: [{ target: 'a', power: 2 }] }],
  });
  const cfg = { ...noContain, decay: 0.5 };
  const imp = E.eventImpact(m, 0, E.analyze(m, 0, cfg), E.analyze(m, 1, cfg));
  assert.deepEqual(imp.direct.map((r) => r.id), ['a']);
  assert.deepEqual(imp.ripple.map((r) => r.id), ['b', 'c']);
  near(imp.ripple[0].delta, 2);
  near(imp.ripple[1].delta, 1);
  assert.deepEqual(imp.ripple[1].path.nodes, ['a', 'b', 'c']);
});

test('hidden heavyweights: small base, lots of borrowed power', () => {
  const m = M.normalize({
    nouns: [{ id: 'king', weight: 10 }, { id: 'clerk', weight: 1 }, { id: 'x', weight: 3 }, { id: 'y', weight: 2 }],
    relationships: [{ from: 'king', to: 'clerk', strength: 0.9, direction: 'one-way' }],
  });
  const d = E.discover(E.analyze(m, 0, noContain), null);
  assert.equal(d.heavyweights[0].id, 'clerk');
});

test('movers compare against a baseline, including vanished nouns', () => {
  const m = M.normalize({
    nouns: [{ id: 'a', weight: 1 }, { id: 'b', weight: 5 }],
    events: [{ time: 1, effects: [{ target: 'a', power: 4 }, { target: 'b', exists: false }] }],
  });
  const d = E.discover(E.analyze(m, 1, noContain), E.analyze(m, 0, noContain));
  const byId = Object.fromEntries(d.movers.map((x) => [x.id, x]));
  near(byId.a.delta, 4);
  assert.equal(byId.b.gone, true);
});

test('normalize warns about bad references instead of failing', () => {
  const m = M.normalize({
    nouns: [{ id: 'a', parent: 'nope' }, { id: 'a' }, { name: 'Has No Id' }],
    relationships: [{ from: 'a', to: 'ghost' }],
    events: [{ name: 'E', effects: [{ target: 'ghost', power: 1 }, { what: 1 }] }],
  });
  assert.deepEqual(m.nouns.map((n) => n.id), ['a', 'a_2', 'has_no_id']);
  assert.equal(m.nouns[0].parent, null);
  assert.equal(m.relationships.length, 0);
  assert.equal(m.events[0].effects.length, 0);
  assert.ok(m.warnings.length >= 5);
});

test('normalize breaks containment loops', () => {
  const m = M.normalize({ nouns: [{ id: 'a', parent: 'b' }, { id: 'b', parent: 'a' }] });
  assert.ok(m.nouns.some((n) => n.parent === null));
  E.analyze(m, 0);
});

test('export round-trips', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'samples', 'salt-coast.json'), 'utf8'));
  const m = M.normalize(raw);
  assert.deepEqual(m.warnings, []);
  const again = M.normalize(M.toJSON(m));
  assert.deepEqual(again.nouns, m.nouns);
  assert.deepEqual(again.relationships, m.relationships);
  assert.deepEqual(again.events, m.events);
});

test('sample analyses at every step without errors', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'samples', 'salt-coast.json'), 'utf8'));
  const m = M.normalize(raw);
  for (let i = 0; i <= m.events.length; i++) {
    const a = E.analyze(m, i, m.settings);
    for (const p of a.power.values()) assert.ok(Number.isFinite(p.total));
    if (i > 0) E.eventImpact(m, i - 1, E.analyze(m, i - 1), a);
  }
  const d = E.discover(E.analyze(m, m.events.length), E.analyze(m, 0));
  assert.ok(d.movers.length && d.heavyweights.length && d.chokepoints.length && d.hiddenLinks.length);
});

test('bundled sample script matches the JSON sample', () => {
  const dir = path.join(__dirname, '..', 'samples');
  const json = JSON.parse(fs.readFileSync(path.join(dir, 'salt-coast.json'), 'utf8'));
  const js = fs.readFileSync(path.join(dir, 'salt-coast.js'), 'utf8');
  const ctx = {};
  new Function('globalThis', js)(ctx);
  assert.deepEqual(ctx.TruthSeek.SAMPLE, json, 'run `npm run build:sample`');
});
