# Policy specification: MY-SAC-WAKALAH-2023, version 1

Status: research encoding by the authors. It has **not** been reviewed by a
qualified Shariah scholar or a Malaysian securities lawyer, and it is not a
Shariah ruling, a legal opinion or a statement about any real issuance.

## 1. Scope

| Item | Value |
|---|---|
| Instrument type | Sukuk Wakalah bi al-Istithmar (synthetic instrument `SYN-SUKUK-WAKALAH-001`) |
| Jurisdiction modelled | Malaysia |
| Governing pronouncement | Shariah Advisory Council (SAC) of the Securities Commission Malaysia, resolution on *Sukuk Wakalah bi al-Istithmar and its tradability*, 266th meeting, 16 March 2023 (SC compilation of SAC resolutions, item 56, printed pp. 143–145) |
| Policy identifier | `MY-SAC-WAKALAH-2023`, version 1 (`POLICY_DOC_HASH = keccak256("docs/policy_specification.md#MY-SAC-WAKALAH-2023-v1")`) |
| Operations covered | issuance (mint against a tranche), ordinary secondary transfer, redemption after maturity |
| Operations not covered | pricing of secondary trades, profit distribution, dissolution amounts, default and dispute resolution |

**Source access note.** The SC website was not reachable from the build
environment. The quotations below are those recorded in the authors' own
SSRN preprint (Mafrur and Khadijah, 2026, doi:10.2139/ssrn.7628219), which cites the same
resolution. They must be checked against the original SC document before
publication.

## 2. Source rule, as quoted

The SAC resolved that, for the Wakalah portfolio described in the resolution:

* (R1) "at least 33% of the Sukuk Wakalah proceeds shall be invested into
  non-debt investment assets", and this minimum "must be complied with at the
  time of each issuance";
* (R2) "it is not required to maintain such percentage throughout the tenure";
* (R3) "the non-debt investment assets shall at all times be a component of
  the Wakalah Portfolio";
* (R4) provided these conditions hold, the sukuk are not categorised as debt
  and may be traded at "any negotiated price between the contracting parties"
  without being subject to bai' al-dayn.

For contrast only (not encoded): AAOIFI Shari'ah Standard No. 59, cl. 8/2/2
and 8/2/3, combines an initial threshold with a continuing 33% floor and a
restoration period set by the Shariah board, after which trading becomes
subject to the rules on the sale of debt. A naive "33% at all times" rule is
therefore an AAOIFI-style reading and is **wrong** for the Malaysian
resolution; scenario S05 / test T03 is the negative control for this mistake.

## 3. Definitions used by the encoding

| Term | Encoding | Evidence it depends on |
|---|---|---|
| Asset of the Wakalah portfolio | an asset identifier for which the legal verifier has attested rights *for this instrument* (EIP-712 `instrumentId` binding) | `RIGHTS` claim by `LEGAL_VERIFIER` |
| Backing-eligible asset | current rights claim, current valuation with value > 0, and (if `excludeEncumbered`) no effective encumbrance | `RIGHTS`, `VALUATION` (`VALUER`), `ENCUMBRANCE` (`CUSTODIAN`) |
| Non-debt investment asset | backing-eligible and currently classified `NON_DEBT` under the active policy version | `CLASSIFICATION` by `SHARIAH_ADVISER` |
| Proceeds of an issuance | `TrancheAllocation.proceeds`, which must equal the number of units minted | wakeel + trustee co-signature |
| Non-debt share of an issuance | sum of allocation amounts to non-debt assets divided by proceeds | tranche allocation and the claims above |
| Current claim | exists, not revoked, `block.timestamp <= validUntil`, signer still an active attestor | attestor registry |

Classification of an asset as debt or non-debt is a Shariah judgement. The
contract does not make it; it only checks that an authorised Shariah adviser
key has signed a current classification bound to the active policy version.

## 4. Encoded rules

