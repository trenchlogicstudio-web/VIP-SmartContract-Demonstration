# Changelog

## v3.21 · MVP v0.2.15 — 20 November 2026

The open-source release. Nothing in the engine, the routes, the consoles or the
canon values changed.

- **Licence.** VIP SmartContract is released under the [MIT License](LICENSE), in
  the repository root and in [`13_VIP_MVP`](13_VIP_MVP/LICENSE). Every source file
  carries a copyright and `SPDX-License-Identifier: MIT` line, and both
  `package.json` files name the licence and the author.
- **Withdrawn from the repository:** the commercial and legal set — buyer briefs
  (02a, 02b), value justification (06), pricing model (06b), strategic value (07),
  letter of intent (08), licence agreement (08b), pitch deck (08c) and NDA (08d) —
  the AS-IS notice (09), the MVP licence note and the competitive battlecard (11).
  The remaining slots keep their numbers.
- **Documents and pages.** The confidentiality status and the proof-chain line are
  gone from every footer and title block; the status line states the licence.
  Wording that addressed a buyer addresses the operator or the integrator. The
  Word footers show the page number again, the title block no longer splits
  across two pages, and Demo A's step controls wrap on a phone screen instead of
  running past it.
- **Canon 1.16, MVP canon 1.15.** `terms` states the licence; the pricing, buyer
  segments, competitor classes and AS-IS scope blocks are removed;
  `licensed_ip` is kept, word for word, as `mechanism_scope`.
- **Documentation in English:** [`README.md`](README.md), this changelog, and
  [`docs/FIXES.md`](docs/FIXES.md), the record of the v3.19 and v3.20 corrections
  with links to the code and the regression tests.
- **CI:** GitHub Actions on `actions/checkout@v7` and `actions/setup-node@v7`,
  Node.js 22.13.0, 22.x, 24.x and 26.x.
- **Verified:** 308 checks and 41 regression scenarios pass, none skipped, on
  Node.js 22.13.0, 22.23.4, 24 and 26, with the workflow run locally; copied out of
  the repository, `13_VIP_MVP` passes with its stated skips. Every page and demo
  opens in Chrome without errors at desktop and phone widths, and a hard-stop
  settlement runs end to end in the guest screen. The compose stack starts both
  services, with a local Node.js 22.13.0 image standing in for the official one,
  which could not be downloaded here. The four Word documents render on the same
  number of pages as before.

## v3.20 · MVP v0.2.14 — 16 November 2026

- **The stop line is held before the stake.** `POST /v3/session/authorize` checks
  each stake before it is placed and refuses one that does not fit what is left to
  the line (`409 STAKE_EXCEEDS_HEADROOM`); `POST /v3/session/release` returns a
  stake that was never played. Every stop states `overshoot_eur`.
- **A pre-commitment binds.** A live session younger than `VIP_COMMITMENT_HOURS`
  (24 by default) refuses a new pre-commit with `409 SESSION_LIVE`.
- The v3.19 of 10 November was built without the pre-stake check that an October
  2026 release under the same numbers had introduced; v3.20 has both sets of
  changes. Details: [`docs/FIXES.md`](docs/FIXES.md).

## v3.19 · MVP v0.2.13 — 10 November 2026

Transactional issuance, exact sub-cent accumulation, idempotent tick receipts,
settlements kept at the terms quoted, eligibility checked again at issuance and
at use, an erasure that answers 503 while another reader holds the old log and
completes on the next call, byte-exact request bodies
with `413` above 1,000,000 bytes, loopback binding with same-origin writes, and
fixes to the consoles and the four demos. Details: [`docs/FIXES.md`](docs/FIXES.md).

## Earlier revisions

Every revision of the canon is recorded in [`12_Canon.json`](12_Canon.json), in its
`canon_change_log` entries, and every revision of the MVP in
[`13_VIP_MVP/CANON.json`](13_VIP_MVP/CANON.json).

---

Copyright (c) 2026 Miloš Petrović (Trench Logic Studio) · MIT License
