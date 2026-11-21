#!/usr/bin/env node
/**
 * VIP SmartContract — Integration Reference · v3.22 · registry slot 04b
 * Copyright (c) 2026 Miloš Petrović (Trench Logic Studio) · SPDX-License-Identifier: MIT
 * A runnable reference for feasibility evaluation, not a deployable production system.
 *
 * Serves all nine routes declared in 04_API_Spec.yaml, with zero dependencies
 * on Node >= 18. State is in memory by design — this is a reference, so 04c
 * declares no database and none is needed.
 *
 * Middleware position: funds never go on chain, rules stay off chain, only the
 * audit proof is hash-anchored.
 *
 * Every value below resolves in 12_Canon.json. If this file and the canon
 * disagree, the canon is right.
 */

'use strict';
const http = require('http');
const crypto = require('crypto');

// ── configuration ─────────────────────────────────────────────────────────
// Every threshold is a per-jurisdiction configurable. Each one is validated at
// startup and the process REFUSES TO START on a bad value. Guarding the input
// alone is not enough: `x > NaN` is false in JavaScript, so a non-finite
// threshold silently turns an upper-bound test into a gate that admits
// everything. A threshold that is not a finite number in range must stop the
// process, not degrade it.
//
// Run directly, a refusal is one sentence and exit code 1. Loaded as a module
// (the MVP suite does), it is an exception the caller can assert on.
function refuse(msg) {
  if (require.main === module) {
    console.error('\n  VIP reference cannot start: ' + msg + '\n');
    process.exit(1);
  }
  throw new Error(msg);
}
function num(key, fallback, lo, hi) {
  const raw = process.env[key];
  const v = raw === undefined ? fallback : Number(raw);
  if ((raw !== undefined && raw.trim() === '') || !Number.isFinite(v) || v < lo || v > hi) {
    refuse(`${key} must be a finite number in [${lo}, ${hi}], got "${raw}". Refusing to start.`);
  }
  return v;
}
const MODES = ['hard_stop', 'advisory'];
const MODE = process.env.VIP_MODE ?? 'hard_stop';
if (!MODES.includes(MODE)) {
  refuse(`VIP_MODE must be one of ${MODES.join(' | ')}, got "${process.env.VIP_MODE}". Refusing to start.`);
}
const CFG = {
  mode: MODE,
  threshold: num('VIP_THRESHOLD', 0.50, 0.05, 0.95),   // canon thresholds.hard_stop_fraction
  nudge: num('VIP_NUDGE', 0.40, 0.05, 0.95),           // canon thresholds.advisory_nudge_fraction
  escalate: num('VIP_ESCALATE', 0.85, 0.05, 0.99),     // canon thresholds.advisory_escalate_fraction
  rollover: num('VIP_ROLLOVER', 0.20, 0, 1),           // canon thresholds.rollover_fraction
  // canon thresholds.redirect_split — per-jurisdiction configurable like every
  // threshold above, validated by the same rule.
  split: {
    spa: num('VIP_SPLIT_SPA', 0.30, 0, 1),
    fnb: num('VIP_SPLIT_FNB', 0.25, 0, 1),
    retail: num('VIP_SPLIT_RETAIL', 0.15, 0, 1)
  },
  port: num('PORT', 8080, 1, 65535)
};
if (!Number.isInteger(CFG.port)) {
  refuse(`PORT must be a whole number in [1, 65535], got "${process.env.PORT}". Refusing to start.`);
}
// ── money in integer cents ────────────────────────────────────────────────
// Every decision that involves money is taken on INTEGER CENTS, and every
// configured fraction is read as an integer number of millionths. Floating
// point displays a ratio; it never decides one. A share computed as
// cents x 0.25 / 0.7000000000000001 carries a rounding error that decides the
// ties the largest-remainder rule gives to position, and the same error let the
// published amount fall a cent below the stop line it named. With integers the
// split follows its rule to the cent and armed_at_eur is the first cent at
// which the policy fires. A fraction is read to six decimal places; no amount
// above MAX_EUR is accepted, so every product below is an exact integer.
const MICRO = 1000000;
const MAX_EUR = 10000000;
function decimalParts(value) {
  const [mantissa, power = '0'] = String(value).toLowerCase().split('e');
  const [whole, fraction = ''] = mantissa.split('.');
  const digits = BigInt(whole + fraction);
  return { digits, places: fraction.length - Number(power) };
}

function addDecimal(left, right) {
  const a = decimalParts(left);
  const b = decimalParts(right);
  const places = Math.max(0, a.places, b.places);
  const sum = a.digits * 10n ** BigInt(places - a.places) +
              b.digits * 10n ** BigInt(places - b.places);
  if (!places) return String(sum);
  const digits = String(sum < 0n ? -sum : sum).padStart(places + 1, '0');
  const fraction = digits.slice(-places).replace(/0+$/, '');
  return (sum < 0n ? '-' : '') + digits.slice(0, -places) + (fraction ? '.' + fraction : '');
}

function cents(value, roundDown = false) {
  if (typeof value === 'number' && Number.isSafeInteger(value * 100)) return value * 100;
  const { digits, places } = decimalParts(value);
  if (places <= 2) return Number(digits * 10n ** BigInt(2 - places));
  const divisor = 10n ** BigInt(places - 2);
  const whole = digits / divisor;
  const remainder = digits % divisor;
  if (roundDown) return Number(remainder < 0n ? whole - 1n : whole);
  if (remainder * 2n >= divisor) return Number(whole + 1n);
  if (remainder * 2n < -divisor) return Number(whole - 1n);
  return Number(whole);
}

