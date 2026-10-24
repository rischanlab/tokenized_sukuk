// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

import {EvidenceRegistry} from "../registry/EvidenceRegistry.sol";
import {SukukPolicyEngine} from "../policy/SukukPolicyEngine.sol";
import {ReasonCodes} from "../libraries/ReasonCodes.sol";

/// @title Benchmark harness: per-transfer (inline) evidence verification
/// @notice Used only to measure the design alternative in which every
///         transfer carries and verifies the signed evidence it relies on,
///         instead of reading evidence verified earlier and stored on-chain.
///         It re-uses the registry's attestor table and EIP-712 domain, and
///         performs the same checks as the stored path for configuration B2:
///         Shariah status, and rights, valuation and classification of one
///         witness asset (four signatures per transfer).
contract InlineEvidenceHarness is EvidenceRegistry {
    event InlineChecked(bytes32 reason);

    constructor(bytes32 instrumentId_, uint64 maxClaimValidity_, address governor)
        EvidenceRegistry(instrumentId_, maxClaimValidity_, governor)
    {}

    /// @param bundle [ShariahStatus, Rights, Valuation, Classification]
    function checkInline(
        Attestation[] calldata bundle,
        address[] calldata signers,
        bytes[] calldata signatures,
        uint32 policyVersion
    ) external returns (bytes32 reason) {
        reason = _verifyBundle(bundle, signers, signatures, policyVersion);
        emit InlineChecked(reason);
    }

    function _verifyBundle(
        Attestation[] calldata bundle,
        address[] calldata signers,
        bytes[] calldata signatures,
        uint32 policyVersion
    ) internal view returns (bytes32) {
        if (bundle.length != 4) return ReasonCodes.NON_DEBT_COMPONENT_UNVERIFIED;
        uint8[4] memory expected = [
            CLAIM_SHARIAH_STATUS,
            CLAIM_RIGHTS,
            CLAIM_VALUATION,
            CLAIM_CLASSIFICATION
        ];
        bytes32 witness = bundle[1].subjectId;
        for (uint256 i = 0; i < 4; ++i) {
            Attestation calldata a = bundle[i];
            Attestor memory attestor = attestors[signers[i]];
            if (
                a.claimType != expected[i] ||
                a.instrumentId != instrumentId ||
                !attestor.active ||
                attestor.role != requiredRole(a.claimType) ||
                a.issuedAt > block.timestamp ||
                block.timestamp > a.validUntil ||
                !SignatureChecker.isValidSignatureNow(
                    signers[i],
                    hashAttestation(a),
                    signatures[i]
                )
            ) return ReasonCodes.NON_DEBT_COMPONENT_UNVERIFIED;
            if (i > 1 && a.subjectId != witness) {
                return ReasonCodes.NON_DEBT_COMPONENT_UNVERIFIED;
            }
        }
        if (
            bundle[0].code != STATUS_ENDORSED ||
            bundle[0].policyVersion != policyVersion
        ) return ReasonCodes.SHARIAH_STATUS_INVALID;
        if (
            bundle[1].flag ||
            bundle[2].amount == 0 ||
            bundle[3].code != CLASS_NON_DEBT ||
            bundle[3].policyVersion != policyVersion
        ) return ReasonCodes.NON_DEBT_COMPONENT_UNVERIFIED;
        return ReasonCodes.OK;
    }
}

/// @title Benchmark harness: stored-state evidence check
/// @notice Calls the policy engine's transfer check (which reads evidence
///         verified earlier) inside a transaction so that its gas can be
///         compared with InlineEvidenceHarness under the same structure.
contract StoredEvidenceHarness {
    SukukPolicyEngine public immutable engine;

    event StoredChecked(bytes32 reason);

    constructor(SukukPolicyEngine engine_) {
        engine = engine_;
    }

    function checkStored() external returns (bytes32 reason) {
        reason = engine.canTransfer(address(0), address(0), 0);
        emit StoredChecked(reason);
    }
}
