# MVP v0.2.11 — Integration

AS-IS evaluation artifact — `09_AS_IS_Notice.txt` of the VIP SmartContract
package governs. This document is a guide only; no integration support is
provided.

The MVP runs in one of two postures. Nothing in the policy engine changes
between them.

**Path 1 — self-sufficient (default).** No downstream. The MVP is the whole
system: pre-commit, ticks, stop, settlement, credit, rollover, audit chain,
console. This is the evaluation posture and it is complete on its own.

**Path 2 — armed downstream.** Set two environment variables and the Boundary
starts mirroring canonical events to your stack:

```
VIP_DOWNSTREAM_URL=https://your-endpoint.example/events
VIP_DOWNSTREAM_KEY=<your key>
```

Both must be set; either one missing keeps the MVP dormant. The boot banner
shows `DORMANT` or `ARMED`, so the posture is never ambiguous, and
`GET /vip/config` reports it too.

## The two surfaces

| Surface | What it is | Who implements it |
|---|---|---|
| `/v3/*` | The architecture contract in `04_API_Spec.yaml`. Six routes. | Your platform, in your own stack |
| `/vip/*` and the HTML console | The product surface of this running system: voluntary stop, credit redemption, rollover application, quarter roll-up, chain verification, erasure | This build only — not part of the specification |

**The mapping between the specification and this build is the identity
mapping.** This MVP serves the six `/v3` routes at their specified paths,
with the specified status codes and the specified error identifiers, and its
response bodies match registry slot `04b_Integration_Reference.js` field for
field on every route but one: on `GET /v3/audit/{session_id}` the fields inside
each event are this build's own record (README, Documented divergences). A
client written against the reference runs against this build with no change
as long as it reads amounts from the tick and state responses rather than from
audit payloads. `test.js` checks the arithmetic: the PARITY block loads the
reference from the package registry and asserts that both produce the same
armed amount, fire on the same tick, and settle to the same preserved,
rollover, residual and credit split — on every amount from €0.01 to €2,000.00,
not on a sample — and that both refuse the same malformed input with the same
identifier.

That is worth stating plainly, because it is not true of every artifact in
this portfolio: where another product's MVP publishes its own paths and maps
them to the specification, here there is nothing to map.

## Delivery semantics

- `POST` to `VIP_DOWNSTREAM_URL`, `Content-Type: application/json`,
  `Authorization: Bearer <VIP_DOWNSTREAM_KEY>`.
- **Fire-and-forget.** 1.5 s timeout, no retries, no queue, at-most-once. The
  policy never blocks, never waits, and never fails a guest action because a
  downstream was slow or absent. If you need guaranteed delivery, put a
  receiver in front that acknowledges fast and queues internally — that is
  buyer-side architecture, not policy-engine behaviour.
- Events are mirrored **after** they are committed to the local hash chain.
  The chain, not the downstream, is the source of truth.
- Arm Path 2 against a **fresh** database and the first boot will mirror the
  whole seeded quarter — 120 milestones — because the seed replays the real
  engine rather than writing fixtures. Point it at a scratch endpoint the
  first time, or arm it against an already-seeded database.

## Event contract

Four event types cross the Boundary. Envelope — `source` names this build and
is read from `package.json`, where the code reads its version:

```json
{
  "source": "vip-mvp/0.2.11",
  "event": {
    "seq": 182,
    "type": "policy.stop",
    "at": "2026-09-09T09:41:03.512Z",
    "hash": "…",
    "fingerprint": "…",
    "payload": { }
  }
}
```

| `type` | Fired when | `payload` |
|---|---|---|
| `policy.stop` | the session stops, by threshold, by the guest's choice or by a programme suppression | `vip_id`, `session_id`, `trigger`, `consumed_eur`, `preserved_eur`, `redirect_eur`, `rollover_eur`, `residual_to_guest_eur`, `eligibility`, `capped`, `eligibility_expired` |
| `redirect.issue` | resort credits are issued from preserved budget | `vip_id`, `session_id`, `credits{spa,fnb,retail}`, `rollover_eur`, `residual_to_guest_eur` |
| `credit.redeem` | an issued credit is redeemed | `vip_id`, `session_id`, `category`, `amount_eur` |
| `guest.erase` | a guest exercises erasure | `guest_id` — the same opaque identifier the other events carry as `vip_id` |