function validVip(value) {
  return typeof value === 'string' && value.trim().length > 0 &&
         !/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value);
}

// The wire format requires a calendar date and a time zone. Date.parse alone
// accepts local dates and normalizes impossible dates such as February 30.
function determinationTime(value) {
  if (typeof value !== 'string') return NaN;
  const m = /^(\d{4})-(\d\d)-(\d\d)[tT](?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:[zZ]|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
  if (!m) return NaN;
  const date = new Date(m[1] + '-' + m[2] + '-' + m[3] + 'T00:00:00Z');
  if (!Number.isFinite(date.getTime()) || date.getUTCDate() !== Number(m[3])) return NaN;
  return Date.parse(value);
}
const eur = c => Math.round(c) / 100;        // whole cents in: a stray fraction of a cent is rounded here, never carried
const micro = x => Math.round(x * MICRO);
const W = {
  threshold: micro(CFG.threshold), nudge: micro(CFG.nudge), escalate: micro(CFG.escalate),
  rollover: micro(CFG.rollover),
  spa: micro(CFG.split.spa), fnb: micro(CFG.split.fnb), retail: micro(CFG.split.retail)
};
if (W.nudge > W.escalate) {
  refuse('VIP_NUDGE must be at or below VIP_ESCALATE. Refusing to start.');
}
W.redirect = W.spa + W.fnb + W.retail;
if (W.rollover + W.redirect > MICRO) {
  refuse('rollover + redirect split exceeds the preserved budget. Refusing to start.');
}
// The remainder is the guest's own money and is returned to them, not captured.
// It is reported as residual_to_guest_eur on every stop so the model closes:
// redirect + rollover + residual always equals the preserved budget.
W.residual = MICRO - W.rollover - W.redirect;
// A configured share as a plain ratio, for display only. No amount is decided
// on it: every amount is decided on the integer millionths in W.
const fraction = m => m / MICRO;
const REDIRECT_TOTAL = fraction(W.redirect);                              // 0.7
const RESIDUAL = fraction(W.residual);                                    // 0.1
// The first cent at or above `fraction` of a budget: the stop line, the nudge
// line and the escalation line, all one computation.
const lineCents = (budget_c, fraction_micro) => Math.ceil(budget_c * fraction_micro / MICRO);

// ── state and audit chain ─────────────────────────────────────────────────
const state = { sessions: new Map(), byId: new Map(), events: [], chain: '', suppressed: new Map() };
const money = n => eur(cents(n));

// ── RG eligibility gate ───────────────────────────────────────────────────
// The gate decides whether an incentive may be ISSUED. It never decides
// whether a guest is at risk: this engine performs no risk assessment and
// holds no harm model. The operator's responsible-gaming determination is an
// INPUT, supplied per session, and the engine's only job is to honour it and
// record that it did. A policy layer that classified harm would be a
// responsible-gaming system and would fall inside the certification perimeter
// of every jurisdiction that has one.
//
// The stricter of the configured default and the per-session input wins. A
// jurisdiction that forbids the incentive outright sets
// VIP_ELIGIBILITY_DEFAULT=suppressed and no session can re-enable it.
const ELIGIBILITY = ['permitted', 'suppressed'];
const ELIGIBILITY_DEFAULT = process.env.VIP_ELIGIBILITY_DEFAULT ?? 'permitted';
if (!ELIGIBILITY.includes(ELIGIBILITY_DEFAULT)) {
  refuse(`VIP_ELIGIBILITY_DEFAULT must be one of ${ELIGIBILITY.join(' | ')}, got "${process.env.VIP_ELIGIBILITY_DEFAULT}". Refusing to start.`);
}
function effectiveEligibility(requested, determined_at, now) {
  if (ELIGIBILITY_DEFAULT === 'suppressed') return 'suppressed';
  if (requested === 'suppressed') return 'suppressed';
  // A determination past its lifetime is not a permission.
  if (eligibilityExpired(determined_at, now)) return 'suppressed';
  return 'permitted';
}

// ── reward cap ────────────────────────────────────────────────────────────
// An absolute euro ceiling on the operator-funded part of a settlement —
// redirect plus rollover. From v3.22 it is on by default at €5,000 per stop;
// `off` removes it, which is the configuration the canon calls uncapped.
//
// Without a ceiling the incentive grows with the pre-committed budget, so a
// larger declared budget earns a larger reward — an incentive to declare a
// larger budget, and the one attack on this design the mechanism does not
// answer by itself. When the cap binds the excess is not retained by the
// operator: it returns to the guest as residual. The canon's reference stop
// earns €4,590, under the default, so every canon figure holds under it.
const REWARD_CAP_DEFAULT_EUR = 5000;
const OFF = raw => raw.trim().toLowerCase() === 'off';
function capEur(key, fallback = REWARD_CAP_DEFAULT_EUR) {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  if (OFF(raw)) return null;
  const v = Number(raw);
  if (!Number.isFinite(v) || v <= 0) {
    refuse(`${key} must be a finite number greater than 0, or off, got "${raw}". Refusing to start.`);
  }
  return v;
}
const REWARD_CAP_EUR = capEur('VIP_REWARD_CAP_EUR');

// ── eligibility lifetime ──────────────────────────────────────────────────
// How long the operator's responsible-gaming determination stays good for.
// From v3.22 it is on by default at 90 days; `off` makes a determination good
// forever, which is the configuration the canon calls never-expiring.
//
// Why it exists: a determination taken once and never revisited is the weakest
// form of a control. Supervisory expectations in several regimes include
// periodic review of a high-value customer's account, and a policy layer that
// honours a two-year-old assessment as though it were today's is not honouring
// a control — it is honouring a memory of one. When the lifetime elapses the
// gate falls CLOSED rather than open: the incentive is withheld until the
// operator supplies a fresh determination. Failing safe is the only defensible
// direction here, because the alternative is issuing value on stale grounds.
const ELIGIBILITY_TTL_DEFAULT_DAYS = 90;
function ttlDays(key, fallback = ELIGIBILITY_TTL_DEFAULT_DAYS) {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  if (OFF(raw)) return null;
  const v = Number(raw);
  if (!Number.isFinite(v) || v <= 0) {
    refuse(`${key} must be a finite number of days greater than 0, or off, got "${raw}". Refusing to start.`);
  }
  return v;
}
const ELIGIBILITY_TTL_DAYS = ttlDays('VIP_ELIGIBILITY_TTL_DAYS');

// ── the commitment period ────────────────────────────────────────────────
// A pre-commitment binds for at least this many hours from the moment it was
// armed. While a session is live and younger than this, a new pre-commit for
// the same guest is refused. Until v3.19 any pre-commit replaced a live session
// at once, so one call with a larger budget moved the line in the middle of
// play: the negotiation the Hard-Stop exists to rule out, available on the
// engine's own route. From v3.22 a STOPPED session holds the guest for the same
// period: a second budget the same day would be a new limit on top of the
// first. After the period a live session may be superseded and a stopped guest
// may commit again, which is how the next day's budget is armed.
// 0 switches the lock off. That is an operator's setting, and it is stated as one.
function commitmentHours(key) {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return 24;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < 0 || v > 168) {
    refuse(`${key} must be a number of hours from 0 to 168, got "${raw}".`);
  }
  return v;
}
const COMMITMENT_HOURS = commitmentHours('VIP_COMMITMENT_HOURS');

