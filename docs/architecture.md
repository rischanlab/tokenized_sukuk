# Architecture

## 1. Components

```
 off-chain documents ──hash──► signed EIP-712 claims ──relay──► EvidenceRegistry
 (rights, valuations,          (legal verifier, valuer,          ├─ attestor registry (one role per key)
  Shariah pronouncements,       custodian, Shariah adviser;      ├─ credential verifier (domain, role, window, seq, signature)
  allocation memos)             wakeel + trustee for tranches)   └─ asset/rights store (latest claim per asset and type)
                                                                          │ views: backingEligible, nonDebtEligible,
                                                                          │        shariahStatusValid, checkTransferEvidence
                                                                          ▼
 governors ──quorum + timelock──► SukukPolicyEngine (ISukukCompliance)
                                   ├─ issuance policy  (authorizeIssuance: tranche signatures, R1, no double counting)
                                   ├─ transfer policy  (canTransfer: suspension, Shariah status, R3 via witness)
                                   ├─ versioned policy (proposals, approvals, activation; tranche keeps its version)
                                   └─ lifecycle state  (Draft → Active ⇄ Suspended)
                                                                          ▲
 agent ──issue / pause / freeze / forced transfer──► SukukToken (ERC-20) ──┘
 holders ──transfer / transferFrom / requestRedemption──►  │
 settlement role ──confirmSettlement──►                    └─► IdentityRegistry (eligibility, expiry)
```

| Brief module | Contract in this repository |
|---|---|
| AttestorRegistry, CredentialVerifier, AssetRightsRegistry | `contracts/registry/EvidenceRegistry.sol` |
| PolicyRegistry, TransferComplianceModule, CircuitBreaker/Governance | `contracts/policy/SukukPolicyEngine.sol` |
| SukukSecurityToken, BackingObligationsRegistry (redemption accounting) | `contracts/token/SukukToken.sol` |
| Identity registry (ERC-3643-style, simplified) | `contracts/registry/IdentityRegistry.sol` |
| Baseline compliance (B0) | `contracts/baseline/BasicCompliance.sol` |
| Benchmark harnesses | `contracts/test/InlineEvidenceHarness.sol` |

The separate `SukukInstrumentRegistry` of the brief is folded into immutable
constructor parameters: `instrumentId` in the registry and engine, `maturity`
and the identity/compliance addresses in the token, and `policyDocHash` in the
policy parameters.

## 2. Evidence timing: stored state, not per-transfer proofs

Signatures are verified once, when a claim is submitted. The registry stores
the decision-relevant fields in one storage slot per (asset, claim type), and
transfers read that state. The alternative, in which each transfer carries and
verifies the signed evidence it relies on, is implemented in
`InlineEvidenceHarness` only for measurement (T14, `inline_vs_stored`). The
inline variant cannot see revocations, sequence ordering or custodian notices
without the same stored state, so it is a weaker check as well as a costlier
transaction for the sender.

## 3. Continuing-component check (R3)

The transfer check reads one nominated *witness* asset instead of scanning the
portfolio, so its cost does not grow with the number of assets. The engine
sets the witness at issuance when the current one is not eligible; anyone can
replace it with `setWitness`, which succeeds only for an asset that satisfies
the active policy. An off-chain relayer is expected to re-nominate when the
witness loses eligibility. Until it does, transfers fail closed even if
another asset qualifies. The B2F variant (`SukukPolicyEngineFallback`)
records up to 32 assets at first allocation and, when the witness check fails
with a component or evidence reason, allows the transfer if any recorded
candidate is non-debt-eligible. The scan is a view; the stored witness is
unchanged, and its cost grows with the position of the first eligible
candidate.

## 4. Lifecycle

* `Draft` until the first tranche is authorised, then `Active`.
* `Suspended` from any state by one governor; it blocks ordinary transfers and
  issuance; it returns to the previous state once a quorum of governors has
  approved resumption in the same suspension epoch.
* Maturity is a timestamp in the token: after it, ordinary transfers and
  issuance stop and holders may `requestRedemption`, which burns units and
  creates a pending claim; the settlement role records payment against it.
  The redemption accounting follows the burn-to-pending pattern of RWA-PoB
  (Mafrur et al., 2026).

## 5. Reason codes

Every denial on the transfer and issuance paths carries a 32-byte ASCII
reason (`contracts/libraries/ReasonCodes.sol`), returned by
`preCheckTransfer` and in the `TransferNotCompliant` or
`IssuanceNotAuthorized` custom errors. Tests and the oracle compare these
codes, not just success or failure.
