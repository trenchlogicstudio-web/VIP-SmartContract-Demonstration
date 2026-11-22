// VIP SmartContract · MVP v0.2.18 · replay of past sessions
// Copyright (c) 2026 Miloš Petrović (Trench Logic Studio) · SPDX-License-Identifier: MIT
//
// Applies the engine's own rules to an operator's past sessions and reports
// what the policy would have done: how many sessions would have stopped, how
// much gaming win the operator would have forgone, and how much resort credit,
// future-play credit and guest balance the stops would have produced. Nothing
// is estimated here that the engine does not compute itself: the stop line is
// armedAt(), each stop is settle(), under whatever configuration the process
// starts with (stop fraction, split, cap, future-play switch, eligibility
// default).
//
// Past sessions carry no pre-committed budget, so the budget is an assumption,
// stated in every report: typical:K gives each guest K times the median of the
// guest's own losing sessions in the file, fixed:EUR gives every guest the same
// amount, and a budget_eur column overrides either for its row. The result is
// the cost of the policy under that assumption. It is not a measurement of how
// guests would behave once they had pre-committed.
//
// The file needs an anonymised guest key, a date and the session's net loss;
// a column that looks like personal data is refused, because none is needed.
'use strict';

const P = require('./policy');
const { cents } = require('./values');

const REQUIRED = ['guest', 'date', 'loss_eur'];
const OPTIONAL = ['peak_loss_eur', 'budget_eur', 'eligibility'];
const PERSONAL = /^(name|first_?name|last_?name|surname|full_?name|e_?mail|email_?address|phone|phone_?number|mobile|address|street|postcode|zip|birth_?date|date_of_birth|dob|birthday|passport|passport_?number|id_?number|national_?id|ssn|card|card_?number|iban|bank_?account|account_?number)$/i;

// RFC 4180 fields: commas, quotes doubled inside quotes, CRLF or LF. Lines that
// start with # are comments.
function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [], field = '', quoted = false, started = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === '') { quoted = true; started = true; }
    else if (ch === ',') { row.push(field); field = ''; started = true; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = ''; started = false;
    } else { field += ch; started = true; }
  }
  if (quoted) throw new Error('The file ends inside a quoted field.');
  if (started || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => !(r.length === 1 && r[0].trim() === '') && !r[0].trimStart().startsWith('#'));
}

function amount(raw, column, row, { signed = false } = {}) {
  if (!/^-?\d+(\.\d{1,2})?$/.test(raw)) {
    throw new Error(`Row ${row}: ${column} "${raw}" is not an amount in euros, written with a dot for decimals and no thousands separator.`);
  }
  const v = Number(raw);
  if (!signed && v < 0) throw new Error(`Row ${row}: ${column} cannot be negative, got ${raw}.`);
  return v;
}

function readSessions(text) {
  const rows = parseCsv(text);
  if (!rows.length) throw new Error('The file has no header row.');
  const header = rows[0].map(h => h.trim().toLowerCase());
  const personal = header.filter(h => PERSONAL.test(h));
  if (personal.length) {
    throw new Error(`The file has columns that look like personal data (${personal.join(', ')}). Remove them: the replay needs only an anonymised guest key, a date and the net loss.`);
  }
  for (const c of REQUIRED) if (!header.includes(c)) throw new Error(`The file has no "${c}" column. Required: ${REQUIRED.join(', ')}; optional: ${OPTIONAL.join(', ')}.`);
  const at = Object.fromEntries(header.map((h, i) => [h, i]));
  const sessions = rows.slice(1).map((r, i) => {
    const n = i + 1;
    const get = c => (at[c] === undefined ? '' : String(r[at[c]] ?? '').trim());
    const guest = get('guest');
    if (!guest) throw new Error(`Row ${n}: the guest key is empty.`);
    if (guest.includes('@')) throw new Error(`Row ${n}: the guest key looks like an e-mail address. Use an anonymised key.`);
    const date = get('date');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) !== date) {
      throw new Error(`Row ${n}: date "${date}" is not a calendar date written YYYY-MM-DD.`);
    }
    const loss = amount(get('loss_eur'), 'loss_eur', n, { signed: true });
    const peak = get('peak_loss_eur') === '' ? null : amount(get('peak_loss_eur'), 'peak_loss_eur', n);
    if (peak !== null && peak < loss) throw new Error(`Row ${n}: peak_loss_eur ${peak} is below the final loss ${loss}.`);
    const budget = get('budget_eur') === '' ? null : amount(get('budget_eur'), 'budget_eur', n);
    if (budget === 0) throw new Error(`Row ${n}: budget_eur must be greater than 0.`);
    const eligibility = get('eligibility') === '' ? null : get('eligibility').toLowerCase();
    if (eligibility !== null && !P.ELIGIBILITY.includes(eligibility)) {
      throw new Error(`Row ${n}: eligibility "${get('eligibility')}" must be ${P.ELIGIBILITY.join(' or ')}.`);
    }
    return { guest, date, loss, peak, budget, eligibility };
  });
  if (!sessions.length) throw new Error('The file has a header but no sessions.');
  return { header, sessions };
}

