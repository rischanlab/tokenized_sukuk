// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ISukukCompliance} from "../interfaces/ISukukCompliance.sol";
import {EvidenceRegistry} from "../registry/EvidenceRegistry.sol";
import {ReasonCodes} from "../libraries/ReasonCodes.sol";

/// @title Evidence-dependent sukuk policy engine (configurations B1 and B2)
/// @notice Compliance contract for SukukToken. It authorises issuance against
///         a signed tranche allocation and gates ordinary transfers on current
///         evidence held in the EvidenceRegistry. Which rules apply is set by
///         a versioned policy:
///         - B1 (evidence only): applyNonDebtRules = false,
///           requireShariahStatus = false.
///         - B2 (Shariah-aware): the encoded reading of the Securities
///           Commission Malaysia SAC resolution on Sukuk Wakalah bi
///           al-Istithmar (266th meeting, 16 March 2023): a minimum non-debt
///           share of each issuance's proceeds, and a continuing non-debt
///           component for secondary transfers, plus a current Shariah status
///           attestation.
/// @dev The encoded rule is the authors' interpretation for a research
///      prototype. It is not a Shariah ruling and has not been reviewed by a
///      Shariah adviser. Policy changes require a governor quorum and a
///      timelock and are never applied retroactively to recorded tranches.
contract SukukPolicyEngine is ISukukCompliance {
    struct PolicyParams {
        uint32 version;
        uint16 minNonDebtBps;
        bool applyNonDebtRules;
        bool requireShariahStatus;
        bool excludeEncumbered;
        bytes32 policyDocHash;
    }

    enum State {
        Draft,
        Active,
        Suspended
    }

    struct TrancheRecord {
        uint256 proceeds;
        uint256 nonDebtAllocated;
        uint32 policyVersion;
        uint64 authorizedAt;
        bytes32 digest;
    }

    struct Proposal {
        PolicyParams params;
        uint64 createdAt;
        uint8 approvals;
        bool executed;
    }

    uint16 public constant BPS = 10_000;

    EvidenceRegistry public immutable evidence;
    bytes32 public immutable instrumentId;
    address public immutable deployer;
    uint8 public immutable quorum;
    uint64 public immutable timelock;

    address public token;

    // Active policy and lifecycle state (read on every transfer).
    PolicyParams public activePolicy;
    State public state;
    State private _stateBeforeSuspension;
    bytes32 public witnessAssetId;

    mapping(uint32 => PolicyParams) public policyHistory;
    mapping(uint32 => uint64) public policyActivatedAt;

    mapping(address => bool) public isGovernor;
    uint256 public nextProposalId = 1;
    mapping(uint256 => Proposal) public proposals;
    mapping(uint256 => mapping(address => bool)) public approvedProposal;

    uint256 public suspensionEpoch;
    bytes32 public suspensionReason;
    mapping(uint256 => mapping(address => bool)) public approvedResume;
    uint8 public resumeApprovals;

    mapping(bytes32 => TrancheRecord) public tranches;
    mapping(bytes32 => uint256) public allocated;

    event TokenBound(address indexed token);
    event TrancheAuthorized(
        bytes32 indexed trancheId,
        bytes32 indexed digest,
        uint256 proceeds,
        uint256 nonDebtAllocated,
        uint32 policyVersion
    );
    event WitnessUpdated(bytes32 indexed assetId);
    event PolicyProposed(uint256 indexed proposalId, uint32 version, address by);
    event PolicyApproved(uint256 indexed proposalId, address by, uint8 approvals);
    event PolicyActivated(uint32 indexed version, bytes32 policyDocHash);
    event InstrumentSuspended(
        uint256 indexed epoch,
        bytes32 reason,
        address indexed by
    );
    event ResumeApproved(uint256 indexed epoch, address by, uint8 approvals);
    event InstrumentResumed(uint256 indexed epoch);

    error AlreadyBound();
    error OnlyToken();
    error NotGovernor();
    error InvalidPolicy();
    error AlreadyApproved();
    error QuorumNotReached();
    error TimelockActive();
    error ProposalClosed();
    error NotSuspended();
    error AlreadySuspended();
    error WitnessNotEligible();
    error ZeroAddress();

    modifier onlyGovernor() {
        if (!isGovernor[msg.sender]) revert NotGovernor();
        _;
    }

    constructor(
        EvidenceRegistry evidence_,
        address[] memory governors,
        uint8 quorum_,
        uint64 timelock_,
        PolicyParams memory initialPolicy
    ) {
        if (
            quorum_ == 0 ||
            quorum_ > governors.length ||
            initialPolicy.version != 1 ||
            initialPolicy.minNonDebtBps > BPS
        ) revert InvalidPolicy();

        evidence = evidence_;
        instrumentId = evidence_.instrumentId();
        deployer = msg.sender;
        quorum = quorum_;
        timelock = timelock_;
        for (uint256 i = 0; i < governors.length; ++i) {
            isGovernor[governors[i]] = true;
        }

        activePolicy = initialPolicy;
        policyHistory[1] = initialPolicy;
        policyActivatedAt[1] = uint64(block.timestamp);
        emit PolicyActivated(1, initialPolicy.policyDocHash);
    }

    function bindToken(address token_) external {
        if (token_ == address(0)) revert ZeroAddress();
        if (msg.sender != deployer || token != address(0)) revert AlreadyBound();
        token = token_;
        emit TokenBound(token_);
    }

    // ------------------------------------------------------------------
    // Transfer policy
    // ------------------------------------------------------------------

    /// @inheritdoc ISukukCompliance
    function canTransfer(address, address, uint256)
        external
        view
        virtual
        returns (bytes32)
    {
        if (state == State.Suspended) return ReasonCodes.INSTRUMENT_SUSPENDED;
        PolicyParams memory p = activePolicy;
        return evidence.checkTransferEvidence(
            witnessAssetId,
            p.version,
            p.applyNonDebtRules,
            p.requireShariahStatus,
            p.excludeEncumbered
        );
    }

    // ------------------------------------------------------------------
    // Issuance policy
    // ------------------------------------------------------------------

    /// @inheritdoc ISukukCompliance
    /// @dev All checks are completed before any state is written, so a
    ///      non-zero reason leaves the engine unchanged.
    function authorizeIssuance(bytes calldata evidenceData, uint256 totalAmount)
        external
        returns (bytes32)
    {
        if (msg.sender != token) revert OnlyToken();
        if (state == State.Suspended) return ReasonCodes.INSTRUMENT_SUSPENDED;

        (
            EvidenceRegistry.TrancheAllocation memory t,
            address[] memory signers,
            bytes[] memory signatures
        ) = abi.decode(
                evidenceData,
                (EvidenceRegistry.TrancheAllocation, address[], bytes[])
            );

        if (tranches[t.trancheId].authorizedAt != 0) {
            return ReasonCodes.TRANCHE_REPLAYED;
        }
        (bytes32 reason, bytes32 digest) = evidence.verifyTranche(
            t,
            signers,
            signatures
        );
        if (reason != ReasonCodes.OK) return reason;
        if (t.proceeds != totalAmount) {
            return ReasonCodes.TRANCHE_AMOUNT_MISMATCH;
        }

        PolicyParams memory p = activePolicy;
        if (t.policyVersion != p.version) {
            return ReasonCodes.TRANCHE_POLICY_MISMATCH;
        }
        if (p.requireShariahStatus && !evidence.shariahStatusValid(p.version)) {
            return ReasonCodes.SHARIAH_STATUS_INVALID;
        }

        (bytes32 allocationReason, uint256 nonDebtSum, bytes32 firstEligible) =
            _checkAllocation(t, p);
        if (allocationReason != ReasonCodes.OK) return allocationReason;

        // The minimum applies to the proceeds of this issuance only; it is not
        // re-tested during the tenure (see the continuing rule in canTransfer).
        if (
            p.applyNonDebtRules &&
            nonDebtSum * BPS < uint256(p.minNonDebtBps) * t.proceeds
        ) return ReasonCodes.NON_DEBT_RATIO_BELOW_MINIMUM;

        // Effects.
        for (uint256 i = 0; i < t.assetIds.length; ++i) {
            _onAllocate(t.assetIds[i], allocated[t.assetIds[i]] == 0);
            allocated[t.assetIds[i]] += t.amounts[i];
        }
        tranches[t.trancheId] = TrancheRecord({
            proceeds: t.proceeds,
            nonDebtAllocated: nonDebtSum,
            policyVersion: p.version,
            authorizedAt: uint64(block.timestamp),
            digest: digest
        });
        if (state == State.Draft) state = State.Active;
        if (
            firstEligible != bytes32(0) &&
            !_witnessEligible(witnessAssetId, p)
        ) {
            witnessAssetId = firstEligible;
            emit WitnessUpdated(firstEligible);
        }
        emit TrancheAuthorized(
            t.trancheId,
            digest,
            t.proceeds,
            nonDebtSum,
            p.version
        );
        return ReasonCodes.OK;
    }

    /// @dev Every listed asset must be backing-eligible; an asset counts
    ///      towards the non-debt share only if it is also currently classified
    ///      as non-debt under the active policy. Cumulative allocations to an
    ///      asset may not exceed its attested value (no double counting).
    function _checkAllocation(
        EvidenceRegistry.TrancheAllocation memory t,
        PolicyParams memory p
    )
        internal
        view
        returns (bytes32 reason, uint256 nonDebtSum, bytes32 firstEligible)
    {
        uint256 total = 0;
        bytes32 previous = bytes32(0);
        for (uint256 i = 0; i < t.assetIds.length; ++i) {
            bytes32 assetId = t.assetIds[i];
            uint256 amount = t.amounts[i];
            if (uint256(assetId) <= uint256(previous) || amount == 0) {
                return (ReasonCodes.ALLOCATION_INVALID, 0, bytes32(0));
            }
            previous = assetId;
            if (!evidence.backingEligible(assetId, p.excludeEncumbered)) {
                return (ReasonCodes.ALLOCATION_INVALID, 0, bytes32(0));
            }
            if (allocated[assetId] + amount > evidence.assetValue(assetId)) {
                return (ReasonCodes.ALLOCATION_INVALID, 0, bytes32(0));
            }
            total += amount;
            if (p.applyNonDebtRules) {
                if (
                    evidence.nonDebtEligible(
                        assetId,
                        p.version,
                        p.excludeEncumbered
                    )
                ) {
                    nonDebtSum += amount;
                    if (firstEligible == bytes32(0)) firstEligible = assetId;
                }
            } else if (firstEligible == bytes32(0)) {
                firstEligible = assetId;
            }
        }
        if (total > t.proceeds) {
            return (ReasonCodes.ALLOCATION_INVALID, 0, bytes32(0));
        }
        return (ReasonCodes.OK, nonDebtSum, firstEligible);
    }

    /// @notice Replaces the witness asset used by the transfer check. Anyone
    ///         may call it; the candidate must satisfy the active policy.
    function setWitness(bytes32 assetId) external {
        if (!_witnessEligible(assetId, activePolicy)) revert WitnessNotEligible();
        witnessAssetId = assetId;
        emit WitnessUpdated(assetId);
    }

    /// @dev Hook for variants that track allocated assets; `firstTime` is
    ///      true when the instrument allocates to the asset for the first time.
    function _onAllocate(bytes32 assetId, bool firstTime) internal virtual {}

    function _witnessEligible(bytes32 assetId, PolicyParams memory p)
        internal
        view
        returns (bool)
    {
        if (assetId == bytes32(0)) return false;
        if (p.applyNonDebtRules) {
            return evidence.nonDebtEligible(assetId, p.version, p.excludeEncumbered);
        }
        return evidence.backingEligible(assetId, p.excludeEncumbered);
    }

    // ------------------------------------------------------------------
    // Governance: versioned policy with quorum and timelock
    // ------------------------------------------------------------------

    function proposePolicy(PolicyParams calldata params)
        external
        onlyGovernor
        returns (uint256 proposalId)
    {
        if (
            params.version != activePolicy.version + 1 ||
            params.minNonDebtBps > BPS
        ) revert InvalidPolicy();
        proposalId = nextProposalId++;
        Proposal storage proposal = proposals[proposalId];
        proposal.params = params;
        proposal.createdAt = uint64(block.timestamp);
        emit PolicyProposed(proposalId, params.version, msg.sender);
    }

    function approvePolicy(uint256 proposalId) external onlyGovernor {
        Proposal storage proposal = proposals[proposalId];
        if (proposal.createdAt == 0 || proposal.executed) revert ProposalClosed();
        if (approvedProposal[proposalId][msg.sender]) revert AlreadyApproved();
        approvedProposal[proposalId][msg.sender] = true;
        proposal.approvals += 1;
        emit PolicyApproved(proposalId, msg.sender, proposal.approvals);
    }

    /// @notice Activates an approved proposal. Attestations bound to the
    ///         previous version (classifications and Shariah status) stop
    ///         counting as current; recorded tranches keep their version.
    function activatePolicy(uint256 proposalId) external onlyGovernor {
        Proposal storage proposal = proposals[proposalId];
        if (proposal.createdAt == 0 || proposal.executed) revert ProposalClosed();
        if (proposal.approvals < quorum) revert QuorumNotReached();
        if (block.timestamp < proposal.createdAt + timelock) {
            revert TimelockActive();
        }
        if (proposal.params.version != activePolicy.version + 1) {
            revert InvalidPolicy();
        }
        proposal.executed = true;
        activePolicy = proposal.params;
        policyHistory[proposal.params.version] = proposal.params;
        policyActivatedAt[proposal.params.version] = uint64(block.timestamp);
        emit PolicyActivated(
            proposal.params.version,
            proposal.params.policyDocHash
        );
    }

    /// @notice Any single governor can suspend ordinary transfers and
    ///         issuance at once (for example on a dispute or a suspected key
    ///         compromise). Resumption needs a quorum.
    function suspend(bytes32 reason) external onlyGovernor {
        if (state == State.Suspended) revert AlreadySuspended();
        _stateBeforeSuspension = state;
        state = State.Suspended;
        suspensionEpoch += 1;
        suspensionReason = reason;
        resumeApprovals = 0;
        emit InstrumentSuspended(suspensionEpoch, reason, msg.sender);
    }

    function approveResume() external onlyGovernor {
        if (state != State.Suspended) revert NotSuspended();
        if (approvedResume[suspensionEpoch][msg.sender]) revert AlreadyApproved();
        approvedResume[suspensionEpoch][msg.sender] = true;
        resumeApprovals += 1;
        emit ResumeApproved(suspensionEpoch, msg.sender, resumeApprovals);
        if (resumeApprovals >= quorum) {
            state = _stateBeforeSuspension;
            emit InstrumentResumed(suspensionEpoch);
        }
    }
}
