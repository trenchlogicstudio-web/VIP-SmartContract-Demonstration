// VIP SmartContract · MVP v0.2.11 · test suite
// AS-IS evaluation artifact — 09_AS_IS_Notice of the VIP SmartContract package governs.
//
// Run:  node test.js
//
// The suite is the checklist a buyer ports before porting the code. It is
// organised so that a passing happy path never stands alone: every control has
// a negative case that MUST fail, the audit chain is tampered with on purpose
// to prove it notices, and each configuration guard is probed in a child
// process to prove the build refuses to start rather than degrading.
//
// v0.2.11 adds the checks a mutation run showed were missing: for each one,
// breaking the line it guards used to leave the whole suite green. The money
// rule is recomputed here, independently and in whole percentages, for every
// cent from €0.01 to €2,000.00, and every stop, nudge and escalation line for
// every budget in the same range.
//
// The PARITY block runs only when the shipped reference
// (04b_Integration_Reference.js) sits beside this build, which is the case in
// the package registry. Standalone it prints SKIP with the reason — never a
// silent pass.
'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');
const net = require('net');
const { spawnSync, spawn } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vip-mvp-test-'));
process.env.VIP_DB = path.join(TMP, 'suite.db');
delete process.env.VIP_DOWNSTREAM_URL;
delete process.env.VIP_DOWNSTREAM_KEY;

const { open, DB_PATH } = require('./src/store');
const { seed } = require('./src/seed');
const { createServer, ADMIN_TOKEN } = require('./src/web');
const B = require('./src/boundary');
const P = require('./src/policy');
const E = require('./src/engine');
const VERSION = require('./package.json').version;

let pass = 0, failed = 0, skipped = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok    ' + name); }
  else { failed++; console.log('  FAIL  ' + name + (detail === undefined ? '' : '   ' + JSON.stringify(detail))); }
};
const skip = (name, why) => { skipped++; console.log('  skip  ' + name + '   (' + why + ')'); };
const head = t => console.log('\n' + t);

let base;
async function call(method, p, body, headers) {
  const r = await fetch(base + p, {
    method,
    headers: Object.assign({ 'content-type': 'application/json' }, headers || {}),
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
  });
  let j = null;
  try { j = await r.json(); } catch { j = null; }
  return { status: r.status, body: j };
}
const near = (a, b) => Math.abs(a - b) < 0.005;

