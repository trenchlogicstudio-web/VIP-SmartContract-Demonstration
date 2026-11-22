// Copyright (c) 2026 Miloš Petrović (Trench Logic Studio) · SPDX-License-Identifier: MIT
// Reproductions for MVP v0.2.14 and SmartContract v3.20, kept in v0.2.16 / v3.22, and those of v0.2.16 / v3.22 at the end. Run with node --test regression.test.js.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');
const { promisify } = require('node:util');
const vm = require('node:vm');

for (const key of Object.keys(process.env)) if (key.startsWith('VIP_')) delete process.env[key];
delete process.env.PORT;
// The reference preset: the cap and the determination lifetime that 0.2.16
// switches on by default are switched off here, as in test.js.
process.env.VIP_REWARD_CAP_EUR = 'off';
process.env.VIP_ELIGIBILITY_TTL_DAYS = 'off';
const S = require('./src/store');
const E = require('./src/engine');
const B = require('./src/boundary');
const { seed } = require('./src/seed');
const { createServer } = require('./src/web');
const refPath = path.resolve(__dirname, '../04b_Integration_Reference.js');
const ref = fs.existsSync(refPath) ? require(refPath) : null;

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vip-review-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function database(t) {
  const db = S.open(':memory:');
  t.after(() => db.close());
  return db;
}

// Each process reads its own configuration at import, like a normal restart.
function childScript(fn) {
  return `const assert = require('node:assert/strict');
    const E = require('./src/engine'), S = require('./src/store'), P = require('./src/policy');
    const db = S.open(), args = JSON.parse(process.argv[1]);
    try { process.stdout.write(JSON.stringify((${fn.toString()})({ E, P, db }, args))); }
    finally { db.close(); }`;
}
function inProcess(env, fn, args = {}) {
  const out = execFileSync(process.execPath, ['-e', childScript(fn), JSON.stringify(args)],
    { cwd: __dirname, env: { ...process.env, VIP_DB: ':memory:', ...env }, encoding: 'utf8' });
  return JSON.parse(out);
}
function stopped(db, vip_id = 'G') {
  const input = { vip_id, budget_eur: 100 };
  const a = E.precommit(db, input);
  E.tick(db, { vip_id, delta_eur: 50 });
  return a.session_id;
}
function expectCode(fn, code, status = 409) {
  assert.throws(fn, e => e.message === code && e.status === status);
}
async function listen(t, server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return 'http://127.0.0.1:' + server.address().port;
}

