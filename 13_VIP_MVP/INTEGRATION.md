# Integration reference

Both services implement the nine routes defined in the [OpenAPI specification](docs/04_API_Spec.yaml). The MVP adds the local console and `/vip` routes. The operator's wallet owns actual balances and must enforce the returned stop.

## Where the line holds

A tick reports money already consumed. A session driven by ticks alone therefore locks on the tick that crosses the line, and that tick counts in full. The engine holds the line only where it sees the stake first:

1. Before accepting a stake, call `POST /v3/session/authorize` with `vip_id` and `stake_eur`. The stake is reserved against what is left to the line as if it were lost. In hard-stop mode a stake that does not fit is refused with `409 STAKE_EXCEEDS_HEADROOM` and `headroom_eur`, the largest stake allowed now. Do not place a refused stake.
2. Place the wager, then report it with `POST /v3/session/tick`, naming the `authorization_id` the check returned. The check closes with that tick.
3. If the wager is cancelled or voided, call `POST /v3/session/release` with the `authorization_id`. Nothing is consumed and the reservation returns.

With every stake checked first, and no wager consuming more than the stake it was checked for, the session locks exactly on `armed_at_eur` and every stop reports `overshoot_eur: 0`. A tick without a check is still accepted and counted in full; when it crosses the line the stop says by how much in `overshoot_eur`. A tick that reports more than its checked stake is counted in full and recorded as `stake.exceeded`. Advisory mode refuses nothing and answers `enforced: false`.

## Session and retry semantics

| Operation | What to retain or check |
|---|---|
| `GET /v3/terms` | Show the guest the returned `terms` and keep `terms_version`. The version is a fingerprint of the terms, the same in both services for the same configuration. |
| `POST /v3/precommit` | Send `terms_version` with the amount the guest agreed to, and `eligibility_at`, the time of the operator's determination. Save the returned `session_id`, `armed_at_eur` and `terms_version`: the session and the `precommit` event record the amount and the version. A version other than the one in force is refused with `409 TERMS_CHANGED` and the version in force; show the guest the new terms before asking again. While the guest's session is live and younger than `VIP_COMMITMENT_HOURS` (24 by default), a second call is refused with `409 SESSION_LIVE`, `session_id` and `supersede_after`; the budget and the line do not move. After that period a second call supersedes the live session. From 3.22 a session that stopped inside the same period, counted from when it was armed, refuses a second call with `409 COMMITMENT_ACTIVE`, `session_id` and `precommit_after`. |
| `POST /v3/session/tick` | Supply `vip_id`, `session_id`, a stable `event_id` and `delta_eur`. The first success stores the response. An identical retry returns the same body and status (200 or 423). A different delta for that key gets 409 `EVENT_CONFLICT`. Without an event ID each call reports new consumption. Name `authorization_id` to report a checked stake; `404 AUTHORIZATION_UNKNOWN` and `409 AUTHORIZATION_CLOSED` consume nothing. |
| `POST /v3/session/authorize` | Returns `authorization_id`, `enforced`, `reserved_eur` and `headroom_eur`. Checks asked for at once cannot share the last euros. A refusal is written to the audit chain as `stake.refused`. |
| `POST /v3/session/release` | Closes a check that was never played. A second release of the same check is `409 AUTHORIZATION_CLOSED`. |
| `GET /v3/policy/state?vip_id=…` | Returns the latest session, `reserved_eur`, `headroom_eur`, current eligibility, preview and issuance flag. A pending quote may shrink under tighter shares or a lower cap, or be withheld. For an issued stop, the preview reports the booked amounts. |
| `POST /v3/redirect/issue` | Provide the guest and the ID of the stopped session. Issuance can complete after a new session opens for that guest. A repeated successful issue returns 409 `ALREADY_ISSUED`. |
| `GET /v3/audit/{session_id}` | Per-session events and the current global chain fingerprint. Hash values and event payload details depend on the implementation. |
| `POST /v3/programme/suppress` | The three accepted reasons are `exclusion`, `player_request` and `rg_determination`. Withdrawal stops the live session, withholds outstanding unissued settlements, blocks use of existing instruments and applies to future sessions. |

Record a past or current determination timestamp with a time zone, such as `2026-01-02T10:30:00+01:00`. A determination counts for 90 days by default; an absent or expired determination withholds the incentive. `VIP_ELIGIBILITY_TTL_DAYS=off` makes a determination good forever. The incentive is capped at €5,000 per stop by default; `VIP_REWARD_CAP_EUR=off` removes the ceiling. Use of previously issued instruments also checks the issuing session and current process default. Programme withdrawal is permanent for that guest in this engine. A pending instrument uses the lower of its original offer and its allocation under the current cap and venue or rollover shares. A disabled venue returns its unissued credit to the guest. A looser policy cannot increase the offer.

