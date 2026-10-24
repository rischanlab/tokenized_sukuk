# Prior-art matrix

Read from the full texts held in the project folder (`technical/papers/`).
"Not reported" means we did not find it in the paper; it does not mean the
authors could not have built it.

| Work | Type | Asset / rights evidence | Signer roles | Freshness, revocation, replay | Sukuk rule encoded | Lifecycle / redemption | Evaluation reported |
|---|---|---|---|---|---|---|---|
| Khan et al. (2022), Global Finance Journal 51, 100539 | Solidity prototype (basic functions for a Sukuk al-Murabahah issuance, run on Remix) and cost-benefit analysis | not reported | not reported | not reported | not reported | basic issuance functions | gas and fee table for the prototype's functions; cost comparison with conventional issuance |
| Shaikh and Zaka (2019), FinanceCom 2018, LNBIP 345, pp. 66–76 | conceptual design (three-ledger model; smart-contract transactions specified in a table) | proposed traceability of financing to assets | parties listed, no key model | not reported | not reported | described, not implemented | none (no implementation reported) |
| Moppratama, Alamsyah and Tricahyono (2024), ICoABCD, pp. 107–112 | stakeholder and data model for property sukuk; practitioner interviews | records of property, financial and Sharia-compliance data | stakeholder roles | not reported | not reported | described | interview-based model assessment; no implementation or tests reported |
| Kunhibava et al. (2021), ISRA IJIF 13(1), 118–135 | legal, regulatory and Shariah review | — | — | — | discusses Shariah and legal issues | — | qualitative |
| Busari and Aminu (2021), JIABR | Shariah analysis of blockchain in sukuk trade | — | — | — | discusses tradability | — | qualitative |
| ERC-3643 (Lebrun et al., 2021) | final standard with reference implementation | investor identity claims (ONCHAINID), not asset evidence | trusted claim issuers per claim topic | claim validity through issuers; not asset-level | none (generic compliance module) | mint, burn, forced transfer, recovery, pause, freeze | standard, not an evaluation |
| Mafrur, Febrianza and Foley (2026), RWA-PoB, arXiv:2608.25269 | Solidity prototype and tests for tokenized Treasury products | one canonical EIP-712 reserve/liability snapshot | five required institutional roles approve the same snapshot | freshness, epochs, role checks | none (Treasury products) | burn-to-pending redemption and settlement confirmation | scenario, invariant, adversarial and gas tests against an aggregate PoR baseline |
| **This work** | Solidity prototype, tests, oracle, benchmark | per-asset rights, valuation, classification and encumbrance claims; tranche allocation | six roles, one role per key, claim type bound to role; wakeel + trustee co-sign tranches | validity window ≤ 30 days, per-subject sequence numbers, claim and attestor revocation, domain binding, tranche replay, EIP-1271 | SAC 2023 Wakalah rule: 33% of each issuance's proceeds; continuing non-debt component for transfers; version-bound Shariah status | ERC-3643-style controls, suspension with quorum resumption, versioned policy with timelock, burn-to-pending redemption | 26-scenario oracle over B0/B1/B2, seeded model-based differential test, gas and latency benchmark |

## What is not new here

ERC-20 tokens, identity allow-lists, pause/freeze/forced-transfer agent
controls (ERC-3643), EIP-712 signatures, role-based signing of reserve
statements and burn-to-pending redemption accounting (RWA-PoB) all have
precedents. The redemption accounting in `SukukToken` follows the RWA-PoB
pattern.

## What this repository adds, as tested

1. Per-asset, per-claim-type evidence from separate roles, combined at use
   into backing and non-debt eligibility, instead of a single aggregate
   snapshot.
2. An encoding of a specific, cited Shariah tradability rule that separates
   the issuance test from the continuing condition, with a negative control
   (T03) against the common "33% at all times" misreading.
3. Policy versioning in which Shariah judgements are bound to the version they
   were made under and recorded tranches are not re-evaluated.
4. A three-way ablation (B0, B1, B2) on the same token, identity registry and
   operation schedule.

## ERC-3643 controls in each configuration

| Control | B0 | B1 | B2 | Note |
|---|---|---|---|---|
| Receiver identity check on transfer, transferFrom, mint, forced transfer | yes | yes | yes | simplified registry: eligibility flag, country, expiry; no ONCHAINID claims or trusted-issuer registry |
| Global compliance check on transfer (`canTransfer`) | yes (always true) | yes | yes | |
| Compliance check on mint | no (always true) | yes | yes | ERC-3643 mint bypasses compliance; here issuance is authorised against a tranche |
| Pause, wallet freeze | yes | yes | yes | |
| Partial token freeze | no | no | no | not implemented |
| Forced transfer | yes | yes | yes | bypasses compliance, as in ERC-3643; requires a justification hash |
| Wallet recovery | no | no | no | not implemented |