for (const kind of ['MVP', 'reference']) {
  const suite = (name, fn) => test(kind + ' / ' + name, { skip: kind === 'reference' && !ref }, t => {
    const db = kind === 'MVP' ? database(t) : null;
    const api = db ? {
      precommit: x => E.precommit(db, x), tick: x => E.tick(db, x), issue: x => E.redirectIssue(db, x),
      state: id => E.stateOf(db, id), suppress: x => E.programmeSuppress(db, x), audit: sid => E.audit(db, sid),
      authorize: x => E.authorize(db, x), release: x => E.release(db, x),
      // Move a session's opening back by `ms`, as if that much time had passed.
      age: (sid, ms) => db.prepare('UPDATE sessions SET opened_at = ? WHERE id = ?').run(new Date(Date.now() - ms).toISOString(), sid),
      armed: id => Boolean(E.latest(db, id)), terms: () => E.terms()
    } : {
      precommit: ref.precommit, tick: ref.tick, issue: ref.redirectIssue, suppress: ref.programmeSuppress,
      state: id => ref.view(ref._state.sessions.get(id)), audit: ref.audit,
      authorize: ref.authorize, release: ref.release,
      age: (sid, ms) => { ref._state.byId.get(sid).opened_at = Date.now() - ms; },
      armed: id => ref._state.sessions.has(id), terms: () => ref.terms()
    };
    return fn(api);
  });
  suite('decimal half cents and accumulated sub-cent ticks', a => {
    a.precommit({ vip_id: 'half', budget_eur: 2.01 });
    assert.equal(a.tick({ vip_id: 'half', delta_eur: 1.005 }).locked, true);
    assert.equal(a.state('half').consumed_eur, 1.01);
    a.precommit({ vip_id: 'tiny', budget_eur: 0.02 });
    assert.equal(a.tick({ vip_id: 'tiny', delta_eur: 0.0045 }).state.consumed_eur, 0);
    assert.equal(a.tick({ vip_id: 'tiny', delta_eur: 5e-4 }).preserved, 0.01);
    a.precommit({ vip_id: 'budget', budget_eur: 1.005 });
    assert.equal(a.state('budget').budget_eur, 1.01);
  });
  suite('calendar dates, future determinations and lossless opaque IDs', a => {
    for (const value of ['2099-01-01T00:00:00Z', '2024-02-30T12:00:00Z', '2020-01-01', '2022-01-01T12:00:00']) {
      expectCode(() => a.precommit({ vip_id: 'date', budget_eur: 1, eligibility_at: value }), 'INVALID_ELIGIBILITY_AT', 400);
    }
    assert.equal(a.precommit({ vip_id: 'Ž🎲', budget_eur: 1, eligibility_at: '2024-02-29T12:00:01+01:00' }).eligibility, 'permitted');
    for (const vip_id of ['   ', 'A\u0000B', '\ud800']) expectCode(() => a.precommit({ vip_id, budget_eur: 1 }), 'INVALID_VIP', 400);
    assert.equal(a.state('Ž🎲').vip_id, 'Ž🎲');
  });
  suite('a delivery can be replayed after stop and after a new session', a => {
    const vip_id = 'replay';
    const { session_id } = a.precommit({ vip_id, budget_eur: 100 });
    const first = { vip_id, session_id, event_id: 'sale-1', delta_eur: 20 };
    const initial = a.tick(first);
    assert.deepEqual(a.tick(first), initial);
    assert.equal(a.state(vip_id).consumed_eur, 20);
    expectCode(() => a.tick({ ...first, delta_eur: 21 }), 'EVENT_CONFLICT');
    expectCode(() => a.tick({ ...first, session_id: undefined }), 'INVALID_EVENT_ID', 400);
    const crossing = { ...first, event_id: 'sale-2', delta_eur: 30 };
    const stop = a.tick(crossing);
    assert.equal(stop.locked, true);
    // The stopped session holds the guest for the commitment period; after it,
    // a new budget is armed and the old delivery still replays its stop.
    expectCode(() => a.precommit({ vip_id, budget_eur: 200 }), 'COMMITMENT_ACTIVE');
    a.age(session_id, 24 * 3600000 + 1000);
    a.precommit({ vip_id, budget_eur: 200 });
    assert.deepEqual(a.tick(crossing), stop);
    assert.equal(a.state(vip_id).consumed_eur, 0);
    expectCode(() => a.tick({ ...crossing, event_id: 'too-late' }), 'NO_LIVE_SESSION');
    expectCode(() => a.tick({ ...first, vip_id: 'stranger' }), 'NO_LIVE_SESSION');
    expectCode(() => a.issue({ vip_id: 'stranger', session_id }), 'NO_LIVE_SESSION');
    assert.equal(a.issue({ vip_id, session_id }).preserved, 50);
    expectCode(() => a.issue({ vip_id, session_id }), 'ALREADY_ISSUED');
  });
  suite('a stake that would cross the line is refused before it is placed, and the session locks on the line', a => {
    const vip_id = 'line';
    const { session_id, armed_at_eur } = a.precommit({ vip_id, budget_eur: 3000 });
    assert.equal(armed_at_eur, 1500);
    a.tick({ vip_id, session_id, delta_eur: 1400 });
    assert.throws(() => a.authorize({ vip_id, stake_eur: 1500 }),
      e => e.message === 'STAKE_EXCEEDS_HEADROOM' && e.status === 409 && e.extra.headroom_eur === 100);
    assert.throws(() => a.authorize({ vip_id, stake_eur: 100.01 }), e => e.message === 'STAKE_EXCEEDS_HEADROOM');
    assert.equal(a.state(vip_id).consumed_eur, 1400);
    const check = a.authorize({ vip_id, stake_eur: 100 });
    assert.equal(check.authorized, true); assert.equal(check.enforced, true);
    assert.equal(check.reserved_eur, 100); assert.equal(check.headroom_eur, 0);
    assert.throws(() => a.authorize({ vip_id, stake_eur: 0.01 }), e => e.extra.headroom_eur === 0);
    assert.equal(a.state(vip_id).reserved_eur, 100); assert.equal(a.state(vip_id).headroom_eur, 0);
    const stop = a.tick({ vip_id, session_id, delta_eur: 100, authorization_id: check.authorization_id });
    assert.equal(stop.locked, true); assert.equal(stop.overshoot_eur, 0); assert.equal(stop.preserved, 1500);
    assert.equal(a.state(vip_id).consumed_eur, 1500); assert.equal(a.state(vip_id).headroom_eur, 0);
    expectCode(() => a.authorize({ vip_id, stake_eur: 1 }), 'ALREADY_STOPPED');
    const types = a.audit(session_id).events.map(e => e.type);
    assert.equal(types.filter(x => x === 'stake.refused').length, 3);
    // The same wager reported without a check is the case this exists for: the
    // tick counts in full, and the stop says how far past the line it went.
    a.precommit({ vip_id: 'unchecked', budget_eur: 3000 });
    a.tick({ vip_id: 'unchecked', delta_eur: 1400 });
    a.authorize({ vip_id: 'unchecked', stake_eur: 50 });
    const late = a.tick({ vip_id: 'unchecked', delta_eur: 1500 });
    assert.equal(late.locked, true); assert.equal(late.overshoot_eur, 1400); assert.equal(late.preserved, 100);
    assert.equal(a.state('unchecked').reserved_eur, 0);
  });
  suite('a check is released, reported once, and never borrowed', a => {
    const vip_id = 'checks';
    const { session_id } = a.precommit({ vip_id, budget_eur: 1000 });
    for (const stake_eur of [0, -5, 0.004, '10', null, undefined, 1e9]) {
      expectCode(() => a.authorize({ vip_id, stake_eur }), 'INVALID_STAKE', 400);
    }
    expectCode(() => a.authorize({ vip_id: 'nobody', stake_eur: 1 }), 'NO_LIVE_SESSION');
    expectCode(() => a.authorize({ vip_id, session_id: 'other', stake_eur: 1 }), 'NO_LIVE_SESSION');
    const first = a.authorize({ vip_id, stake_eur: 500 });
    assert.equal(first.headroom_eur, 0);
    const back = a.release({ vip_id, authorization_id: first.authorization_id });
    assert.equal(back.released, true); assert.equal(back.headroom_eur, 500); assert.equal(back.reserved_eur, 0);
    expectCode(() => a.release({ vip_id, authorization_id: first.authorization_id }), 'AUTHORIZATION_CLOSED');
    expectCode(() => a.tick({ vip_id, delta_eur: 10, authorization_id: first.authorization_id }), 'AUTHORIZATION_CLOSED');
    expectCode(() => a.tick({ vip_id, delta_eur: 10, authorization_id: 'nope' }), 'AUTHORIZATION_UNKNOWN', 404);
    expectCode(() => a.release({ vip_id, authorization_id: 7 }), 'AUTHORIZATION_UNKNOWN', 404);
    a.precommit({ vip_id: 'neighbour', budget_eur: 1000 });
    const theirs = a.authorize({ vip_id: 'neighbour', stake_eur: 5 });
    expectCode(() => a.tick({ vip_id, delta_eur: 5, authorization_id: theirs.authorization_id }), 'AUTHORIZATION_UNKNOWN', 404);
    assert.equal(a.state(vip_id).consumed_eur, 0);
    // A wager that consumed more than the stake it was checked for is recorded, not refused.
    const small = a.authorize({ vip_id, stake_eur: 200 });
    assert.equal(a.tick({ vip_id, delta_eur: 250, authorization_id: small.authorization_id }).state.consumed_eur, 250);
    const exceeded = a.audit(session_id).events.filter(e => e.type === 'stake.exceeded');
    assert.equal(exceeded.length, 1);
    // A checked report delivered twice counts once, and its check closes once.
    const next = a.authorize({ vip_id, stake_eur: 50 });
    const report = { vip_id, session_id, event_id: 'wager-1', delta_eur: 50, authorization_id: next.authorization_id };
    assert.deepEqual(a.tick(report), a.tick(report));
    assert.equal(a.state(vip_id).consumed_eur, 300); assert.equal(a.state(vip_id).reserved_eur, 0);
    // Advisory enforces no line: the stake is reserved and the answer says so.
    a.precommit({ vip_id: 'advised', budget_eur: 1000, mode: 'advisory' });
    const loose = a.authorize({ vip_id: 'advised', stake_eur: 900 });
    assert.equal(loose.enforced, false); assert.equal(loose.headroom_eur, 0);
  });
  suite('2,000 seeded sessions with every stake checked never pass the line', a => {
    // A fixed seed, so a failure names a session and a step anyone can replay.
    let seed = 0x5eed2014;
    const rnd = () => { seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
    const cents = (lo, hi) => Math.floor(lo + rnd() * (hi - lo + 1));
    const seen = { stops: 0, refused: 0, reported: 0, released: 0 };
    for (let n = 0; n < 2000; n++) {
      const vip_id = 'seed-' + n;
      const { session_id, armed_at_eur } = a.precommit({ vip_id, budget_eur: cents(2, 500000) / 100 });
      const line = Math.round(armed_at_eur * 100);
      for (let step = 0; step < 60; step++) {
        const where = vip_id + ' step ' + step;
        const room = line - Math.round(a.state(vip_id).consumed_eur * 100);
        // Stakes that fit, stakes far too large, and the stake that is exactly what is left.
        const pick = rnd();
        const stake = pick < 0.15 ? room : pick < 0.35 ? cents(room + 1, room * 3 + 100) : cents(1, room);
        let check;
        try { check = a.authorize({ vip_id, session_id, stake_eur: stake / 100 }); }
        catch (e) {
          assert.equal(e.message, 'STAKE_EXCEEDS_HEADROOM', where);
          assert.ok(stake > room, where + ': a stake that fits was refused');
          assert.equal(Math.round(e.extra.headroom_eur * 100), room, where);
          seen.refused++; continue;
        }
        assert.ok(stake <= room, where + ': a stake larger than what is left was authorized');
        if (rnd() < 0.1) { a.release({ vip_id, session_id, authorization_id: check.authorization_id }); seen.released++; continue; }
        // The wager consumes its stake, or part of it when the platform counts net loss; never more.
        const used = rnd() < 0.7 ? stake : cents(1, stake);
        const answer = a.tick({ vip_id, session_id, delta_eur: used / 100, authorization_id: check.authorization_id });
        seen.reported++;
        const now = a.state(vip_id), consumed = Math.round(now.consumed_eur * 100);
        assert.ok(consumed <= line, where + ': consumed ' + consumed + ' passed the line ' + line);
        assert.equal(now.reserved_eur, 0, where);
        if (answer.locked) {
          assert.equal(consumed, line, where); assert.equal(answer.overshoot_eur, 0, where);
          seen.stops++; break;
        }
      }
    }
    // The run has to have reached the cases it is for.
    assert.ok(seen.stops >= 1500 && seen.refused >= 2000 && seen.reported >= 5000 && seen.released >= 500, JSON.stringify(seen));
  });
  suite('a live session is not superseded inside the commitment period', a => {
    const vip_id = 'bound', HOUR = 3600000;
    const first = a.precommit({ vip_id, budget_eur: 1000 });
    a.tick({ vip_id, delta_eur: 450 });
    const open = a.authorize({ vip_id, stake_eur: 40 });
    for (const budget_eur of [100000, 1000, 10]) {
      assert.throws(() => a.precommit({ vip_id, budget_eur }), e => e.message === 'SESSION_LIVE' && e.status === 409 &&
        e.extra.session_id === first.session_id && Number.isFinite(Date.parse(e.extra.supersede_after)));
    }
    const still = a.state(vip_id);
    assert.equal(still.session_id, first.session_id); assert.equal(still.budget_eur, 1000);
    assert.equal(still.consumed_eur, 450); assert.equal(still.headroom_eur, 10);
    // A clock set backwards leaves the opening in the future: the session stays held.
    a.age(first.session_id, -6 * HOUR);
    expectCode(() => a.precommit({ vip_id, budget_eur: 2000 }), 'SESSION_LIVE');
    a.age(first.session_id, 24 * HOUR - 60000);
    expectCode(() => a.precommit({ vip_id, budget_eur: 2000 }), 'SESSION_LIVE');
    a.age(first.session_id, 24 * HOUR + 1000);
    const second = a.precommit({ vip_id, budget_eur: 2000 });
    assert.notEqual(second.session_id, first.session_id); assert.equal(second.armed_at_eur, 1000);
    assert.equal(a.state(vip_id).consumed_eur, 0); assert.equal(a.state(vip_id).reserved_eur, 0);
    // The check granted under the old session died with it.
    expectCode(() => a.tick({ vip_id, delta_eur: 40, authorization_id: open.authorization_id }), 'AUTHORIZATION_UNKNOWN', 404);
    // From v3.22 a stopped session holds the guest for the same period, counted
    // from when it was armed: a larger, an equal and a smaller budget are refused
    // alike, the answer names the session and the time a new one is accepted, and
    // a clock set backwards keeps the guest held.
    const done = a.precommit({ vip_id: 'done', budget_eur: 100 });
    assert.equal(a.tick({ vip_id: 'done', delta_eur: 50 }).locked, true);
    for (const budget_eur of [100000, 100, 10]) {
      assert.throws(() => a.precommit({ vip_id: 'done', budget_eur }), e => e.message === 'COMMITMENT_ACTIVE' && e.status === 409 &&
        e.extra.session_id === done.session_id && Number.isFinite(Date.parse(e.extra.precommit_after)));
    }
    assert.equal(a.state('done').session_id, done.session_id); assert.equal(a.state('done').stopped, true);
    a.age(done.session_id, -6 * HOUR);
    expectCode(() => a.precommit({ vip_id: 'done', budget_eur: 100 }), 'COMMITMENT_ACTIVE');
    a.age(done.session_id, 24 * HOUR - 60000);
    expectCode(() => a.precommit({ vip_id: 'done', budget_eur: 100 }), 'COMMITMENT_ACTIVE');
    a.age(done.session_id, 24 * HOUR + 1000);
    assert.equal(a.precommit({ vip_id: 'done', budget_eur: 100 }).armed_at_eur, 50);
    // A stop the guest asked for, a withdrawal from the programme, holds the
    // guest the same way as the line does.
    a.precommit({ vip_id: 'chose', budget_eur: 100, mode: 'advisory' });
    a.suppress({ vip_id: 'chose', reason: 'player_request' });
    expectCode(() => a.precommit({ vip_id: 'chose', budget_eur: 100 }), 'COMMITMENT_ACTIVE');
  });
  suite('the terms a guest agreed to are recorded beside the amount, and other terms arm nothing', a => {
    const { terms_version } = a.terms();
    assert.match(terms_version, /^terms-[0-9a-f]{12}$/);
    for (const other of ['terms-000000000000', 'old', 7, null]) {
      assert.throws(() => a.precommit({ vip_id: 'agreed', budget_eur: 900, terms_version: other }),
        e => e.message === 'TERMS_CHANGED' && e.status === 409 && e.extra.terms_version === terms_version);
    }
    assert.equal(a.armed('agreed'), false);
    const r = a.precommit({ vip_id: 'agreed', budget_eur: 900, terms_version });
    assert.equal(r.terms_version, terms_version);
    assert.equal(a.state('agreed').terms_version, terms_version);
    const armedEvent = a.audit(r.session_id).events.find(e => e.type === 'precommit');
    assert.equal(armedEvent.terms_version, terms_version); assert.equal(armedEvent.budget_eur, 900);
    // Without a version the session records the version in force.
    assert.equal(a.precommit({ vip_id: 'unnamed', budget_eur: 10 }).terms_version, terms_version);
  });
  suite('programme withdrawal covers older unissued sessions once', a => {
    const vip_id = 'withdraw';
    const ids = [];
    for (let i = 0; i < 2; i++) {
      // The first stopped session holds the guest for the commitment period, so
      // it is moved back past it before the second budget is armed.
      if (ids.length) a.age(ids[ids.length - 1], 24 * 3600000 + 1000);
      ids.push(a.precommit({ vip_id, budget_eur: 100 }).session_id);
      a.tick({ vip_id, delta_eur: 50 });
    }
    a.suppress({ vip_id, reason: 'player_request' });
    for (const id of ids) {
      expectCode(() => a.issue({ vip_id, session_id: id }), 'INCENTIVE_SUPPRESSED');
      assert.equal(a.audit(id).events.filter(e => e.scope === 'settlement').length, 1);
    }
  });
}

test('issuance failure rolls back every instrument and the audit; retry issues once', t => {
  const db = database(t);
  const id = stopped(db);
  db.exec("CREATE TRIGGER reject_fnb BEFORE INSERT ON credits WHEN NEW.category='fnb' BEGIN SELECT RAISE(ABORT,'injected'); END");
  assert.throws(() => E.redirectIssue(db, { vip_id: 'G' }), /injected/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM credits').get().n, 0);
  assert.equal(E.audit(db, id).events.length, 2);
  db.exec('DROP TRIGGER reject_fnb');
  E.redirectIssue(db, { vip_id: 'G' });
  assert.equal(db.prepare('SELECT count(*) AS n FROM credits').get().n, 3);
  assert.equal(db.prepare('SELECT count(*) AS n FROM rollover').get().n, 1);
  assert.equal(B.verify(db).valid, true);
});

test('seed failure can be retried from an empty ledger', t => {
  const db = database(t);
  db.exec("CREATE TRIGGER reject_seed BEFORE INSERT ON guests WHEN NEW.id='VIP-0002' BEGIN SELECT RAISE(ABORT,'injected'); END");
  assert.throws(() => seed(db), /injected/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM guests').get().n, 0);
  assert.equal(B.verify(db).length, 0);
  db.exec('DROP TRIGGER reject_seed');
  assert.equal(seed(db), true);
  assert.equal(E.quarter(db).stopped_sessions_in_quarter, 60);
});

test('no downstream dispatch from a transaction that rolls back', t => {
  const db = database(t);
  const originalFetch = global.fetch;
  const old = { ...B.downstream };
  const sent = [];
  t.after(() => { global.fetch = originalFetch; Object.assign(B.downstream, old); });
  global.fetch = async (url, init) => { sent.push(JSON.parse(init.body).event.type); return new Response(); };
  Object.assign(B.downstream, { url: 'http://127.0.0.1/', key: 'local-test' });
  E.precommit(db, { vip_id: 'callback', budget_eur: 2 });
  assert.throws(() => S.transaction(db, () => {
    E.tick(db, { vip_id: 'callback', delta_eur: 1 });
    assert.deepEqual(sent, []);
    throw new Error('injected');
  }), /injected/);
  assert.deepEqual(sent, []);
  assert.equal(E.stateOf(db, 'callback').consumed_eur, 0);
  E.tick(db, { vip_id: 'callback', delta_eur: 1 });
  assert.deepEqual(sent, ['policy.stop']);
});

test('quarter uses one cohort and outstanding rollover decreases on use', t => {
  const db = database(t);
  seed(db);
  const initial = E.quarter(db);
  stopped(db, 'outside');
  E.redirectIssue(db, { vip_id: 'outside' });
  const c = db.prepare("SELECT id FROM credits WHERE guest_id='outside' LIMIT 1").get();
  E.redeem(db, { credit_id: c.id });
  assert.deepEqual(E.quarter(db), initial);
  E.applyRollover(db, { vip_id: 'VIP-0001' });
  assert.equal(E.quarter(db).rollover_allocated_eur, 61200);
  assert.equal(E.quarter(db).rollover_liability_eur, 60180);
});

test('restart preserves the armed line, quote, and successful event receipts', t => {
  const env = { VIP_DB: path.join(tempDir(t), 'restart.db') };
  const session_id = inProcess(env, ({ E, db }) => E.precommit(db, { vip_id: 'R', budget_eur: 100 }).session_id);
  const crossing = { session_id, vip_id: 'R', event_id: 'stop', delta_eur: 50 };
  const first = inProcess({ ...env, VIP_THRESHOLD: '.90' }, ({ E, db }, args) => E.tick(db, args), crossing);
  const next = { ...env, VIP_SPLIT_SPA: '.35', VIP_SPLIT_FNB: '.25', VIP_SPLIT_RETAIL: '.15', VIP_ROLLOVER: '.25' };
  assert.deepEqual(inProcess(next, ({ E, db }, args) => E.tick(db, args), crossing), first);
  const issued = inProcess(next, ({ E, db }) => E.redirectIssue(db, { vip_id: 'R' }));
  assert.deepEqual(issued.credits, { spa: 15, fnb: 12.5, retail: 7.5 });
  assert.equal(issued.rollover, 10);
});

test('fractional-cent cap rounds down and a stricter cap limits an existing quote', t => {
  const env = { VIP_DB: path.join(tempDir(t), 'cap.db') };
  inProcess(env, ({ E, db }) => { E.precommit(db, { vip_id: 'C', budget_eur: 100 }); return E.tick(db, { vip_id: 'C', delta_eur: 50 }); });
  const result = inProcess({ ...env, VIP_REWARD_CAP_EUR: '1.009' }, ({ E, db, P }) => ({
    liveQuote: P.settle(50), issued: E.redirectIssue(db, { vip_id: 'C' })
  }));
  assert.equal(result.liveQuote.redirect + result.liveQuote.rollover, 1);
  assert.equal(result.issued.residual, 49);
  assert.equal(Object.values(result.issued.credits).reduce((n,x) => n + Math.round(100*x), 0) + Math.round(result.issued.rollover*100), 100);
  inProcess(env, ({ E, db }) => { E.precommit(db, { vip_id: 'V', budget_eur: 100 }); return E.tick(db, { vip_id: 'V', delta_eur: 50 }); });
  const zeroSpa = inProcess({ ...env, VIP_SPLIT_SPA:'0', VIP_ROLLOVER:'.30' }, ({ E, db }) => E.redirectIssue(db, { vip_id:'V' }));
  assert.deepEqual(zeroSpa.credits, { spa:0, fnb:12.5, retail:7.5 });
  assert.equal(zeroSpa.rollover, 10);
  assert.equal(zeroSpa.residual, 20);
});

test('new jurisdiction setting and expired source determination block old instruments', t => {
  const env = { VIP_DB: path.join(tempDir(t), 'gates.db') };
  inProcess(env, ({ E, db }) => {
    E.precommit(db, { vip_id: 'gate', budget_eur: 10, eligibility_at: '2020-05-01T08:00:00Z' });
    E.tick(db, { vip_id: 'gate', delta_eur: 5 });
    return E.redirectIssue(db, { vip_id: 'gate' });
  });
  for (const scope of [{ VIP_ELIGIBILITY_DEFAULT: 'suppressed' }, { VIP_ELIGIBILITY_TTL_DAYS: '1' }]) {
    const blocked = inProcess({ ...env, ...scope }, ({ E, db }) => {
      const results = [];
      for (const op of [() => E.redeem(db, { credit_id: 1 }), () => E.applyRollover(db, { vip_id: 'gate' })]) {
        try { op(); results.push('issued'); } catch (e) { results.push(e.message); }
      }
      return results;
    });
    assert.deepEqual(blocked, ['INCENTIVE_SUPPRESSED','INCENTIVE_SUPPRESSED']);
  }
});

test('a refusal stays on the books after TTL is relaxed', t => {
  const env = { VIP_DB: path.join(tempDir(t), 'refusal.db') };
  inProcess(env, ({ E, db }) => { E.precommit(db, { vip_id: 'X', budget_eur: 20 }); return E.tick(db, { vip_id: 'X', delta_eur: 10 }); });
  const attempt = ({ E, db }) => {
    try { return E.redirectIssue(db, { vip_id: 'X' }); } catch (e) { return e.message; }
  };
  assert.equal(inProcess({ ...env, VIP_ELIGIBILITY_TTL_DAYS: '7' }, attempt), 'INCENTIVE_SUPPRESSED');
  assert.equal(inProcess(env, attempt), 'INCENTIVE_SUPPRESSED');
  assert.equal(inProcess(env, ({ db }) => db.prepare('SELECT residual_eur FROM sessions').get().residual_eur), 10);
});

test('migration recovers old live ticks and preserves historic settlement totals', t => {
  const file = path.join(tempDir(t), 'old.db');
  let db = S.open(file);
  stopped(db);
  E.precommit(db, { vip_id: 'old', budget_eur: 0.02 });
  E.tick(db, { vip_id: 'old', delta_eur: 0.0045 });
  db.exec('ALTER TABLE sessions DROP COLUMN consumed_exact; ALTER TABLE sessions DROP COLUMN settlement_json;');
  db.close();
  db = S.open(file);
  t.after(() => db.close());
  assert.equal(E.tick(db, { vip_id: 'old', delta_eur: 0.0005 }).preserved, 0.01);
  assert.equal(E.redirectIssue(db, { vip_id: 'G' }).residual, 5);
  assert.equal(B.verify(db).valid, true);
});

test('a held reader makes erasure retryable without duplicating its audit entry', t => {
  const file = path.join(tempDir(t), 'erase.db');
  const db = S.open(file), reader = S.open(file);
  t.after(() => { reader.close(); db.close(); });
  seed(db);
  reader.exec('BEGIN');
  reader.prepare("SELECT display_name FROM guests WHERE id='VIP-0001'").get();
  db.exec('PRAGMA busy_timeout=10');
  expectCode(() => B.erase(db, 'VIP-0001'), 'ERASURE_PENDING', 503);
  reader.exec('COMMIT');
  assert.equal(B.erase(db,'VIP-0001').erased, true);
  assert.equal(db.prepare("SELECT count(*) n FROM events WHERE type='guest.erase'").get().n, 1);
  for (const suffix of ['', '-wal']) {
    if (fs.existsSync(file + suffix)) assert.equal(fs.readFileSync(file + suffix).includes('Synthetic Guest 001'), false);
  }
});

test('malformed payload and altered sequence produce an audit finding', t => {
  const db = database(t);
  B.append(db, 'precommit', { session_id: 's' });
  db.exec("UPDATE events SET payload = '{'");
  assert.deepEqual(B.verify(db), { valid: false, length: 1, broken_at_seq: 1, reason: 'INVALID_PAYLOAD' });
  db.exec("UPDATE events SET seq = 2");
  assert.equal(B.verify(db).reason, 'SEQ_MISMATCH');
});

test('two independent writers can issue the same stop only once', async t => {
  const file = path.join(tempDir(t), 'race.db');
  const db = S.open(file);
  stopped(db);
  db.close();
  const run = promisify(execFile);
  const fn = ({ db, E }) => { try { return E.redirectIssue(db, { vip_id: 'G' }).issued; } catch (e) { return e.message; } };
  const results = await Promise.all([1,2].map(() => run(process.execPath, ['-e',childScript(fn),'{}'],
    { cwd: __dirname, env: { ...process.env, VIP_DB:file } })));
  assert.deepEqual(results.map(r => JSON.parse(r.stdout)).sort(), ['ALREADY_ISSUED', true]);
  const verify = S.open(file);
  t.after(() => verify.close());
  assert.equal(verify.prepare('SELECT count(*) n FROM credits').get().n, 3);
  assert.equal(B.verify(verify).valid, true);
});

function postChunks(base, chunks, headers = {}) {
  return new Promise((resolve,reject) => {
    const req = http.request(base + '/v3/precommit', { method:'POST', headers:{ 'content-type':'application/json', ...headers } }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status:res.statusCode, body:JSON.parse(body) }));
    });
    req.on('error', reject);
    req.write(chunks[0]);
    setTimeout(() => req.end(chunks[1]), 10);
  });
}

