# VIP SmartContract MVP

This local Node.js application persists demo sessions and issued credits in SQLite. The guest screen, host console and admin page call the same engine as the HTTP API. Version **0.2.17** ships inside VIP SmartContract **v3.23**, and this folder also runs on its own.

Use Node 22.13+ on the 22 line or Node 24+ with built-in SQLite. Run `npm test` in this directory, then `npm start`. Open [the guest screen](http://127.0.0.1:3400/). For a worked example, set a budget of €1,000 in hard-stop mode, review the amounts, confirm, and stake €500 with **Check, then report**. The stake fits exactly, the service returns 423 and preserves €500. Choose **Issue settled credits**. Under the default policy the guest receives €150 in spa credit, €125 in dining credit, €75 in retail credit, €100 in rollover and €50 in residual funds. See [configuration](.env.example), [the API contract](docs/04_API_Spec.yaml) and [the fixes](../docs/FIXES.md).

## Reviewed receipts in 0.2.17

The guest reviews the estimated amounts if play stops on the line, the selected mode, eligibility, the cap and the commitment. A separate confirmation arms the policy. Declining and editing the preview leave the database untouched. Opening the receipt shows the agreed example and the policy used at settlement. Raw contract clients can still call `/v3/precommit`. Their receipt distinguishes a supplied version from a configured default. Legacy sessions show an unavailable agreement.

Run `npm run example` for a permitted and a withheld €20,000 case in a fresh in-memory database, including an audit-chain check. [Integration details](INTEGRATION.md).

## Changes in 0.2.16

**The guest agrees to stated terms, and the record says which.** `GET /v3/terms` publishes the terms a pre-commitment is made under — the stop line, the split of the preserved budget, the ceiling on the incentive, the lifetime of the operator's determination and the commitment period — with a version that is a fingerprint of exactly those values. Every pre-commit records the version beside the amount: in the session, in `GET /v3/policy/state` and in the `precommit` event of the chain. A pre-commit that sends a `terms_version` other than the one in force is refused with `409 TERMS_CHANGED`, and nothing is armed. The guest screen shows the terms and sends their version.

**A stop holds the guest for the commitment period.** A stopped session holds the guest until `VIP_COMMITMENT_HOURS` (24 by default) after it was armed: a second budget inside that period is refused with `409 COMMITMENT_ACTIVE`, which names the session and `precommit_after`. Until 0.2.15 a stopped guest could arm a second budget at once. `0` switches both holds off.

**Replay past sessions before anything runs live.** `npm run replay -- sessions.csv` applies this engine's stop line and settlement, under the configuration of the environment, to an operator's anonymised past sessions (`guest`, `date`, `loss_eur`; optional `peak_loss_eur`, `budget_eur`, `eligibility`) and reports the stops, the gaming win forgone, the resort credit by venue, the future-play credit and the guests' own balances, in total and by month; `--json` and `--stops` write the report and one row per stop. Past sessions carry no pre-committed budget, so the budget is an assumption the report states: `--budget typical:2` (the default) gives each guest twice the median of the guest's own losing sessions, `--budget fixed:20000` gives everyone the same. A column that looks like personal data is refused. The result is the cost of the policy under that assumption, not a measurement of how guests behave once they have pre-committed. `samples/sessions-synthetic.csv` is an invented quarter that `samples/make-sessions.js` reproduces exactly.

**Future-play credit has a switch.** Future-play credit is the one part of a settlement that returns value to the gaming floor, and it is granted at the moment a guest stops. Where the operator's counsel treats that as an inducement to gamble, `VIP_FUTURE_PLAY=off` removes it: the rollover is 0, below the benefit ceiling its share stays with the guest; where the ceiling binds, the ceiling is all resort credit and the guest keeps the rest, as with the switch on, and the published terms and their version show it. `off` wins over any `VIP_ROLLOVER`; a value other than `on` or `off` refuses to start. The default is `on`, at 20%, and Demos B and C carry the same switch.

**The ceiling and the determination lifetime are on by default.** Without configuration the incentive is capped at €5,000 per stop and the operator's eligibility determination counts for 90 days, so a pre-commit without `eligibility_at` issues nothing. `VIP_REWARD_CAP_EUR=off` and `VIP_ELIGIBILITY_TTL_DAYS=off` restore the uncapped, never-expiring reference configuration. The reference stop earns €4,590 and the seed records a fresh determination, so the seeded quarter is the canon quarter under either configuration. The guest screen can simulate a current operator assessment.

## What 0.2.15 changes

The licence. VIP SmartContract is open source under the MIT License, and this build with it. The engine, the routes, the console and every canon value are those of 0.2.14.

## What 0.2.14 changes

**The stop line is held before the stake, not after it.** A tick reports money already consumed, so a session driven by ticks alone locks on the tick that crosses the line and that tick counts in full: on a line of €1,500 with €1,400 consumed, a reported €1,500 stopped the session at €2,900. `POST /v3/session/authorize` checks each stake before it is placed, reserves it against what is left to the line, and refuses one that does not fit (`409 STAKE_EXCEEDS_HEADROOM` with `headroom_eur`). The tick that reports the stake names its `authorization_id`. `POST /v3/session/release` returns a stake that was never played. Every stop now carries `overshoot_eur`: 0 when each stake was checked first, and the amount past the line when one was only reported.

**A pre-commitment binds.** A second pre-commit used to replace a live session at once, so a larger budget sent in the middle of play moved the line. A live session younger than `VIP_COMMITMENT_HOURS` (24 by default) now refuses it with `409 SESSION_LIVE` and says from when a new one is accepted. After that period a live session is superseded as before. A stopped session did not hold the guest until 0.2.16.

The earlier 0.2.13 of this line did not contain the pre-stake check that a 0.2.13 published in October did. This release has both sets of changes.

Copied out of the repository, this folder runs without the in-memory reference service and the four offline HTML demos, and the tests that use those files report explicit skips. Inside the repository the full suite runs.

| Component | Responsibility |
|---|---|
| [policy.js](src/policy.js), [settlement.js](src/settlement.js), [values.js](src/values.js) | Decimal inputs, persisted stop line, eligibility, caps and cent allocation |
| [engine.js](src/engine.js) | Sessions, tick receipts, settlement, withholding and instruments |
| [store.js](src/store.js) | Schema, migrations, write transactions and commit callbacks |
| [boundary.js](src/boundary.js) | Local hash chain, optional outbound events and display-name erasure |
| [seed.js](src/seed.js) | Replay synthetic sessions to build the initial ledger |
| [web.js](src/web.js), [request.js](src/request.js) | Pages, product operations and nine contract routes |
| [test.js](test.js), [regression.test.js](regression.test.js) | Baseline and adversarial regression tests |

The reference service retains state in memory. The MVP retains superseded sessions and instrument lifecycles on disk. Both accept an optional session ID on ticks, checks, releases and issues, an optional event ID on ticks, and both apply the pre-stake check, the commitment period on live and stopped sessions, and the published terms with the same version. Audit payload fields and fingerprints are local to each implementation. The MVP also records advisory crossings, redemption, rollover use and erasure. Use tick, state and issuance responses for cross-implementation comparisons.

Released under the MIT License: see [LICENSE](LICENSE). Copyright (c) 2026 Miloš Petrović (Trench Logic Studio).