// ── the terms a guest agrees to ───────────────────────────────────────────
// Everything that decides what a pre-commitment does with the guest's money,
// published by GET /v3/terms with a version that is a fingerprint of exactly
// these values. Every pre-commit records the version it was armed under, beside
// the amount; a pre-commit that names another version arms nothing. The MVP at
// slot 13 computes the version the same way, so the same terms carry the same
// version in both services.
function canonicalTerms(o) {
  if (o === null || typeof o !== 'object') return JSON.stringify(o);
  return '{' + Object.keys(o).sort().map(k => JSON.stringify(k) + ':' + canonicalTerms(o[k])).join(',') + '}';
}
const TERMS = Object.freeze({
  default_mode: CFG.mode,
  stop_fraction: fraction(W.threshold),
  advisory_nudge_fraction: fraction(W.nudge),
  advisory_escalate_fraction: fraction(W.escalate),
  redirect_split: Object.freeze({ spa: fraction(W.spa), fnb: fraction(W.fnb), retail: fraction(W.retail) }),
  rollover_fraction: fraction(W.rollover),
  residual_to_guest_fraction: fraction(W.residual),
  reward_cap_eur: REWARD_CAP_EUR,
  eligibility_default: ELIGIBILITY_DEFAULT,
  eligibility_ttl_days: ELIGIBILITY_TTL_DAYS,
  commitment_hours: COMMITMENT_HOURS
});
const TERMS_VERSION = 'terms-' + crypto.createHash('sha256').update(canonicalTerms(TERMS)).digest('hex').slice(0, 12);

// Returns true when a determination taken at determined_at is too old to rely
// on. An absent timestamp is treated as expired when a lifetime is configured:
// an unknown age is not a young age.
function eligibilityExpired(determined_at, now) {
  if (determined_at == null) return ELIGIBILITY_TTL_DAYS !== null;
  const t = determinationTime(determined_at);
  const asOf = now === undefined ? Date.now() : now;
  if (!Number.isFinite(t) || t > asOf) return true;
  return ELIGIBILITY_TTL_DAYS !== null && (asOf - t) / 86400000 > ELIGIBILITY_TTL_DAYS;
}


// settle: the single place a preserved budget is divided, gate and cap
// included. Both this file and the MVP run this same arithmetic; the suite
// asserts they agree rather than assuming it.