test('both HTTP services preserve split UTF-8, enforce the byte limit and refuse foreign origins', async t => {
  const servers = [createServer(database(t))];
  if (ref) servers.push(ref.server);
  for (const server of servers) {
    const base = await listen(t, server);
    const vip_id = 'Živa-🎲';
    const bytes = Buffer.from(JSON.stringify({ vip_id, budget_eur: 10 }));
    const split = bytes.indexOf(Buffer.from('🎲')) + 1;
    assert.equal((await postChunks(base, [bytes.subarray(0,split),bytes.subarray(split)])).status, 201);
    const state = await (await fetch(base + '/v3/policy/state?vip_id=' + encodeURIComponent(vip_id))).json();
    assert.equal(state.vip_id, vip_id);
    const reject = await postChunks(base, [Buffer.from('{"pad":"'),Buffer.from('ž'.repeat(500000)+'"}')]);
    assert.deepEqual(reject, { status:413, body:{ error:'PAYLOAD_TOO_LARGE' } });
    assert.equal((await postChunks(base,[bytes],{ origin:'https://example.invalid' })).status,403);
    assert.equal((await postChunks(base,[Buffer.from([0xff])])).status,400);
  }
});

test('served console scripts compile and both user roles can issue a stopped session', async t => {
  const db = database(t), base = await listen(t, createServer(db));
  stopped(db,'pending');
  for (const route of ['/', '/host', '/admin?token=evaluation-only']) {
    const res = await fetch(base + route);
    const html = await res.text();
    const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
    assert.doesNotThrow(() => new vm.Script(script));
    assert.equal(res.headers.get('referrer-policy'),'no-referrer');
    if (route !== '/admin?token=evaluation-only') assert.ok(script.includes('/v3/redirect/issue'));
  }
  const pending = await (await fetch(base + '/vip/credits?vip_id=pending')).json();
  assert.equal(pending.pending_sessions.length,1);
  const form = await fetch(base + '/admin', { headers: { accept:'text/html' } });
  assert.match(await form.text(), /type="password"/);
});

