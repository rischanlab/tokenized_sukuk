// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

import {ReasonCodes} from "../libraries/ReasonCodes.sol";

/// @title Evidence registry for one tokenized sukuk instrument
/// @notice Combines three modules of the proposed architecture:
///         (i) an attestor registry that binds each signing address to exactly
///         one institutional role, (ii) an EIP-712 credential verifier with
///         instrument, chain and contract binding, validity windows, per-subject
///         sequence numbers and revocation, and (iii) an asset/rights registry
///         that keeps the latest accepted claim of each type for each asset.
/// @dev The registry authenticates who signed which statement and whether the
///      statement is current under the trust policy below. It does not and
///      cannot establish that the statement is true, that an asset exists or
///      that a Shariah classification is correct.
contract EvidenceRegistry is AccessControl, EIP712 {
    // ------------------------------------------------------------------
    // Roles
    // ------------------------------------------------------------------

    /// @notice Governance role that onboards and revokes attestors.
    bytes32 public constant GOVERNOR_ROLE = keccak256("GOVERNOR_ROLE");

    // Attestor roles. An address may hold at most one of them, ever.
    bytes32 public constant WAKEEL = keccak256("WAKEEL");
    bytes32 public constant TRUSTEE = keccak256("TRUSTEE");
    bytes32 public constant LEGAL_VERIFIER = keccak256("LEGAL_VERIFIER");
    bytes32 public constant VALUER = keccak256("VALUER");
    bytes32 public constant CUSTODIAN = keccak256("CUSTODIAN");
    bytes32 public constant SHARIAH_ADVISER = keccak256("SHARIAH_ADVISER");

    // ------------------------------------------------------------------
    // Claim types and codes
    // ------------------------------------------------------------------

    uint8 public constant CLAIM_RIGHTS = 1; // LEGAL_VERIFIER
    uint8 public constant CLAIM_VALUATION = 2; // VALUER
    uint8 public constant CLAIM_CLASSIFICATION = 3; // SHARIAH_ADVISER
    uint8 public constant CLAIM_ENCUMBRANCE = 4; // CUSTODIAN
    uint8 public constant CLAIM_SHARIAH_STATUS = 5; // SHARIAH_ADVISER

    uint8 public constant CLASS_NON_DEBT = 1;
    uint8 public constant CLASS_DEBT = 2;
    uint8 public constant STATUS_ENDORSED = 1;
    uint8 public constant STATUS_NOT_ENDORSED = 2;

    /// @notice Generic attestation envelope signed under EIP-712.
    /// @dev Field meaning by claimType:
    ///      RIGHTS:         code = rights type, flag = encumbered
    ///      VALUATION:      amount = value in nominal units
    ///      CLASSIFICATION: code = asset class, policyVersion = policy applied
    ///      ENCUMBRANCE:    flag = encumbered
    ///      SHARIAH_STATUS: subjectId = instrumentId, code = status,
    ///                      policyVersion = policy assessed
    struct Attestation {
        bytes32 instrumentId;
        uint8 claimType;
        bytes32 subjectId;
        uint8 code;
        bool flag;
        uint256 amount;
        uint32 policyVersion;
        bytes32 evidenceHash;
        uint64 seq;
        uint64 issuedAt;
        uint64 validUntil;
    }

    /// @notice Tranche allocation signed by the wakeel and the trustee.
    /// @dev `assetIds` must be strictly increasing so that an asset cannot be
    ///      listed twice in one allocation.
    struct TrancheAllocation {
        bytes32 instrumentId;
        bytes32 trancheId;
        uint256 proceeds;
        bytes32[] assetIds;
        uint256[] amounts;
        uint32 policyVersion;
        bytes32 evidenceHash;
        uint64 issuedAt;
        uint64 validUntil;
    }

    bytes32 public constant ATTESTATION_TYPEHASH = keccak256(
        "Attestation(bytes32 instrumentId,uint8 claimType,bytes32 subjectId,uint8 code,bool flag,uint256 amount,uint32 policyVersion,bytes32 evidenceHash,uint64 seq,uint64 issuedAt,uint64 validUntil)"
    );

    bytes32 public constant TRANCHE_TYPEHASH = keccak256(
        "TrancheAllocation(bytes32 instrumentId,bytes32 trancheId,uint256 proceeds,bytes32[] assetIds,uint256[] amounts,uint32 policyVersion,bytes32 evidenceHash,uint64 issuedAt,uint64 validUntil)"
    );

    /// @dev Decision-relevant fields of an accepted claim, packed in one slot.
    struct StoredClaim {
        address signer;
        uint40 validUntil;
        uint32 policyVersion;
        uint8 code;
        bool flag;
        bool revoked;
    }

    struct Attestor {
        bytes32 role;
        bool active;
    }

    bytes32 public immutable instrumentId;
    uint64 public immutable maxClaimValidity;

    mapping(address => Attestor) public attestors;
    mapping(bytes32 => mapping(uint8 => StoredClaim)) private _claims;
    mapping(bytes32 => mapping(uint8 => uint64)) public lastSeq;
    mapping(bytes32 => uint256) public assetValue;

    event AttestorRegistered(address indexed attestor, bytes32 indexed role);
    event AttestorRevoked(address indexed attestor, bytes32 indexed role);
    event AttestationAccepted(
        bytes32 indexed digest,
        uint8 indexed claimType,
        bytes32 indexed subjectId,
        address signer,
        uint64 seq,
        uint64 validUntil,
        bytes32 evidenceHash
    );
    event AttestationRevoked(
        bytes32 indexed subjectId,
        uint8 indexed claimType,
        address indexed by
    );
    event EvidenceConflict(
        bytes32 indexed assetId,
        address rightsSigner,
        address custodianSigner
    );

    error InvalidRole();
    error AttestorAlreadyAssigned();
    error UnknownAttestor();
    error WrongInstrument();
    error InvalidClaimType();
    error UnauthorizedSigner();
    error InvalidTimeWindow();
    error StaleOrReplayedClaim();
    error InvalidSignature();
    error InvalidClaimContent();
    error NotRevocable();

    constructor(
        bytes32 instrumentId_,
        uint64 maxClaimValidity_,
        address governor
    ) EIP712("TokenizedSukukEvidence", "1") {
        instrumentId = instrumentId_;
        maxClaimValidity = maxClaimValidity_;
        _grantRole(DEFAULT_ADMIN_ROLE, governor);
        _grantRole(GOVERNOR_ROLE, governor);
    }

    // ------------------------------------------------------------------
    // Attestor registry
    // ------------------------------------------------------------------

    function registerAttestor(address attestor, bytes32 role)
        external
        onlyRole(GOVERNOR_ROLE)
    {
        if (
            role != WAKEEL &&
            role != TRUSTEE &&
            role != LEGAL_VERIFIER &&
            role != VALUER &&
            role != CUSTODIAN &&
            role != SHARIAH_ADVISER
        ) revert InvalidRole();
        if (attestor == address(0)) revert UnknownAttestor();
        // One role per address, and an address is never reassigned after
        // revocation, so old signatures cannot acquire a new meaning.
        if (attestors[attestor].role != bytes32(0)) {
            revert AttestorAlreadyAssigned();
        }
        attestors[attestor] = Attestor(role, true);
        emit AttestorRegistered(attestor, role);
    }

    /// @notice Revokes an attestor (e.g. on key compromise). Every claim the
    ///         attestor signed stops counting as current immediately, because
    ///         currency is evaluated at the time of use.
    function revokeAttestor(address attestor) external onlyRole(GOVERNOR_ROLE) {
        Attestor storage a = attestors[attestor];
        if (a.role == bytes32(0)) revert UnknownAttestor();
        a.active = false;
        emit AttestorRevoked(attestor, a.role);
    }

    function requiredRole(uint8 claimType) public pure returns (bytes32) {
        if (claimType == CLAIM_RIGHTS) return LEGAL_VERIFIER;
        if (claimType == CLAIM_VALUATION) return VALUER;
        if (claimType == CLAIM_CLASSIFICATION) return SHARIAH_ADVISER;
        if (claimType == CLAIM_ENCUMBRANCE) return CUSTODIAN;
        if (claimType == CLAIM_SHARIAH_STATUS) return SHARIAH_ADVISER;
        revert InvalidClaimType();
    }

    // ------------------------------------------------------------------
    // Credential verification and storage
    // ------------------------------------------------------------------

    function hashAttestation(Attestation calldata a)
        public
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    ATTESTATION_TYPEHASH,
                    a.instrumentId,
                    a.claimType,
                    a.subjectId,
                    a.code,
                    a.flag,
                    a.amount,
                    a.policyVersion,
                    a.evidenceHash,
                    a.seq,
                    a.issuedAt,
                    a.validUntil
                )
            )
        );
    }

    /// @notice Verifies and records a signed attestation. Anyone may relay it;
    ///         only the signer's authority matters. Supports EOA and EIP-1271
    ///         contract signers.
    function submitAttestation(
        Attestation calldata a,
        address signer,
        bytes calldata signature
    ) external {
        if (a.instrumentId != instrumentId) revert WrongInstrument();
        bytes32 role = requiredRole(a.claimType);
        Attestor memory attestor = attestors[signer];
        if (!attestor.active || attestor.role != role) {
            revert UnauthorizedSigner();
        }
        if (
            a.issuedAt > block.timestamp ||
            block.timestamp > a.validUntil ||
            a.validUntil - a.issuedAt > maxClaimValidity
        ) revert InvalidTimeWindow();
        if (a.seq <= lastSeq[a.subjectId][a.claimType]) {
            revert StaleOrReplayedClaim();
        }
        _validateContent(a);

        bytes32 digest = hashAttestation(a);
        if (!SignatureChecker.isValidSignatureNow(signer, digest, signature)) {
            revert InvalidSignature();
        }

        lastSeq[a.subjectId][a.claimType] = a.seq;
        _claims[a.subjectId][a.claimType] = StoredClaim({
            signer: signer,
            validUntil: uint40(a.validUntil),
            policyVersion: a.policyVersion,
            code: a.code,
            flag: a.claimType == CLAIM_VALUATION ? a.amount > 0 : a.flag,
            revoked: false
        });
        if (a.claimType == CLAIM_VALUATION) {
            assetValue[a.subjectId] = a.amount;
        }

        emit AttestationAccepted(
            digest,
            a.claimType,
            a.subjectId,
            signer,
            a.seq,
            a.validUntil,
            a.evidenceHash
        );

        if (a.claimType == CLAIM_RIGHTS || a.claimType == CLAIM_ENCUMBRANCE) {
            _flagConflict(a.subjectId);
        }
    }

    /// @notice Revokes the current claim of a type for a subject. Callable by
    ///         the claim's signer or by governance.
    function revokeAttestation(bytes32 subjectId, uint8 claimType) external {
        StoredClaim storage c = _claims[subjectId][claimType];
        if (c.signer == address(0) || c.revoked) revert NotRevocable();
        if (msg.sender != c.signer && !hasRole(GOVERNOR_ROLE, msg.sender)) {
            revert NotRevocable();
        }
        c.revoked = true;
        emit AttestationRevoked(subjectId, claimType, msg.sender);
    }

    function hashTranche(TrancheAllocation calldata t)
        public
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    TRANCHE_TYPEHASH,
                    t.instrumentId,
                    t.trancheId,
                    t.proceeds,
                    keccak256(abi.encodePacked(t.assetIds)),
                    keccak256(abi.encodePacked(t.amounts)),
                    t.policyVersion,
                    t.evidenceHash,
                    t.issuedAt,
                    t.validUntil
                )
            )
        );
    }

    /// @notice Checks that a tranche allocation is bound to this instrument,
    ///         inside its validity window and signed by an active wakeel and an
    ///         active trustee (two distinct addresses by construction).
    /// @return reason Zero when valid, otherwise TRANCHE_INVALID.
    /// @return digest EIP-712 digest of the allocation.
    function verifyTranche(
        TrancheAllocation calldata t,
        address[] calldata signers,
        bytes[] calldata signatures
    ) external view returns (bytes32 reason, bytes32 digest) {
        digest = hashTranche(t);
        if (
            t.instrumentId != instrumentId ||
            t.assetIds.length != t.amounts.length ||
            signers.length != 2 ||
            signatures.length != 2 ||
            t.issuedAt > block.timestamp ||
            block.timestamp > t.validUntil ||
            t.validUntil - t.issuedAt > maxClaimValidity
        ) return (ReasonCodes.TRANCHE_INVALID, digest);

        bool sawWakeel = false;
        bool sawTrustee = false;
        for (uint256 i = 0; i < 2; ++i) {
            Attestor memory a = attestors[signers[i]];
            if (!a.active) return (ReasonCodes.TRANCHE_INVALID, digest);
            if (a.role == WAKEEL) sawWakeel = true;
            else if (a.role == TRUSTEE) sawTrustee = true;
            if (
                !SignatureChecker.isValidSignatureNow(
                    signers[i],
                    digest,
                    signatures[i]
                )
            ) return (ReasonCodes.TRANCHE_INVALID, digest);
        }
        if (!sawWakeel || !sawTrustee) {
            return (ReasonCodes.TRANCHE_INVALID, digest);
        }
        return (ReasonCodes.OK, digest);
    }

    // ------------------------------------------------------------------
    // Evidence status views used by the policy engine
    // ------------------------------------------------------------------

    function claimOf(bytes32 subjectId, uint8 claimType)
        external
        view
        returns (StoredClaim memory)
    {
        return _claims[subjectId][claimType];
    }

    /// @notice A claim is current if it exists, has not been revoked, has not
    ///         expired and its signer is still an active attestor.
    function isCurrent(bytes32 subjectId, uint8 claimType)
        public
        view
        returns (bool)
    {
        return _isCurrent(_claims[subjectId][claimType]);
    }

    /// @notice Encumbrance is treated as negative evidence: an "encumbered"
    ///         notice from the custodian stays effective until superseded or
    ///         revoked, even after its validity window or its signer lapses.
    function isEncumbered(bytes32 assetId) public view returns (bool) {
        StoredClaim memory rights = _claims[assetId][CLAIM_RIGHTS];
        StoredClaim memory notice = _claims[assetId][CLAIM_ENCUMBRANCE];
        return (rights.flag && _isCurrent(rights)) ||
            (notice.signer != address(0) && notice.flag && !notice.revoked);
    }

    /// @notice Rights and valuation evidence are current, the attested value
    ///         is positive and, if required, the asset is not encumbered.
    function backingEligible(bytes32 assetId, bool excludeEncumbered)
        public
        view
        returns (bool)
    {
        if (!_isCurrent(_claims[assetId][CLAIM_RIGHTS])) return false;
        StoredClaim memory valuation = _claims[assetId][CLAIM_VALUATION];
        if (!valuation.flag || !_isCurrent(valuation)) return false;
        if (excludeEncumbered && isEncumbered(assetId)) return false;
        return true;
    }

    /// @notice Backing-eligible and currently classified as a non-debt
    ///         investment asset under the given policy version.
    function nonDebtEligible(
        bytes32 assetId,
        uint32 policyVersion,
        bool excludeEncumbered
    ) public view returns (bool) {
        StoredClaim memory c = _claims[assetId][CLAIM_CLASSIFICATION];
        if (
            c.code != CLASS_NON_DEBT ||
            c.policyVersion != policyVersion ||
            !_isCurrent(c)
        ) return false;
        return backingEligible(assetId, excludeEncumbered);
    }

    function shariahStatusValid(uint32 policyVersion)
        public
        view
        returns (bool)
    {
        StoredClaim memory c = _claims[instrumentId][CLAIM_SHARIAH_STATUS];
        return c.code == STATUS_ENDORSED &&
            c.policyVersion == policyVersion &&
            _isCurrent(c);
    }

    /// @notice Single entry point for the transfer-time evidence check, so
    ///         that the policy engine makes one external call per transfer.
    function checkTransferEvidence(
        bytes32 witnessAssetId,
        uint32 policyVersion,
        bool applyNonDebtRules,
        bool requireShariahStatus,
        bool excludeEncumbered
    ) external view returns (bytes32) {
        if (requireShariahStatus && !shariahStatusValid(policyVersion)) {
            return ReasonCodes.SHARIAH_STATUS_INVALID;
        }
        if (applyNonDebtRules) {
            if (
                witnessAssetId == bytes32(0) ||
                !nonDebtEligible(witnessAssetId, policyVersion, excludeEncumbered)
            ) return ReasonCodes.NON_DEBT_COMPONENT_UNVERIFIED;
        } else if (
            witnessAssetId == bytes32(0) ||
            !backingEligible(witnessAssetId, excludeEncumbered)
        ) {
            return ReasonCodes.BACKING_EVIDENCE_INVALID;
        }
        return ReasonCodes.OK;
    }

    // ------------------------------------------------------------------
    // Internal
    // ------------------------------------------------------------------

    function _isCurrent(StoredClaim memory c) internal view returns (bool) {
        return c.signer != address(0) &&
            !c.revoked &&
            block.timestamp <= c.validUntil &&
            attestors[c.signer].active;
    }

    function _validateContent(Attestation calldata a) internal view {
        if (a.subjectId == bytes32(0)) revert InvalidClaimContent();
        if (a.claimType == CLAIM_CLASSIFICATION) {
            if (a.code != CLASS_NON_DEBT && a.code != CLASS_DEBT) {
                revert InvalidClaimContent();
            }
        } else if (a.claimType == CLAIM_SHARIAH_STATUS) {
            if (
                a.subjectId != instrumentId ||
                (a.code != STATUS_ENDORSED && a.code != STATUS_NOT_ENDORSED)
            ) revert InvalidClaimContent();
        }
    }

    function _flagConflict(bytes32 assetId) internal {
        StoredClaim memory rights = _claims[assetId][CLAIM_RIGHTS];
        StoredClaim memory notice = _claims[assetId][CLAIM_ENCUMBRANCE];
        if (
            _isCurrent(rights) &&
            !rights.flag &&
            notice.signer != address(0) &&
            notice.flag &&
            !notice.revoked
        ) {
            emit EvidenceConflict(assetId, rights.signer, notice.signer);
        }
    }
}