function budgetRule(spec = 'typical:2') {
  const m = /^(typical|fixed):(\d+(?:\.\d+)?)$/.exec(String(spec).trim());
  if (!m || !(Number(m[2]) > 0)) {
    throw new Error(`The budget must be typical:K (K times the median of the guest's own losing sessions) or fixed:EUR, got "${spec}".`);
  }
  const value = Number(m[2]);
  return { kind: m[1], value, text: m[1] === 'typical'
    ? `${value} × the median of each guest's own losing sessions in the file`
    : `€${value.toLocaleString('en-US')} for every guest` };
}

function median(xs) {
  const a = [...xs].sort((x, y) => x - y), k = a.length;
  return k % 2 ? a[(k - 1) / 2] : (a[k / 2 - 1] + a[k / 2]) / 2;
}

const E = c => P.eur(c);

function replay(sessions, { budget = 'typical:2', eligibility = 'permitted' } = {}) {
  const rule = budgetRule(budget);
  if (!P.ELIGIBILITY.includes(eligibility)) throw new Error(`The eligibility default must be ${P.ELIGIBILITY.join(' or ')}, got "${eligibility}".`);
  const typical = new Map();
  if (rule.kind === 'typical') {
    const losses = new Map();
    for (const s of sessions) if (s.loss > 0) { if (!losses.has(s.guest)) losses.set(s.guest, []); losses.get(s.guest).push(s.loss); }
    for (const [g, xs] of losses) typical.set(g, median(xs));
  }
  const usesPeak = sessions.some(s => s.peak !== null);
  const sum = () => ({ sessions: 0, stops: 0, win: 0, forgone: 0, preserved: 0, redirect: 0, spa: 0, fnb: 0, retail: 0, rollover: 0, residual: 0, capped: 0, suppressed: 0 });
  const total = sum(), months = new Map(), guests = new Set(), stopped = new Set(), withoutBudget = new Set(), stops = [];
  let from = null, to = null;
  for (const s of sessions) {
    guests.add(s.guest);
    from = from === null || s.date < from ? s.date : from;
    to = to === null || s.date > to ? s.date : to;
    const month = s.date.slice(0, 7);
    if (!months.has(month)) months.set(month, sum());
    const buckets = [total, months.get(month)];
    const lossC = cents(s.loss);
    for (const b of buckets) { b.sessions++; b.win += lossC; }
    let b = s.budget;
    if (b === null) b = rule.kind === 'fixed' ? rule.value : (typical.has(s.guest) ? P.money(rule.value * typical.get(s.guest)) : null);
    if (b === null || b <= 0) { withoutBudget.add(s.guest); continue; }
    const line = P.armedAt(b);
    if ((s.peak ?? s.loss) < line) continue;
    // With the stake checked first the session ends on the line: the guest
    // loses the line instead of the recorded loss, and the rest of the budget
    // is preserved and settled exactly as the engine settles a stop.
    const preserved = E(cents(b) - cents(line));
    const elig = s.eligibility ?? eligibility;
    const when = s.date + 'T12:00:00.000Z';
    const st = P.settle(preserved, elig, when, Date.parse(when));
    const forgoneC = lossC - cents(line);
    stopped.add(s.guest);
    for (const t of buckets) {
      t.stops++; t.forgone += forgoneC; t.preserved += cents(st.preserved);
      t.redirect += cents(st.redirect); t.rollover += cents(st.rollover); t.residual += cents(st.residual);
      t.spa += cents(st.credits.spa); t.fnb += cents(st.credits.fnb); t.retail += cents(st.credits.retail);
      if (st.capped) t.capped++;
      if (st.eligibility === 'suppressed') t.suppressed++;
    }
    stops.push({ guest: s.guest, date: s.date, loss_eur: s.loss, peak_loss_eur: s.peak, budget_eur: b, line_eur: line,
      preserved_eur: st.preserved, resort_credit_eur: st.redirect, spa_eur: st.credits.spa, fnb_eur: st.credits.fnb,
      retail_eur: st.credits.retail, future_play_eur: st.rollover, guest_balance_eur: st.residual,
      capped: st.capped, eligibility: st.eligibility, win_forgone_eur: E(forgoneC) });
  }
  const out = t => ({ sessions: t.sessions, stops: t.stops, gaming_win_eur: E(t.win), gaming_win_forgone_eur: E(t.forgone),
    preserved_eur: E(t.preserved), resort_credit_eur: E(t.redirect),
    credits: { spa_eur: E(t.spa), fnb_eur: E(t.fnb), retail_eur: E(t.retail) },
    future_play_credit_eur: E(t.rollover), guest_balances_eur: E(t.residual), capped_stops: t.capped, stops_without_incentive: t.suppressed });
  return {
    kind: 'VIP SmartContract replay of past sessions',
    terms_version: P.TERMS_VERSION, terms: P.TERMS, future_play: P.FUTURE_PLAY,
    assumptions: {
      budget: rule.text,
      eligibility_default: eligibility,
      trigger: usesPeak
        ? 'the deepest loss in the session (peak_loss_eur) reaching the stop line'
        : "the session's final net loss reaching the stop line; a guest who was further down during the session and won some back is not counted",
      stake_check: 'stakes are checked before they are played, so a stopped session ends exactly on the line',
      not_applied: 'the hold after a stop (VIP_COMMITMENT_HOURS) is not applied, because the file has dates, not times',
    },
    period: { from, to },
    guests: guests.size, guests_stopped: stopped.size, guests_without_budget: withoutBudget.size,
    totals: out(total),
    months: [...months].sort(([a], [b]) => (a < b ? -1 : 1)).map(([month, t]) => ({ month, ...out(t) })),
    stops,
    note: "The engine's own rules applied to past sessions under the assumptions above. They show what the policy would have cost the operator, at face value, not how guests would have behaved: a guest who pre-commits may play differently.",
  };
}