test('reset preserves unrelated files and reseeds an existing VIP database', t => {
  const dir = tempDir(t), file = path.join(dir, 'demo.db');
  let db = S.open(file);
  seed(db); db.close();
  const reset = dbPath => require('node:child_process').spawnSync(process.execPath, ['reset.js'], {
    cwd: __dirname, env: { ...process.env, VIP_DB: dbPath }, encoding: 'utf8'
  });
  assert.equal(reset(file).status, 0);
  db = S.open(file);
  assert.equal(B.verify(db).length, 0);
  assert.equal(seed(db), true);
  assert.equal(E.quarter(db).preserved_eur, 306000);
  assert.equal(B.verify(db).valid, true);
  db.close();
  const other = path.join(dir, 'other.db');
  fs.writeFileSync(other, 'unrelated data');
  assert.notEqual(reset(other).status, 0);
  assert.equal(fs.readFileSync(other,'utf8'), 'unrelated data');
});

test('a blank share or reversed advisory thresholds are rejected at boot', () => {
  for (const file of ['./src/policy', ...(ref ? [refPath] : [])]) {
    for (const config of [{VIP_SPLIT_SPA:' '},{VIP_NUDGE:'.90',VIP_ESCALATE:'.80'}]) {
      const probe = require('node:child_process').spawnSync(process.execPath, ['-e','require(process.argv[1])',file],
        { cwd: __dirname, env: { ...process.env, ...config }, encoding:'utf8' });
      assert.notEqual(probe.status,0);
      assert.match(probe.stderr,/VIP_(NUDGE|SPLIT_SPA)/);
    }
  }
});

// Execute the bundled page's own handlers using a small DOM fixture and a real
// loopback HTTP server. These checks cover actions and their ledger effects.
test('guest console arms, stops and issues a real settlement', async t => {
  const db = database(t), base = await listen(t, createServer(db));
  const html = await (await fetch(base + '/')).text();
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value:'', addEventListener() {} });
    return elements.get(id);
  };
  const context = vm.createContext({
    document: { querySelector:element, querySelectorAll:() => [] },
    fetch:(url, opts) => fetch(base + url, opts), crypto:globalThis.crypto
  });
  element('#vip').value = 'screen';
  element('#budget').value = '1000';
  element('#mode').value = 'hard_stop';
  element('#determined').checked = true;
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1],context);
  await vm.runInContext('reviewQuote()',context);
  await vm.runInContext('pre()',context);
  assert.equal(E.stateOf(db,'screen').stopped,false);
  await vm.runInContext('tick(500)',context);
  assert.equal(E.stateOf(db,'screen').stopped,true);
  assert.equal(element('#issue').hidden,false);
  await vm.runInContext('issue()',context);
  assert.equal(E.stateOf(db,'screen').redirect_issued,true);
  assert.equal(element('#issue').hidden,true);
});

test('offline demo controls preserve terms, model ceiling and playback position', {skip: !fs.existsSync(path.join(__dirname,'../05a_Demo_A_Screens.html'))}, () => {
  const root = path.join(__dirname, '..');
  function demo(filename, values = {}) {
    const nodes = new Map();
    const node = key => {
      if (!nodes.has(key)) nodes.set(key, {
        value: values[key] ?? '', textContent:'', innerHTML:'', style:{},
        classList:{ add(){}, remove(){}, toggle(){} }, querySelectorAll(){ return []; }
      });
      return nodes.get(key);
    };
    let nextFrame;
    const ctx = vm.createContext({ document:{ getElementById:node }, clearInterval(){nextFrame=null;},
      setInterval(fn){ nextFrame=fn; return 1; } });
    const html = fs.readFileSync(path.join(root,filename),'utf8');
    runPageScripts(html, ctx);
    return { node, ctx, frame:() => nextFrame(), html };
  }
  const a = demo('05a_Demo_A_Screens.html');
  vm.runInContext("step=2;decision='permitted';armed=true;draw()",a.ctx);
  assert.match(a.node('stage').innerHTML,/id=slr[^>]* disabled/);
  a.node('slr').oninput.call({value:'9000'});
  assert.equal(a.ctx.bud,3000);
  const b = demo('05b_Demo_B_Policy_Engine.html',{s:50,r:70});
  b.node('deal').onclick();
  assert.equal(b.node('s').disabled,true);
  b.node('reset').onclick();
  assert.equal(b.node('s').disabled,false);
  const c = demo('05c_Demo_C_Synthetic_Case_Study.html',{n:60,p:5100,g:70,r:84});
  c.node('p2').onclick();
  assert.equal(c.node('g').value,80);
  const d = demo('05d_Demo_D_Narrative_Proof.html');
  d.node('play').onclick(); d.frame();
  d.node('play').onclick(); d.node('play').onclick(); d.frame();
  assert.equal(d.ctx.cur,2);
});

test('legacy partial issuance can be retried without duplicating credit or concealing a prior redemption', t => {
  const db = database(t);
  const insert = db.prepare("INSERT INTO credits(session_id, guest_id, category, amount_eur, issued_at, redeemed_at) VALUES(?,?,'spa',15,'old',?)");
  const id = stopped(db,'partial');
  const unused = insert.run(id,'partial',null);
  expectCode(() => E.redeem(db,{credit_id:Number(unused.lastInsertRowid)}), 'CREDIT_UNKNOWN',404);
  E.redirectIssue(db,{vip_id:'partial'});
  assert.equal(db.prepare('SELECT count(*) n FROM credits WHERE session_id=?').get(id).n,3);
  const conflict = stopped(db,'used');
  insert.run(conflict,'used','old');
  expectCode(() => E.redirectIssue(db,{vip_id:'used'}),'LEDGER_CONFLICT');
  assert.equal(db.prepare('SELECT redeemed_at FROM credits WHERE session_id=?').get(conflict).redeemed_at,'old');
});

test('newest precommit wins if the wall clock moves backwards', t => {
  const db = database(t);
  const older = E.precommit(db,{vip_id:'clock',budget_eur:20});
  // The older session is stopped and moved past its commitment period first: a
  // live or a stopped session inside the period holds the guest.
  E.tick(db,{vip_id:'clock',delta_eur:10});
  db.prepare('UPDATE sessions SET opened_at=? WHERE id=?').run(new Date(Date.now()-25*3600000).toISOString(),older.session_id);
  const newer = E.precommit(db,{vip_id:'clock',budget_eur:50});
  // Then the clock moves: the older session now claims to open in the future.
  db.prepare('UPDATE sessions SET opened_at=? WHERE id=?').run('2099-01-01T00:00:00Z',older.session_id);
  assert.equal(E.stateOf(db,'clock').session_id,newer.session_id);
  assert.equal(E.tick(db,{vip_id:'clock',delta_eur:25}).locked,true);
});

test('a refused stake stays in the chain although its request fails, and the chain still verifies', t => {
  const db = database(t);
  const { session_id } = E.precommit(db, { vip_id: 'kept', budget_eur: 100 });
  const before = db.prepare('SELECT count(*) n FROM events').get().n;
  assert.throws(() => E.authorize(db, { vip_id: 'kept', stake_eur: 50.01 }), e => e.message === 'STAKE_EXCEEDS_HEADROOM');
  const rows = db.prepare("SELECT payload FROM events WHERE type = 'stake.refused'").all().map(r => JSON.parse(r.payload));
  assert.deepEqual(rows, [{ vip_id: 'kept', session_id, stake_eur: 50.01, headroom_eur: 50 }]);
  assert.equal(db.prepare('SELECT count(*) n FROM events').get().n, before + 1);
  assert.equal(db.prepare('SELECT count(*) n FROM authorizations').get().n, 0);
  assert.equal(db.prepare('SELECT reserved_eur FROM sessions WHERE id = ?').get(session_id).reserved_eur, 0);
  assert.equal(B.verify(db).valid, true);
});

test('stakes asked for at once over HTTP cannot share the last euros, and refusals carry the headroom', async t => {
  const db = database(t), base = await listen(t, createServer(db));
  const post = (route, body) => fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    .then(async r => ({ status: r.status, body: await r.json() }));
  assert.equal((await post('/v3/precommit', { vip_id: 'rush', budget_eur: 2000 })).status, 201);
  const all = await Promise.all(Array.from({ length: 12 }, () => post('/v3/session/authorize', { vip_id: 'rush', stake_eur: 300 })));
  assert.equal(all.filter(r => r.status === 200).length, 3);
  for (const r of all.filter(r => r.status !== 200)) {
    assert.equal(r.status, 409); assert.equal(r.body.error, 'STAKE_EXCEEDS_HEADROOM'); assert.equal(typeof r.body.headroom_eur, 'number');
  }
  const state = await (await fetch(base + '/v3/policy/state?vip_id=rush')).json();
  assert.equal(state.reserved_eur, 900); assert.equal(state.headroom_eur, 100);
  const again = await post('/v3/precommit', { vip_id: 'rush', budget_eur: 50000 });
  assert.equal(again.status, 409); assert.equal(again.body.error, 'SESSION_LIVE');
  assert.equal(typeof again.body.session_id, 'string'); assert.ok(Number.isFinite(Date.parse(again.body.supersede_after)));
  const route = await fetch(base + '/v3/nothing');
  assert.equal((await route.json()).routes.length, 9);
  assert.equal(B.verify(db).valid, true);
});

test('a database written before 0.2.14 gains the reservation, the checks and the tick link', t => {
  const file = path.join(tempDir(t), 'before-checks.db');
  let db = S.open(file);
  const { session_id } = E.precommit(db, { vip_id: 'carried', budget_eur: 1000 });
  E.tick(db, { vip_id: 'carried', delta_eur: 300 });
  db.exec('DROP INDEX idx_authorizations_session; DROP TABLE authorizations; ALTER TABLE sessions DROP COLUMN reserved_eur; ALTER TABLE ticks DROP COLUMN authorization_id;');
  db.close();
  db = S.open(file);
  t.after(() => db.close());
  assert.equal(E.stateOf(db, 'carried').headroom_eur, 200);
  const check = E.authorize(db, { vip_id: 'carried', stake_eur: 200 });
  assert.equal(E.tick(db, { vip_id: 'carried', session_id, delta_eur: 200, authorization_id: check.authorization_id }).overshoot_eur, 0);
  assert.equal(db.prepare('SELECT authorization_id FROM ticks ORDER BY id DESC LIMIT 1').get().authorization_id, check.authorization_id);
  assert.equal(B.verify(db).valid, true);
});

