# Threat model and trust boundaries

## 1. What the system can and cannot establish

The contracts authenticate **who** signed a statement about an asset or the
instrument, check that the signer holds the role required for that kind of
statement, and check that the statement is bound to this instrument, chain and
verifying contract and is still current. They then apply a written policy to
the current set of statements.

They cannot establish that a statement is true. In particular they cannot show
that an asset exists, that the wakeel holds enforceable rights in it, that it
is free of an undisclosed lien, that its valuation is fair, that its Shariah
classification is correct, or that any regulator has approved an offering.
Hashes of off-chain documents (`evidenceHash`) prove only that a signer
referred to a document with that hash.

## 2. Parties and keys

| Party | On-chain authority | Trusted for |
|---|---|---|
| Governors (3 keys, quorum 2) | register and revoke attestors (registry `GOVERNOR_ROLE`, held by the first governor in the prototype); propose, approve and activate policy versions (quorum + 1-day timelock); suspend (any one governor); resume (quorum) | honest onboarding of attestors; not to collude |
| Agent (issuer operator) | `issue` with valid tranche evidence; pause/unpause; freeze; forced transfer with a justification hash; identity registry entries | KYC and eligibility data; legitimate use of forced transfers |
| Wakeel | co-signs tranche allocations | truthful allocation of proceeds |
| Trustee | co-signs tranche allocations | independent check of the allocation |
| Legal verifier | `RIGHTS` claims | truth of rights statements |
| Valuer | `VALUATION` claims | truth of valuations |
| Custodian | `ENCUMBRANCE` notices | timely notice of liens |
| Shariah adviser | `CLASSIFICATION` and `SHARIAH_STATUS` claims | correctness of Shariah judgements |
| Settlement role | `confirmSettlement` | that the off-chain payment occurred |
| Relayer (anyone) | submits signed claims, nominates a witness | nothing: it cannot alter signed content |

Each attestor address holds exactly one role and is never reassigned after
revocation. The contracts cannot prevent one institution from controlling
several addresses with different roles; separation of the institutions behind
the keys is a governance obligation.

## 3. Adversaries, mitigations and tests

| # | Threat | Mitigation in the prototype | Evidence |
|---|---|---|---|
| A1 | Ineligible investor or operator bypasses transfer rules (incl. `transferFrom`) | all balance changes go through `_update`, which runs the pre-check unless the call is the privileged issue, redemption or forced-transfer path | T09, I7 tests; model-based test |
| A2 | Forged signature, unregistered key, key outside its role, altered payload | attestor registry with one role per key; role required per claim type; EIP-712 digest over all fields; `SignatureChecker` (EOA and EIP-1271) | T05 tests |
| A3 | Replay of a claim or tranche; cross-instrument, cross-chain or cross-contract replay | per-(subject, type) strictly increasing `seq`; recorded `trancheId`; `instrumentId` in payload; EIP-712 domain with `chainId` and `verifyingContract` | T07 tests, S12, S13 |
| A4 | Stale or withheld evidence | maximum claim validity (30 days); currency evaluated at use; transfers fail closed when the evidence they need lapses | T06 tests, S09, S10 |
| A5 | Compromised attestor key | governor revokes the attestor; all of its claims stop counting immediately; remediation through a new key and fresh claims | T11, S18, S19 |
| A6 | Out-of-order updates within one block | sequence numbers, not arrival order, decide which claim is authoritative | T12 |
| A7 | Contradictory rights and encumbrance evidence | conflict event; encumbered assets excluded; encumbrance notices do not lapse with time (negative evidence) | T08, S14 |
| A8 | Double counting of an asset across tranches | cumulative `allocated` per asset bounded by attested value; sorted, duplicate-free allocations | T08/I5, S15 |
| A9 | Silent or unilateral policy change | versioned policy, governor quorum, timelock, no retroactive effect on recorded tranches, version-bound Shariah attestations | T10, S17 |
| A10 | Double redemption or unaccounted obligations | burn to pending; settlement bounded by the pending amount; `totalIssued = supply + pending + settled` | T13, S21, S22, invariant I6 |
| A11 | Emergency halt | any one governor can suspend; resumption needs a quorum; votes do not carry over between suspension epochs | lifecycle tests, S25 |

## 4. Residual risks (not mitigated by the contracts)

* **Honest signature, false content.** A valuer who signs an inflated
  valuation, or a legal verifier who attests rights that do not exist,
  produces evidence the contracts accept. Example: the valuer attests
  ASSET-IJARAH-001 at 25,000,000 units after the property was destroyed; the
  issuance minimum and the continuing-component check both pass.
* **Correct rule, outdated input.** If an asset is sold off-chain and nobody
  signs a zero valuation or revokes the rights claim, the asset keeps counting
  until its claims expire (at most 30 days in the prototype). The stale-state
  window is bounded by the validity period, not removed.
* **Collusion.** Wakeel and trustee together can authorise any allocation
  that the attested values permit; valuer and legal verifier together can
  create those values. Two governors can activate any policy after the
  timelock.
* **Agent powers.** As in ERC-3643, the forced-transfer path bypasses the
  compliance contract, so it does not apply the Shariah tradability rule. The
  prototype requires a justification hash and emits an event, which makes use
  auditable but does not prevent abuse. The agent can also pause or freeze.
* **Key concentration in the test deployment.** For convenience the test
  deployment gives one key (`admin`) the agent role, the first governor seat
  and the registry's `GOVERNOR_ROLE`. Attestor onboarding and revocation are
  therefore single-key operations in the prototype. A deployment would
  separate these keys and put the registry role behind the same quorum as
  policy changes.
* **Liveness.** Fail-closed checks turn missing evidence into blocked
  transfers. Holders can be unable to sell for reasons outside their control
  (lapsed attestations, an invalidated witness that nobody re-nominates, a
  suspension that does not reach quorum to resume).
* **Block timestamps** decide freshness; validators can shift them by a small
  amount, which matters only at validity boundaries.
* **Privacy.** Claims, signer addresses and allocations are public on a
  public chain; document hashes are signed and emitted in events, not stored. Investor identity data is
  reduced to an eligibility flag, country code and expiry.
* **No continuing coverage test.** Transfers check that a non-debt component
  is evidenced, not that attested values cover the certificates outstanding
  (scenario G03, test T16).
* **Cross-instrument pledges.** No-double-counting holds within one
  instrument's engine; another instrument can allocate against the same asset
  (test T15).
* **Not audited.** The contracts have not been audited or formally verified.
  Slither 0.11.6, Solidity fuzz properties and six hand-written mutants were
  applied (`outputs/static/`); these cover selected properties only.