// ── exact allocation ──────────────────────────────────────────────────────
// Money is split in CENTS, as integers, and the split is guaranteed to close.
//
// The old arithmetic computed each leg independently — redirect, rollover and
// residual each as a rounded percentage of the preserved budget — and three
// independent roundings do not add up. Measured across every amount from €0.01
// to €2,000.00, the three legs failed to sum to the preserved budget in about
// 52,205 of the 200,000 cases, one in four, by a cent either way. One cent is small; money
// that appears or disappears in a settlement is not, because an operator's
// reconciliation runs on exact equality and an operator's auditor tests it.
//
// allocate() uses the largest-remainder method on integers: every share is
// total x weight / sum-of-weights, floored; the leftover cents go one at a
// time to the largest remainders, ties broken by position. Remainders are
// compared as integers, so a tie is a tie and position decides it — exactly
// the rule, on every amount. The parts always sum to the whole, no part is
// ever negative, and a weight of zero receives nothing.
function allocate(total_c, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (total_c <= 0 || sum === 0) return weights.map(() => 0);
  const raw = weights.map(w => total_c * w);
  const out = raw.map(r => Math.floor(r / sum));
  let left = total_c - out.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, rem: r - out[i] * sum }))
    .sort((a, b) => (b.rem - a.rem) || (a.i - b.i));
  for (let k = 0; left > 0; k++, left--) out[order[k % order.length].i] += 1;
  return out;
}

function settle(preserved_eur, eligibility, determined_at, now) {
  const p = Math.max(0, cents(preserved_eur));
  const preserved = eur(p);
  now ??= Date.now();
  const expired = eligibilityExpired(determined_at, now);
  const elig = effectiveEligibility(eligibility, determined_at, now);

  // Suppressed: the stop still happens and the budget is still preserved, but
  // nothing is issued. The whole preserved amount returns to the guest as
  // residual, so the model closes exactly as it does when an incentive runs.
  if (elig === 'suppressed') {
    return {
      preserved, eligibility: elig, capped: false, expired,
      credits: { spa: 0, fnb: 0, retail: 0 },
      redirect: 0, rollover: 0, residual: preserved
    };
  }

  // Two allocations, each exact. The first divides the preserved budget three
  // ways; the second divides the redirect leg across the three venues. Because
  // both use largest-remainder on integer cents, spa + fnb + retail === redirect
  // and redirect + rollover + residual === preserved, always.
  let [redirect, rollover, residual] = allocate(p, [W.redirect, W.rollover, W.residual]);
  let capped = false;

  if (REWARD_CAP_EUR !== null && eur(redirect + rollover) > REWARD_CAP_EUR) {
    capped = true;
    [redirect, rollover] = allocate(cents(REWARD_CAP_EUR, true), [W.redirect, W.rollover]);
    // The guest takes the whole difference, computed as the remainder so the
    // model still closes to the cent.
    residual = p - redirect - rollover;
  }

  const [spa, fnb, retail] = allocate(redirect, [W.spa, W.fnb, W.retail]);

  return {
    preserved, eligibility: elig, capped, expired,
    credits: { spa: eur(spa), fnb: eur(fnb), retail: eur(retail) },
    redirect: eur(redirect), rollover: eur(rollover), residual: eur(residual)
  };
}


function evt(type, payload) {
  const e = { seq: state.events.length + 1, type, at: new Date().toISOString(), ...payload };
  state.events.push(e);
  // Hash chain: each link folds the previous chain value with the new event, so
  // altering any earlier row breaks every fingerprint after it.
  state.chain = crypto.createHash('sha256').update(state.chain + JSON.stringify(e)).digest('hex');
  e.fingerprint = state.chain.slice(0, 16);
  return e;
}

// ── policy ────────────────────────────────────────────────────────────────
function terms() {
  return { terms_version: TERMS_VERSION, terms: TERMS };
}

function precommit({ vip_id, budget_eur, mode, eligibility, eligibility_at, terms_version }) {
  if (!validVip(vip_id)) fail('INVALID_VIP', 400);
  // At least one cent and at most MAX_EUR: below a cent there is no line to
  // arm, and above the bound the cent arithmetic stops being exact.
  if (!Number.isFinite(budget_eur) || budget_eur < 0.01 || budget_eur > MAX_EUR) fail('INVALID_BUDGET', 400);
  // Money is counted in whole cents from the moment it arrives: a budget that
  // carries a fraction of a cent is taken to the nearest cent.
  budget_eur = eur(cents(budget_eur));
  const m = mode === undefined ? CFG.mode : mode;
  if (!MODES.includes(m)) fail('INVALID_MODE', 400);
  const requested = eligibility === undefined ? 'permitted' : eligibility;
  if (!ELIGIBILITY.includes(requested)) fail('INVALID_ELIGIBILITY', 400);
  if (eligibility_at !== undefined) {
    const t = determinationTime(eligibility_at);
    if (!Number.isFinite(t) || t > Date.now()) fail('INVALID_ELIGIBILITY_AT', 400);
  }
  // An absent determination date is recorded as absent, never filled in with the
  // current time: with a lifetime configured an unknown age counts as expired.
  const elig_at = eligibility_at === undefined ? null : eligibility_at;
  // A version the client sends is the version it showed the guest. If it is not
  // the version in force, the guest agreed to other terms and nothing is armed.
  if (terms_version !== undefined && terms_version !== TERMS_VERSION) {
    fail('TERMS_CHANGED', 409, { terms_version: TERMS_VERSION });
  }
  // A guest withdrawn from the programme cannot be re-enrolled by opening a
  // session; suppression outlives the session that carried it.
  const elig = state.suppressed.has(vip_id) ? 'suppressed' : effectiveEligibility(requested, elig_at);
  const s = {
    vip_id, budget: budget_eur, mode: m, consumed: 0, consumed_exact: '0', eligibility: elig, eligibility_at: elig_at,
    session_id: crypto.randomUUID(), stopped: false, redirect_issued: false, receipts: new Map(),
    opened_at: Date.now(), reserved_c: 0, authorizations: new Map(), terms_version: TERMS_VERSION
  };
  const previous = state.sessions.get(vip_id);
  if (previous && previous.stopped && !previous.closed) {
    // From v3.22 a stopped session holds the guest for the rest of the
    // commitment period, counted from the moment it was armed.
    const after = previous.opened_at + COMMITMENT_HOURS * 3600000;
    if (!(Date.now() >= after)) {
      fail('COMMITMENT_ACTIVE', 409, { session_id: previous.session_id, precommit_after: new Date(after).toISOString() });
    }
  }
  if (previous && !previous.stopped && !previous.closed) {
    // A pre-commitment binds for the commitment period: a live session younger
    // than that is not superseded, and the answer says when one may be.
    const free_at = previous.opened_at + COMMITMENT_HOURS * 3600000;
    if (Date.now() < free_at) {
      fail('SESSION_LIVE', 409, { session_id: previous.session_id, supersede_after: new Date(free_at).toISOString() });
    }
    previous.closed = true;
    previous.reserved_c = 0;
    // A stake checked under the superseded session cannot be reported against
    // the new one: its check closes with the session that granted it.
    for (const a of previous.authorizations.values()) if (!a.closed_by) a.closed_by = 'superseded';
  }
  state.sessions.set(vip_id, s);
  state.byId.set(s.session_id, s);
  const e = evt('precommit', { vip_id, budget_eur, mode: m, session_id: s.session_id, eligibility: elig, eligibility_at: elig_at, terms_version: TERMS_VERSION });
  const armed = eur(lineCents(cents(budget_eur), W.threshold));
  return { session_id: s.session_id, armed_at_eur: armed, mode: m, eligibility: elig, eligibility_at: elig_at, terms_version: TERMS_VERSION, fingerprint: e.fingerprint };
}