test('the commitment period is configuration: validated at boot, and 0 restores immediate supersession', () => {
  for (const file of ['./src/policy', ...(ref ? [refPath] : [])]) {
    for (const bad of ['-1', '169', 'a day', ' ']) {
      const probe = require('node:child_process').spawnSync(process.execPath, ['-e', 'require(process.argv[1])', file],
        { cwd: __dirname, env: { ...process.env, VIP_COMMITMENT_HOURS: bad }, encoding: 'utf8' });
      if (bad === ' ') continue;   // blank is read as unset by every numeric setting; checked below
      assert.notEqual(probe.status, 0, file + ' ' + bad);
      assert.match(probe.stderr, /VIP_COMMITMENT_HOURS/);
    }
  }
  const supersede = ({ E, P, db }) => {
    const a = E.precommit(db, { vip_id: 'cfg', budget_eur: 100 });
    try { return { hours: P.COMMITMENT_HOURS, second: E.precommit(db, { vip_id: 'cfg', budget_eur: 9000 }).session_id !== a.session_id }; }
    catch (e) { return { hours: P.COMMITMENT_HOURS, refused: e.message }; }
  };
  assert.deepEqual(inProcess({}, supersede), { hours: 24, refused: 'SESSION_LIVE' });
  assert.deepEqual(inProcess({ VIP_COMMITMENT_HOURS: '0' }, supersede), { hours: 0, second: true });
  assert.deepEqual(inProcess({ VIP_COMMITMENT_HOURS: '0.5' }, supersede), { hours: 0.5, refused: 'SESSION_LIVE' });
});

test('guest console checks a stake before reporting it, and a refused stake is never reported', async t => {
  const db = database(t), base = await listen(t, createServer(db));
  const html = await (await fetch(base + '/')).text();
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value:'', addEventListener() {} });
    return elements.get(id);
  };
  const context = vm.createContext({
    document: { querySelector:element, querySelectorAll:() => [] },
    fetch:(url, opts) => fetch(base + url, opts), crypto:globalThis.crypto
  });
  element('#vip').value = 'careful';
  element('#budget').value = '1000';
  element('#mode').value = 'hard_stop';
  element('#determined').checked = true;
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1],context);
  await vm.runInContext('reviewQuote()',context);
  await vm.runInContext('pre()',context);
  await vm.runInContext('checked(1500)',context);
  assert.equal(E.stateOf(db,'careful').consumed_eur,0,'a stake the check refused is not reported');
  assert.equal(E.stateOf(db,'careful').stopped,false);
  assert.match(element('#state').innerHTML,/Largest stake allowed now<\/th><td class="num">500\.00/);
  await vm.runInContext('checked(500)',context);
  const state = E.stateOf(db,'careful');
  assert.equal(state.stopped,true); assert.equal(state.consumed_eur,500); assert.equal(state.reserved_eur,0);
  const stop = JSON.parse(db.prepare("SELECT payload FROM events WHERE type='policy.stop'").get().payload);
  assert.equal(stop.overshoot_eur,0);
  assert.equal(db.prepare("SELECT count(*) n FROM events WHERE type='stake.refused'").get().n,1);
  const config = await (await fetch(base + '/vip/config')).json();
  assert.equal(config.commitment_hours,24); assert.equal(config.spec_routes.length,9);
});

// ── v3.22 / MVP v0.2.16 ────────────────────────────────────────────────────
// The changes made after the outside review of v3.21: the terms a guest agrees
// to and their version, the hold of a stopped session, the defaults for the
// reward cap and the determination lifetime, and the four demos and the index.

const DEFAULTS = { VIP_REWARD_CAP_EUR: undefined, VIP_ELIGIBILITY_TTL_DAYS: undefined };
function byReference(env, src) {
  return JSON.parse(execFileSync(process.execPath, ['-e', 'const r = require(process.argv[1]); process.stdout.write(JSON.stringify(' + src + '))', refPath],
    { cwd: __dirname, env: { ...process.env, ...env }, encoding: 'utf8' }));
}
const PACKAGE = path.join(__dirname, '..');
const inPackage = { skip: !fs.existsSync(path.join(PACKAGE, '00_INDEX.html')) };
function runPageScripts(html, ctx) {
  for (const [, src, inline] of html.matchAll(/<script(?: src="([^"]+)")?>([\s\S]*?)<\/script>/g)) {
    const code = src ? fs.readFileSync(path.join(PACKAGE, src), 'utf8') : inline;
    vm.runInContext(code, ctx);
  }
}
function offlineDemo(filename, values = {}) {
  const nodes = new Map();
  const node = key => {
    if (!nodes.has(key)) nodes.set(key, {
      value: values[key] ?? '', textContent:'', innerHTML:'', style:{},
      classList:{ add(){}, remove(){}, toggle(){} }, querySelectorAll(){ return []; }
    });
    return nodes.get(key);
  };
  const ctx = vm.createContext({ document:{ getElementById:node }, clearInterval(){}, setInterval(){ return 1; } });
  const html = fs.readFileSync(path.join(PACKAGE, filename), 'utf8');
  runPageScripts(html, ctx);
  return { node, ctx, html };
}

test('the terms carry a version that is their fingerprint, the same in both services and different when a term changes', () => {
  const P = require('./src/policy');
  const t = E.terms();
  assert.equal(t.terms_version, 'terms-' + require('node:crypto').createHash('sha256').update(P.canonicalTerms(t.terms)).digest('hex').slice(0, 12));
  assert.deepEqual(Object.keys(t.terms).sort(), ['advisory_escalate_fraction', 'advisory_nudge_fraction', 'commitment_hours', 'default_mode',
    'eligibility_default', 'eligibility_ttl_days', 'redirect_split', 'residual_to_guest_fraction', 'reward_cap_eur', 'rollover_fraction', 'stop_fraction']);
  assert.equal(t.terms.stop_fraction, 0.5); assert.equal(t.terms.commitment_hours, 24);
  if (ref) assert.deepEqual(ref.terms(), t);
  const ours = env => inProcess(env, ({ E }) => E.terms().terms_version);
  const seen = new Set([t.terms_version]);
  for (const env of [DEFAULTS, { VIP_THRESHOLD: '0.6' }, { VIP_REWARD_CAP_EUR: '2500' }, { VIP_ELIGIBILITY_TTL_DAYS: '30' },
                     { VIP_COMMITMENT_HOURS: '12' }, { VIP_SPLIT_RETAIL: '0' }, { VIP_MODE: 'advisory' }]) {
    const v = ours(env);
    assert.equal(seen.has(v), false, JSON.stringify(env)); seen.add(v);
    if (ref) assert.equal(byReference(env, 'r.TERMS_VERSION'), v, JSON.stringify(env));
  }
  // The same configuration keeps its version across a restart.
  assert.equal(ours({}), t.terms_version);
});