`vip_id` is an opaque identifier. No display name and no contact data crosses
the Boundary — by construction, not by filtering: the chain payloads never
contained a name in the first place, and `test.js` asserts that no display
name appears anywhere in the event log.

The six remaining event types — `precommit`, `advisory.nudge`,
`advisory.escalate`, `rollover.apply`, `incentive.suppressed` and
`eligibility.expired` — stay local. They are in the audit chain, and every
one written for a session is readable through `GET /v3/audit/{session_id}`; a
programme-level `incentive.suppressed` belongs to the guest rather than to a
session, carries no `session_id`, and is read from the chain in the database
itself. None of them is mirrored: a downstream needs the money and the
obligations, not every intermediate signal.

**`guest.erase` is not optional to honour.** If your downstream stores
anything keyed to `vip_id`, receiving this event obliges you to apply your own
erasure there. This build's chain stays valid after erasure because it never
contained the name; your stack must reach the same state by its own
means.

## Where the money lands in your systems

The three integration points a resort actually needs, in the order they occur:

1. **`policy.stop`** — the moment gaming revenue stops and preserved budget
   appears. Your compliance store wants this row; so does the host's screen.
2. **`redirect.issue`** — credit is now outstanding against spa, F&B and
   retail. This is an issuance, not a sale: book it as a liability, not
   revenue.
3. **`credit.redeem`** — the credit is used. This is where non-gaming revenue
   is recognised, and it is the only one of the three that belongs in a
   revenue line.

Rollover is the fourth position and it is deliberately not mirrored on
issuance: `rollover.apply` stays local because the liability is extinguished
inside this system. If you need the rollover balance in your ledger, read it
from `redirect.issue.rollover_eur` and clear it when the credit is applied at a
later visit — here that is `rollover.apply`, which stays local, so the clearing
must come from wherever your platform applies the credit.

## Relationship to the VIP SmartContract package documents

- `04_API_Spec.yaml` — the six `/v3` routes here match it by path, status
  code and error identifier. The spec is the contract; this MVP is one witness
  of it.
- `04b_Integration_Reference.js` — the zero-dependency in-memory reference,
  still shipped and still the smallest readable statement of the mechanism.
  This MVP does not replace it and does not reimplement it: it is the same
  arithmetic with storage, a console and a boundary around it, and the PARITY
  block exists so that claim can be checked rather than believed.
- `04c_docker-compose.yml` — runs both: the reference on port 8080 and this
  MVP on port 3400.
- `12_Canon.json` — the package canon. `CANON.json` here mirrors it for every
  shared value and adds only what belongs to a running build.

## What the buyer replaces

Per `09_AS_IS_Notice.txt`: everything. SQLite becomes your store, `node:http`
becomes your gateway, the seeded quarter becomes your live guest and session
data, the dispatcher becomes your bus, and the console becomes your host
tooling. What must survive the replacement is the invariant set, in order of
importance:

1. **The threshold is engine-enforced**, and a threshold that is not a finite
   number in range stops the process rather than admitting everything.
2. **The model closes, and follows its rule**: redirect plus rollover plus
   residual equals preserved budget, always, and the residual is returned to
   the guest. Money is decided in integer cents — the split by largest
   remainder, a tie to the earlier position — and the stop line the pre-commit
   publishes is the first cent at which the engine fires, not an amount near
   it.
3. **Both modes settle through one path**, so an enforced stop and a voluntary
   stop cannot drift apart.
4. **Every decision is hash-chained**, and the chain is verifiable from
   genesis to head.
5. **No name enters the chain**, so erasure never damages it — and
   erasure reaches the files: the name is gone from the database file and its
   write-ahead log, not only from the API.

`test.js` is the checklist — port the assertions before you port the code.