| Rule | Encoded check | Where | Reason code on failure |
|---|---|---|---|
| R1 issuance minimum | `nonDebtSum * 10000 >= minNonDebtBps * proceeds` with `minNonDebtBps = 3300`; every allocated asset must be backing-eligible; cumulative allocation to an asset may not exceed its attested value; allocation total may not exceed proceeds | `SukukPolicyEngine.authorizeIssuance` | `NON_DEBT_RATIO_BELOW_MINIMUM`, `ALLOCATION_INVALID` |
| R2 no maintenance | the ratio is **not** evaluated after issuance | (absence of a check; tested by T03) | — |
| R3 continuing component | an ordinary transfer requires the *witness* asset to be non-debt-eligible now (B2F: or one of the first 32 allocated assets; an eligible 33rd asset is not scanned, test T21) | `SukukPolicyEngine.canTransfer` → `EvidenceRegistry.checkTransferEvidence` | `NON_DEBT_COMPONENT_UNVERIFIED` |
| R4 price treatment | **not implemented and not tested.** A token transfer carries no price and the prototype has no settlement or delivery-versus-payment module, so no price-dependent consequence can be observed or enforced. That the rules on bai' al-dayn apply when R3 fails is the authors' inference and needs Shariah review | — | — |
| R4 proxy (authors' control) | **design choice, not required by the SAC**: ordinary transfers fail closed while R3 is not evidenced; no fail-open mode is implemented. S06 (blocked) and S23 (allowed while R1 and R3 hold) exercise this control; neither involves a price | `canTransfer` | `NON_DEBT_COMPONENT_UNVERIFIED` |
| Shariah status (prototype requirement, not part of the SAC text) | a current `SHARIAH_STATUS` attestation with code `ENDORSED` for the active policy version, required for issuance and transfer | `authorizeIssuance`, `checkTransferEvidence` | `SHARIAH_STATUS_INVALID` |

### Interpretation choices that a reviewer should confirm

1. **"At least 33%"** is read literally as 33.00% (3,300 basis points), not
   one third. S02 (exactly 33.00%) is allowed and S03 (32.99%) is denied.
2. **Denominator.** The share is computed over the proceeds of the tranche
   being issued, not over the whole portfolio, following "at the time of each
   issuance". Unallocated proceeds count in the denominator and not in the
   numerator.
3. **Encumbered assets** are excluded from both the backing and the non-debt
   counts (`excludeEncumbered = true`). The resolution does not mention
   encumbrance; this is a conservative design choice.
4. **Consequence of losing the component.** Under the resolution, losing the
   non-debt component removes the negotiated-price treatment and brings the
   rules on bai' al-dayn into play; it does not prohibit transfers as such.
   The prototype cannot see trade prices, so it cannot enforce par trading.
   It therefore suspends ordinary transfers (fail closed) until a current
   non-debt asset is evidenced and nominated. No fail-open mode (allow
   transfers and raise an alert for the Shariah adviser) is implemented.
   Governance could adopt a version with `applyNonDebtRules = false`, but that
   replaces the non-debt test with the B1 backing test and also disables the
   issuance minimum, so it is not a fail-open variant of the same policy. The
   choice belongs in the offering documents.
5. **Witness.** R3 asks whether *some* non-debt asset remains. The contract
   checks one nominated witness asset (O(1) per transfer). If the witness
   loses eligibility while another asset still qualifies, transfers fail
   closed until anyone calls `setWitness` with a qualifying asset. This is a
   liveness cost of the design (test "T03 liveness"; supplementary oracle
   scenarios G01 and G02). Configuration B2F (`SukukPolicyEngineFallback`)
   additionally scans up to 32 assets recorded at first allocation when the
   witness fails, without changing the stored witness (test "T03-F").
6. **Policy version binding.** Classifications and Shariah status attestations
   name the policy version they were made under. After a policy upgrade they
   stop counting until re-attested; recorded tranches keep the version under
   which they were authorised (no retroactive re-evaluation).

## 5. Decision order

For ordinary transfers (`SukukToken.preCheckTransfer`): paused → frozen
sender or receiver → matured → receiver not verified → instrument suspended →
Shariah status → continuing non-debt component (B2) or backing evidence (B1).
The first failing check determines the reason code.

For issuance (`SukukPolicyEngine.authorizeIssuance`, after the token's agent,
pause, maturity and non-empty checks): suspended → tranche replay → tranche
signatures and window → amount equals proceeds → tranche policy version →
Shariah status → allocation validity → issuance minimum. The token then
requires each recipient to be a verified identity.

## 6. Configurations

| Parameter | B1 | B2 |
|---|---|---|
| `minNonDebtBps` | 0 | 3300 |
| `applyNonDebtRules` | false | true |
| `requireShariahStatus` | false | true |
| `excludeEncumbered` | true | true |

B0 uses `BasicCompliance`, which allows every issuance and transfer that the
token's own identity, pause, freeze and maturity checks allow.

## 7. Review and sign-off

| Reviewer role | Name | Date | Outcome |
|---|---|---|---|
| Shariah adviser | — | — | not yet reviewed |
| Legal (Malaysian capital markets) | — | — | not yet reviewed |