test('GET /v3/terms serves the terms over HTTP, and a version that is not in force arms nothing', async t => {
  const db = database(t), base = await listen(t, createServer(db));
  const terms = await (await fetch(base + '/v3/terms')).json();
  assert.deepEqual(terms, JSON.parse(JSON.stringify(E.terms())));
  const post = body => fetch(base + '/v3/precommit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    .then(async r => ({ status: r.status, body: await r.json() }));
  const refused = await post({ vip_id: 'http-terms', budget_eur: 500, terms_version: 'terms-ffffffffffff' });
  assert.equal(refused.status, 409); assert.equal(refused.body.error, 'TERMS_CHANGED'); assert.equal(refused.body.terms_version, terms.terms_version);
  assert.equal(db.prepare("SELECT count(*) n FROM sessions WHERE guest_id='http-terms'").get().n, 0);
  assert.equal(db.prepare("SELECT count(*) n FROM guests WHERE id='http-terms'").get().n, 0);
  const armed = await post({ vip_id: 'http-terms', budget_eur: 500, terms_version: terms.terms_version });
  assert.equal(armed.status, 201); assert.equal(armed.body.terms_version, terms.terms_version);
  assert.equal(db.prepare("SELECT terms_version FROM sessions WHERE guest_id='http-terms'").get().terms_version, terms.terms_version);
  assert.equal((await (await fetch(base + '/vip/config')).json()).terms_version, terms.terms_version);
});

test('an unconfigured install caps the incentive at €5,000 per stop and counts a determination for 90 days, in both services; off switches either off', () => {
  const probe = ({ E, P, db }) => {
    const now = new Date().toISOString();
    const big = P.settle(6000, 'permitted', now), canon = P.settle(5100, 'permitted', now);
    E.precommit(db, { vip_id: 'undated', budget_eur: 1000 });
    E.precommit(db, { vip_id: 'dated', budget_eur: 1000, eligibility_at: now });
    const undated = E.tick(db, { vip_id: 'undated', delta_eur: 500 }), dated = E.tick(db, { vip_id: 'dated', delta_eur: 500 });
    return { cap: P.REWARD_CAP_EUR, ttl: P.ELIGIBILITY_TTL_DAYS, big: [big.redirect, big.rollover, big.residual, big.capped],
             canon: [canon.redirect, canon.rollover, canon.residual, canon.capped], undated: undated.eligibility, dated: dated.eligibility };
  };
  const expected = { cap: 5000, ttl: 90, big: [3888.89, 1111.11, 1000, true], canon: [3570, 1020, 510, false], undated: 'suppressed', dated: 'permitted' };
  assert.deepEqual(inProcess(DEFAULTS, probe), expected);
  // Blank is read as unset, as for every other setting.
  assert.deepEqual(inProcess({ VIP_REWARD_CAP_EUR: '', VIP_ELIGIBILITY_TTL_DAYS: ' ' }, ({ P }) => [P.REWARD_CAP_EUR, P.ELIGIBILITY_TTL_DAYS]), [5000, 90]);
  assert.deepEqual(inProcess({ VIP_REWARD_CAP_EUR: 'Off', VIP_ELIGIBILITY_TTL_DAYS: 'OFF' }, ({ P }) => [P.REWARD_CAP_EUR, P.ELIGIBILITY_TTL_DAYS]), [null, null]);
  if (ref) {
    const src = "[r.REWARD_CAP_EUR, r.ELIGIBILITY_TTL_DAYS, ...['big', 'canon'].map((k, i) => { const s = r.settle(i ? 5100 : 6000, 'permitted', new Date().toISOString()); return [s.redirect, s.rollover, s.residual, s.capped]; })]";
    assert.deepEqual(byReference(DEFAULTS, src), [5000, 90, expected.big, expected.canon]);
    assert.deepEqual(byReference({ VIP_REWARD_CAP_EUR: 'off', VIP_ELIGIBILITY_TTL_DAYS: 'off' }, '[r.REWARD_CAP_EUR, r.ELIGIBILITY_TTL_DAYS]'), [null, null]);
  }
  for (const file of ['./src/policy', ...(ref ? [refPath] : [])]) {
    for (const [key, bad] of [['VIP_REWARD_CAP_EUR', '0'], ['VIP_REWARD_CAP_EUR', 'none'], ['VIP_ELIGIBILITY_TTL_DAYS', '-1'], ['VIP_ELIGIBILITY_TTL_DAYS', 'never']]) {
      const probeRun = require('node:child_process').spawnSync(process.execPath, ['-e', 'require(process.argv[1])', file],
        { cwd: __dirname, env: { ...process.env, [key]: bad }, encoding: 'utf8' });
      assert.notEqual(probeRun.status, 0, file + ' ' + key + '=' + bad);
      assert.match(probeRun.stderr, new RegExp(key + '.*or off'));
    }
  }
});

test('under the defaults the seeded quarter is still the canon quarter, and the cap binds on the live session with the larger room', () => {
  const r = inProcess(DEFAULTS, ({ E, db }) => {
    require('./src/seed').seed(db);
    const q = E.quarter(db);
    return { preserved: q.preserved_eur, redirected: q.redirected_eur, rollover: q.rollover_allocated_eur, residual: q.residual_to_guests_eur,
             issued: q.credits_issued.count, d1: E.stateOf(db, 'VIP-D01').incentive_preview, d1_eligibility: E.stateOf(db, 'VIP-D01').eligibility };
  });
  assert.deepEqual(r, { preserved: 306000, redirected: 214200, rollover: 61200, residual: 30600, issued: 180,
    d1: { redirect_eur: 3888.89, rollover_eur: 1111.11, residual_to_guest_eur: 600, capped: true }, d1_eligibility: 'permitted' });
});

test('with the commitment period at 0 a stopped guest may commit again at once, in both services', () => {
  const again = ({ E, db }) => {
    E.precommit(db, { vip_id: 'z', budget_eur: 100 }); E.tick(db, { vip_id: 'z', delta_eur: 50 });
    try { return E.precommit(db, { vip_id: 'z', budget_eur: 100 }).armed_at_eur; } catch (e) { return e.message; }
  };
  assert.equal(inProcess({ VIP_COMMITMENT_HOURS: '0' }, again), 50);
  assert.equal(inProcess({}, again), 'COMMITMENT_ACTIVE');
  if (ref) {
    const src = "(() => { r.precommit({ vip_id: 'z', budget_eur: 100 }); r.tick({ vip_id: 'z', delta_eur: 50 }); try { return r.precommit({ vip_id: 'z', budget_eur: 100 }).armed_at_eur; } catch (e) { return e.message; } })()";
    assert.equal(byReference({ VIP_COMMITMENT_HOURS: '0' }, src), 50);
    assert.equal(byReference({}, src), 'COMMITMENT_ACTIVE');
  }
});

test('a database written before 0.2.16 gains the terms column, and its sessions keep null there', t => {
  const file = path.join(tempDir(t), 'before-terms.db');
  let db = S.open(file);
  E.precommit(db, { vip_id: 'older', budget_eur: 1000 });
  db.exec('ALTER TABLE sessions DROP COLUMN terms_version');
  db.close();
  db = S.open(file);
  t.after(() => db.close());
  assert.equal(E.stateOf(db, 'older').terms_version, null);
  assert.equal(E.precommit(db, { vip_id: 'newer', budget_eur: 10 }).terms_version, E.terms().terms_version);
  assert.equal(B.verify(db).valid, true);
});

test('the guest console shows the terms, sends their version and the determination, and requires a fresh review when terms change', async t => {
  const db = database(t), base = await listen(t, createServer(db));
  const html = await (await fetch(base + '/')).text();
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value:'', addEventListener() {} });
    return elements.get(id);
  };
  const context = vm.createContext({
    document: { querySelector:element, querySelectorAll:() => [] },
    fetch:(url, opts) => fetch(base + url, opts), crypto:globalThis.crypto
  });
  element('#vip').value = 'informed'; element('#budget').value = '1000'; element('#mode').value = 'hard_stop';
  element('#determined').checked = true;
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context);
  await vm.runInContext('pre()', context);
  assert.equal(E.latest(db, 'informed'), undefined);
  await vm.runInContext('reviewQuote()', context);
  const version = E.terms().terms_version;
  assert.match(element('#terms').textContent, new RegExp('^Terms ' + version));
  assert.match(element('#line').textContent, /Hard-Stop locks play/);
  vm.runInContext("review.quote.terms_version='terms-000000000000'", context);
  await vm.runInContext('pre()', context);
  assert.equal(E.latest(db, 'informed'), undefined, 'different terms arm nothing');
  assert.equal(element('#confirm').disabled, true);
  await vm.runInContext('reviewQuote()', context);
  assert.equal(vm.runInContext('review.quote.terms_version', context), version);
  await vm.runInContext('pre()', context);
  const s = E.latest(db, 'informed');
  assert.equal(s.terms_version, version); assert.equal(s.budget_eur, 1000);
  assert.ok(Number.isFinite(Date.parse(s.eligibility_at)) && Date.parse(s.eligibility_at) <= Date.now());
  assert.equal(E.receipt(db,'informed').agreement.confirmation,'quote_confirmed');
});

test('the index and the guide link to every demo, and every local link in the pages resolves', inPackage, () => {
  const demos = ['05a_Demo_A_Screens.html', '05b_Demo_B_Policy_Engine.html', '05c_Demo_C_Synthetic_Case_Study.html', '05d_Demo_D_Narrative_Proof.html'];
  for (const page of ['00_INDEX.html', '05_Demo_Guide.html']) {
    const html = fs.readFileSync(path.join(PACKAGE, page), 'utf8');
    for (const d of demos) assert.ok(html.includes('href="' + d + '"'), page + ' links ' + d);
  }
  let links = 0;
  for (const page of fs.readdirSync(PACKAGE).filter(f => f.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(PACKAGE, page), 'utf8');
    for (const [, href] of html.matchAll(/href="([^"]+)"/g)) {
      if (/^(https?:|mailto:|#)/.test(href)) continue;
      links++;
      assert.ok(fs.existsSync(path.join(PACKAGE, href.split('#')[0])), page + ' → ' + href);
    }
  }
  assert.ok(links >= 40, 'links checked: ' + links);
});

test('Demo C shows issued, redeemed and still-owed credit, can show a retention worse than the stop alone, and keeps the canon band', inPackage, () => {
  const c = offlineDemo('05c_Demo_C_Synthetic_Case_Study.html', { n:60, p:5100, g:70, q:50, r:84 });
  const shown = id => c.node(id).textContent;
  assert.deepEqual(['tIss', 'tRed', 'tOpen', 'tRoll', 'tRollOpen', 'tRes', 'tOwed'].map(shown),
    ['€214,200', '€107,100', '€107,100', '€61,200', '€61,200', '€30,600', '€168,300']);
  assert.equal(shown('mPre'), '€306K'); assert.equal(shown('mRed'), '€214K');
  assert.doesNotMatch(c.node('verd').innerHTML, /fewer guests than the stop alone/);
  c.node('r').value = 55; c.node('r').oninput();
  assert.match(c.node('verd').innerHTML, /keeps fewer guests than the stop alone/);
  c.node('p3').onclick();
  assert.equal(c.node('r').value, 52); assert.equal(c.node('g').value, 40);
  assert.match(c.html, /id="r" min="40" max="92"/);
  assert.match(c.html, /id="g" min="40" max="80"/);
  for (const id of ['n', 'p', 'g', 'q', 'r']) {
    assert.match(c.html, new RegExp('<label for="' + id + '">'));
    assert.match(c.html, new RegExp('id="' + id + '"[^>]*aria-describedby="h' + id.toUpperCase() + '"'));
  }
  const canon = JSON.parse(fs.readFileSync(path.join(PACKAGE, '12_Canon.json'), 'utf8'));
  assert.match(canon.model_figures._figure_kinds.non_gaming_capture, /Demo slider band 40–80%/);
});

test('Demo D can be driven from the keyboard, and Demo A shows the version of the terms the engine publishes by default', inPackage, () => {
  const d = offlineDemo('05d_Demo_D_Narrative_Proof.html');
  assert.match(d.html, /role=listitem tabindex=0/);
  assert.match(d.html, /k\.key==="Enter"\|\|k\.key===" "/);
  assert.match(d.html, /ArrowDown/);
  vm.runInContext('go(4,false)', d.ctx);
  assert.equal(d.ctx.cur, 4);
  assert.match(d.node('nt').textContent, /^W8/);
  const a = offlineDemo('05a_Demo_A_Screens.html');
  const version = inProcess(DEFAULTS, ({ E }) => E.terms().terms_version);
  assert.equal(a.ctx.TERMS_VERSION, version);
  vm.runInContext("step=3;decision='permitted';armed=true;draw()", a.ctx);
  assert.match(a.node('stage').innerHTML, new RegExp('terms ' + version));
  vm.runInContext("step=2;decision='permitted';armed=false;draw()", a.ctx);
  assert.match(a.node('stage').innerHTML, /<label for=slr>/);
});

test('on a phone the control panel of Demos B and C scrolls with the page instead of covering the results, the settlement table keeps its column names, and no card grid is wider than the screen', inPackage, () => {
  const pages = fs.readdirSync(PACKAGE).filter(f => f.endsWith('.html'));
  const withPanel = pages.filter(f => fs.readFileSync(path.join(PACKAGE, f), 'utf8').includes('class="ctrlcard"'));
  assert.deepEqual(withPanel.sort(), ['05b_Demo_B_Policy_Engine.html', '05c_Demo_C_Synthetic_Case_Study.html']);
  for (const f of pages) {
    const html = fs.readFileSync(path.join(PACKAGE, f), 'utf8');
    if (!html.includes('.ctrlcard{')) continue;
    assert.match(html, /\.ctrlcard\{[^}]*position:sticky[^}]*max-height:calc\(100vh - 32px\);overflow-y:auto\}/, f);
    assert.match(html, /@media\(max-width:860px\)\{\.ctrlcard\{position:static;max-height:none;overflow:visible\}\}/, f);
  }
  for (const f of pages) {
    const html = fs.readFileSync(path.join(PACKAGE, f), 'utf8');
    assert.doesNotMatch(html, /minmax\(\d+px,1fr\)/, f);
  }
  const c = offlineDemo('05c_Demo_C_Synthetic_Case_Study.html');
  assert.match(c.html, /\.calcgrid\{[^}]*grid-template-columns:300px minmax\(0,1fr\)/);
  for (const id of ['tIss', 'tRed', 'tOpen', 'tRoll', 'tRollOpen', 'tRes', 'tOwed']) {
    assert.match(c.html, new RegExp('data-h="(Issued|Redeemed or used|Still owed)" id="' + id + '"'), id);
  }
  assert.match(c.html, /table\.settle td\[data-h\]::before\{content:attr\(data-h\)/);
});

