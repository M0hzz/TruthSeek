#!/usr/bin/env node
// Wraps samples/*.json as samples/*.js so the "Sample" button works when
// index.html is opened straight from disk (browsers block fetch() on file://).
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '..', 'samples');
const src = path.join(dir, 'salt-coast.json');
const data = JSON.parse(fs.readFileSync(src, 'utf8'));
const out = '// Generated from salt-coast.json by `npm run build:sample`. Do not edit by hand.\n' +
  'globalThis.TruthSeek = globalThis.TruthSeek || {};\n' +
  `globalThis.TruthSeek.SAMPLE = ${JSON.stringify(data)};\n`;
fs.writeFileSync(path.join(dir, 'salt-coast.js'), out);
console.log('wrote samples/salt-coast.js');
