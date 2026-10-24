// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SukukPolicyEngine} from "./SukukPolicyEngine.sol";
import {EvidenceRegistry} from "../registry/EvidenceRegistry.sol";
import {ReasonCodes} from "../libraries/ReasonCodes.sol";

/// @title Policy engine with a bounded witness fallback (configuration B2-F)
/// @notice Identical to SukukPolicyEngine except for the transfer check. When
///         the nominated witness asset no longer satisfies the active policy,
///         the check scans the assets this instrument has allocated to (in
///         order of first allocation, at most MAX_CANDIDATES) and permits the
///         transfer if any of them does. A relayer can still re-nominate the
///         witness with setWitness to restore the constant-cost path.
/// @dev The scan is a view and does not update the witness. Its cost grows
///      with the position of the first eligible candidate; assets allocated
///      after the cap is reached are not scanned.
contract SukukPolicyEngineFallback is SukukPolicyEngine {
    uint256 public constant MAX_CANDIDATES = 32;

    bytes32[] public witnessCandidates;

    constructor(
        EvidenceRegistry evidence_,
        address[] memory governors,
        uint8 quorum_,
        uint64 timelock_,
        PolicyParams memory initialPolicy
    ) SukukPolicyEngine(evidence_, governors, quorum_, timelock_, initialPolicy) {}

    function candidateCount() external view returns (uint256) {
        return witnessCandidates.length;
    }

    function canTransfer(address, address, uint256)
        external
        view
        override
        returns (bytes32)
    {
        if (state == State.Suspended) return ReasonCodes.INSTRUMENT_SUSPENDED;
        PolicyParams memory p = activePolicy;
        bytes32 witness = witnessAssetId;
        bytes32 reason = evidence.checkTransferEvidence(
            witness,
            p.version,
            p.applyNonDebtRules,
            p.requireShariahStatus,
            p.excludeEncumbered
        );
        if (
            reason != ReasonCodes.NON_DEBT_COMPONENT_UNVERIFIED &&
            reason != ReasonCodes.BACKING_EVIDENCE_INVALID
        ) return reason;

        uint256 n = witnessCandidates.length;
        for (uint256 i = 0; i < n; ++i) {
            bytes32 candidate = witnessCandidates[i];
            if (candidate != witness && _witnessEligible(candidate, p)) {
                return ReasonCodes.OK;
            }
        }
        return reason;
    }

    function _onAllocate(bytes32 assetId, bool firstTime) internal override {
        if (firstTime && witnessCandidates.length < MAX_CANDIDATES) {
            witnessCandidates.push(assetId);
        }
    }
}