function tick(payload) {
  const { event_id, session_id, vip_id, delta_eur } = payload;
  if (event_id === undefined) return recordTick(payload);
  if (!validVip(event_id) || [...event_id].length > 128 || !validVip(session_id)) fail('INVALID_EVENT_ID', 400);
  const s = state.byId.get(session_id);
  if (!s || s.vip_id !== vip_id) fail('NO_LIVE_SESSION', 409);
  const prior = s.receipts.get(event_id);
  if (prior) {
    if (prior.delta !== delta_eur) fail('EVENT_CONFLICT', 409);
    return JSON.parse(prior.response);
  }
  const result = recordTick(payload);
  s.receipts.set(event_id, { delta: delta_eur, response: JSON.stringify(result) });
  return result;
}

function recordTick({ vip_id, delta_eur, session_id, authorization_id }) {
  const s = validVip(vip_id) ? state.sessions.get(vip_id) : undefined;
  if (!s || (session_id !== undefined && session_id !== s.session_id)) fail('NO_LIVE_SESSION', 409);
  if (s.stopped) fail('ALREADY_STOPPED', 409);
  // A tick REPORTS consumption, and consumption only goes up. A negative delta
  // was accepted here until v3.11 and silently reduced consumption, which lets a
  // caller walk a session back from its stop line and postpone the stop
  // indefinitely. The MVP has refused it since v0.2.4; this file did not, so the
  // two implementations disagreed on a control the canon declares. Corrections,
  // if an integration ever needs them, belong on their own route with their own
  // link in the chain, never hidden inside a tick.
  if (!Number.isFinite(delta_eur) || delta_eur < 0 || delta_eur > MAX_EUR) fail('INVALID_DELTA', 400);
  // A tick that reports a checked stake names it, and the check closes with it.
  // Everything is validated before anything moves.
  const auth = authorization_id === undefined ? null : openAuthorization(authorization_id, s);
  // The reported total is kept exactly, so ticks below a cent still add up; the
  // stop, the display and the settlement all read that total in whole cents.
  const total = addDecimal(s.consumed_exact, delta_eur);
  if (!Number.isSafeInteger(cents(total))) fail('INVALID_DELTA', 400);
  s.consumed_exact = total;
  s.consumed = Number(total);
  if (auth) {
    closeAuthorization(s, auth, 'tick');
    // The guarantee holds only while a wager consumes no more than the stake it
    // was checked for. When it consumes more, that is recorded, not refused.
    if (Math.round(delta_eur * MICRO) > Math.round(auth.stake_eur * MICRO)) {
      evt('stake.exceeded', { vip_id, session_id: s.session_id, authorization_id: auth.id,
                              stake_eur: auth.stake_eur, consumed_eur: delta_eur });
    }
  }
  if (cents(total) >= lineCents(cents(s.budget), W.threshold)) {
    if (s.mode === 'hard_stop') return { locked: true, ...stop(s, 'threshold') };
    return { state: view(s), advisory: 'threshold reached — host escalation recommended' };
  }
  return { state: view(s) };
}

