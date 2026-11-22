// Copyright (c) 2026 Miloš Petrović (Trench Logic Studio). SPDX-License-Identifier: MIT
// A self-contained example of the shipped defaults, using a fresh memory database.
'use strict';
const assert = require('node:assert/strict');
for (const key of Object.keys(process.env)) {
  if (key.startsWith('VIP_')) delete process.env[key];
}
const { open } = require('./src/store');
const engine = require('./src/engine');
const { verify } = require('./src/boundary');
const db = open(':memory:');
try {
  const inputs = [['permitted', 5000], ['suppressed', 10000]];
  for (const [eligibility, expectedGuestBalance] of inputs) {
    const input = { vip_id: 'sample-' + eligibility, budget_eur: 20000, mode: 'hard_stop',
      eligibility, eligibility_at: new Date().toISOString() };
    const quote = engine.quote(db, input);
    const session = engine.confirm(db, { ...input, terms_version: quote.terms_version, quote_id: quote.quote_id, review_id: quote.review_id });
    const key = { vip_id: input.vip_id, session_id: session.session_id };
    const stake = engine.authorize(db, { ...key, stake_eur: session.armed_at_eur });
    const stop = engine.tick(db, { ...key, authorization_id: stake.authorization_id,
      event_id: 'checked-stake-1', delta_eur: session.armed_at_eur });
    if (eligibility === 'permitted') engine.redirectIssue(db, key);
    const receipt = engine.receipt(db, key.vip_id, key.session_id);
    const agreed = receipt.agreement.at_line;
    const applied = receipt.events.find(row => row.type === 'policy.stop');
    assert.equal(agreed.residual, expectedGuestBalance);
    assert.equal(applied.residual_to_guest_eur, agreed.residual);
    assert.equal(stop.overshoot_eur, 0);
    assert.deepEqual([applied.redirect_eur, applied.rollover_eur], eligibility === 'permitted' ? [3888.89,1111.11] : [0,0]);
    console.log(JSON.stringify({ eligibility, budget_eur: input.budget_eur, stop_eur: session.armed_at_eur,
      resort_eur: applied.redirect_eur, future_play_eur: applied.rollover_eur,
      guest_balance_eur: applied.residual_to_guest_eur, evidence: receipt.agreement.confirmation }));
  }
  assert.equal(verify(db).valid, true);
  console.log('Both receipts reconcile. The local audit chain verifies.');
} finally { db.close(); }