const eurText = v => '€' + v.toLocaleString('en-US', { minimumFractionDigits: Math.round(v * 100) % 100 ? 2 : 0, maximumFractionDigits: 2 });
const pct = (a, b) => (b ? (100 * a / b).toFixed(1) + '%' : '—');

function summary(r) {
  const t = r.totals;
  const line = (k, v) => '  ' + k.padEnd(30) + v;
  return [
    `VIP replay · ${t.sessions.toLocaleString('en-US')} sessions · ${r.guests.toLocaleString('en-US')} guests · ${r.period.from} to ${r.period.to}`,
    `terms ${r.terms_version} · stop at ${r.terms.stop_fraction * 100}% · cap ${r.terms.reward_cap_eur === null ? 'off' : eurText(r.terms.reward_cap_eur) + ' per stop'} · future-play credit ${r.future_play}${r.future_play === 'on' ? ' (' + r.terms.rollover_fraction * 100 + '%)' : ''}`,
    `budget: ${r.assumptions.budget}`,
    `trigger: ${r.assumptions.trigger}`,
    '',
    line('stops', `${t.stops.toLocaleString('en-US')} of ${t.sessions.toLocaleString('en-US')} sessions (${pct(t.stops, t.sessions)}), ${r.guests_stopped} guests`),
    line('gaming win in the file', eurText(t.gaming_win_eur)),
    line('gaming win forgone at stops', `${eurText(t.gaming_win_forgone_eur)} (${pct(t.gaming_win_forgone_eur, t.gaming_win_eur)})`),
    line('resort credit issued', `${eurText(t.resort_credit_eur)} (spa ${eurText(t.credits.spa_eur)}, F&B ${eurText(t.credits.fnb_eur)}, retail ${eurText(t.credits.retail_eur)})`),
    line('future-play credit', eurText(t.future_play_credit_eur)),
    line("guests' own balances", eurText(t.guest_balances_eur)),
    line('stops at the benefit ceiling', String(t.capped_stops)),
    line('stops without incentive', String(t.stops_without_incentive)),
    ...(r.guests_without_budget ? [line('guests without a budget', `${r.guests_without_budget} (no losing session to take a typical loss from)`)] : []),
    '',
    r.note,
  ].join('\n');
}

function stopsCsv(r) {
  const cols = ['guest', 'date', 'loss_eur', 'peak_loss_eur', 'budget_eur', 'line_eur', 'preserved_eur', 'resort_credit_eur', 'spa_eur', 'fnb_eur',
    'retail_eur', 'future_play_eur', 'guest_balance_eur', 'capped', 'eligibility', 'win_forgone_eur'];
  const cell = v => (v === null || v === undefined ? '' : /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v));
  return ['# VIP SmartContract replay · stops · © 2026 Miloš Petrović (Trench Logic Studio) · MIT License', cols.join(',')]
    .concat(r.stops.map(s => cols.map(c => cell(s[c])).join(','))).join('\n') + '\n';
}

module.exports = { parseCsv, readSessions, budgetRule, median, replay, summary, stopsCsv, REQUIRED, OPTIONAL };