// A child process that loads this build under its own configuration. The
// configuration is read once, at load, so a different one needs a new process.
function child(env, src) {
  const r = spawnSync(process.execPath, ['-e', src],
    { cwd: __dirname, env: Object.assign({}, process.env, env), encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { json = null; }
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', json };
}

// The whole server, started the way a buyer starts it, on a port of its own.
function freePort() {
  return new Promise(res => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
async function startServer(env) {
  const port = await freePort();
  const ch = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: Object.assign({}, process.env, { PORT: String(port), VIP_DB: path.join(TMP, 'srv-' + port + '.db') }, env)
  });
  let out = '', err = '';
  ch.stdout.on('data', d => { out += d; });
  ch.stderr.on('data', d => { err += d; });
  const t0 = Date.now();
  const up = await new Promise(res => {
    const poll = () => {
      if (ch.exitCode !== null) return res(false);
      if (/evaluation instance/.test(out)) return res(true);
      if (Date.now() - t0 > 8000) return res(false);
      setTimeout(poll, 25);
    };
    poll();
  });
  let q = null;
  if (up) { try { q = await (await fetch('http://127.0.0.1:' + port + '/vip/quarter')).json(); } catch { q = null; } }
  if (ch.exitCode === null) { ch.kill(); await new Promise(r => ch.on('exit', r)); }
  return { up, q, out, err };
}

(async () => {
  const db = open();
  const fresh = seed(db);
  const server = createServer(db);
  await new Promise(res => server.listen(0, res));
  base = 'http://127.0.0.1:' + server.address().port;

  console.log('\nVIP SmartContract · MVP v' + VERSION + ' · suite');
  console.log('  db ' + process.env.VIP_DB + (fresh ? ' (freshly seeded)' : ''));

  // ── 0 · the instance under test ─────────────────────────────────────────
  head('SEED · the evaluation instance starts from a known state');
  ok('SEED · a fresh database is seeded, and seed() says so', fresh === true, fresh);
  ok('SEED · a database that already holds guests is left alone, and seed() says so', seed(db) === false);
  ok('STORE · the database file is the one VIP_DB names', DB_PATH === process.env.VIP_DB, DB_PATH);

  // ── 1 · the specification surface ───────────────────────────────────────
  head('CONTRACT · the six routes of 04_API_Spec.yaml');

  let r = await call('POST', '/v3/precommit', { vip_id: 'T-HARD', budget_eur: 3000, mode: 'hard_stop' });
  ok('precommit returns 201', r.status === 201, r);
  ok('armed_at_eur is budget x the canon threshold', near(r.body.armed_at_eur, 1500), r.body);
  const hardSession = r.body.session_id;

  r = await call('GET', '/v3/policy/state?vip_id=T-HARD');
  ok('state returns 200 with nothing consumed', r.status === 200 && r.body.consumed_eur === 0, r.body);
  ok('distance to threshold equals the armed amount', near(r.body.distance_to_threshold_eur, 1500), r.body);
  ok('a live session is reported as not stopped', r.body.stopped === false, r.body.stopped);

  r = await call('POST', '/v3/session/tick', { vip_id: 'T-HARD', delta_eur: 600 });
  ok('a tick below the threshold returns 200 and does not stop', r.status === 200 && !r.body.locked, r.body);

  r = await call('POST', '/v3/session/tick', { vip_id: 'T-HARD', delta_eur: 500 });
  ok('still below the threshold at 1100 of 3000', r.status === 200 && !r.body.locked, r.body);

  r = await call('POST', '/v3/session/tick', { vip_id: 'T-HARD', delta_eur: 420 });
  ok('crossing the threshold returns 423 Locked', r.status === 423 && r.body.locked === true, r);
  const stop = r.body;
  ok('preserved is what was left of the budget', near(stop.preserved, 1480), stop);
  ok('rollover is the canon fraction of preserved', near(stop.rollover, 296), stop);
  ok('residual is returned to the guest, not captured', near(stop.residual_to_guest_eur, 148), stop);
  const creditSum = stop.credits.spa + stop.credits.fnb + stop.credits.retail;
  ok('credits split spa/fnb/retail per canon', near(stop.credits.spa, 444) && near(stop.credits.fnb, 370) && near(stop.credits.retail, 222), stop.credits);
  ok('THE MODEL CLOSES · redirect + rollover + residual = preserved',
     near(creditSum + stop.rollover + stop.residual_to_guest_eur, stop.preserved),
     { creditSum, rollover: stop.rollover, residual: stop.residual_to_guest_eur, preserved: stop.preserved });
  ok('the stop returns an audit fingerprint', typeof stop.fingerprint === 'string' && stop.fingerprint.length === 16, stop.fingerprint);

  r = await call('GET', '/v3/policy/state?vip_id=T-HARD');
  ok('after the stop the state reports the session stopped', r.status === 200 && r.body.stopped === true, r.body);

  r = await call('POST', '/v3/redirect/issue', { vip_id: 'T-HARD' });
  ok('redirect issue returns 200 with the same split', r.status === 200 && near(r.body.credits.spa, 444), r);
  ok('redirect issue says that it issued', r.body.issued === true, r.body);

  r = await call('GET', '/v3/audit/' + hardSession);
  ok('audit returns the session chain in order', r.status === 200 && r.body.events.length >= 3, r.body && r.body.events && r.body.events.length);
  ok('audit events are precommit, policy.stop, redirect.issue',
     r.body.events.map(e => e.type).join(',') === 'precommit,policy.stop,redirect.issue',
     r.body.events.map(e => e.type));

  r = await call('POST', '/v3/precommit', { vip_id: 'T-DEFMODE', budget_eur: 100 });
  ok('a precommit without a mode runs the configured default and says which',
     r.status === 201 && r.body.mode === P.CFG.mode && P.CFG.mode === 'hard_stop', r);

  // ── 2 · every control has a negative case ───────────────────────────────
  head('NEGATIVE · each canon error identifier, provoked on purpose');

  r = await call('POST', '/v3/precommit', { budget_eur: 100, mode: 'hard_stop' });
  ok('INVALID_VIP on a missing vip_id', r.status === 400 && r.body.error === 'INVALID_VIP', r);

  r = await call('POST', '/v3/precommit', { vip_id: 123, budget_eur: 100, mode: 'hard_stop' });
  ok('INVALID_VIP on a vip_id that is not a string', r.status === 400 && r.body.error === 'INVALID_VIP', r);

  r = await call('POST', '/v3/precommit', { vip_id: 'T-BAD', budget_eur: 0, mode: 'hard_stop' });
  ok('INVALID_BUDGET on a zero budget', r.status === 400 && r.body.error === 'INVALID_BUDGET', r);

  r = await call('POST', '/v3/precommit', { vip_id: 'T-BAD', budget_eur: 'abc', mode: 'hard_stop' });
  ok('INVALID_BUDGET on a non-numeric budget', r.status === 400 && r.body.error === 'INVALID_BUDGET', r);

  // One cent to MAX_EUR, both ends included, and nothing a JSON number can
  // overflow to.
  for (const [b, want] of [[0.009, 400], [0.01, 201], [P.MAX_EUR, 201], [P.MAX_EUR + 0.01, 400]]) {
    r = await call('POST', '/v3/precommit', { vip_id: 'T-BOUND', budget_eur: b, mode: 'hard_stop' });
    ok(`BOUNDS · a budget of ${b} is ${want === 201 ? 'accepted' : 'refused with INVALID_BUDGET'}`,
       r.status === want && (want === 201 || r.body.error === 'INVALID_BUDGET'), r);
    if (b === 0.01) ok('BOUNDS · a one-cent budget is armed at one cent', r.body.armed_at_eur === 0.01, r.body);
  }
  r = await call('POST', '/v3/precommit', '{"vip_id":"T-BOUND","budget_eur":1e400,"mode":"hard_stop"}');
  ok('BOUNDS · a budget that overflows to Infinity is refused', r.status === 400 && r.body.error === 'INVALID_BUDGET', r);

  r = await call('POST', '/v3/precommit', { vip_id: 'T-BAD', budget_eur: 100, mode: 'whatever' });
  ok('INVALID_MODE on an unknown mode', r.status === 400 && r.body.error === 'INVALID_MODE', r);

  // Ordered deliberately: a fresh live session, so INVALID_DELTA is what the
  // engine is being asked about and not ALREADY_STOPPED from an earlier test.
  await call('POST', '/v3/precommit', { vip_id: 'T-DELTA', budget_eur: 1000, mode: 'hard_stop' });
  for (const bad of [{ delta_eur: 'abc' }, { delta_eur: null }, {}]) {
    r = await call('POST', '/v3/session/tick', Object.assign({ vip_id: 'T-DELTA' }, bad));
    ok('INVALID_DELTA on ' + JSON.stringify(bad), r.status === 400 && r.body.error === 'INVALID_DELTA', r);
  }
  r = await call('POST', '/v3/session/tick', { vip_id: 'T-DELTA', delta_eur: 0 });
  ok('BOUNDS · a zero tick is accepted and moves nothing', r.status === 200 && r.body.state.consumed_eur === 0, r);
  r = await call('POST', '/v3/session/tick', { vip_id: 'T-DELTA', delta_eur: P.MAX_EUR + 0.01 });
  ok('BOUNDS · a tick above MAX_EUR is refused with INVALID_DELTA', r.status === 400 && r.body.error === 'INVALID_DELTA', r);
  await call('POST', '/v3/precommit', { vip_id: 'T-MAXD', budget_eur: P.MAX_EUR, mode: 'hard_stop' });
  r = await call('POST', '/v3/session/tick', { vip_id: 'T-MAXD', delta_eur: P.MAX_EUR });
  ok('BOUNDS · a tick of exactly MAX_EUR is accepted, and on a budget of MAX_EUR it stops with nothing preserved',
     r.status === 423 && r.body.locked === true && r.body.preserved === 0, r);

  r = await call('POST', '/v3/session/tick', { vip_id: 'T-HARD', delta_eur: 10 });
  ok('ALREADY_STOPPED on a tick after the stop', r.status === 409 && r.body.error === 'ALREADY_STOPPED', r);

  r = await call('POST', '/v3/session/tick', { vip_id: 'NOBODY', delta_eur: 10 });
  ok('NO_LIVE_SESSION on a tick for an unknown VIP', r.status === 409 && r.body.error === 'NO_LIVE_SESSION', r);

  // A vip_id that is not a string names no session. Handed to SQLite as a
  // bind value some of these were a driver error, and a 500.
  for (const v of [true, 5, {}, [], null]) {
    r = await call('POST', '/v3/session/tick', { vip_id: v, delta_eur: 10 });
    ok('NO_LIVE_SESSION on a tick whose vip_id is ' + JSON.stringify(v), r.status === 409 && r.body.error === 'NO_LIVE_SESSION', r);
  }

  r = await call('GET', '/v3/policy/state?vip_id=NOBODY');
  ok('NO_LIVE_SESSION on state for an unknown VIP', r.status === 409 && r.body.error === 'NO_LIVE_SESSION', r);
  r = await call('GET', '/v3/policy/state');
  ok('NO_LIVE_SESSION on state with no vip_id at all', r.status === 409 && r.body.error === 'NO_LIVE_SESSION', r);

  r = await call('POST', '/v3/redirect/issue', { vip_id: 'T-DELTA' });
  ok('NOT_STOPPED when redirect is asked for before the stop', r.status === 409 && r.body.error === 'NOT_STOPPED', r);

  r = await call('POST', '/v3/redirect/issue', { vip_id: 'T-HARD' });
  ok('ALREADY_ISSUED on a second redirect for one session', r.status === 409 && r.body.error === 'ALREADY_ISSUED', r);

  r = await call('POST', '/v3/redirect/issue', { vip_id: 'NOBODY' });
  ok('NO_LIVE_SESSION on a redirect for an unknown VIP', r.status === 409 && r.body.error === 'NO_LIVE_SESSION', r);
  r = await call('POST', '/v3/redirect/issue', { vip_id: true });
  ok('NO_LIVE_SESSION on a redirect whose vip_id is not a string', r.status === 409 && r.body.error === 'NO_LIVE_SESSION', r);

  r = await call('GET', '/v3/audit/not-a-session');
  ok('SESSION_UNKNOWN on an audit for an unknown session', r.status === 404 && r.body.error === 'SESSION_UNKNOWN', r);
  r = await call('GET', '/v3/audit/%E0%A4%A');
  ok('BAD_REQUEST on an audit path that is not valid percent-encoding', r.status === 400 && r.body.error === 'BAD_REQUEST', r);

  r = await call('GET', '/v3/nothing/here');
  ok('NO_ROUTE names the six specification routes', r.status === 404 && r.body.error === 'NO_ROUTE' && r.body.routes.length === 6, r);

  r = await call('POST', '/v3/precommit', '{not json');
  ok('BAD_JSON on an unparseable body', r.status === 400 && r.body.error === 'BAD_JSON', r);
  // A body that parses but is not an object failed on destructuring inside the
  // route and came back as a 500 carrying the runtime's message.
  for (const raw of ['null', '5', '"text"', '[]', '[1,2]', 'true']) {
    r = await call('POST', '/v3/precommit', raw);
    ok('BAD_JSON on a body that parses to ' + raw, r.status === 400 && r.body.error === 'BAD_JSON', r);
  }

  // The body limit is one million bytes: that many is read, one more is not.
  {
    const o = { vip_id: 'NOBODY-BIG', delta_eur: 1, pad: '' };
    o.pad = 'x'.repeat(1e6 - JSON.stringify(o).length);
    const big = JSON.stringify(o);
    let answered = null;
    try { answered = await call('POST', '/v3/session/tick', big); } catch { answered = null; }
    ok('BODY · exactly 1,000,000 bytes is read and answered',
       big.length === 1e6 && answered !== null && answered.status === 409 && answered.body.error === 'NO_LIVE_SESSION',
       answered && answered.status);
    let cut = false;
    try { await call('POST', '/v3/session/tick', big + ' '); } catch { cut = true; }
    ok('BODY · one byte more is cut off before it is parsed', cut === true);
  }

  // ── 3 · advisory mode ───────────────────────────────────────────────────
  head('ADVISORY · the same engine, a different action');

  const advSid = (await call('POST', '/v3/precommit', { vip_id: 'T-ADV', budget_eur: 1000, mode: 'advisory' })).body.session_id;
  const advTypes = () => db.prepare('SELECT type, payload FROM events ORDER BY seq ASC').all()
    .filter(e => JSON.parse(e.payload).session_id === advSid).map(e => e.type).join(',');
  r = await call('POST', '/v3/session/tick', { vip_id: 'T-ADV', delta_eur: 410 });
  ok('the nudge activates at the canon nudge fraction', r.status === 200 && r.body.state.nudge_active === true, r.body);
  ok('the nudge carries the live incentive preview', r.body.state.incentive_preview.redirect_eur > 0, r.body.state.incentive_preview);
  ok('the nudge is written to the chain once, and the escalation is not written early',
     advTypes() === 'precommit,advisory.nudge', advTypes());

  r = await call('POST', '/v3/session/tick', { vip_id: 'T-ADV', delta_eur: 200 });
  ok('advisory does NOT lock at the threshold', r.status === 200 && !r.body.locked, r);
  ok('advisory returns the host escalation advice at the threshold', typeof r.body.advisory === 'string', r.body);
  ok('a second tick past the nudge line does not nudge again', advTypes() === 'precommit,advisory.nudge', advTypes());

  r = await call('POST', '/v3/session/tick', { vip_id: 'T-ADV', delta_eur: 250 });
  ok('escalation activates at the canon escalate fraction', r.body.state.escalate_active === true, r.body.state);

  // One tick can cross BOTH advisory lines. The canon says each event fires
  // when its line is crossed, so a jump must not swallow the nudge.
  await call('POST', '/v3/precommit', { vip_id: 'T-JUMP', budget_eur: 1000, mode: 'advisory' });
  await call('POST', '/v3/session/tick', { vip_id: 'T-JUMP', delta_eur: 900 });
  {
    const seen = db.prepare("SELECT type FROM events WHERE payload LIKE '%T-JUMP%' ORDER BY seq ASC").all().map(e => e.type);
    ok('a jump across both advisory lines emits the nudge AND the escalation, in order',
       seen.join(',') === 'precommit,advisory.nudge,advisory.escalate', seen);
  }

  const advPreview = (await call('GET', '/v3/policy/state?vip_id=T-ADV')).body.incentive_preview;
  r = await call('POST', '/vip/session/stop', { vip_id: 'T-ADV' });
  ok('a voluntary stop settles identically to an enforced one',
     r.status === 200 && near(r.body.rollover, advPreview.rollover_eur) &&
     near(r.body.residual_to_guest_eur, advPreview.residual_to_guest_eur), { got: r.body, preview: advPreview });
  ok('the voluntary stop says it stopped, and why', r.body.stopped === true && r.body.trigger === 'voluntary', r.body);
  ok('the session chain reads precommit, one nudge, one escalation, the stop',
     advTypes() === 'precommit,advisory.nudge,advisory.escalate,policy.stop', advTypes());
  r = await call('POST', '/vip/session/stop', { vip_id: 'T-ADV' });
  ok('ALREADY_STOPPED on a second voluntary stop', r.status === 409 && r.body.error === 'ALREADY_STOPPED', r);
  r = await call('POST', '/vip/session/stop', { vip_id: 'NOBODY' });
  ok('NO_LIVE_SESSION on a voluntary stop for an unknown VIP', r.status === 409 && r.body.error === 'NO_LIVE_SESSION', r);
  r = await call('POST', '/vip/session/stop', {});
  ok('NO_LIVE_SESSION on a voluntary stop that names nobody', r.status === 409 && r.body.error === 'NO_LIVE_SESSION', r);

  // ── 3b · each line fires on its own cent ────────────────────────────────
  head('LINES · each line fires on its own cent, not one cent later');

  await call('POST', '/v3/precommit', { vip_id: 'T-LINES', budget_eur: 1000, mode: 'advisory' });
  r = await call('POST', '/v3/session/tick', { vip_id: 'T-LINES', delta_eur: 399.99 });
  ok('LINES · one cent below the nudge line: no nudge', r.status === 200 && r.body.state.nudge_active === false, r.body);
  r = await call('POST', '/v3/session/tick', { vip_id: 'T-LINES', delta_eur: 0.01 });
  ok('LINES · on the nudge line: nudge, no escalation', r.body.state.nudge_active === true && r.body.state.escalate_active === false, r.body);
  r = await call('POST', '/v3/session/tick', { vip_id: 'T-LINES', delta_eur: 99.99 });
  ok('LINES · one cent below the stop line in advisory: no advice yet', r.status === 200 && r.body.advisory === undefined, r.body);
  r = await call('POST', '/v3/session/tick', { vip_id: 'T-LINES', delta_eur: 0.01 });
  ok('LINES · on the stop line in advisory: advice, and still no lock',
     r.status === 200 && typeof r.body.advisory === 'string' && !r.body.locked, r.body);
  r = await call('POST', '/v3/session/tick', { vip_id: 'T-LINES', delta_eur: 349.99 });
  ok('LINES · one cent below the escalation line: no escalation', r.body.state.escalate_active === false, r.body.state);
  r = await call('POST', '/v3/session/tick', { vip_id: 'T-LINES', delta_eur: 0.01 });
  ok('LINES · on the escalation line: escalation', r.body.state.escalate_active === true, r.body.state);

  await call('POST', '/v3/precommit', { vip_id: 'T-HLINE', budget_eur: 1000, mode: 'hard_stop' });
  r = await call('POST', '/v3/session/tick', { vip_id: 'T-HLINE', delta_eur: 450 });
  ok('LINES · hard_stop never nudges, even past the nudge line', r.status === 200 && r.body.state.nudge_active === false, r.body);
  r = await call('POST', '/v3/session/tick', { vip_id: 'T-HLINE', delta_eur: 49.99 });
  ok('LINES · hard_stop one cent below the stop line: no lock', r.status === 200 && !r.body.locked, r.body);
  r = await call('POST', '/v3/session/tick', { vip_id: 'T-HLINE', delta_eur: 0.01 });
  ok('LINES · hard_stop on the stop line: locked, with exactly half preserved',
     r.status === 423 && r.body.locked === true && r.body.preserved === 500, r);

  await call('POST', '/v3/precommit', { vip_id: 'T-HJUMP', budget_eur: 1000, mode: 'hard_stop' });
  await call('POST', '/v3/session/tick', { vip_id: 'T-HJUMP', delta_eur: 900 });
  r = await call('GET', '/v3/policy/state?vip_id=T-HJUMP');
  ok('LINES · a hard_stop session past every line reports neither advisory signal',
     r.body.stopped === true && r.body.nudge_active === false && r.body.escalate_active === false, r.body);

  // An odd-cent budget: half of 1000.03 is 500.015, and the line is the first
  // whole cent at or above it. The number published is the number enforced.
  r = await call('POST', '/v3/precommit', { vip_id: 'T-ODD', budget_eur: 1000.03, mode: 'hard_stop' });
  ok('LINES · 1000.03 is armed at 500.02, the first cent at or above half', r.body.armed_at_eur === 500.02, r.body);
  r = await call('POST', '/v3/session/tick', { vip_id: 'T-ODD', delta_eur: 500.01 });
  ok('LINES · one cent below the published line does not stop, and says one cent is left',
     r.status === 200 && r.body.state.distance_to_threshold_eur === 0.01, r.body);
  r = await call('POST', '/v3/session/tick', { vip_id: 'T-ODD', delta_eur: 0.01 });
  ok('LINES · the published line itself stops', r.status === 423 && r.body.preserved === 500.01, r);

  await call('POST', '/v3/precommit', { vip_id: 'T-CENT', budget_eur: 100, mode: 'hard_stop' });
  r = await call('POST', '/v3/session/tick', { vip_id: 'T-CENT', delta_eur: 0.29 });
  ok('LINES · consumption is reported to the cent it was ticked (0.29, not 0.28)', r.body.state.consumed_eur === 0.29, r.body.state);
  await call('POST', '/v3/precommit', { vip_id: 'T-FRAC', budget_eur: 3000, mode: 'hard_stop' });
  r = await call('POST', '/v3/session/tick', { vip_id: 'T-FRAC', delta_eur: 2 });
  ok('LINES · the consumed fraction is rounded to three places, not cut (2 of 3000 is 0.001)',
     r.body.state.consumed_fraction === 0.001, r.body.state);

  // ── 4 · the product surface ─────────────────────────────────────────────
  head('PRODUCT · the money chain, end to end');

  const q = (await call('GET', '/vip/quarter')).body;
  ok('the seeded quarter holds 60 stopped sessions', q.stopped_sessions_in_quarter === 60, q.stopped_sessions_in_quarter);
  ok('preserved reproduces the canon quarter figure', near(q.preserved_eur, 306000), q.preserved_eur);
  ok('redirected reproduces the canon quarter figure', near(q.redirected_eur, 214200), q.redirected_eur);
  ok('rollover liability reproduces the canon quarter figure', near(q.rollover_liability_eur, 61200), q.rollover_liability_eur);
  ok('residual returned to guests closes the quarter',
     near(q.redirected_eur + q.rollover_liability_eur + q.residual_to_guests_eur, q.preserved_eur),
     { r: q.redirected_eur, ro: q.rollover_liability_eur, res: q.residual_to_guests_eur, p: q.preserved_eur });
  ok('non-gaming capture equals the canon fraction', near(q.non_gaming_capture, 0.70), q.non_gaming_capture);
  ok('non-gaming capture is exactly 0.7 to three places', q.non_gaming_capture === 0.7, q.non_gaming_capture);
  ok('the capture figure ships with its denominator', typeof q._non_gaming_capture_denominator === 'string');

  const cr = (await call('GET', '/vip/credits?vip_id=VIP-0001')).body;
  ok('a seeded VIP holds three issued credits', cr.credits.length === 3, cr.credits.length);
  const cid = cr.credits[0].id;
  ok('the first credit ever issued carries identifier 1', cid === 1, cid);
  r = await call('POST', '/vip/credit/redeem', { credit_id: cid });
  ok('redeeming a credit returns 200', r.status === 200 && r.body.redeemed === true, r);
  r = await call('POST', '/vip/credit/redeem', { credit_id: cid });
  ok('CREDIT_REDEEMED on redeeming the same credit twice', r.status === 409 && r.body.error === 'CREDIT_REDEEMED', r);
  const q2 = (await call('GET', '/vip/quarter')).body;
  ok('redemption moves the redeemed total, not the issued total',
     q2.credits_redeemed.count === 1 && q2.credits_issued.count === q.credits_issued.count,
     { redeemed: q2.credits_redeemed, issued: q2.credits_issued });
  // A credit is named by the positive integer it was issued under. Nothing
  // else names one: not a numeric string, and not `true`, which coerced to 1.
  for (const bad of [999999, 0, -1, 1.5, '2', true, null]) {
    r = await call('POST', '/vip/credit/redeem', { credit_id: bad });
    ok('CREDIT_UNKNOWN on a credit_id of ' + JSON.stringify(bad), r.status === 404 && r.body.error === 'CREDIT_UNKNOWN', r);
  }
  r = await call('POST', '/vip/credit/redeem', {});
  ok('CREDIT_UNKNOWN when no credit_id is sent', r.status === 404 && r.body.error === 'CREDIT_UNKNOWN', r);
  ok('none of those refusals redeemed anything', (await call('GET', '/vip/quarter')).body.credits_redeemed.count === 1);

  r = await call('POST', '/vip/rollover/apply', { vip_id: 'VIP-0001' });
  ok('rollover applies once', r.status === 200 && r.body.applied === true && near(r.body.amount_eur, 1020), r);
  r = await call('POST', '/vip/rollover/apply', { vip_id: 'VIP-0001' });
  ok('NO_ROLLOVER once it has been applied', r.status === 404 && r.body.error === 'NO_ROLLOVER', r);
  for (const bad of [{}, { vip_id: true }, { vip_id: 5 }, { vip_id: 'NOBODY' }]) {
    r = await call('POST', '/vip/rollover/apply', bad);
    ok('NO_ROLLOVER on ' + JSON.stringify(bad), r.status === 404 && r.body.error === 'NO_ROLLOVER', r);
  }

  r = await call('POST', '/vip/guest/erase', { vip_id: 'VIP-0002' });
  ok('UNAUTHORIZED without the admin token', r.status === 401 && r.body.error === 'UNAUTHORIZED', r);

  // The roll-up on a database built for the purpose: nothing stopped, then one
  // session whose capture is two thirds.
  {
    const dq = open(':memory:');
    const q0 = E.quarter(dq);
    ok('QUARTER · an instance with nothing stopped reports zero capture, not NaN',
       q0.stopped_sessions_in_quarter === 0 && q0.non_gaming_capture === 0, q0);
    dq.exec("INSERT INTO guests(id, tier, created_at) VALUES('Q', 'unclassified', 'x')");
    dq.exec("INSERT INTO sessions(id, guest_id, mode, state, budget_eur, armed_at_eur, consumed_eur, opened_at, " +
            "preserved_eur, redirect_eur, rollover_eur, residual_eur, quarter) " +
            "VALUES('q1', 'Q', 'hard_stop', 'stopped', 6, 3, 3, 'x', 3, 2, 0.6, 0.4, 1)");
    ok('QUARTER · capture is rounded to three places, not cut (2 of 3 is 0.667)',
       E.quarter(dq).non_gaming_capture === 0.667, E.quarter(dq).non_gaming_capture);
    dq.close();
  }

  // ── 5 · the boundary ────────────────────────────────────────────────────
  head('BOUNDARY · chain, erasure, downstream posture');

  let v = (await call('GET', '/vip/chain/verify')).body;
  ok('the chain verifies from genesis to head', v.valid === true && v.length > 180, v);

  for (const bad of [{ vip_id: 'NOBODY' }, {}, { vip_id: true }, { vip_id: 5 }]) {
    r = await call('POST', '/vip/guest/erase', bad, { 'x-admin-token': ADMIN_TOKEN });
    ok('GUEST_UNKNOWN on erasing ' + JSON.stringify(bad), r.status === 404 && r.body.error === 'GUEST_UNKNOWN', r);
  }

  r = await call('POST', '/vip/guest/erase', { vip_id: 'VIP-0002' }, { 'x-admin-token': ADMIN_TOKEN });
  ok('erasure returns 200 with the admin token', r.status === 200 && r.body.erased === true, r);
  const erased = db.prepare('SELECT display_name, erased_at FROM guests WHERE id = ?').get('VIP-0002');
  ok('erasure nulls the one column that names a person', erased.display_name === null && !!erased.erased_at, erased);
  // Erased means gone from the files on disk, not only from the API: the
  // database file and its write-ahead log are read as bytes. The first check
  // proves the reader can see a name that is still there.
  {
    const files = ['', '-wal'].map(s => process.env.VIP_DB + s).filter(f => fs.existsSync(f));
    const bytes = files.map(f => fs.readFileSync(f));
    const has = name => bytes.some(b => b.includes(Buffer.from(name, 'utf8')));
    ok('DISK · the byte check sees a name that was not erased (Synthetic Guest 003)', has('Synthetic Guest 003'), files);
    ok('DISK · the erased name is in neither the database file nor its log', !has('Synthetic Guest 002'), files);
  }
  v = (await call('GET', '/vip/chain/verify')).body;
  ok('the chain is STILL valid after erasure', v.valid === true, v);
  const leak = db.prepare("SELECT COUNT(*) n FROM events WHERE payload LIKE '%Synthetic Guest%'").get().n;
  ok('no display name ever entered the chain', leak === 0, leak);

  r = await call('POST', '/vip/guest/erase', { vip_id: 'VIP-0002' }, { 'x-admin-token': ADMIN_TOKEN });
  ok('ALREADY_ERASED on a second erasure', r.body.error === 'ALREADY_ERASED', r);

  const cfg = (await call('GET', '/vip/config')).body;
  ok('the downstream is DORMANT unless both variables are set', cfg.downstream === 'DORMANT', cfg.downstream);

  // Tamper calibration on a separate database: the chain must not merely be
  // present, it must NOTICE. Without this, "hash-chained" is decoration.
  {
    const tamperPath = path.join(TMP, 'tamper.db');
    const t = open(tamperPath);
    B.append(t, 'precommit', { vip_id: 'X', session_id: 'S', budget_eur: 100 });
    B.append(t, 'policy.stop', { vip_id: 'X', session_id: 'S', preserved_eur: 50 });
    B.append(t, 'redirect.issue', { vip_id: 'X', session_id: 'S', rollover_eur: 10 });
    ok('a fresh chain of three verifies', B.verify(t).valid === true);
    t.prepare("UPDATE events SET payload = ? WHERE seq = 2").run(JSON.stringify({ vip_id: 'X', session_id: 'S', preserved_eur: 5000 }));
    const broken = B.verify(t);
    ok('TAMPER · altering row 2 breaks the chain at row 2',
       broken.valid === false && broken.broken_at_seq === 2 && broken.reason === 'HASH_MISMATCH', broken);
    t.close();

    const t2 = open(path.join(TMP, 'tamper2.db'));
    B.append(t2, 'precommit', { vip_id: 'X', session_id: 'S', budget_eur: 100 });
    B.append(t2, 'policy.stop', { vip_id: 'X', session_id: 'S', preserved_eur: 50 });
    t2.prepare('UPDATE events SET prev_hash = ? WHERE seq = 2').run('0'.repeat(64));
    const relinked = B.verify(t2);
    ok('TAMPER · re-linking row 2 to another predecessor breaks the chain at row 2',
       relinked.valid === false && relinked.broken_at_seq === 2 && relinked.reason === 'PREV_MISMATCH', relinked);
    t2.close();

    const t0 = open(path.join(TMP, 'empty.db'));
    const empty = B.verify(t0);
    ok('an EMPTY chain is a valid chain of length 0, not a crash',
       empty.valid === true && empty.length === 0 && empty.head === 'GENESIS', empty);
    t0.close();
  }
  {
    const c = B.canonical({ b: 1, a: [2, { d: null, c: 'x' }], e: 's' });
    ok('CANONICAL · keys sorted at every depth, arrays in order, null, numbers and strings as JSON',
       c === '{"a":[2,{"c":"x","d":null}],"b":1,"e":"s"}', c);
  }

  // Path 2: armed only with BOTH variables, and when armed it sends the stop
  // and the issue — named with this build's version — and nothing else.
  {
    const armedWith = env => child(env, "process.stdout.write(JSON.stringify(require('./src/boundary').downstream.armed()))").json;
    ok('DOWNSTREAM · a URL without a key stays dormant', armedWith({ VIP_DOWNSTREAM_URL: 'http://127.0.0.1:9/x' }) === false);
    ok('DOWNSTREAM · a key without a URL stays dormant', armedWith({ VIP_DOWNSTREAM_KEY: 'k' }) === false);
    ok('DOWNSTREAM · both together arm it',
       armedWith({ VIP_DOWNSTREAM_URL: 'http://127.0.0.1:9/x', VIP_DOWNSTREAM_KEY: 'k' }) === true);
    const got = child({}, [
      "const http=require('http');const got=[];",
      "const sink=http.createServer((q,s)=>{let b='';q.on('data',c=>{b+=c});",
      "q.on('end',()=>{got.push({auth:q.headers.authorization,body:JSON.parse(b)});s.end('{}')})});",
      "sink.listen(0,'127.0.0.1',()=>{",
      "process.env.VIP_DOWNSTREAM_URL='http://127.0.0.1:'+sink.address().port+'/ingest';",
      "process.env.VIP_DOWNSTREAM_KEY='k-suite';",
      "const S=require('./src/store');const db=S.open(':memory:');const E=require('./src/engine');",
      "E.precommit(db,{vip_id:'DS',budget_eur:1000,mode:'hard_stop'});",
      "E.tick(db,{vip_id:'DS',delta_eur:600});E.redirectIssue(db,{vip_id:'DS'});",
      "const t0=Date.now();const done=()=>{process.stdout.write(JSON.stringify(got));process.exit(0)};",
      "const wait=()=>got.length>=2?setTimeout(done,150):(Date.now()-t0>4000?done():setTimeout(wait,20));wait()});"
    ].join('')).json || [];
    const types = got.map(g => g.body && g.body.event && g.body.event.type).sort();
    ok('DOWNSTREAM · armed, it sends the stop and the issue and nothing else',
       JSON.stringify(types) === '["policy.stop","redirect.issue"]', types);
    ok('DOWNSTREAM · every dispatch names this build as its source (vip-mvp/' + VERSION + ')',
       got.length > 0 && got.every(g => g.body.source === 'vip-mvp/' + VERSION), got.map(g => g.body && g.body.source));
    ok('DOWNSTREAM · and carries the bearer credential', got.length > 0 && got.every(g => g.auth === 'Bearer k-suite'),
       got.map(g => g.auth));
  }

  // ── 6 · configuration refuses to degrade ────────────────────────────────
  head('CONFIG · a bad threshold stops the process, it does not soften the gate');

  const probe = (env, label) => {
    const res = spawnSync(process.execPath, ['-e', "require('./src/policy')"], {
      cwd: __dirname, env: Object.assign({}, process.env, env), encoding: 'utf8'
    });
    ok(label + ' refuses to start', res.status !== 0 && /Refusing to start/.test(res.stderr || ''), (res.stderr || '').split('\n')[4]);
  };
  probe({ VIP_MODE: 'xyz' }, 'VIP_MODE=xyz');
  probe({ VIP_THRESHOLD: 'abc' }, 'VIP_THRESHOLD=abc');
  probe({ VIP_THRESHOLD: '-1' }, 'VIP_THRESHOLD=-1');
  probe({ VIP_THRESHOLD: 'NaN' }, 'VIP_THRESHOLD=NaN');
  probe({ VIP_ROLLOVER: '5' }, 'VIP_ROLLOVER=5');
  probe({ VIP_ROLLOVER: '0.9' }, 'VIP_ROLLOVER=0.9 (rollover + redirect exceeds preserved)');
  probe({ VIP_SPLIT_SPA: 'abc' }, 'VIP_SPLIT_SPA=abc');
  probe({ VIP_SPLIT_FNB: '-0.1' }, 'VIP_SPLIT_FNB=-0.1');
  probe({ VIP_SPLIT_RETAIL: '0.9' }, 'VIP_SPLIT_RETAIL=0.9 (split + rollover exceeds preserved)');
  {
    const res = spawnSync(process.execPath, ['-e', "require('./src/policy').num('PORT',3400,1,65535)"], {
      cwd: __dirname, env: Object.assign({}, process.env, { PORT: 'abc' }), encoding: 'utf8'
    });
    ok('PORT=abc refuses to start', res.status !== 0 && /Refusing to start/.test(res.stderr || ''));
  }

  // The split is a per-jurisdiction configurable, and the canon says so. If it
  // could only be read from a literal, that sentence would be a promise with no
  // lever behind it.
  {
    const res = spawnSync(process.execPath, ['-e',
      "const P=require('./src/policy');process.stdout.write(JSON.stringify(P.CFG.split)+'|'+P.REDIRECT_TOTAL.toFixed(2))"],
      { cwd: __dirname, env: Object.assign({}, process.env,
        { VIP_SPLIT_SPA: '0.20', VIP_SPLIT_FNB: '0.20', VIP_SPLIT_RETAIL: '0.10' }), encoding: 'utf8' });
    const [split, total] = (res.stdout || '|').split('|');
    ok('CONFIGURABLE · each redirect share is read from its own variable',
       split === '{"spa":0.2,"fnb":0.2,"retail":0.1}' && total === '0.50', res.stdout);
  }

  // Refusing is half of it. Every value on the edge of what the validation
  // accepts must be accepted, and read exactly: a fraction becomes an integer
  // number of millionths, rounded to the nearest, never cut.
  for (const [env, label, check] of [
    [{ VIP_THRESHOLD: '0.05' }, 'VIP_THRESHOLD=0.05, its lower bound', w => w.threshold === 50000],
    [{ VIP_THRESHOLD: '0.95' }, 'VIP_THRESHOLD=0.95, its upper bound', w => w.threshold === 950000],
    [{ VIP_ESCALATE: '0.99' }, 'VIP_ESCALATE=0.99, its upper bound', w => w.escalate === 990000],
    [{ VIP_ROLLOVER: '0' }, 'VIP_ROLLOVER=0, its lower bound', w => w.rollover === 0 && w.residual === 300000],
    [{ VIP_ROLLOVER: '0.3' }, 'VIP_ROLLOVER=0.3, so the legs sum to exactly 1', w => w.residual === 0],
    [{ VIP_SPLIT_SPA: '0.07', VIP_SPLIT_FNB: '0.56', VIP_SPLIT_RETAIL: '0.17' },
     'spa 0.07 + F&B 0.56 + retail 0.17 + rollover 0.20, exactly 1, which floating point adds to 1.0000000000000002',
     w => w.redirect === 800000 && w.residual === 0],
    [{ VIP_SPLIT_SPA: '0.17142857142857143' }, 'a share of 0.17142857142857143, read as 171429 millionths',
     w => w.spa === 171429]
  ]) {
    const c = child(env, "process.stdout.write(JSON.stringify(require('./src/policy').W))");
    ok('CONFIG · ' + label + ' is accepted', c.status === 0 && !!c.json && check(c.json), c.json || c.stderr.split('\n')[4]);
  }

  // A share configured to zero issues nothing: no zero-euro instrument exists
  // to be redeemed for nothing later.
  {
    const ISSUE = "const S=require('./src/store');const db=S.open(':memory:');const E=require('./src/engine');" +
      "E.precommit(db,{vip_id:'Z',budget_eur:3000,mode:'hard_stop'});const t=E.tick(db,{vip_id:'Z',delta_eur:1600});" +
      "const i=E.redirectIssue(db,{vip_id:'Z'});const n=s=>db.prepare(s).get().n;" +
      "process.stdout.write(JSON.stringify({t,i,credits:n('SELECT COUNT(*) n FROM credits'),rollover:n('SELECT COUNT(*) n FROM rollover')}))";
    let z = child({ VIP_SPLIT_SPA: '0', VIP_SPLIT_FNB: '0', VIP_SPLIT_RETAIL: '0' }, ISSUE).json;
    ok('ZERO SPLIT · the stop settles and closes: nothing redirected, rollover and residual take it all',
       !!z && z.t.credits.spa === 0 && z.t.credits.fnb === 0 && z.t.credits.retail === 0 &&
       z.t.rollover === 280 && z.t.residual_to_guest_eur === 1120 && z.t.preserved === 1400, z && z.t);
    ok('ZERO SPLIT · no zero-euro credit is written; the rollover is',
       !!z && z.i.issued === true && z.credits === 0 && z.rollover === 1, z && { credits: z.credits, rollover: z.rollover });
    z = child({ VIP_ROLLOVER: '0' }, ISSUE).json;
    ok('ZERO ROLLOVER · no zero-euro rollover is written; the three credits are',
       !!z && z.i.rollover === 0 && z.rollover === 0 && z.credits === 3, z && { credits: z.credits, rollover: z.rollover });
  }

  // ── 6b · the RG eligibility gate and the reward cap ─────────────────────
  head('GATE · the incentive may be withheld without withdrawing the protection');

  // The reference configuration: no gate, no cap, and every canon figure
  // holds. This check exists so a later change to the gate cannot quietly
  // move the numbers the whole package is built on.
  await call('POST', '/v3/precommit', { vip_id: 'T-G0', budget_eur: 3000, mode: 'hard_stop' });
  r = await call('POST', '/v3/session/tick', { vip_id: 'T-G0', delta_eur: 1600 });
  ok('REFERENCE · eligibility defaults to permitted', r.body.eligibility === 'permitted', r.body);
  ok('REFERENCE · the canon settlement is unchanged by the gate',
     near(r.body.preserved, 1400) && near(r.body.credits.spa, 420) &&
     near(r.body.rollover, 280) && near(r.body.residual_to_guest_eur, 140), r.body);

  r = await call('POST', '/v3/precommit', { vip_id: 'T-G0b', budget_eur: 100, mode: 'hard_stop' });
  ok('GATE · a pre-commit that sends no determination date is recorded without one (null), not dated now',
     r.status === 201 && r.body.eligibility_at === null && r.body.eligibility === 'permitted', r.body);

  // Suppressed at pre-commit: the operator's RG determination arrives with the
  // session. The stop still fires; nothing is issued; the guest keeps it all.
  r = await call('POST', '/v3/precommit', { vip_id: 'T-G1', budget_eur: 3000, mode: 'hard_stop', eligibility: 'suppressed' });
  ok('SUPPRESSED · the session records the determination', r.body.eligibility === 'suppressed', r.body);
  r = await call('POST', '/v3/session/tick', { vip_id: 'T-G1', delta_eur: 1600 });
  ok('SUPPRESSED · the stop still fires', r.status === 423 && r.body.locked === true, r.status);
  ok('SUPPRESSED · nothing is issued',
     r.body.rollover === 0 && r.body.credits.spa === 0 && r.body.credits.fnb === 0 && r.body.credits.retail === 0, r.body);
  ok('SUPPRESSED · the whole preserved budget returns to the guest',
     near(r.body.residual_to_guest_eur, r.body.preserved), r.body);
  r = await call('POST', '/v3/redirect/issue', { vip_id: 'T-G1' });
  ok('SUPPRESSED · redirect/issue refuses with INCENTIVE_SUPPRESSED',
     r.status === 409 && r.body.error === 'INCENTIVE_SUPPRESSED', r);

  // Mid-session suppression: an exclusion feed or a withdrawal request lands
  // while the guest is playing. It must take effect on the spot.
  await call('POST', '/v3/precommit', { vip_id: 'T-G2', budget_eur: 4000, mode: 'hard_stop' });
  await call('POST', '/v3/session/tick', { vip_id: 'T-G2', delta_eur: 500 });
  r = await call('POST', '/v3/programme/suppress', { vip_id: 'T-G2', reason: 'exclusion' });
  ok('PROGRAMME · suppression stops a live session immediately',
     r.status === 200 && r.body.session_stopped === true, r);
  ok('PROGRAMME · the answer says suppressed, and names the reason',
     r.body.suppressed === true && r.body.reason === 'exclusion', r.body);
  ok('PROGRAMME · the stopped session issues nothing and returns everything',
     r.body.stopped.credits.spa === 0 && near(r.body.stopped.residual_to_guest_eur, 3500), r.body.stopped);
  r = await call('POST', '/v3/programme/suppress', { vip_id: 'T-G2', reason: 'exclusion' });
  ok('PROGRAMME · a second suppression is refused', r.status === 409 && r.body.error === 'ALREADY_SUPPRESSED', r);

  // Suppression outlives the session that carried it.
  r = await call('POST', '/v3/precommit', { vip_id: 'T-G2', budget_eur: 2000, mode: 'hard_stop' });
  ok('PROGRAMME · a suppressed guest cannot be re-enrolled by a new pre-commit',
     r.body.eligibility === 'suppressed', r.body);

  // An exclusion feed can name a guest before the guest has ever played.
  r = await call('POST', '/v3/programme/suppress', { vip_id: 'T-NOSESSION', reason: 'player_request' });
  ok('PROGRAMME · a guest with no session can be suppressed, and nothing is stopped',
     r.status === 200 && r.body.session_stopped === false && r.body.stopped === null, r);
  r = await call('POST', '/v3/programme/suppress', { vip_id: 123, reason: 'exclusion' });
  ok('PROGRAMME · INVALID_VIP on a vip_id that is not a string', r.status === 400 && r.body.error === 'INVALID_VIP', r);
  r = await call('POST', '/v3/programme/suppress', { reason: 'exclusion' });
  ok('PROGRAMME · INVALID_VIP when no vip_id is sent', r.status === 400 && r.body.error === 'INVALID_VIP', r);

  // From the moment a guest is suppressed no incentive value reaches them: a
  // credit or a rollover issued before the suppression is not collected after it.
  {
    const c3 = (await call('GET', '/vip/credits?vip_id=VIP-0003')).body.credits.find(c => !c.redeemed_at);
    await call('POST', '/v3/programme/suppress', { vip_id: 'VIP-0003', reason: 'exclusion' });
    r = await call('POST', '/vip/credit/redeem', { credit_id: c3.id });
    ok('PROGRAMME · an excluded guest cannot redeem a credit issued before the exclusion',
       r.status === 409 && r.body.error === 'INCENTIVE_SUPPRESSED', r);
    r = await call('POST', '/vip/rollover/apply', { vip_id: 'VIP-0003' });
    ok('PROGRAMME · nor apply a rollover issued before it', r.status === 409 && r.body.error === 'INCENTIVE_SUPPRESSED', r);
    const c4 = (await call('GET', '/vip/credits?vip_id=VIP-0004')).body.credits[0];
    await call('POST', '/v3/programme/suppress', { vip_id: 'VIP-0004', reason: 'player_request' });
    r = await call('POST', '/vip/credit/redeem', { credit_id: c4.id });
    ok('PROGRAMME · every suppression reason stops redemption, not only exclusion',
       r.status === 409 && r.body.error === 'INCENTIVE_SUPPRESSED', r);
    r = await call('POST', '/vip/rollover/apply', { vip_id: 'VIP-0005' });
    ok('PROGRAMME · a guest who was never suppressed still applies rollover', r.status === 200 && r.body.applied === true, r);
    await call('POST', '/v3/precommit', { vip_id: 'T-PS', budget_eur: 3000, mode: 'hard_stop' });
    const stp = (await call('POST', '/v3/session/tick', { vip_id: 'T-PS', delta_eur: 1600 })).body;
    await call('POST', '/v3/programme/suppress', { vip_id: 'T-PS', reason: 'rg_determination' });
    const psid = (await call('GET', '/v3/policy/state?vip_id=T-PS')).body.session_id;
    const pev = (await call('GET', '/v3/audit/' + psid)).body.events.filter(e => e.type === 'incentive.suppressed');
    ok('PROGRAMME · a suppression that lands on a stopped, unissued settlement writes that refusal to the chain',
       stp.locked === true && pev.length === 1 && pev[0].scope === 'settlement' && near(pev[0].returned_to_guest_eur, 1400), pev);
    await call('POST', '/v3/precommit', { vip_id: 'T-PS0', budget_eur: 3000, mode: 'hard_stop', eligibility: 'suppressed' });
    await call('POST', '/v3/session/tick', { vip_id: 'T-PS0', delta_eur: 1600 });
    await call('POST', '/v3/programme/suppress', { vip_id: 'T-PS0', reason: 'exclusion' });
    const psid0 = (await call('GET', '/v3/policy/state?vip_id=T-PS0')).body.session_id;
    const pev0 = (await call('GET', '/v3/audit/' + psid0)).body.events.filter(e => e.type === 'incentive.suppressed');
    ok('PROGRAMME · a settlement that already issued nothing is not written as refused a second time',
       pev0.length === 1 && pev0[0].scope === 'settlement', pev0);
  }

  // The refusal is evidence, not an absence.
  r = await call('GET', '/vip/chain/verify');
  ok('AUDIT · the chain still verifies after suppression', r.body.valid === true, r.body);
  {
    const rows = db.prepare("SELECT payload FROM events WHERE type = 'incentive.suppressed'").all()
      .map(x => JSON.parse(x.payload));
    ok('AUDIT · a refusal to issue is written to the chain', rows.length >= 2, rows.length);
    ok('AUDIT · the programme row names the reason',
       rows.some(x => x.scope === 'programme' && x.reason === 'exclusion'), rows);
    ok('AUDIT · the settlement row records what went back to the guest',
       rows.some(x => x.scope === 'settlement' && x.returned_to_guest_eur > 0), rows);
  }

  r = await call('POST', '/v3/precommit', { vip_id: 'T-G3', budget_eur: 1000, eligibility: 'maybe' });
  ok('GATE · an unknown eligibility value is refused', r.status === 400 && r.body.error === 'INVALID_ELIGIBILITY', r);
  r = await call('POST', '/v3/programme/suppress', { vip_id: 'T-G3', reason: 'because' });
  ok('GATE · an unknown suppression reason is refused', r.status === 400 && r.body.error === 'INVALID_REASON', r);

  // A jurisdiction that forbids the incentive outright sets it once, at the
  // process, and no session can re-enable it.
  {
    const res = spawnSync(process.execPath, ['-e',
      "const P=require('./src/policy');process.stdout.write(JSON.stringify(P.settle(1480,'permitted')))"],
      { cwd: __dirname, env: Object.assign({}, process.env, { VIP_ELIGIBILITY_DEFAULT: 'suppressed' }), encoding: 'utf8' });
    let j = null; try { j = JSON.parse(res.stdout); } catch {}
    ok('JURISDICTION · a suppressed default overrides a permitted session',
       j && j.eligibility === 'suppressed' && j.redirect === 0 && near(j.residual, 1480), res.stdout);
  }
  {
    const res = spawnSync(process.execPath, ['-e', "require('./src/policy')"],
      { cwd: __dirname, env: Object.assign({}, process.env, { VIP_ELIGIBILITY_DEFAULT: 'sometimes' }), encoding: 'utf8' });
    ok('JURISDICTION · an unknown default refuses to start', res.status !== 0, res.status);
  }

  // The cap answers the one attack the mechanism does not answer by itself:
  // a bigger declared budget must not buy a bigger reward without limit.
  {
    const res = spawnSync(process.execPath, ['-e',
      "const P=require('./src/policy');process.stdout.write(JSON.stringify(P.settle(1480,'permitted')))"],
      { cwd: __dirname, env: Object.assign({}, process.env, { VIP_REWARD_CAP_EUR: '500' }), encoding: 'utf8' });
    let j = null; try { j = JSON.parse(res.stdout); } catch {}
    ok('CAP · the operator-funded part is held at the ceiling',
       j && j.capped === true && near(j.redirect + j.rollover, 500), res.stdout);
    ok('CAP · the excess goes to the guest, not to the operator',
       j && near(j.residual, 980) && near(j.redirect + j.rollover + j.residual, j.preserved), res.stdout);
  }
  {
    const res = spawnSync(process.execPath, ['-e', "require('./src/policy')"],
      { cwd: __dirname, env: Object.assign({}, process.env, { VIP_REWARD_CAP_EUR: '-5' }), encoding: 'utf8' });
    ok('CAP · a cap that is not a positive number refuses to start', res.status !== 0, res.status);
  }
  {
    let c = child({ VIP_REWARD_CAP_EUR: '0' }, "require('./src/policy')");
    ok('CAP · a cap of zero refuses to start', c.status !== 0 && /Refusing to start/.test(c.stderr), c.status);
    const SETTLE = "process.stdout.write(JSON.stringify(require('./src/policy').settle(1480,'permitted')))";
    c = child({ VIP_REWARD_CAP_EUR: '1332' }, SETTLE);
    ok('CAP · a cap exactly equal to the reward does not bind, and changes nothing',
       !!c.json && c.json.capped === false && c.json.redirect === 1036 && c.json.rollover === 296 && c.json.residual === 148, c.json);
    c = child({ VIP_REWARD_CAP_EUR: '1331.99' }, SETTLE);
    ok('CAP · one cent less binds, and that cent goes to the guest',
       !!c.json && c.json.capped === true && Math.round((c.json.redirect + c.json.rollover) * 100) === 133199 &&
       c.json.residual === 148.01, c.json);
  }
  ok('CAP · an uncapped settlement, and a suppressed one, say capped: false',
     P.settle(1480).capped === false && P.settle(1480, 'suppressed').capped === false,
     [P.settle(1480).capped, P.settle(1480, 'suppressed').capped]);


  // ── 6c · the eligibility determination can go stale ─────────────────────
  head('TTL · a determination taken once is not a permission forever');

  // Reference configuration: no lifetime, and nothing about the canon moves.
  await call('POST', '/v3/precommit', { vip_id: 'T-T0', budget_eur: 3000, mode: 'hard_stop' });
  r = await call('POST', '/v3/session/tick', { vip_id: 'T-T0', delta_eur: 1600 });
  ok('TTL REFERENCE · unset means the determination never expires',
     r.body.eligibility === 'permitted' && r.body.eligibility_expired === false, r.body);
  ok('TTL REFERENCE · the canon settlement is untouched',
     near(r.body.preserved, 1400) && near(r.body.credits.spa, 420) &&
     near(r.body.rollover, 280) && near(r.body.residual_to_guest_eur, 140), r.body);

  r = await call('POST', '/v3/precommit', { vip_id: 'T-T1', budget_eur: 1000, eligibility_at: 'yesterday' });
  ok('TTL · an unparseable determination date is refused',
     r.status === 400 && r.body.error === 'INVALID_ELIGIBILITY_AT', r);

  {
    const stale = new Date(Date.now() - 200 * 86400000).toISOString();
    const fresh = new Date(Date.now() - 10 * 86400000).toISOString();
    const env90 = Object.assign({}, process.env, { VIP_ELIGIBILITY_TTL_DAYS: '90' });
    const run = (src) => {
      const res = spawnSync(process.execPath, ['-e', src],
        { cwd: __dirname, env: env90, encoding: 'utf8' });
      try { return JSON.parse(res.stdout); } catch { return { _raw: res.stdout, _err: res.stderr }; }
    };
    let j = run(`const P=require('./src/policy');process.stdout.write(JSON.stringify(P.settle(1480,'permitted',${JSON.stringify(fresh)})))`);
    ok('TTL · a fresh determination still permits',
       j.eligibility === 'permitted' && j.expired === false && near(j.redirect, 1036), j);
    j = run(`const P=require('./src/policy');process.stdout.write(JSON.stringify(P.settle(1480,'permitted',${JSON.stringify(stale)})))`);
    ok('TTL · a determination past its lifetime withholds the incentive',
       j.eligibility === 'suppressed' && j.expired === true && j.redirect === 0, j);
    ok('TTL · and the whole preserved budget still returns to the guest',
       near(j.residual, 1480), j);
    j = run("const P=require('./src/policy');process.stdout.write(JSON.stringify(P.settle(1480,'permitted')))");
    ok('TTL · an ABSENT determination date is treated as expired, not as fresh',
       j.eligibility === 'suppressed' && j.expired === true, j);
    const bad = spawnSync(process.execPath, ['-e', "require('./src/policy')"],
      { cwd: __dirname, env: Object.assign({}, process.env, { VIP_ELIGIBILITY_TTL_DAYS: '0' }), encoding: 'utf8' });
    ok('TTL · a lifetime that is not a positive number refuses to start', bad.status !== 0, bad.status);
    // The edge of the lifetime, on a fixed clock: exactly 90 days still holds,
    // one millisecond more has lapsed, and a date nobody can read has lapsed.
    j = run("const P=require('./src/policy');const at='2026-01-01T00:00:00.000Z';const t=Date.parse(at),D=86400000;" +
            "process.stdout.write(JSON.stringify({bad:P.eligibilityExpired('not a date'),before:P.eligibilityExpired(at,t+89*D)," +
            "edge:P.eligibilityExpired(at,t+90*D),past:P.eligibilityExpired(at,t+90*D+1)}))");
    ok('TTL · a determination date nobody can read has lapsed', j.bad === true, j);
    ok('TTL · inside the lifetime it holds', j.before === false, j);
    ok('TTL · at exactly the lifetime it still holds', j.edge === false, j);
    ok('TTL · one millisecond past the lifetime it has lapsed', j.past === true, j);
    // Through the engine, not only through settle(): a pre-commit that sends no
    // date is recorded without one, so a configured lifetime withholds it.
    j = run("const S=require('./src/store');const db=S.open(':memory:');const E=require('./src/engine');" +
            "const a=E.precommit(db,{vip_id:'Z2',budget_eur:3000,mode:'hard_stop'});" +
            "const t=E.tick(db,{vip_id:'Z2',delta_eur:1600});let i;try{i=E.redirectIssue(db,{vip_id:'Z2'})}catch(e){i=e.message}" +
            "process.stdout.write(JSON.stringify({a,t,i}))");
    ok('TTL · a pre-commit with no determination date is recorded without one, not dated now',
       !!j.a && j.a.eligibility_at === null && j.a.eligibility === 'suppressed', j.a || j);
    ok('TTL · so under a lifetime its settlement is withheld and nothing can be collected',
       !!j.t && j.t.eligibility === 'suppressed' && j.t.eligibility_expired === true && j.t.rollover === 0 &&
       j.i === 'INCENTIVE_SUPPRESSED', { t: j.t, i: j.i });
  }

  // An expiry is a different fact from a suppression and the chain says so.
  {
    const stale = new Date(Date.now() - 400 * 86400000).toISOString();
    const res = spawnSync(process.execPath, ['-e',
      "const S=require('./src/store');const db=S.open(':memory:');S.migrate(db);" +
      "const E=require('./src/engine');" +
      `E.precommit(db,{vip_id:'Z1',budget_eur:3000,mode:'hard_stop',eligibility_at:${JSON.stringify(stale)}});` +
      "E.tick(db,{vip_id:'Z1',delta_eur:1600});" +
      "const rows=db.prepare(\"SELECT type,payload FROM events WHERE type IN ('eligibility.expired','incentive.suppressed')\").all();" +
      "process.stdout.write(JSON.stringify(rows.map(x=>({type:x.type,payload:JSON.parse(x.payload)}))))"],
      { cwd: __dirname, env: Object.assign({}, process.env, { VIP_ELIGIBILITY_TTL_DAYS: '90' }), encoding: 'utf8' });
    let rows = []; try { rows = JSON.parse(res.stdout); } catch {}
    const types = rows.map(x => x.type);
    ok('AUDIT · a lapse writes eligibility.expired', types.includes('eligibility.expired'), res.stdout || res.stderr);
    ok('AUDIT · and the refusal to issue is written alongside it',
       types.includes('incentive.suppressed'), res.stdout || res.stderr);
    const lapse = rows.find(x => x.type === 'eligibility.expired');
    ok('AUDIT · the lapse row carries the determination date it lapsed from, and the lifetime',
       !!lapse && lapse.payload.determined_at === stale && lapse.payload.ttl_days === 90, lapse);
  }
  {
    // A determination that lapses between the stop and the issue call: the
    // refusal is written once, with the lapse, and a second call adds nothing.
    const res = spawnSync(process.execPath, ['-e',
      "const S=require('./src/store');const db=S.open(':memory:');const E=require('./src/engine');" +
      "const at=new Date().toISOString();const a=E.precommit(db,{vip_id:'LAPSE',budget_eur:3000,mode:'hard_stop',eligibility_at:at});" +
      "const t=E.tick(db,{vip_id:'LAPSE',delta_eur:1600});" +
      "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1100);" +
      "const r=[];for(let k=0;k<2;k++){try{E.redirectIssue(db,{vip_id:'LAPSE'});r.push('issued')}catch(e){r.push(e.message)}}" +
      "const rows=E.audit(db,a.session_id).events;const ev=rows.map(e=>e.type+(e.scope?':'+e.scope:''));" +
      "const x=rows.find(e=>e.type==='eligibility.expired');" +
      "process.stdout.write(JSON.stringify({elig:t.eligibility,r,ev,at,det:x&&x.determined_at}))"],
      { cwd: __dirname, env: Object.assign({}, process.env, { VIP_ELIGIBILITY_TTL_DAYS: '0.00001' }), encoding: 'utf8' });
    let lp = null; try { lp = JSON.parse(res.stdout); } catch { lp = null; }
    ok('AUDIT · a determination that lapses between the stop and the issue call is written once, with the lapse',
       !!lp && lp.elig === 'permitted' && lp.r.join() === 'INCENTIVE_SUPPRESSED,INCENTIVE_SUPPRESSED' &&
       lp.ev.filter(x => x === 'eligibility.expired').length === 1 &&
       lp.ev.filter(x => x === 'incentive.suppressed:settlement').length === 1 && lp.det === lp.at, lp || res.stderr);
  }


  // ── 6d · the settlement closes, and cannot be walked around ─────────────
  head('CLOSURE · money that appears or disappears is a defect, not a rounding detail');

  // Exhaustive rather than sampled. Before this release three legs were each
  // rounded independently and 52,205 of these 200,000 amounts failed to sum to the
  // preserved budget, by a cent in either direction. A sample would have missed
  // it for years; the full sweep cannot.
  {
    let legs = 0, creds = 0, negs = 0, worst = 0;
    for (let c = 1; c <= 200000; c++) {
      const s = P.settle(c / 100);
      const a = Math.round((s.redirect + s.rollover + s.residual) * 100);
      const b = Math.round(s.preserved * 100);
      if (a !== b) { legs++; if (Math.abs(a - b) > Math.abs(worst)) worst = a - b; }
      const cs = Math.round((s.credits.spa + s.credits.fnb + s.credits.retail) * 100);
      if (cs !== Math.round(s.redirect * 100)) creds++;
      if (s.credits.spa < 0 || s.credits.fnb < 0 || s.credits.retail < 0 ||
          s.rollover < 0 || s.residual < 0) negs++;
    }
    ok('CLOSURE · redirect + rollover + residual === preserved, for every cent from 0.01 to 2000.00',
       legs === 0, { failures: legs, worst_cents: worst });
    ok('CLOSURE · spa + fnb + retail === redirect, for every one of them', creds === 0, creds);
    ok('CLOSURE · no leg is ever negative', negs === 0, negs);
  }
  {
    const s = P.settle(1480);
    ok('CLOSURE · the canon settlement is bit-for-bit what it always was',
       s.credits.spa === 444 && s.credits.fnb === 370 && s.credits.retail === 222 &&
       s.redirect === 1036 && s.rollover === 296 && s.residual === 148, s);
  }
  {
    const res = spawnSync(process.execPath, ['-e',
      "const P=require('./src/policy');let bad=0;" +
      "for(let c=1;c<=200000;c++){const s=P.settle(c/100);" +
      "if(Math.round((s.redirect+s.rollover+s.residual)*100)!==Math.round(s.preserved*100))bad++;}" +
      "process.stdout.write(String(bad))"],
      { cwd: __dirname, env: Object.assign({}, process.env, { VIP_REWARD_CAP_EUR: '500' }), encoding: 'utf8' });
    ok('CLOSURE · it still closes when the cap binds', res.stdout === '0', res.stdout || res.stderr);
  }

  // ── 6e · the rule itself, recomputed ────────────────────────────────────
  head('MONEY · the settlement rule and every line, recomputed independently to the cent');

  // Closing is necessary, not sufficient: a split can close and still put a
  // cent into the wrong venue. The rule is written out again here in whole
  // percentages — largest remainder on integer cents, a tie to the earlier
  // position; first redirect / rollover / residual at 70 / 20 / 10, then spa /
  // F&B / retail at 30 / 25 / 15 — and every cent must come out the same.
  {
    const lr = (total, w) => {
      const sum = w.reduce((a, b) => a + b, 0);
      const out = w.map(x => Math.floor(total * x / sum));
      const rem = w.map((x, i) => total * x - out[i] * sum);
      let left = total - out.reduce((a, b) => a + b, 0);
      const order = w.map((_, i) => i).sort((a, b) => rem[b] - rem[a] || a - b);
      for (let k = 0; left > 0; k++, left--) out[order[k]]++;
      return out;
    };
    let diff = 0, first = null;
    for (let c = 1; c <= 200000; c++) {
      const s = P.settle(c / 100);
      const [red, roll, res] = lr(c, [70, 20, 10]);
      const [spa, fnb, ret] = lr(red, [30, 25, 15]);
      const got = [s.preserved, s.redirect, s.rollover, s.residual, s.credits.spa, s.credits.fnb, s.credits.retail]
        .map(x => Math.round(x * 100));
      const want = [c, red, roll, res, spa, fnb, ret];
      if (got.join() !== want.join()) { diff++; if (!first) first = { eur: c / 100, got, want }; }
    }
    ok('MONEY · every cent from 0.01 to 2000.00 settles exactly as the stated rule, leg by leg and venue by venue',
       diff === 0, { differ: diff, first });
  }
  // The stop line, the nudge line and the escalation line are each the first
  // whole cent at or above their fraction of the budget — ceil(b/2), ceil(2b/5)
  // and ceil(17b/20) in integer arithmetic — and each fires on that cent and
  // not on the one before.
  {
    let bad = 0, first = null;
    for (let b = 1; b <= 200000; b++) {
      const be = b / 100;
      const L = { stop: Math.floor((b + 1) / 2), nudge: Math.floor((2 * b + 4) / 5), escalate: Math.floor((17 * b + 19) / 20) };
      const adv = x => P.assess(x / 100, be, 'advisory');
      const hs = x => P.assess(x / 100, be, 'hard_stop');
      const good = Math.round(P.armedAt(be) * 100) === L.stop &&
        !hs(L.stop - 1).locks && hs(L.stop).locks &&
        !adv(L.nudge - 1).nudge && adv(L.nudge).nudge &&
        !adv(L.escalate - 1).escalate && adv(L.escalate).escalate &&
        Math.round(P.distanceToThreshold((L.stop - 1) / 100, be) * 100) === 1;
      if (!good) { bad++; if (!first) first = { budget: be, armed: P.armedAt(be), lines: L }; }
    }
    ok('MONEY · for every budget from 0.01 to 2000.00 each line is the first cent at or above its fraction, and fires there',
       bad === 0, { bad, first });
  }
  ok('MONEY · allocate gives nothing, never a negative part, to a total at or below zero',
     JSON.stringify(P.allocate(-5, [1, 2])) === '[0,0]' && JSON.stringify(P.allocate(0, [1, 2])) === '[0,0]',
     [P.allocate(-5, [1, 2]), P.allocate(0, [1, 2])]);
  ok('MONEY · allocate gives nothing, not NaN, when every weight is zero',
     JSON.stringify(P.allocate(100, [0, 0, 0])) === '[0,0,0]', P.allocate(100, [0, 0, 0]));
  ok('MONEY · a tie goes to the earlier position, and the parts always close',
     JSON.stringify(P.allocate(1, [1, 1])) === '[1,0]' && JSON.stringify(P.allocate(2, [1, 1, 1])) === '[1,1,0]',
     [P.allocate(1, [1, 1]), P.allocate(2, [1, 1, 1])]);
  ok('MONEY · eur() takes whole cents: a stray fraction of a cent is rounded, never carried (2950.5 cents is 29.51)',
     P.eur(2950.5) === 29.51 && P.eur(29.4) === 0.29 && P.eur(148000) === 1480, [P.eur(2950.5), P.eur(29.4), P.eur(148000)]);
  ok('MONEY · the display fraction of a zero budget is 0, not NaN or Infinity',
     P.assess(0, 0, 'hard_stop').fraction === 0 && P.assess(5, 0, 'hard_stop').fraction === 0,
     [P.assess(0, 0, 'hard_stop').fraction, P.assess(5, 0, 'hard_stop').fraction]);
  // Money arrives in whole cents: a tick that carries a fraction of a cent is
  // counted to the nearest cent, so consumption, the stop and the settlement
  // read the same number and add back to the budget.
  {
    let bad = 0, first = null;
    for (let k = 0; k <= 300; k++) {
      const d = 499.005 + k / 100, v = 'T-SUB-' + k;
      await call('POST', '/v3/precommit', { vip_id: v, budget_eur: 1000, mode: 'hard_stop' });
      const t = (await call('POST', '/v3/session/tick', { vip_id: v, delta_eur: d })).body;
      const st = (await call('GET', '/v3/policy/state?vip_id=' + v)).body;
      const pv = st.incentive_preview;
      const pres = t.locked ? t.preserved : st.budget_eur - st.consumed_eur;
      const closes = Math.round(st.consumed_eur * 100) + Math.round(pres * 100) === 100000;
      const agrees = !t.locked ||
        Math.round((pv.redirect_eur + pv.rollover_eur + pv.residual_to_guest_eur) * 100) === Math.round(t.preserved * 100);
      if (!closes || !agrees) { bad++; if (!first) first = { d, t, st }; }
    }
    ok('MONEY · a tick with a fraction of a cent is counted to the cent: consumed and preserved make the budget, and the preview matches the settlement',
       bad === 0, { bad, first });
    await call('POST', '/v3/precommit', { vip_id: 'T-DISP', budget_eur: 3000, mode: 'advisory' });
    await call('POST', '/v3/session/tick', { vip_id: 'T-DISP', delta_eur: 1.1 });
    let st = (await call('GET', '/v3/policy/state?vip_id=T-DISP')).body;
    ok('MONEY · consumption is shown to the nearest cent, never rounded up (1.10 reads 1.1)', st.consumed_eur === 1.1, st.consumed_eur);
    await call('POST', '/v3/precommit', { vip_id: 'T-TINY', budget_eur: 1, mode: 'hard_stop' });
    let tiny = 0, tr = null;
    for (let k = 1; k <= 400 && !(tr && tr.locked); k++) {
      tr = (await call('POST', '/v3/session/tick', { vip_id: 'T-TINY', delta_eur: 0.004 })).body; tiny = k;
    }
    ok('MONEY · ticks each below a cent still add up: 0.004 at a time stops a 1.00 budget on tick 124, at its 0.50 line',
       !!tr && tr.locked === true && tiny === 124, { ticks: tiny, last: tr });
    await call('POST', '/v3/session/tick', { vip_id: 'T-DISP', delta_eur: 998.9 });
    st = (await call('GET', '/v3/policy/state?vip_id=T-DISP')).body;
    ok('MONEY · the consumed fraction is rounded to the nearest thousandth (1,000 of 3,000 reads 0.333)',
       st.consumed_fraction === 0.333, st.consumed_fraction);
    const mic = child({ VIP_THRESHOLD: '0.1234561' },
      "process.stdout.write(JSON.stringify(require('./src/policy').armedAt(10000)))");
    ok('MONEY · a configured fraction is read to the NEAREST millionth: 0.1234561 arms 10,000 at 1,234.56',
       mic.json === 1234.56, mic.json);
  }

  // ── 6f · adversarial ordering ───────────────────────────────────────────
  head('ADVERSARIAL · the guards must hold in an order nobody designed for');

  await call('POST', '/v3/precommit', { vip_id: 'T-A0', budget_eur: 2000, mode: 'hard_stop' });
  r = await call('POST', '/v3/session/tick', { vip_id: 'T-A0', delta_eur: -500 });
  ok('DELTA · a negative tick is refused outright', r.status === 400 && r.body.error === 'INVALID_DELTA', r);

  // A negative tick must not be able to walk a session back below its own stop.
  await call('POST', '/v3/precommit', { vip_id: 'T-A1', budget_eur: 2000, mode: 'hard_stop' });
  await call('POST', '/v3/session/tick', { vip_id: 'T-A1', delta_eur: 900 });
  r = await call('POST', '/v3/session/tick', { vip_id: 'T-A1', delta_eur: -800 });
  ok('DELTA · and cannot be used to disarm a session approaching its stop',
     r.status === 400 && r.body.error === 'INVALID_DELTA', r);
  r = await call('GET', '/v3/policy/state?vip_id=T-A1');
  ok('DELTA · consumption is unchanged by the refused tick', near(r.body.consumed_eur, 900), r.body);

  // Stop first, suppress second, then try to collect.
  await call('POST', '/v3/precommit', { vip_id: 'T-A2', budget_eur: 3000, mode: 'hard_stop' });
  await call('POST', '/v3/session/tick', { vip_id: 'T-A2', delta_eur: 1600 });
  r = await call('POST', '/v3/programme/suppress', { vip_id: 'T-A2', reason: 'exclusion' });
  ok('ORDER · suppression after a stop is accepted', r.status === 200, r.status);
  ok('ORDER · and it does not stop the stopped session a second time', r.body.session_stopped === false, r.body);
  r = await call('POST', '/v3/redirect/issue', { vip_id: 'T-A2' });
  ok('ORDER · and the already-settled incentive can no longer be collected',
     r.status === 409 && r.body.error === 'INCENTIVE_SUPPRESSED', r);

  // Collect first, then try to collect again.
  await call('POST', '/v3/precommit', { vip_id: 'T-A3', budget_eur: 3000, mode: 'hard_stop' });
  await call('POST', '/v3/session/tick', { vip_id: 'T-A3', delta_eur: 1600 });
  r = await call('POST', '/v3/redirect/issue', { vip_id: 'T-A3' });
  ok('ORDER · a first issue succeeds', r.status === 200, r.status);
  r = await call('POST', '/v3/redirect/issue', { vip_id: 'T-A3' });
  ok('ORDER · a replayed issue is refused', r.status === 409 && r.body.error === 'ALREADY_ISSUED', r);

  // Collect before there is anything to collect.
  await call('POST', '/v3/precommit', { vip_id: 'T-A4', budget_eur: 3000, mode: 'hard_stop' });
  r = await call('POST', '/v3/redirect/issue', { vip_id: 'T-A4' });
  ok('ORDER · issuing before a stop is refused', r.status >= 400, r);

  // Suppress first, enrol second, stop third, collect fourth.
  await call('POST', '/v3/programme/suppress', { vip_id: 'T-A5', reason: 'player_request' });
  await call('POST', '/v3/precommit', { vip_id: 'T-A5', budget_eur: 3000, mode: 'hard_stop' });
  r = await call('POST', '/v3/session/tick', { vip_id: 'T-A5', delta_eur: 1600 });
  ok('ORDER · a guest suppressed before enrolling settles with nothing issued',
     r.body.credits.spa === 0 && near(r.body.residual_to_guest_eur, r.body.preserved), r.body);
  r = await call('POST', '/v3/redirect/issue', { vip_id: 'T-A5' });
  ok('ORDER · and cannot collect afterwards', r.status === 409, r);

  r = await call('GET', '/vip/chain/verify');
  ok('ADVERSARIAL · the chain still verifies after all of it', r.body.valid === true, r.body);

  // Cap, suppression and lifetime together, in the same process.
  {
    const stale = new Date(Date.now() - 400 * 86400000).toISOString();
    const res = spawnSync(process.execPath, ['-e',
      "const P=require('./src/policy');const out=[];" +
      `out.push(P.settle(1480,'permitted',${JSON.stringify(stale)}));` +
      "out.push(P.settle(1480,'suppressed'));" +
      "process.stdout.write(JSON.stringify(out))"],
      { cwd: __dirname, encoding: 'utf8',
        env: Object.assign({}, process.env, { VIP_REWARD_CAP_EUR: '500', VIP_ELIGIBILITY_TTL_DAYS: '90' }) });
    let j = []; try { j = JSON.parse(res.stdout); } catch {}
    ok('COMBINED · a cap does not resurrect an expired determination',
       j[0] && j[0].redirect === 0 && j[0].expired === true && near(j[0].residual, 1480), res.stdout);
    ok('COMBINED · nor an explicit suppression',
       j[1] && j[1].redirect === 0 && near(j[1].residual, 1480), res.stdout);
  }

  // The documented upgrade path has to be real.
  {
    const res = spawnSync(process.execPath, ['-e',
      "const S=require('./src/store');const db=S.open(':memory:');" +
      "db.exec('DROP TABLE IF EXISTS sessions');" +
      "db.exec(\"CREATE TABLE sessions(id TEXT PRIMARY KEY, guest_id TEXT, mode TEXT, state TEXT, budget_eur REAL, armed_at_eur REAL, consumed_eur REAL, opened_at TEXT)\");" +
      "S.migrate(db);" +
      "const cols=db.prepare('PRAGMA table_info(sessions)').all().map(c=>c.name);" +
      "process.stdout.write(JSON.stringify(cols))"],
      { cwd: __dirname, encoding: 'utf8' });
    let cols = []; try { cols = JSON.parse(res.stdout); } catch {}
    ok('MIGRATION · an older schema gains both new columns',
       cols.includes('eligibility') && cols.includes('eligibility_at'), res.stdout || res.stderr);
  }

  // ── 6g · the consoles this build serves ─────────────────────────────────
  // Every button a person can press must map to a call the engine accepts.
  // The guest screen shipped a "-500 (win)" button that sent a NEGATIVE delta
  // — a leftover from before consumption became monotonic — and the engine
  // answered 400 INVALID_DELTA on the very page a reader is told to open
  // first. Nothing below the HTTP layer can see that; this reads the pages.
  head('CONSOLES · the pages this build serves, and the ticks their controls send');
  for (const page of ['/', '/host', '/admin?token=' + encodeURIComponent(ADMIN_TOKEN)]) {
    const res = await fetch(base + page);
    const html = await res.text();
    const ticks = [...html.matchAll(/tick\(\s*(-?[\d.]+)\s*\)/g)].map(m => Number(m[1]));
    ok(`CONSOLES · ${page.split('?')[0]} is served as HTML and names MVP v${VERSION}`,
       res.status === 200 && /text\/html/.test(res.headers.get('content-type') || '') && html.includes('MVP v' + VERSION),
       res.status);
    ok(`CONSOLES · ${page.split('?')[0]} offers no negative tick`,
       ticks.every(n => Number.isFinite(n) && n >= 0), ticks.filter(n => !(n >= 0)));
  }
  r = await call('GET', '/admin');
  ok('CONSOLES · /admin without the token is 401, with a hint that names the variable',
     r.status === 401 && r.body.error === 'UNAUTHORIZED' && r.body.hint === 'open /admin?token=<VIP_ADMIN_TOKEN>', r);
  // Whatever a caller armed a session with is printed on the host console. It
  // goes through esc(), and click handlers read it from data attributes.
  {
    const html = await (await fetch(base + '/host')).text();
    const m = html.match(/const esc=[^\n]*?;(?=\n)/);
    let esc = null;
    try { esc = m ? new Function(m[0] + ';return esc;')() : null; } catch { esc = null; }
    const probeText = `<a href="x" onclick='y'>&\\=`;
    ok('CONSOLES · esc() rewrites exactly the six markup characters, and nothing else',
       !!esc && esc(probeText) === '&#60;a href=&#34;x&#34; onclick=&#39;y&#39;&#62;&#38;&#92;=', esc && esc(probeText));
    ok('CONSOLES · the host console prints vip_ids through esc() and wires its buttons through data attributes',
       html.includes('esc(s.vip_id)') && html.includes('data-stop=') && !/onclick="stop\(/.test(html));
  }
  r = await call('GET', '/vip/guests');
  ok('CONSOLES · /vip/guests answers with the guest list',
     r.status === 200 && Array.isArray(r.body.guests) && r.body.guests.length >= 63, r.status);
  r = await call('GET', '/vip/sessions');
  ok('CONSOLES · /vip/sessions answers with the live sessions',
     r.status === 200 && Array.isArray(r.body.live) && typeof r.body.stopped_count === 'number', r.status);
  r = await call('GET', '/vip/config');
  ok('CONSOLES · /vip/config reports the canon split: stop 0.5, redirect 0.7, residual 0.1',
     r.status === 200 && r.body.threshold === 0.5 && r.body.redirect_total === 0.7 && r.body.residual_to_guest === 0.1, r.body);
  ok('CONSOLES · /vip/config reports the gate, the cap and the lifetime it runs under',
     r.body.eligibility_default === 'permitted' && r.body.reward_cap_eur === null && r.body.eligibility_ttl_days === null,
     r.body);
  r = await call('POST', '/vip/nothing', {});
  ok('CONSOLES · an unknown POST route is NO_ROUTE', r.status === 404 && r.body.error === 'NO_ROUTE', r);
  r = await call('GET', '/vip/unknown');
  ok('CONSOLES · an unknown GET route is NO_ROUTE', r.status === 404 && r.body.error === 'NO_ROUTE', r);

  // ── 6h · starting the whole build ───────────────────────────────────────
  head('STARTUP · every configuration the validation accepts starts, seeds and serves');

  // Each of these was accepted by the validation and then failed at startup:
  // the seed replays the engine, and the engine refused what the seed asked.
  for (const [env, label] of [
    [{ VIP_SPLIT_SPA: '0', VIP_SPLIT_FNB: '0', VIP_SPLIT_RETAIL: '0' }, 'every redirect share at zero'],
    [{ VIP_THRESHOLD: '0.05' }, 'the stop line at its lower bound'],
    [{ VIP_ELIGIBILITY_DEFAULT: 'suppressed' }, 'the incentive suppressed for the whole jurisdiction'],
    [{ VIP_ELIGIBILITY_TTL_DAYS: '90' }, 'a determination lifetime, which the seeded sessions carry no date for']
  ]) {
    const s = await startServer(env);
    ok('STARTUP · ' + label + ': the server starts and serves a seeded quarter',
       s.up && !!s.q && s.q.stopped_sessions_in_quarter === 60,
       { up: s.up, quarter: s.q && s.q.stopped_sessions_in_quarter, err: s.err.slice(-240) });
  }
  {
    const res = spawnSync(process.execPath, ['server.js'], {
      cwd: __dirname, encoding: 'utf8',
      env: Object.assign({}, process.env, { VIP_THRESHOLD: 'abc', VIP_DB: path.join(TMP, 'refused.db') })
    });
    ok('STARTUP · a refused configuration exits 1 with one sentence and no stack trace',
       res.status === 1 && /VIP MVP cannot start: VIP_THRESHOLD must be a finite number/.test(res.stderr) &&
       !/\n\s+at /.test(res.stderr), res.stderr);
    ok('STARTUP · and it refuses before it creates a database', !fs.existsSync(path.join(TMP, 'refused.db')));
    const port = spawnSync(process.execPath, ['server.js'], {
      cwd: __dirname, encoding: 'utf8',
      env: Object.assign({}, process.env, { PORT: 'abc', VIP_DB: path.join(TMP, 'refused-port.db') })
    });
    ok('STARTUP · a port that is not a number is refused the same way, before any database exists',
       port.status === 1 && /VIP MVP cannot start: PORT must be a finite number/.test(port.stderr) &&
       !/\n\s+at /.test(port.stderr) && !fs.existsSync(path.join(TMP, 'refused-port.db')), port.stderr);
    const frac = spawnSync(process.execPath, ['server.js'], {
      cwd: __dirname, encoding: 'utf8',
      env: Object.assign({}, process.env, { PORT: '3400.5', VIP_DB: path.join(TMP, 'refused-frac.db') })
    });
    ok('STARTUP · a port that is not a whole number is refused in one sentence, before any database exists',
       frac.status === 1 && /VIP MVP cannot start: PORT must be a whole number/.test(frac.stderr) &&
       !/\n\s+at /.test(frac.stderr) && !fs.existsSync(path.join(TMP, 'refused-frac.db')), frac.stderr);
  }
  {
    const s = await startServer({ VIP_SPLIT_SPA: '0.1', VIP_SPLIT_FNB: '0.1', VIP_SPLIT_RETAIL: '0.133333' });
    ok('STARTUP · a quarter whose capture is not a round number reports it to the nearest thousandth (0.333)',
       s.up && !!s.q && s.q.non_gaming_capture === 0.333, { up: s.up, capture: s.q && s.q.non_gaming_capture });
  }
  {
    const res = child({}, "const M=require('module');const L=M._load;" +
      "M._load=function(r){if(r==='node:sqlite')throw new Error('absent');return L.apply(this,arguments)};require('./src/store')");
    ok('STARTUP · on a runtime without node:sqlite the build names the Node it needs, and stops',
       res.status === 1 && res.stderr.includes('Needs Node >= 22.13.0 for the built-in node:sqlite module') &&
       !/\n\s+at /.test(res.stderr), res.stderr);
  }

  // ── 7 · parity with the shipped reference ───────────────────────────────
  head('PARITY · this build against registry slot 04b_Integration_Reference.js');

  const refPath = path.join(__dirname, '..', '04b_Integration_Reference.js');
  if (!fs.existsSync(refPath)) {
    skip('parity against the shipped reference', 'the reference is not beside this build; it sits next to the MVP inside the package registry, not in the standalone archive');
  } else {
    const ref = require(refPath);

    // v0.2.5 · THE CHECK THAT WAS MISSING, and it is why the two builds were
    // allowed to disagree for a whole revision. v3.10 added the non-negative
    // delta guard to this build and not to the reference; every parity check
    // below sends well-formed input, so all of them passed while the same
    // negative tick returned 400 here and 200 there, walking a session back
    // from its stop line. A parity claim that only ever sends valid input is
    // not a parity claim. Both implementations must REFUSE the same thing.
    ref.precommit({ vip_id: 'PARITY-NEG', budget_eur: 1000, mode: 'hard_stop' });
    ref.tick({ vip_id: 'PARITY-NEG', delta_eur: 490 });
    let refNeg = null;
    try { ref.tick({ vip_id: 'PARITY-NEG', delta_eur: -400 }); }
    catch (e) { refNeg = { error: e.message, status: e.status }; }
    await call('POST', '/v3/precommit', { vip_id: 'T-PARITY-NEG', budget_eur: 1000, mode: 'hard_stop' });
    await call('POST', '/v3/session/tick', { vip_id: 'T-PARITY-NEG', delta_eur: 490 });
    const ourNeg = await call('POST', '/v3/session/tick', { vip_id: 'T-PARITY-NEG', delta_eur: -400 });
    ok('PARITY · the reference REFUSES a negative delta',
       refNeg !== null && refNeg.error === 'INVALID_DELTA' && refNeg.status === 400, refNeg);
    ok('PARITY · this build refuses it with the same identifier and status',
       ourNeg.status === 400 && ourNeg.body.error === 'INVALID_DELTA', ourNeg.body);
    ok('PARITY · the reference did not move consumption on the refused tick',
       near(ref._state.sessions.get('PARITY-NEG').consumed, 490),
       ref._state.sessions.get('PARITY-NEG').consumed);
    const negState = (await call('GET', '/v3/policy/state?vip_id=T-PARITY-NEG')).body;
    ok('PARITY · and this build did not move it either', near(negState.consumed_eur, 490), negState.consumed_eur);

    const rp = ref.precommit({ vip_id: 'PARITY', budget_eur: 3000, mode: 'hard_stop' });
    ok('PARITY · armed_at_eur identical', near(rp.armed_at_eur, 1500), rp.armed_at_eur);
    const rs = ref.tick({ vip_id: 'PARITY', delta_eur: 1600 });
    await call('POST', '/v3/precommit', { vip_id: 'T-PARITY', budget_eur: 3000, mode: 'hard_stop' });
    const ours = (await call('POST', '/v3/session/tick', { vip_id: 'T-PARITY', delta_eur: 1600 })).body;
    ok('PARITY · both fire the stop on the same tick', rs.locked === true && ours.locked === true);
    ok('PARITY · preserved identical', near(rs.preserved, ours.preserved), { ref: rs.preserved, mvp: ours.preserved });
    ok('PARITY · rollover identical', near(rs.rollover, ours.rollover), { ref: rs.rollover, mvp: ours.rollover });
    ok('PARITY · residual identical', near(rs.residual_to_guest_eur, ours.residual_to_guest_eur), { ref: rs.residual_to_guest_eur, mvp: ours.residual_to_guest_eur });
    ok('PARITY · every credit line identical',
       near(rs.credits.spa, ours.credits.spa) && near(rs.credits.fnb, ours.credits.fnb) && near(rs.credits.retail, ours.credits.retail),
       { ref: rs.credits, mvp: ours.credits });

    // The gate has to agree too, or the two implementations would diverge
    // exactly where a regulator is looking.
    const rsup = ref.settle(1480, 'suppressed');
    const psup = P.settle(1480, 'suppressed');
    ok('PARITY · a suppressed settlement is identical',
       rsup.redirect === psup.redirect && rsup.rollover === psup.rollover && near(rsup.residual, psup.residual),
       { ref: rsup, mvp: psup });
    ok('PARITY · both return the whole preserved budget when suppressed',
       near(rsup.residual, 1480) && near(psup.residual, 1480), { ref: rsup.residual, mvp: psup.residual });

    // The lifetime has to agree across both implementations too.
    const rt = ref.settle(1480, 'permitted', new Date(Date.now() - 400 * 86400000).toISOString());
    const pt = P.settle(1480, 'permitted', new Date(Date.now() - 400 * 86400000).toISOString());
    ok('PARITY · both read the same determination age the same way',
       rt.expired === pt.expired && rt.eligibility === pt.eligibility && rt.redirect === pt.redirect,
       { ref: { e: rt.expired, el: rt.eligibility }, mvp: { e: pt.expired, el: pt.eligibility } });

    // v0.2.11 · the money and the bounds, on every cent, in both.
    {
      let d = 0, first = null;
      for (let c = 1; c <= 200000; c++) {
        const a = P.settle(c / 100), b = ref.settle(c / 100, 'permitted');
        const x = [a.redirect, a.rollover, a.residual, a.credits.spa, a.credits.fnb, a.credits.retail].join();
        const y = [b.redirect, b.rollover, b.residual, b.credits.spa, b.credits.fnb, b.credits.retail].join();
        if (x !== y) { d++; if (!first) first = { eur: c / 100, mvp: x, ref: y }; }
      }
      ok('PARITY · every cent from 0.01 to 2000.00 settles identically in both', d === 0, { differ: d, first });
      let a = 0;
      for (let b = 1; b <= 200000; b++) {
        if (Math.round(P.armedAt(b / 100) * 100) !== ref.lineCents(ref.cents(b / 100), ref.W.threshold)) a++;
      }
      ok('PARITY · every budget from 0.01 to 2000.00 is armed at the same cent in both', a === 0, a);
    }
    {
      const refuses = fn => { try { fn(); return null; } catch (e) { return e.message + '/' + e.status; } };
      ok('PARITY · both take a budget of exactly MAX_EUR and refuse one cent more with INVALID_BUDGET',
         ref.MAX_EUR === P.MAX_EUR &&
         refuses(() => ref.precommit({ vip_id: 'PB', budget_eur: ref.MAX_EUR, mode: 'hard_stop' })) === null &&
         refuses(() => ref.precommit({ vip_id: 'PB', budget_eur: ref.MAX_EUR + 0.01, mode: 'hard_stop' })) === 'INVALID_BUDGET/400',
         { ref: ref.MAX_EUR, mvp: P.MAX_EUR });
      ref.precommit({ vip_id: 'PS', budget_eur: 3000, mode: 'hard_stop' });
      ref.tick({ vip_id: 'PS', delta_eur: 1600 });
      ref.programmeSuppress({ vip_id: 'PS', reason: 'exclusion' });
      E.precommit(db, { vip_id: 'PS-M', budget_eur: 3000, mode: 'hard_stop' });
      E.tick(db, { vip_id: 'PS-M', delta_eur: 1600 });
      E.programmeSuppress(db, { vip_id: 'PS-M', reason: 'exclusion' });
      ok('PARITY · both refuse to issue an incentive settled before a suppression arrived',
         refuses(() => ref.redirectIssue({ vip_id: 'PS' })) === 'INCENTIVE_SUPPRESSED/409' &&
         refuses(() => E.redirectIssue(db, { vip_id: 'PS-M' })) === 'INCENTIVE_SUPPRESSED/409');
      const kind = e => e.type + (e.scope ? ':' + e.scope : '');
      const refTypes = ref.audit(ref._state.sessions.get('PS').session_id).events.map(kind);
      const mvpTypes = E.audit(db, E.stateOf(db, 'PS-M').session_id).events.map(kind);
      ok('PARITY · both write that refusal to the chain as a settlement link, in the same order',
         refTypes.includes('incentive.suppressed:settlement') && refTypes.join() === mvpTypes.join(),
         { ref: refTypes, mvp: mvpTypes });
      let sd = 0, sfirst = null;
      for (let k = 0; k <= 300; k++) {
        const d = 499.005 + k / 100, v = 'SUB' + k;
        ref.precommit({ vip_id: v, budget_eur: 1000, mode: 'hard_stop' });
        E.precommit(db, { vip_id: v + '-M', budget_eur: 1000, mode: 'hard_stop' });
        const a = ref.tick({ vip_id: v, delta_eur: d }), b = E.tick(db, { vip_id: v + '-M', delta_eur: d });
        const x = JSON.stringify([!!a.locked, a.locked ? a.preserved : 0, ref.view(ref._state.sessions.get(v)).consumed_eur]);
        const y = JSON.stringify([!!b.locked, b.locked ? b.preserved : 0, E.stateOf(db, v + '-M').consumed_eur]);
        if (x !== y) { sd++; if (!sfirst) sfirst = { d, ref: x, mvp: y }; }
      }
      ok('PARITY · a tick with a fraction of a cent is counted to the same cent in both, and stops them on the same cent',
         sd === 0, { differ: sd, first: sfirst });
      const rb = ref.precommit({ vip_id: 'SUBB', budget_eur: 1000.005, mode: 'hard_stop' });
      const mb = E.precommit(db, { vip_id: 'SUBB-M', budget_eur: 1000.005, mode: 'hard_stop' });
      ref.precommit({ vip_id: 'TINY', budget_eur: 1, mode: 'hard_stop' });
      E.precommit(db, { vip_id: 'TINY-M', budget_eur: 1, mode: 'hard_stop' });
      let rk = 0, mk = 0;
      for (let k = 1; k <= 400 && !rk; k++) if (ref.tick({ vip_id: 'TINY', delta_eur: 0.004 }).locked) rk = k;
      for (let k = 1; k <= 400 && !mk; k++) if (E.tick(db, { vip_id: 'TINY-M', delta_eur: 0.004 }).locked) mk = k;
      ok('PARITY · ticks each below a cent add up the same way in both, and stop them on the same tick',
         rk === 124 && mk === 124, { ref: rk, mvp: mk });
      const lapse = child({ VIP_ELIGIBILITY_TTL_DAYS: '0.00001', PORT: '65000' },
        "const R=require('../04b_Integration_Reference.js');" +
        "const at=new Date().toISOString();const a=R.precommit({vip_id:'L',budget_eur:3000,mode:'hard_stop',eligibility_at:at});" +
        "const t=R.tick({vip_id:'L',delta_eur:1600});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1100);" +
        "const r=[];for(let k=0;k<2;k++){try{R.redirectIssue({vip_id:'L'});r.push('issued')}catch(e){r.push(e.message)}}" +
        "const rows=R.audit(a.session_id).events;const ev=rows.map(e=>e.type+(e.scope?':'+e.scope:''));" +
        "const x=rows.find(e=>e.type==='eligibility.expired');" +
        "process.stdout.write(JSON.stringify({elig:t.eligibility,r,ev,at,det:x&&x.determined_at}))").json;
      ok('PARITY · the reference writes a lapse between the stop and the issue call the same way, once',
         !!lapse && lapse.elig === 'permitted' && lapse.r.join() === 'INCENTIVE_SUPPRESSED,INCENTIVE_SUPPRESSED' &&
         lapse.ev.filter(x => x === 'eligibility.expired').length === 1 &&
         lapse.ev.filter(x => x === 'incentive.suppressed:settlement').length === 1 && lapse.det === lapse.at, lapse);
      ok('PARITY · a budget with a fraction of a cent is taken to the same cent in both',
         rb.armed_at_eur === mb.armed_at_eur &&
         ref.view(ref._state.sessions.get('SUBB')).budget_eur === E.stateOf(db, 'SUBB-M').budget_eur,
         { ref: rb.armed_at_eur, mvp: mb.armed_at_eur });
      const fp = spawnSync(process.execPath, [refPath], {
        encoding: 'utf8', env: Object.assign({}, process.env, { PORT: '8080.5' }) });
      ok('PARITY · the reference refuses a port that is not a whole number in one sentence, as this build does',
         fp.status === 1 && /PORT must be a whole number/.test(fp.stderr) && !/\n\s+at /.test(fp.stderr), fp.stderr);
      const ttl = child({ VIP_ELIGIBILITY_TTL_DAYS: '90', PORT: '65000' },
        "const R=require('../04b_Integration_Reference.js');" +
        "const a=R.precommit({vip_id:'T',budget_eur:3000,mode:'hard_stop'});const t=R.tick({vip_id:'T',delta_eur:1600});" +
        "let i;try{i=R.redirectIssue({vip_id:'T'})}catch(e){i=e.message}process.stdout.write(JSON.stringify({a,t,i}))").json;
      ok('PARITY · the reference records an absent determination date as absent too, and withholds the settlement',
         !!ttl && ttl.a.eligibility_at === null && ttl.t.eligibility === 'suppressed' && ttl.i === 'INCENTIVE_SUPPRESSED', ttl);
      ok('PARITY · both answer NO_LIVE_SESSION to a vip_id that is not a string',
         refuses(() => ref.tick({ vip_id: true, delta_eur: 1 })) === 'NO_LIVE_SESSION/409' &&
         refuses(() => E.tick(db, { vip_id: true, delta_eur: 1 })) === 'NO_LIVE_SESSION/409');
    }
  }

  // Dormant means dormant: across everything above, with both variables unset,
  // not one dispatch was attempted.
  await new Promise(res => setTimeout(res, 50));
  ok('DOWNSTREAM · dormant, it attempted nothing in the whole run',
     B.downstream.sent === 0 && B.downstream.failed === 0, { sent: B.downstream.sent, failed: B.downstream.failed });

  // ── done ────────────────────────────────────────────────────────────────
  server.close();
  db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log('\n  ' + pass + ' passed · ' + failed + ' failed · ' + skipped + ' skipped');
  console.log(failed === 0 ? '  ALL CHECKS PASSED\n' : '  SUITE FAILED\n');
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