function stop(s, trigger) {
  if (!s || s.closed) fail('NO_LIVE_SESSION', 409);
  if (s.stopped) fail('ALREADY_STOPPED', 409);
  s.stopped = true;
  // How far consumption went past the line: zero while every stake is checked
  // first, and written into the stop when it is not. Advisory enforces no line.
  const overshoot = s.mode === 'hard_stop'
    ? eur(Math.max(0, cents(s.consumed_exact ?? s.consumed) - lineCents(cents(s.budget), W.threshold))) : 0;
  let voided = 0;
  for (const a of s.authorizations.values()) if (!a.closed_by) { a.closed_by = 'stop'; voided++; }
  s.reserved_c = 0;
  const st = settle(eur(cents(s.budget) - cents(s.consumed_exact ?? s.consumed)), s.eligibility, s.eligibility_at);
  s.eligibility = st.eligibility;
  s.stop_capped = st.capped;
  s.pending = { preserved: st.preserved, credits: st.credits, rollover: st.rollover, residual: st.residual };
  const e = evt('policy.stop', {
    vip_id: s.vip_id, session_id: s.session_id, trigger: trigger || 'threshold',
    consumed: money(s.consumed_exact ?? s.consumed), preserved: st.preserved, rollover: st.rollover,
    residual_to_guest_eur: st.residual, credits: st.credits,
    eligibility: st.eligibility, capped: st.capped, eligibility_expired: st.expired,
    overshoot_eur: overshoot, authorizations_voided: voided
  });
  if (st.expired) {
    evt('eligibility.expired', {
      vip_id: s.vip_id, session_id: s.session_id,
      determined_at: s.eligibility_at || null, ttl_days: ELIGIBILITY_TTL_DAYS
    });
  }
  // A refusal to issue is its own link in the chain. A regulator asking this
  // system to prove itself needs the occasions it did NOT reward, and an
  // absent row proves nothing.
  if (st.eligibility === 'suppressed') {
    evt('incentive.suppressed', {
      vip_id: s.vip_id, session_id: s.session_id, scope: 'settlement',
      preserved_eur: st.preserved, returned_to_guest_eur: st.residual
    });
  }
  return {
    preserved: st.preserved, rollover: st.rollover, residual_to_guest_eur: st.residual,
    credits: st.credits, eligibility: st.eligibility, capped: st.capped,
    eligibility_expired: st.expired, overshoot_eur: overshoot, fingerprint: e.fingerprint
  };
}

// ── the pre-stake check ───────────────────────────────────────────────────
// A tick reports consumption AFTER it has happened, so a stop driven by ticks
// alone locks the session on the tick that crosses the line, and that tick
// counts in full. The engine can hold the line only where it sees the stake
// first. With this call in the wager path it does: every stake the platform
// accepts is reserved against what is left to the line, as if it were lost,
// and a stake larger than that is refused before it is placed. In Advisory
// mode nothing is enforced: the stake is reserved and the answer says so.
function headroomCents(s) {
  return Math.max(0, lineCents(cents(s.budget), W.threshold) - cents(s.consumed_exact ?? s.consumed) - s.reserved_c);
}

function liveSession(vip_id, session_id) {
  const s = validVip(vip_id) ? state.sessions.get(vip_id) : undefined;
  if (!s || s.closed || (session_id !== undefined && session_id !== s.session_id)) fail('NO_LIVE_SESSION', 409);
  if (s.stopped) fail('ALREADY_STOPPED', 409);
  return s;
}

function authorize({ vip_id, stake_eur, session_id }) {
  const s = liveSession(vip_id, session_id);
  if (!Number.isFinite(stake_eur) || stake_eur < 0.01 || stake_eur > MAX_EUR) fail('INVALID_STAKE', 400);
  const stake_c = cents(stake_eur);
  const headroom_c = headroomCents(s);
  const enforced = s.mode === 'hard_stop';
  if (enforced && stake_c > headroom_c) {
    // A refused stake is the Hard-Stop working: it is its own link in the chain.
    evt('stake.refused', { vip_id, session_id: s.session_id, stake_eur: eur(stake_c), headroom_eur: eur(headroom_c) });
    fail('STAKE_EXCEEDS_HEADROOM', 409, { headroom_eur: eur(headroom_c) });
  }
  const a = { id: crypto.randomUUID(), stake_eur: eur(stake_c), closed_by: null };
  s.authorizations.set(a.id, a);
  s.reserved_c += stake_c;
  return { authorized: true, authorization_id: a.id, session_id: s.session_id, stake_eur: a.stake_eur, enforced,
           reserved_eur: eur(s.reserved_c), headroom_eur: eur(headroomCents(s)) };
}

// An open check of this guest's current session, or a refusal. An id that is
// not this guest's names nothing, and says so the same way an unknown one does.
function openAuthorization(authorization_id, s) {
  const a = typeof authorization_id === 'string' ? s.authorizations.get(authorization_id) : undefined;
  if (!a) fail('AUTHORIZATION_UNKNOWN', 404);
  if (a.closed_by) fail('AUTHORIZATION_CLOSED', 409);
  return a;
}

function closeAuthorization(s, a, by) {
  a.closed_by = by;
  s.reserved_c = Math.max(0, s.reserved_c - cents(a.stake_eur));
}

