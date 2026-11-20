# VIP SmartContract MVP

This local Node.js application persists demo sessions and issued credits in SQLite. The guest screen, host console and admin page call the same engine as the HTTP API. Version **0.2.15** ships inside VIP SmartContract **v3.21**, and this folder also runs on its own.

Use Node 22.13+ on the 22 line or Node 24+ with built-in SQLite. Run `npm test` in this directory, then `npm start`. Open [the guest screen](http://127.0.0.1:3400/). For a worked example, set a budget of €1,000 in hard-stop mode and stake €500 with **Check, then report**. The stake fits exactly, the service returns 423 and preserves €500. Choose **Issue settled credits**. Under the default policy the guest receives €150 in spa credit, €125 in dining credit, €75 in retail credit, €100 in rollover and €50 in residual funds. See [configuration](.env.example), [the API contract](docs/04_API_Spec.yaml) and [the fixes](../docs/FIXES.md).

## What 0.2.15 changes

The licence. VIP SmartContract is open source under the MIT License, and this build with it. The engine, the routes, the console and every canon value are those of 0.2.14.

## What 0.2.14 changes

**The stop line is held before the stake, not after it.** A tick reports money already consumed, so a session driven by ticks alone locks on the tick that crosses the line and that tick counts in full: on a line of €1,500 with €1,400 consumed, a reported €1,500 stopped the session at €2,900. `POST /v3/session/authorize` checks each stake before it is placed, reserves it against what is left to the line, and refuses one that does not fit (`409 STAKE_EXCEEDS_HEADROOM` with `headroom_eur`). The tick that reports the stake names its `authorization_id`. `POST /v3/session/release` returns a stake that was never played. Every stop now carries `overshoot_eur`: 0 when each stake was checked first, and the amount past the line when one was only reported.

**A pre-commitment binds.** A second pre-commit used to replace a live session at once, so a larger budget sent in the middle of play moved the line. A live session younger than `VIP_COMMITMENT_HOURS` (24 by default) now refuses it with `409 SESSION_LIVE` and says from when a new one is accepted. After that period a live session is superseded as before. A stopped session does not hold the guest.

The earlier 0.2.13 of this line did not contain the pre-stake check that a 0.2.13 published in October did. This release has both sets of changes.

Copied out of the repository, this folder runs without the in-memory reference service and the four offline HTML demos, and the tests that use those files report explicit skips. Inside the repository the full suite runs.

| Component | Responsibility |
|---|---|
| [policy.js](src/policy.js), [values.js](src/values.js) | Decimal inputs, persisted stop line, eligibility, caps and cent allocation |
| [engine.js](src/engine.js) | Sessions, tick receipts, settlement, withholding and instruments |
| [store.js](src/store.js) | Schema, migrations, write transactions and commit callbacks |
| [boundary.js](src/boundary.js) | Local hash chain, optional outbound events and display-name erasure |
| [seed.js](src/seed.js) | Replay synthetic sessions to build the initial ledger |
| [web.js](src/web.js), [request.js](src/request.js) | Pages, product operations and eight contract routes |
| [test.js](test.js), [regression.test.js](regression.test.js) | Baseline and adversarial regression tests |

The reference service retains state in memory. The MVP retains superseded sessions and instrument lifecycles on disk. Both accept an optional session ID on ticks, checks, releases and issues, an optional event ID on ticks, and both apply the pre-stake check and the commitment period. Audit payload fields and fingerprints are local to each implementation. The MVP also records advisory crossings, redemption, rollover use and erasure. Use tick, state and issuance responses for cross-implementation comparisons.

Released under the MIT License: see [LICENSE](LICENSE). Copyright (c) 2026 Miloš Petrović (Trench Logic Studio).
