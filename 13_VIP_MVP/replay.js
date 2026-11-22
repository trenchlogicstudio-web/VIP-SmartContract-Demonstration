#!/usr/bin/env node
// VIP SmartContract · MVP v0.2.18 · replay past sessions from the command line
// Copyright (c) 2026 Miloš Petrović (Trench Logic Studio) · SPDX-License-Identifier: MIT
//
//   node replay.js sessions.csv [--budget typical:2 | fixed:20000] [--eligibility permitted|suppressed]
//                               [--json report.json] [--stops stops.csv]
//
// Reads anonymised past sessions (guest, date, loss_eur; optional peak_loss_eur,
// budget_eur, eligibility), applies this engine's rules under the configuration
// of the environment (VIP_THRESHOLD, VIP_REWARD_CAP_EUR, VIP_FUTURE_PLAY, ...),
// and prints what the policy would have done. Nothing leaves this computer and
// no database is written.
'use strict';

const fs = require('node:fs');

const USAGE = 'usage: node replay.js sessions.csv [--budget typical:K|fixed:EUR] [--eligibility permitted|suppressed] [--json report.json] [--stops stops.csv]';
function fail(message) { console.error('VIP replay: ' + message); process.exit(1); }

const args = process.argv.slice(2);
const options = { budget: 'typical:2', eligibility: 'permitted', json: null, stops: null };
const files = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '-h' || a === '--help') { console.log(USAGE); process.exit(0); }
  if (a.startsWith('--')) {
    const key = a.slice(2);
    if (!(key in options)) fail(`unknown option ${a}. ${USAGE}`);
    const value = args[++i];
    if (value === undefined || value.startsWith('--')) fail(`${a} needs a value.`);
    options[key] = value;
  } else files.push(a);
}
if (files.length !== 1) fail(USAGE);

let replay;
try { replay = require('./src/replay'); } catch (e) { fail(e.message); }
try {
  const { sessions } = replay.readSessions(fs.readFileSync(files[0], 'utf8'));
  const report = replay.replay(sessions, { budget: options.budget, eligibility: options.eligibility });
  console.log(replay.summary(report));
  if (options.json) fs.writeFileSync(options.json, JSON.stringify(report, null, 2) + '\n');
  if (options.stops) fs.writeFileSync(options.stops, replay.stopsCsv(report));
} catch (e) {
  fail(e.code === 'ENOENT' ? `cannot read ${files[0]}.` : e.message);
}