// The stake was checked but never played. Its reservation returns to the headroom.
function release({ vip_id, authorization_id, session_id }) {
  const s = liveSession(vip_id, session_id);
  const a = openAuthorization(authorization_id, s);
  closeAuthorization(s, a, 'release');
  return { released: true, authorization_id: a.id, reserved_eur: eur(s.reserved_c), headroom_eur: eur(headroomCents(s)) };
}
// ── programme suppression ─────────────────────────────────────────────────
// One route, three reasons, one effect: stop issuing to this guest, now and
// from now on.
//   exclusion        the guest is on an exclusion or self-exclusion register
//   player_request   the guest asked to leave the programme
//   rg_determination the operator's responsible-gaming assessment withdrew it
// A live session stops on the spot. The stop is not cancelled and the budget
// is not forfeited: the guest keeps the whole preserved amount as residual.
// Suppression removes the incentive, never the protection.
const SUPPRESS_REASONS = ['exclusion', 'player_request', 'rg_determination'];

function programmeSuppress({ vip_id, reason }) {
  if (!validVip(vip_id)) fail('INVALID_VIP', 400);
  if (!SUPPRESS_REASONS.includes(reason)) fail('INVALID_REASON', 400);
  if (state.suppressed.has(vip_id)) fail('ALREADY_SUPPRESSED', 409);
  state.suppressed.set(vip_id, { reason, at: new Date().toISOString() });
  const e = evt('incentive.suppressed', { vip_id, reason, scope: 'programme' });
  let stopped = null;
  const s = state.sessions.get(vip_id);
  // The guest's session is marked whether it is live or already stopped: an
  // incentive settled before the suppression arrived is not collected after it.
  if (s) {
    s.eligibility = 'suppressed';
    if (!s.stopped) stopped = stop(s, 'suppression');
  }
  for (const prior of state.byId.values()) {
    if (prior.vip_id === vip_id && prior.stopped && !prior.redirect_issued) withhold(prior);
  }
  return { vip_id, suppressed: true, reason, session_stopped: stopped !== null, stopped, fingerprint: e.fingerprint };
}


function view(s) {
  const frac = s.consumed / s.budget;
  const b = cents(s.budget), c = cents(s.consumed_exact ?? s.consumed);
  const preserved = eur(Math.max(0, b - c));
  const now = Date.now();
  const eligibility = effectiveEligibility(s.eligibility, s.eligibility_at, now);
  let pv = settle(preserved, s.eligibility, s.eligibility_at, now);
  if (s.stopped && (s.redirect_issued || eligibility === 'permitted')) {
    const { credits, residual, rollover } = s.pending;
    pv = { redirect: money(credits.spa + credits.fnb + credits.retail), rollover, residual, capped: s.stop_capped };
  }
  return {
    vip_id: s.vip_id, session_id: s.session_id, mode: s.mode, stopped: s.stopped,
    budget_eur: s.budget, terms_version: s.terms_version ?? null, consumed_eur: eur(c),
    consumed_fraction: Math.round(frac * 1000) / 1000,
    distance_to_threshold_eur: eur(Math.max(0, lineCents(b, W.threshold) - c)),
    reserved_eur: eur(s.reserved_c || 0),
    // The largest stake the check would allow now; a stopped session allows none.
    headroom_eur: s.stopped ? 0 : eur(headroomCents(s)),
    nudge_active: s.mode === 'advisory' && c >= lineCents(b, W.nudge),
    escalate_active: s.mode === 'advisory' && c >= lineCents(b, W.escalate),
    eligibility, eligibility_expired: eligibilityExpired(s.eligibility_at, now),
    redirect_issued: Boolean(s.redirect_issued),
    incentive_preview: { redirect_eur: pv.redirect, rollover_eur: pv.rollover,
                         residual_to_guest_eur: pv.residual, capped: pv.capped }
  };
}

function withhold(s) {
  s.eligibility = 'suppressed';
  const p = s.pending.preserved;
  s.pending = { preserved: p, credits: { spa: 0, fnb: 0, retail: 0 }, rollover: 0, residual: p };
  if (state.events.some(e => e.type === 'incentive.suppressed' && e.session_id === s.session_id)) return;
  if (eligibilityExpired(s.eligibility_at)) {
    evt('eligibility.expired', { vip_id: s.vip_id, session_id: s.session_id,
      determined_at: s.eligibility_at, ttl_days: ELIGIBILITY_TTL_DAYS });
  }
  evt('incentive.suppressed', { vip_id: s.vip_id, session_id: s.session_id, scope: 'settlement',
    preserved_eur: p, returned_to_guest_eur: p });
}

function redirectIssue({ vip_id, session_id }) {
  const s = session_id === undefined ? state.sessions.get(vip_id) : state.byId.get(session_id);
  if (!validVip(vip_id) || !s || s.closed || s.vip_id !== vip_id) fail('NO_LIVE_SESSION', 409);
  if (!s.stopped) fail('NOT_STOPPED', 409);
  if (s.redirect_issued) fail('ALREADY_ISSUED', 409);
  if (effectiveEligibility(s.eligibility, s.eligibility_at) === 'suppressed') {
    withhold(s);
    fail('INCENTIVE_SUPPRESSED', 409);
  }
  s.redirect_issued = true;
  const e = evt('redirect.issue', { vip_id, session_id: s.session_id, ...s.pending });
  return { issued: true, ...s.pending, fingerprint: e.fingerprint };
}

function audit(session_id) {
  const rows = state.events.filter(e => e.session_id === session_id);
  if (!rows.length) fail('SESSION_UNKNOWN', 404);
  return { session_id, events: rows, chain: state.chain.slice(0, 16) };
}