// v3.23. These scenarios exercise UI entry points, the local wire format and real restarts.
function confirmation(input, offer) {
  return { ...input, review_id: offer.review_id, quote_id: offer.quote_id, terms_version: offer.terms_version };
}
test('review is read-only and binds the guest, budget, mode, decision and terms to the confirmed receipt', t => {
  const db = database(t);
  const input = { vip_id:'reader', budget_eur:20000, mode:'hard_stop', eligibility:'permitted', eligibility_at:new Date().toISOString() };
  const offer = E.quote(db, input), body = confirmation(input, offer);
  assert.equal(db.prepare('SELECT count(*) n FROM guests').get().n,0);
  assert.equal(db.prepare('SELECT count(*) n FROM events').get().n,0);
  for (const change of [{vip_id:'other'}, {budget_eur:19999}, {mode:'advisory'}, {eligibility:'suppressed'}, {quote_id:'old'}]) {
    assert.throws(()=>E.confirm(db,{...body,...change}), /QUOTE_CHANGED/);
  }
  assert.equal(E.latest(db,'reader'),undefined);
  const a=E.confirm(db,body), rec=E.receipt(db,'reader',a.session_id);
  assert.deepEqual(rec.agreement,{...offer,confirmation:'quote_confirmed'});
  assert.equal(rec.agreement.terms_version,E.terms().terms_version);
  assert.throws(()=>E.receipt(db,'other',a.session_id),/SESSION_UNKNOWN/);
  assert.equal(B.verify(db).valid,true);
});

test('a withdrawal between review and confirmation invalidates the offer and the next quote shows the guest their full balance', t => {
  const db=database(t), input={vip_id:'withdrawn',budget_eur:20000,eligibility_at:new Date().toISOString()};
  const previous=E.quote(db,input);
  E.programmeSuppress(db,{vip_id:input.vip_id,reason:'player_request'});
  assert.throws(()=>E.confirm(db,confirmation(input,previous)),/QUOTE_CHANGED/);
  assert.equal(E.latest(db,input.vip_id),undefined);
  const offer=E.quote(db,input);
  assert.deepEqual([offer.at_line.redirect,offer.at_line.rollover,offer.at_line.residual],[0,0,10000]);
  E.confirm(db,confirmation(input,offer));
  assert.equal(E.tick(db,{vip_id:input.vip_id,delta_eur:10000}).eligibility,'suppressed');
});

test('repeated concurrent HTTP confirmations return one session and the same receipt', async t => {
  const db=database(t), base=await listen(t,createServer(db));
  async function post(route, payload) {
    const resp = await fetch(base+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
    return {status:resp.status,body:await resp.json()};
  }
  const input={vip_id:'twice',budget_eur:1000}, q=await post('/vip/quote',input);
  const body=confirmation(input,q.body);
  const responses=await Promise.all(Array.from({length:5},()=>post('/vip/confirm',body)));
  assert.equal(responses[0].status,201);
  for(const r of responses) assert.deepEqual(r,responses[0]);
  assert.equal(db.prepare("SELECT count(*) n FROM events WHERE type='precommit'").get().n,1);
  assert.equal((await post('/vip/confirm',{...body,budget_eur:2000})).status,409);
  const state=await (await fetch(base+'/vip/session/receipt?vip_id=twice&session_id='+responses[0].body.session_id)).json();
  assert.equal(state.agreement.review_id,q.body.review_id);
});

test('fresh review IDs permit a new explicit decision when the commitment is genuinely over', () => {
  const run=inProcess({VIP_COMMITMENT_HOURS:'0'},({E,db})=>{
    const input={vip_id:'again',budget_eur:100};
    const q=E.quote(db,input), first={...input,review_id:q.review_id,quote_id:q.quote_id};
    const a=E.confirm(db,first); E.tick(db,{vip_id:'again',delta_eur:50});
    const replay=E.confirm(db,first), second=E.quote(db,input);
    const b=E.confirm(db,{...input,review_id:second.review_id,quote_id:second.quote_id});
    return [a.session_id===replay.session_id,q.review_id!==second.review_id,a.session_id!==b.session_id];
  });
  assert.deepEqual(run,[true,true,true]);
});

test('legacy and API-created sessions never acquire a simulated guest confirmation', t => {
  const file=path.join(tempDir(t),'old.db');
  let db=S.open(file);
  E.precommit(db,{vip_id:'old',budget_eur:500});
  db.exec('ALTER TABLE sessions DROP COLUMN agreement_json'); db.close();
  db=S.open(file); t.after(()=>db.close());
  assert.equal(E.receipt(db,'old').agreement,null);
  E.tick(db,{vip_id:'old',delta_eur:250});
  assert.equal(E.receipt(db,'old').events[0].policy.reason,'legacy_terms_unavailable');
  E.precommit(db,{vip_id:'raw',budget_eur:500});
  E.precommit(db,{vip_id:'version',budget_eur:500,terms_version:E.terms().terms_version});
  assert.equal(E.receipt(db,'raw').agreement.confirmation,'configured_only');
  assert.equal(E.receipt(db,'version').agreement.confirmation,'version_supplied');
  assert.equal(B.verify(db).valid,true);
});

test('an accepted €5,000 cap survives a restart with looser rules; a tighter €2,000 cap leaves a reconciled audit record', t => {
  const file=path.join(tempDir(t),'terms.db'), config={...DEFAULTS, VIP_DB:file};
  const arm=({E,db},id)=>{
    const b={vip_id:id,budget_eur:20000,eligibility_at:new Date().toISOString()};
    const q=E.quote(db,b); E.confirm(db,{...b,quote_id:q.quote_id,review_id:q.review_id});
    return q.terms_version;
  };
  const saved=inProcess(config,({E,db})=>{
    const input={vip_id:'retry-restart',budget_eur:20000}, q=E.quote(db,input);
    const body={...input,review_id:q.review_id,quote_id:q.quote_id,terms_version:q.terms_version};
    return {body,result:E.confirm(db,body)};
  });
  const replay=inProcess({...config,VIP_REWARD_CAP_EUR:'2000'},({E,db},body)=>E.confirm(db,body),saved.body);
  assert.deepEqual(replay,saved.result);
  const first=inProcess(config,arm,'tight');
  inProcess(config,arm,'loose');inProcess(config,arm,'issue');
  function stop({E,db},id) {
    E.tick(db,{vip_id:id,delta_eur:10000});
    const receipt=E.receipt(db,id), event=receipt.events.find(e=>e.type==='policy.stop');
    return {guest:event.residual_to_guest_eur,agreement:receipt.agreement.at_line.residual,policy:event.policy};
  }
  const tight=inProcess({...config,VIP_REWARD_CAP_EUR:'2000'},stop,'tight');
  assert.equal(tight.guest,8000);assert.equal(tight.agreement,5000);
  assert.equal(tight.policy.agreed_version,first);assert.notEqual(tight.policy.current_version,first);
  assert.equal(tight.policy.reason,'original_and_current_limits');
  assert.equal(tight.policy.current_terms.reward_cap_eur,2000);
  const loose=inProcess({...config,VIP_REWARD_CAP_EUR:'off'},stop,'loose');
  assert.equal(loose.guest,5000);
  inProcess(config,stop,'issue');
  const issued=inProcess({...config,VIP_REWARD_CAP_EUR:'2000'},({E,db})=>{
    const r=E.redirectIssue(db,{vip_id:'issue'}),e=E.receipt(db,'issue').events.at(-1);
    return [r.residual,e.type,e.policy.reason,e.policy.agreed_version,e.policy.current_version];
  });
  assert.deepEqual(issued,[8000,'redirect.issue','original_and_current_limits',first,tight.policy.current_version]);
});

test('the original hold, advisory warning lines and expiry survive a restart with relaxed settings', t => {
  const config={VIP_DB:path.join(tempDir(t),'hold.db'),VIP_COMMITMENT_HOURS:'24',VIP_ELIGIBILITY_TTL_DAYS:'2'};
  inProcess(config,({E,db})=>{
    const time=new Date(Date.now()-86400000).toISOString();
    E.precommit(db,{vip_id:'policy',mode:'advisory',budget_eur:1000,eligibility_at:time});
    E.precommit(db,{vip_id:'aging',budget_eur:1000,eligibility_at:time});
    return true;
  });
  const result=inProcess({...config,VIP_COMMITMENT_HOURS:'0',VIP_NUDGE:'.75',VIP_ESCALATE:'.95',VIP_ELIGIBILITY_TTL_DAYS:'off'},({E,db})=>{
    const t=E.tick(db,{vip_id:'policy',delta_eur:450});
    let refusal;try{E.precommit(db,{vip_id:'policy',budget_eur:2000})}catch(e){refusal=e.message}
    const clock=Date.now;Date.now=()=>clock()+2*86400000;
    try {
      const expiry=E.tick(db,{vip_id:'aging',delta_eur:500});
      const events=E.audit(db,E.latest(db,'aging').id).events;
      return [t.state.nudge_active,refusal,expiry.eligibility,expiry.residual_to_guest_eur,events.find(e=>e.type==='eligibility.expired').ttl_days];
    }finally{Date.now=clock}
  });
  assert.deepEqual(result,[true,'SESSION_LIVE','suppressed',500,2]);
});

test('Demo B renders the same guest receipt as the default engine on both checked and reported-only stakes',inPackage,()=>{
  const expected=inProcess(DEFAULTS,({P},values)=>values.map(v=>P.settle(v,'permitted',new Date().toISOString())),[10000,9100]);
  for(const checked of [true,false]){
    const b=offlineDemo('05b_Demo_B_Policy_Engine.html',{s:50,r:70});
    if(!checked)b.node('cA').onclick();
    for(let i=0;i<50&&!b.ctx.fired;i++)b.node('deal').onclick();
    assert.equal(b.ctx.fired,true);
    const preserved=20000-b.ctx.dd;
    const amounts=expected[0].preserved===preserved?expected[0]:inProcess(DEFAULTS,({P},x)=>P.settle(x,'permitted',new Date().toISOString()),preserved);
    const formatted=vm.runInContext('fmc',b.ctx);
    for(const field of ['redirect','rollover','residual'])assert.ok(b.node('amounts').textContent.includes(formatted(amounts[field])));
    assert.match(b.node('log').innerHTML,/cap applied/);
    b.node('reset').onclick();b.node('mH').onclick();
    for(let i=0;i<50&&!b.ctx.fired;i++)b.node('deal').onclick();
    assert.match(b.node('amounts').textContent,/Resort services €0 · future-play credit €0/);
    assert.ok(b.node('amounts').textContent.includes(formatted(preserved)));
  }
});

test('Demo C applies the cap before aggregation and resets all five inputs on the Ceiling preset',inPackage,()=>{
  const c=offlineDemo('05c_Demo_C_Synthetic_Case_Study.html',{n:60,p:5100,g:70,q:50,r:84});
  c.node('q').value=10; c.node('p2').onclick();
  const per=inProcess({...DEFAULTS,VIP_SPLIT_SPA:'.4',VIP_SPLIT_FNB:'.25',VIP_SPLIT_RETAIL:'.15'},({P})=>P.settle(8000,'permitted',new Date().toISOString()));
  for(const [id,value] of [['tIss',per.redirect],['tRoll',per.rollover],['tRes',per.residual]]){
    assert.equal(c.node(id).textContent,'€'+(value*110).toLocaleString('en-US'));
  }
  assert.equal(c.node('q').value,50);
  assert.match(c.node('capStatus').textContent,/€550,000.*€330,000/);
  c.node('q').value=100;c.node('q').oninput();assert.equal(c.node('tOpen').textContent,'€0');
  c.node('q').value=0;c.node('q').oninput();assert.equal(c.node('tOwed').textContent,'€550,000');
});

test('Demo A offers a real decline, a protected stop without incentives and a capped receipt',inPackage,()=>{
  for(const permitted of [true,false]){
    const a=offlineDemo('05a_Demo_A_Screens.html');
    vm.runInContext('go(1)',a.ctx); a.node(permitted?'allow':'withhold').onclick();
    vm.runInContext('go(2)',a.ctx);a.node('slr').oninput.call({value:'20000'});
    vm.runInContext('go(3)',a.ctx);
    assert.match(a.node('stage').innerHTML,permitted?/€3,888.89/:/€10,000/);
    a.node('decline').onclick();assert.equal(a.ctx.armed,false);
    vm.runInContext('go(5)',a.ctx);assert.match(a.node('stage').innerHTML,/accept the amounts/);
    vm.runInContext('go(2);go(3)',a.ctx);a.node('arm').onclick();
    vm.runInContext('go(4)',a.ctx);a.node('fire').onclick();vm.runInContext('go(5)',a.ctx);
    assert.match(a.node('stage').innerHTML,permitted?/€5,000/:/Benefits withheld/);
  }
});

test('the shared cents calculation agrees with the independent reference at the cap boundary and across all Demo B share settings',inPackage,()=>{
  const math=require('./src/settlement');
  const inputs=[0,.01,5100,5555.55,5555.56,5555.57,8000,10000,12000];
  const expected=inProcess(DEFAULTS,({P},xs)=>xs.map(v=>P.settle(v,'permitted',new Date().toISOString())),inputs);
  for(const [i,n] of inputs.entries()){
    const actual=math.demoSettlement(n);
    assert.deepEqual([actual.redirect,actual.rollover,actual.residual,actual.credits,actual.capped],
      [expected[i].redirect,expected[i].rollover,expected[i].residual,expected[i].credits,expected[i].capped]);
  }
  for(let share=40;share<=80;share++){
    for(const n of inputs){
      const q=math.demoSettlement(n,share);
      const cents=x=>Math.round(x*100);
      assert.equal(cents(q.redirect)+cents(q.rollover)+cents(q.residual),cents(n));
      assert.ok(cents(q.redirect)+cents(q.rollover)<=500000);
    }
  }
  if(ref){
    const result=byReference(DEFAULTS,"[0.01,5100,5555.55,5555.56,5555.57,8000,10000].map(v=>r.settle(v,'permitted',new Date().toISOString()))");
    for(const entry of result) assert.deepEqual(math.demoSettlement(entry.preserved).credits,entry.credits);
  }
});

test('pilot worksheet starts empty, rejects inconsistent counts and reports absolute rates with uncertainty',inPackage,()=>{
  const d=offlineDemo('16_Evaluation.html');
  const result=()=>d.node('calculated').textContent;
  assert.equal(result(),'Enter all four counts.');
  for(const [id,n] of Object.entries({xt:30,nt:100,xc:20,nc:100}))d.node(id).value=n;
  d.node('nt').oninput();
  assert.match(result(),/30.0% \(30\/100\).*20.0% \(20\/100\).*10.0 percentage points/);
  // For no events in the first group and all ten in the second, Wilson's
  // nonzero endpoint is z²/(10+z²), which also fixes the Newcombe upper limit.
  const limits=d.ctx.compareVisits(0,10,10,10);
  assert.equal(limits.lower,-1);
  assert.ok(Math.abs(limits.upper-(-1+Math.SQRT2*3.841458820694124/(10+3.841458820694124)))<1e-10);
  d.node('nt').value=0; d.node('nt').oninput();assert.match(result(),/each group needs/i);
  d.node('nt').value=29; d.node('nt').oninput();assert.match(result(),/visits cannot exceed/);
});

test('every text file names its owner, in the MVP and, when present, in the whole package', () => {
  const roots = [__dirname];
  if (!inPackage.skip) roots.push(PACKAGE);
  const skipDir = new Set(['.git', 'node_modules', 'data']);
  const binary = /\.(docx|png|jpe?g|gif|ico|pdf|zip|db|db-wal|db-shm|sqlite)$/i;
  const missing = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (!skipDir.has(entry.name)) walk(full); continue; }
      if (!entry.isFile() || binary.test(entry.name)) continue;
      if (!fs.readFileSync(full, 'utf8').includes('Miloš Petrović')) missing.push(path.relative(PACKAGE, full));
    }
  };
  for (const root of roots) walk(root);
  assert.deepEqual([...new Set(missing)], []);
});