Session IDs isolate delayed operations. An anonymous retry of a pre-commit can still open a new session. Persist the operator's pre-commit decision before retrying across a network failure. SQLite keeps the new tick receipts in the same transaction as the tick and its decision. Receipts last as long as their sessions. Restarting the reference service clears its memory.

## Local product operations

| Route | Result |
|---|---|
| `POST /vip/session/stop` | Voluntary stop, with optional expected `session_id` |
| `GET /vip/credits?vip_id=…` | Issued instruments, held rollover and pending eligible session IDs |
| `POST /vip/credit/redeem` | Consume an issued instrument by numeric `credit_id` and record the event |
| `POST /vip/rollover/apply` | Record use of the oldest eligible outstanding rollover for the guest |
| `GET /vip/quarter` | Allocation, outstanding rollover and issued/redeemed credits for seeded stopped sessions |
| `GET /vip/chain/verify` | Report the first broken row and reason or return the current full chain head |
| `POST /vip/guest/erase` | Supply an admin token in `x-admin-token`. Remove the display name and checkpoint the SQLite WAL. Retry `503 ERASURE_PENDING` after the blocking reader releases its snapshot. |
| `GET /vip/config`, `/vip/sessions`, `/vip/guests` | Runtime settings and local demo views |

## Downstream delivery

Set both `VIP_DOWNSTREAM_URL` and `VIP_DOWNSTREAM_KEY` to activate the optional dispatcher. It posts JSON after the local transaction commits, using bearer authentication and a 1.5 second timeout. The envelope is `{ "source": "vip-mvp/0.2.16", "event": { "seq": 1, "type": "…", "payload": {}, "at": "…", "hash": "…", "fingerprint": "…" } }`. The sequence in this example is illustrative.

| Mirrored event | Payload fields |
|---|---|
| `policy.stop` | `vip_id`, `session_id`, `trigger`, `consumed_eur`, `preserved_eur`, `redirect_eur`, `rollover_eur`, `residual_to_guest_eur`, `eligibility`, `capped`, `eligibility_expired`, `overshoot_eur`, `authorizations_voided` |
| `redirect.issue` | `vip_id`, `session_id`, `credits` (spa, fnb, retail), `rollover_eur`, `residual_to_guest_eur` |
| `credit.redeem` | `vip_id`, `session_id`, `category`, `amount_eur` |
| `guest.erase` | `guest_id` |

Delivery is best effort. Receivers can observe loss or reordering and should use sequence numbers and fingerprints when reconciling. No external timestamp service, blockchain, queue or retry worker is configured. With the default policy, a fresh seed and an armed dispatcher, 60 stops and 60 issuances are eligible for delivery. Use a local test receiver for that demonstration.

Audit data uses operator-supplied opaque IDs. Use synthetic IDs for evaluation. Local erasure removes the display name from the database and its WAL. Backups, downstream stores and records keyed by the opaque ID have their own lifecycle.

## Earlier databases

Startup migrates the original MVP schema in one transaction. A database written before 0.2.14 gains the `authorizations` table, the reservation column on its sessions and the link from a tick to its check; its sessions keep their budgets and lines, and a live one is held for the commitment period counted from its opening. A database written before 0.2.16 gains the `terms_version` column; its sessions keep `null` there, because which terms they were armed under was not recorded, and a stopped one holds its guest for the rest of the commitment period like any other. Live sub-cent totals are rebuilt from recorded ticks. Completed historical monetary amounts and hashes are retained. A legacy pending stop contains the redirect, rollover and residual totals but lacks a per-venue quote. The service divides that recorded redirect using the current venue proportions. If every venue is disabled, it returns the redirect to the guest. New stops persist the exact per-venue offer.

An interrupted legacy issue can leave unused credit rows. A new issue replaces these atomically if no issuance was recorded and nothing was spent. The service returns `409 LEDGER_CONFLICT` when there is evidence of previous use or issuance for a supposedly unissued stop. Reconcile that existing ledger against the source records before changing balances. Previously redeemed duplicates in a completed historical settlement require the same review.

[Regression scenarios and source locations](../docs/FIXES.md) · [License](LICENSE) · Copyright (c) 2026 Miloš Petrović (Trench Logic Studio)
