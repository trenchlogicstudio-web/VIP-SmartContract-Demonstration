# Fixes

This is the record of the corrections in VIP SmartContract v3.19 / MVP v0.2.13 and
v3.20 / MVP v0.2.14, with a reproduction for each and links to the code and the
regression tests. Release v3.21 / MVP v0.2.15 changes the licence only — see the
[changelog](../CHANGELOG.md). The links point at the v3.21 code.

## v3.20 / MVP v0.2.14 — 16 November 2026

The release of 10 November (v0.2.13 / v3.19) was built from v0.2.12 / v3.18 and
therefore did not contain the pre-stake check that had been published in October
under the same numbers, v0.2.13 / v3.19. This release has both sets of changes and
one new one. Tested on Node.js 22.23.4.

| Finding | What it was and what it is now | Code and reproduction |
|---|---|---|
| The stop line | A tick reports money already consumed. On a line of €1,500 with €1,400 consumed, a reported €1,500 locked the session only at €2,900 and preserved €100 instead of €1,500. A stake of €50,000 against a budget of €3,000 went through in full. Now `POST /v3/session/authorize` checks a stake before it is played, reserves it against what is left to the line, and refuses a stake that does not fit (409 STAKE_EXCEEDS_HEADROOM with `headroom_eur`). The tick that reports the stake names its `authorization_id`. The session locks exactly on the line, and every stop carries `overshoot_eur`: 0 when every stake was checked, and the amount past the line when one was only reported. | [check](../13_VIP_MVP/src/engine.js#L229) · [room to the line](../13_VIP_MVP/src/policy.js#L331) · [overshoot](../13_VIP_MVP/src/engine.js#L166) · [regression](../13_VIP_MVP/regression.test.js#L120) |
| Releasing and repeating a check | `POST /v3/session/release` returns the reservation of a stake that was not played. A closed check cannot be reported or released again, another session's checks and unknown ones are refused, and nothing is consumed. A wager that consumes more than its check is recorded in full and logged as `stake.exceeded`. | [release](../13_VIP_MVP/src/engine.js#L280) · [regression](../13_VIP_MVP/regression.test.js#L149) |
| A refusal stays in the log | A refused stake is the evidence that the stop works, but the request that caused it fails and its transaction is rolled back. The `stake.refused` record is therefore written after the rollback, in a transaction of its own, and the hash chain stays intact. | [record after the rollback](../13_VIP_MVP/src/store.js#L185) · [regression](../13_VIP_MVP/regression.test.js#L614) |
| Concurrent stakes | Twelve stakes of €300 sent at once against a line of €1,000: exactly three go through, and the others get 409 with the room that is left. | [regression](../13_VIP_MVP/regression.test.js#L627) |
| Seeded test of the line | 2,000 sessions from a fixed seed: stakes that fit, stakes that are too large and a stake of exactly what is left to the line, with a check released now and then. Consumption never passes the line, and every stop is exactly on it. When the check is loosened by one cent on purpose, the test fails at the first step. | [regression](../13_VIP_MVP/regression.test.js#L184) |
| A commitment binds | A new pre-commit used to replace a live session at once. At €450 of a €500 line, one call with a budget of €100,000 made the line €50,000. Now a live session younger than `VIP_COMMITMENT_HOURS` (24 by default, 0–168 allowed) refuses a new pre-commit with 409 SESSION_LIVE and says from when one will be accepted. A larger, an equal and a smaller budget are refused alike. After that period a live session is superseded as before. A clock turned back does not unlock the session. A stopped session does not hold the guest: whether a stopped guest may commit to a budget again the same day remains the platform's rule, as before. The value 0 switches the rule off. | [rule](../13_VIP_MVP/src/engine.js#L95) · [setting](../13_VIP_MVP/src/policy.js#L138) · [regression](../13_VIP_MVP/regression.test.js#L227) · [setting, test](../13_VIP_MVP/regression.test.js#L663) |
| Older databases and the console | A database from an earlier release gains the table of checks, the reservation column and the link from a tick to its check. The guest screen gains **Check, then report** buttons and shows the reserved amount and the largest stake allowed. | [migration](../13_VIP_MVP/src/store.js#L229) · [regression](../13_VIP_MVP/regression.test.js#L647) · [guest screen](../13_VIP_MVP/src/web.js#L144) · [regression](../13_VIP_MVP/regression.test.js#L683) |

Results of this release: in the full package 308 base checks and 41 regression
scenarios, none skipped; in the standalone MVP 283 base checks with 1 skipped and
32 regression scenarios with 9 skipped, because the checks that need the reference
implementation and the HTML demos exist only in the package. Both implementations,
the MVP and the reference, pass the same scenarios for the stake check and for the
commitment period.
[The check in the in-memory implementation](../04b_Integration_Reference.js#L515) ·
[the commitment period in the in-memory implementation](../04b_Integration_Reference.js#L384)

Not tested in this update: a real browser, Docker, and operation beside a real
wallet. The line holds only if the platform asks before every stake and no wager
consumes more than its check; the commitment period reads the system clock.

## v3.19 / MVP v0.2.13 — 10 November 2026

The review started from MVP 0.2.12 and VIP SmartContract 3.18. All 14 files of the
standalone MVP were identical to the files in the package's `13_VIP_MVP` folder. The
corrections went into MVP v0.2.13 and SmartContract v3.19. The check counts below
refer to that release, measured on Node.js 24.22.1.

### Results

| Check | Result |
|---|---|
| Delivered version, with the reference implementation | 308 checks passed, 0 failed, 0 skipped |
| Corrected release, base suite | 308 checks passed, 0 failed, 0 skipped |
| Additional regression scenarios | 28 scenarios passed, 0 failed, 0 skipped |
| Both services started from the unpacked project | On each service the shape of 12 responses across all six routes was checked against the OpenAPI specification |
| Migration of a database written by the original application | All 189 existing events and the final hash stayed the same on opening. The open session went on accepting consumption, and a settlement stopped earlier was issued |

The base suite still compares the allocation for every cent from €0.01 to €2,000.
One original check now requires an explicit HTTP 413 for an oversized request;
before, it expected the TCP connection to be dropped. Run `npm test` from the
repository root. To repeat only the new cases, run
`node --test 13_VIP_MVP/regression.test.js`.

### Findings

| Area | Reproduction and outcome | Code and test |
|---|---|---|
| Interruption during issuance | An interruption while writing the second category left one spa credit in the database. A retry on the original produced four instruments, two of them spa credits. All instruments, the issuance marker and the log record are now committed together. | [transaction](../13_VIP_MVP/src/store.js#L150) · [regression](../13_VIP_MVP/regression.test.js#L270) · [additional check](../13_VIP_MVP/regression.test.js#L428) |
| Interrupted seeding and event dispatch | One guest already written used to prevent seeding again after an error. Now the whole sample set is committed at once. Outbound dispatch starts only after the local write has succeeded. | [seed set](../13_VIP_MVP/src/seed.js#L72) · [delivery](../13_VIP_MVP/src/boundary.js#L37) · [regression](../13_VIP_MVP/regression.test.js#L284) · [additional check](../13_VIP_MVP/regression.test.js#L295) |
| Money precision | For a budget of €2.01 the original read a consumption of €1.005 as €1.00 and missed the lock. Now it reads €1.01 and locks the session. Sub-cent records keep their exact decimal sum across a restart. | [decimal arithmetic](../13_VIP_MVP/src/values.js#L13) · [regression](../13_VIP_MVP/regression.test.js#L81) · [additional check](../13_VIP_MVP/regression.test.js#L387) |
| Expiry, suppression and a date in the future | The original accepted a determination dated in the future. Switching the global mode to suppressed, or a determination expiring, still allowed instruments already issued to be used. Now the date is checked against the calendar and the time zone, and eligibility is checked again at issuance and at use. | [date](../13_VIP_MVP/src/values.js#L45) · [use](../13_VIP_MVP/src/engine.js#L580) · [regression](../13_VIP_MVP/regression.test.js#L91) · [additional check](../13_VIP_MVP/regression.test.js#L357) |
| Repeated and late delivery | Two deliveries of the same €20 report gave €40 of consumption. With a stable session_id and event_id the same request now returns the first result, including 423 after the stop. A different amount under the same key gets 409. Both services keep the earlier behaviour when the key is absent. | [SQLite receipt](../13_VIP_MVP/src/engine.js#L293) · [in-memory receipt](../04b_Integration_Reference.js#L399) · [regression](../13_VIP_MVP/regression.test.js#L99) |
| Issuance after a new session | An earlier settlement became unreachable through the API after a new pre-commit. It can now be issued by session and guest ID. Late consumption for the old session gets 409, and withdrawal from the programme covers every unissued settlement of the guest. | [session choice](../13_VIP_MVP/src/engine.js#L35) · [withdrawal](../13_VIP_MVP/src/engine.js#L524) · [regression](../13_VIP_MVP/regression.test.js#L255) |
| A policy change after a restart | A session with a budget of €100 and a published threshold of €50 could go on playing past €50 after the threshold was raised to 90%. Issuance also recomputed the allocation. Now the agreed threshold and the recorded settlement are used. A lower cap or category share can reduce an unissued offer, and the difference belongs to the guest. A cap of €1.009 allows at most €1.00. | [threshold](../13_VIP_MVP/src/policy.js#L224) · [settlement](../13_VIP_MVP/src/engine.js#L405) · [regression](../13_VIP_MVP/regression.test.js#L329) · [additional check](../13_VIP_MVP/regression.test.js#L341) |
| A refused amount and an old ledger entry | A refusal could leave the old amount in the session's columns, payable again after a configuration change. Now the refusal is recorded once and the preserved amount belongs to the guest. An interrupted old issuance can be repeated when there is no evidence that anything was already used. | [refusal](../13_VIP_MVP/src/engine.js#L427) · [old entries](../13_VIP_MVP/src/engine.js#L461) · [regression](../13_VIP_MVP/regression.test.js#L376) · [additional check](../13_VIP_MVP/regression.test.js#L589) |
| The quarter and the outstanding liability | Credits issued by hand entered the total of the sample quarter they did not belong to. Every total now uses the same set of seeded sessions. When a guest applies €1,020 of rollover credit, the outstanding liability falls from €61,200 to €60,180, while the allocation at the stop stays €61,200. | [quarter query](../13_VIP_MVP/src/engine.js#L622) · [regression](../13_VIP_MVP/regression.test.js#L315) |
| The log and erasure | Corrupt JSON in the log caused a server error. Verification now names the first row at fault and the reason. When another reader of the database holds an old WAL, erasure answers 503 ERASURE_PENDING; calling again completes the same request and does not write a second erasure. | [chain verification](../13_VIP_MVP/src/boundary.js#L44) · [erasure](../13_VIP_MVP/src/boundary.js#L118) · [regression](../13_VIP_MVP/regression.test.js#L419) · [additional check](../13_VIP_MVP/regression.test.js#L402) |
| HTTP, identifiers and local access | A multi-byte character split across two network packets could change a guest ID. An oversized request dropped the connection. Both services now read bytes, answer 413 above 1,000,000 bytes and refuse invalid UTF-8. The local profile binds its ports to loopback and refuses write requests from a browser page of another origin. | [HTTP](../13_VIP_MVP/src/request.js#L7) · [address](../13_VIP_MVP/server.js#L29) · [regression](../13_VIP_MVP/regression.test.js#L458) |
| The consoles and the four HTML demos | The guest and the host can now issue a stopped settlement from the screen. In Demo A the agreed budget is locked, and in Demo B the parameters stay fixed during play. In Demo C the redirect is capped at 80% beside the 20% rollover. In Demo D playback resumes from the paused week. | [guest screen](../13_VIP_MVP/src/web.js#L100) · [regression](../13_VIP_MVP/regression.test.js#L526) · [additional check](../13_VIP_MVP/regression.test.js#L552) |
| Settings, session choice and reset | An empty numeric share used to pass as zero; it is refused now, and so is a configuration in which escalation comes before the first nudge. The write order picks the latest session when the clock moves back. Reset checks the schema and deletes the demonstration data in one transaction. | [reset](../13_VIP_MVP/reset.js#L11) · [regression](../13_VIP_MVP/regression.test.js#L493) · [additional check](../13_VIP_MVP/regression.test.js#L513) · [additional check](../13_VIP_MVP/regression.test.js#L603) |

### Existing databases and the limits of these checks

Migration keeps the amounts and hashes already completed. Release 0.2.12 recorded the
total for the venues, the rollover and the residual, but kept no per-venue split
for unissued settlements. On the first such issuance the stored total is divided by
the venue shares in force at that moment; with all three categories switched off,
that part returns to the guest. New settlements store the per-venue split as well.
If an old settlement, supposedly unissued, already has a used instrument, the answer
is 409 `LEDGER_CONFLICT`. Duplicates already redeemed in an earlier completed
session need reconciling against the source records.
[Handling an earlier database](../13_VIP_MVP/INTEGRATION.md#earlier-databases)

The tests use local HTTP services, SQLite, separate processes and writes
interrupted on purpose. The console controls were checked by running their
JavaScript against the local API with a stand-in for the browser DOM. Rendering in a
real browser and starting the Docker containers are not part of these results; the
compose file was checked statically. A GitHub workflow runs the suite on every push.
[Workflow definition](../.github/workflows/test.yml)

The measurements are of synthetic sessions and the local log. A real wallet, a
casino integration, a one-session-per-day rule and independent timestamping need
the surrounding environment. An outside event receiver can miss a delivery made
after the local commit. [Events and delivery](../13_VIP_MVP/INTEGRATION.md#downstream-delivery)

---

Copyright (c) 2026 Miloš Petrović (Trench Logic Studio) · MIT License