test('on the project site the MVP guide opens its Markdown links on GitHub, and a downloaded copy keeps them local', () => {
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  assert.match(html, /href="README\.md"/);
  assert.match(html, /href="INTEGRATION\.md"/);
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const site = 'https://trenchlogicstudio-web.github.io/VIP-SmartContract-Demonstration/13_VIP_MVP/';
  const online = [{ href: site + 'README.md' }, { href: site + 'INTEGRATION.md' }];
  require('node:vm').runInNewContext(script, { location: { href: site + 'index.html' }, document: { querySelectorAll: () => online } });
  assert.deepEqual(online.map(a => a.href), ['README.md', 'INTEGRATION.md']
    .map(f => 'https://github.com/trenchlogicstudio-web/VIP-SmartContract-Demonstration/blob/main/13_VIP_MVP/' + f));
  const offline = [{ href: 'file:///x/13_VIP_MVP/README.md' }];
  require('node:vm').runInNewContext(script, { location: { href: 'file:///x/13_VIP_MVP/index.html' }, document: { querySelectorAll: () => offline } });
  assert.equal(offline[0].href, 'file:///x/13_VIP_MVP/README.md');
});

test('future-play credit switches off in both services: its share stays with the guest, the published terms show it, and a misspelt value refuses to start', () => {
  const probe = ({ P, E }) => {
    const now = new Date().toISOString();
    return { fp: P.FUTURE_PLAY, rollover: P.TERMS.rollover_fraction, version: E.terms().terms_version,
      small: P.settle(2000, 'permitted', now), big: P.settle(10000, 'permitted', now) };
  };
  const on = inProcess(DEFAULTS, probe), off = inProcess({ ...DEFAULTS, VIP_FUTURE_PLAY: 'off' }, probe);
  assert.equal(on.fp, 'on'); assert.equal(on.rollover, 0.2);
  assert.deepEqual([on.small.redirect, on.small.rollover, on.small.residual], [1400, 400, 200]);
  assert.equal(off.fp, 'off'); assert.equal(off.rollover, 0);
  assert.deepEqual([off.small.redirect, off.small.rollover, off.small.residual], [1400, 0, 600]);
  // At €10,000 preserved the €5,000 ceiling binds either way; switched off, all of it is resort credit.
  assert.deepEqual([off.big.redirect, off.big.rollover, off.big.residual, off.big.capped], [5000, 0, 5000, true]);
  assert.notEqual(off.version, on.version);
  // The stricter setting wins over a configured rollover, and blank or "on" changes nothing.
  assert.deepEqual(inProcess({ ...DEFAULTS, VIP_FUTURE_PLAY: ' OFF ', VIP_ROLLOVER: '0.20' }, probe), off);
  assert.deepEqual(inProcess({ ...DEFAULTS, VIP_FUTURE_PLAY: '' }, probe), on);
  assert.deepEqual(inProcess({ ...DEFAULTS, VIP_FUTURE_PLAY: 'On' }, probe), on);
  if (ref) {
    const env = { ...DEFAULTS, VIP_FUTURE_PLAY: 'off' };
    assert.deepEqual(byReference(env, "[r.FUTURE_PLAY, r.TERMS_VERSION, r.settle(2000, 'permitted', new Date().toISOString()).rollover]"),
      ['off', off.version, 0]);
  }
  for (const file of ['./src/policy', ...(ref ? [refPath] : [])]) {
    for (const bad of ['of', 'false', '0', 'no']) {
      const run = require('node:child_process').spawnSync(process.execPath, ['-e', 'require(process.argv[1])', file],
        { cwd: __dirname, env: { ...process.env, VIP_FUTURE_PLAY: bad }, encoding: 'utf8' });
      assert.notEqual(run.status, 0, file + ' VIP_FUTURE_PLAY=' + bad);
      assert.match(run.stderr, /VIP_FUTURE_PLAY must be on or off/);
    }
  }
});

test('Demos B and C switch future-play credit off exactly as the engine does, and the presets return to the reference setting', inPackage, () => {
  const engine = inProcess({ ...DEFAULTS, VIP_FUTURE_PLAY: 'off' }, ({ P }, values) =>
    values.map(v => P.settle(v, 'permitted', new Date().toISOString())), [10000, 5100]);
  const b = offlineDemo('05b_Demo_B_Policy_Engine.html', { s: 50, r: 70 });
  assert.equal(b.ctx.fp, true);
  b.node('fX').onclick();
  for (let i = 0; i < 50 && !b.ctx.fired; i++) b.node('deal').onclick();
  assert.equal(b.ctx.fired, true);
  assert.equal(20000 - b.ctx.dd, engine[0].preserved);
  const formatted = vm.runInContext('fmc', b.ctx);
  for (const field of ['redirect', 'rollover', 'residual']) assert.ok(b.node('amounts').textContent.includes(formatted(engine[0][field])), field);
  assert.match(b.node('amounts').textContent, /future-play credit €0/);
  assert.match(b.node('log').innerHTML, /Future-play credit off/);
  const c = offlineDemo('05c_Demo_C_Synthetic_Case_Study.html', { n: 60, p: 5100, g: 70, q: 50, r: 84 });
  assert.equal(c.node('tRoll').textContent, '€61,200');
  c.node('fX').onclick();
  assert.equal(c.ctx.FP, false);
  assert.equal(c.node('tRollPct').textContent, 'off');
  assert.equal(c.node('tRoll').textContent, '€0');
  assert.equal(c.node('tIss').textContent, '€' + (engine[1].redirect * 60).toLocaleString('en-US'));
  assert.equal(c.node('tRes').textContent, '€' + (engine[1].residual * 60).toLocaleString('en-US'));
  assert.match(c.node('verd').innerHTML, /future-play credit off/);
  c.node('p1').onclick();
  assert.equal(c.ctx.FP, true);
  assert.equal(c.node('tRoll').textContent, '€61,200');
});