function fail(code, status, extra) { const e = new Error(code); e.status = status; if (extra) e.extra = extra; throw e; }

// ── transport ─────────────────────────────────────────────────────────────
const ROUTES = ['POST /v3/precommit', 'POST /v3/session/tick', 'GET /v3/policy/state',
                'POST /v3/redirect/issue', 'GET /v3/audit/{session_id}',
                'POST /v3/programme/suppress', 'POST /v3/session/authorize',
                'POST /v3/session/release', 'GET /v3/terms'];


const MAX_BODY_BYTES = 1_000_000;

// Accumulate bytes, then decode once: a chunk may end inside a UTF-8 character.
function readBody(req, res, handle) {
  const reject = (status, error) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ error }));
  };
  const local = !process.env.VIP_BIND_HOST || ['127.0.0.1', '::1', 'localhost'].includes(process.env.VIP_BIND_HOST);
  let target;
  try {
    target = new URL('http://' + req.headers.host);
    if (local && !['127.0.0.1', '[::1]', 'localhost'].includes(target.hostname)) throw new Error();
    if (req.method === 'POST' && req.headers.origin && new URL(req.headers.origin).origin !== target.origin) throw new Error();
  } catch {
    req.resume();
    return reject(403, 'FORBIDDEN_ORIGIN');
  }
  const chunks = [];
  let bytes = 0;
  req.on('data', chunk => {
    if (bytes > MAX_BODY_BYTES) return;
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) {
      chunks.length = 0;
      return reject(413, 'PAYLOAD_TOO_LARGE');
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (bytes > MAX_BODY_BYTES) return;
    let body;
    try { body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)); }
    catch { return reject(400, 'BAD_JSON'); }
    handle(body);
  });
}


const server = http.createServer((req, res) => {
  readBody(req, res, body => {
    const send = (status, obj) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return send(400, { error: 'BAD_REQUEST' }); }
    const path = url.pathname;
    let payload = {};
    if (body) { try { payload = JSON.parse(body); } catch { return send(400, { error: 'BAD_JSON' }); } }
    // A body that parses but is not a JSON object — null, an array, a bare
    // string or number — is refused here, before any route reads it: a null
    // failed on destructuring and came back as a 500.
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return send(400, { error: 'BAD_JSON' });
    }
    try {
      if (req.method === 'GET' && path === '/v3/terms') return send(200, terms());
      if (req.method === 'POST' && path === '/v3/precommit') return send(201, precommit(payload));
      if (req.method === 'POST' && path === '/v3/session/tick') {
        const r = tick(payload);
        return send(r.locked ? 423 : 200, r);          // 423 Locked: the stop is the product working
      }
      if (req.method === 'GET' && path === '/v3/policy/state') {
        const s = state.sessions.get(url.searchParams.get('vip_id'));
        if (!s) return send(409, { error: 'NO_LIVE_SESSION' });
        return send(200, view(s));
      }
      if (req.method === 'POST' && path === '/v3/session/authorize') return send(200, authorize(payload));
      if (req.method === 'POST' && path === '/v3/session/release') return send(200, release(payload));
      if (req.method === 'POST' && path === '/v3/redirect/issue') return send(200, redirectIssue(payload));
      if (req.method === 'POST' && path === '/v3/programme/suppress') return send(200, programmeSuppress(payload));
      if (req.method === 'GET' && path.startsWith('/v3/audit/')) {
        let sid;
        try { sid = decodeURIComponent(path.slice('/v3/audit/'.length)); }
        catch { return send(400, { error: 'BAD_REQUEST' }); }   // not valid percent-encoding
        return send(200, audit(sid));
      }
      return send(404, { error: 'NO_ROUTE', routes: ROUTES });
    } catch (err) {
      return send(err.status || 500, Object.assign({ error: err.status ? err.message : 'INTERNAL_ERROR' }, err.status ? err.extra || {} : {}));
    }
  });
});

if (require.main === module) {
  server.listen(CFG.port, process.env.VIP_BIND_HOST || '127.0.0.1', () => {
    const pct = m => `${m / 10000}%`;
    console.log(`VIP SmartContract reference v3.22 · mode=${CFG.mode} · threshold=${pct(W.threshold)} · ` +
                `rollover=${pct(W.rollover)} · redirect=${pct(W.redirect)} · residual=${pct(W.residual)} · ` +
                `eligibility=${ELIGIBILITY_DEFAULT} · cap=${REWARD_CAP_EUR === null ? 'off' : REWARD_CAP_EUR} · ` +
                `determination=${ELIGIBILITY_TTL_DAYS === null ? 'never expires' : ELIGIBILITY_TTL_DAYS + 'd'} · ` +
                `commitment=${COMMITMENT_HOURS}h · ${TERMS_VERSION} · :${CFG.port} · ${ROUTES.length}/9 spec routes live`);
  });
}

module.exports = { server, terms, TERMS, TERMS_VERSION, precommit, tick, authorize, release, COMMITMENT_HOURS, stop, view, redirectIssue, audit, settle, MAX_EUR, W, lineCents, cents,
                   ELIGIBILITY_TTL_DAYS, eligibilityExpired, allocate,
                   programmeSuppress, SUPPRESS_REASONS, ELIGIBILITY, effectiveEligibility,
                   REWARD_CAP_EUR, CFG, _state: state };
