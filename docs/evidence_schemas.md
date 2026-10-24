# Evidence schemas

All claims are EIP-712 typed data under the domain

```
name              = "TokenizedSukukEvidence"
version           = "1"
chainId           = <chain id>
verifyingContract = <EvidenceRegistry address>
```

so a signature is valid for one registry on one chain. The instrument is also
named in the payload (`instrumentId`).

## 1. Attestation

```
Attestation(bytes32 instrumentId,uint8 claimType,bytes32 subjectId,uint8 code,
            bool flag,uint256 amount,uint32 policyVersion,bytes32 evidenceHash,
            uint64 seq,uint64 issuedAt,uint64 validUntil)
```

| claimType | Name | Required signer role | subjectId | Meaningful fields |
|---|---|---|---|---|
| 1 | RIGHTS | LEGAL_VERIFIER | asset id | `code` rights type (test convention: 1 beneficial interest, 2 legal title, 3 receivable; not interpreted on-chain); `flag` encumbered |
| 2 | VALUATION | VALUER | asset id | `amount` value in nominal units (0 = disposed or worthless) |
| 3 | CLASSIFICATION | SHARIAH_ADVISER | asset id | `code` 1 non-debt, 2 debt; `policyVersion` |
| 4 | ENCUMBRANCE | CUSTODIAN | asset id | `flag` encumbered |
| 5 | SHARIAH_STATUS | SHARIAH_ADVISER | instrument id | `code` 1 endorsed, 2 not endorsed; `policyVersion` |

Common fields: `evidenceHash` is the keccak256 hash of the referenced
off-chain document; `seq` must exceed the last accepted `seq` for the same
(subject, claim type); `issuedAt <= now <= validUntil` at submission and
`validUntil - issuedAt <= 30 days`.

Acceptance checks, in order: instrument, signer role and activity, time
window, sequence, content, signature (`SignatureChecker`, EOA or EIP-1271).

Stored form (one slot): signer, `validUntil` (uint40), `policyVersion`,
`code`, `flag` (for valuations: amount > 0), `revoked`. The valuation amount
is kept separately in `assetValue`.

A claim is **current** when it exists, is not revoked, has not expired and
its signer is still an active attestor. An encumbrance notice with
`flag = true` stays effective after expiry and after its signer is revoked
(negative evidence); it ends only when superseded or revoked.

## 2. TrancheAllocation

```
TrancheAllocation(bytes32 instrumentId,bytes32 trancheId,uint256 proceeds,
                  bytes32[] assetIds,uint256[] amounts,uint32 policyVersion,
                  bytes32 evidenceHash,uint64 issuedAt,uint64 validUntil)
```

Signed by one active WAKEEL and one active TRUSTEE. `assetIds` must be
strictly increasing (no duplicates); `amounts` must be positive; the sum of
`amounts` may not exceed `proceeds`; `proceeds` must equal the number of units
minted; `policyVersion` must equal the active version. A `trancheId` can be
authorised once.

The issuance evidence passed to `SukukToken.issue` is
`abi.encode(TrancheAllocation, address[2] signers, bytes[2] signatures)`.

## 3. Off-chain fixtures

`fixtures/synthetic_portfolios/wakalah_portfolio_v1.json` describes the
synthetic instrument, its three assets and its first tranche.
`fixtures/mock_legal_documents/*.txt` are placeholders whose hashes stand for
the referenced documents. Neither represents a real issuer, asset or investor.

## 4. Relation to W3C Verifiable Credentials

The envelope plays the role of a credential (issuer, subject, claims,
validity, status), but it is not a W3C Verifiable Credential and is not
interoperable with VC tooling without a mapping layer. Selective disclosure is
not supported.
