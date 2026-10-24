// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {IIdentityRegistry} from "../interfaces/IIdentityRegistry.sol";
import {ISukukCompliance} from "../interfaces/ISukukCompliance.sol";
import {ReasonCodes} from "../libraries/ReasonCodes.sol";

/// @title Permissioned sukuk token (shared by configurations B0, B1 and B2)
/// @notice ERC-20 token with an ERC-3643-style control surface: receiver
///         eligibility through an identity registry, a pluggable compliance
///         contract, pause, wallet freezing and an agent-only forced transfer.
///         The three experimental configurations deploy this same contract and
///         differ only in the compliance contract bound to it.
/// @dev Research prototype; not audited and not intended for production.
///      Every supply change goes through `issue` (compliance-authorised mint)
///      or `requestRedemption` (holder-initiated burn). There is no other mint
///      or burn path. Token amounts are nominal units with 18 decimals; the
///      contract does not assume that any amount is guaranteed on redemption.
contract SukukToken is ERC20, AccessControl, Pausable {
    bytes32 public constant AGENT_ROLE = keccak256("AGENT_ROLE");
    bytes32 public constant SETTLEMENT_ROLE = keccak256("SETTLEMENT_ROLE");

    IIdentityRegistry public immutable identityRegistry;
    ISukukCompliance public immutable compliance;
    uint64 public immutable maturity;

    mapping(address => bool) public frozen;

    /// @notice Cumulative units minted through authorised issuances.
    uint256 public totalIssued;
    /// @notice Units burned by redemption requests and not yet settled.
    uint256 public pendingRedemptionUnits;
    /// @notice Units whose redemption has been confirmed by the settlement role.
    uint256 public settledRedemptionUnits;

    struct Redemption {
        address holder;
        uint128 units;
        uint128 settledUnits;
    }

    uint256 public nextRedemptionId = 1;
    mapping(uint256 => Redemption) public redemptions;

    /// @dev Set only for the duration of an agent or supply operation, so that
    ///      `_update` can distinguish them from ordinary transfers.
    bool private transient _privileged;

    event Issued(bytes32 indexed evidenceDigest, uint256 totalAmount);
    event ForcedTransfer(
        address indexed from,
        address indexed to,
        uint256 amount,
        bytes32 justificationHash,
        address indexed agent
    );
    event WalletFrozen(address indexed wallet, bool frozen);
    event RedemptionRequested(
        uint256 indexed redemptionId,
        address indexed holder,
        uint256 units
    );
    event RedemptionSettled(
        uint256 indexed redemptionId,
        uint256 units,
        uint256 totalSettled,
        bytes32 paymentReference
    );

    error TransferNotCompliant(bytes32 reason);
    error IssuanceNotAuthorized(bytes32 reason);
    error InvalidIssuance();
    error JustificationRequired();
    error NotMatured();
    error InvalidRedemption();

    constructor(
        string memory name_,
        string memory symbol_,
        IIdentityRegistry identityRegistry_,
        ISukukCompliance compliance_,
        uint64 maturity_,
        address admin
    ) ERC20(name_, symbol_) {
        identityRegistry = identityRegistry_;
        compliance = compliance_;
        maturity = maturity_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(AGENT_ROLE, admin);
    }

    // ------------------------------------------------------------------
    // Ordinary transfers
    // ------------------------------------------------------------------

    /// @notice Pre-check required by ERC-3643-style tokens: returns the reason
    ///         an ordinary transfer would be denied, or zero if it would pass.
    function preCheckTransfer(address from, address to, uint256 amount)
        public
        view
        returns (bytes32)
    {
        if (paused()) return ReasonCodes.TOKEN_PAUSED;
        if (frozen[from] || frozen[to]) return ReasonCodes.WALLET_FROZEN;
        if (block.timestamp >= maturity) return ReasonCodes.INSTRUMENT_MATURED;
        if (!identityRegistry.isVerified(to)) {
            return ReasonCodes.RECEIVER_NOT_VERIFIED;
        }
        return compliance.canTransfer(from, to, amount);
    }

    function _update(address from, address to, uint256 value)
        internal
        override
    {
        if (!_privileged) {
            bytes32 reason = preCheckTransfer(from, to, value);
            if (reason != ReasonCodes.OK) revert TransferNotCompliant(reason);
        }
        super._update(from, to, value);
    }

    // ------------------------------------------------------------------
    // Issuance
    // ------------------------------------------------------------------

    /// @notice Mints a tranche to eligible subscribers after the compliance
    ///         contract has authorised it against `evidence`.
    function issue(
        bytes calldata evidence,
        address[] calldata recipients,
        uint256[] calldata amounts
    ) external onlyRole(AGENT_ROLE) whenNotPaused {
        if (
            recipients.length == 0 ||
            recipients.length != amounts.length ||
            block.timestamp >= maturity
        ) revert InvalidIssuance();

        uint256 total = 0;
        for (uint256 i = 0; i < amounts.length; ++i) {
            total += amounts[i];
        }
        if (total == 0) revert InvalidIssuance();

        bytes32 reason = compliance.authorizeIssuance(evidence, total);
        if (reason != ReasonCodes.OK) revert IssuanceNotAuthorized(reason);

        _privileged = true;
        for (uint256 i = 0; i < recipients.length; ++i) {
            if (!identityRegistry.isVerified(recipients[i])) {
                revert TransferNotCompliant(ReasonCodes.RECEIVER_NOT_VERIFIED);
            }
            _mint(recipients[i], amounts[i]);
        }
        _privileged = false;

        totalIssued += total;
        emit Issued(keccak256(evidence), total);
    }

    // ------------------------------------------------------------------
    // Agent controls (ERC-3643 style)
    // ------------------------------------------------------------------

    function pause() external onlyRole(AGENT_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(AGENT_ROLE) {
        _unpause();
    }

    function setFrozen(address wallet, bool isFrozen)
        external
        onlyRole(AGENT_ROLE)
    {
        frozen[wallet] = isFrozen;
        emit WalletFrozen(wallet, isFrozen);
    }

    /// @notice Administrative transfer (e.g. key recovery or a court order).
    /// @dev As in ERC-3643, the forced path checks only the receiver's
    ///      eligibility and bypasses the compliance contract, so it does not
    ///      apply the Shariah tradability rule. It therefore requires a
    ///      non-zero hash of the off-chain justification and is logged with
    ///      the acting agent.
    function forcedTransfer(
        address from,
        address to,
        uint256 amount,
        bytes32 justificationHash
    ) external onlyRole(AGENT_ROLE) {
        if (justificationHash == bytes32(0)) revert JustificationRequired();
        if (!identityRegistry.isVerified(to)) {
            revert TransferNotCompliant(ReasonCodes.RECEIVER_NOT_VERIFIED);
        }
        _privileged = true;
        _transfer(from, to, amount);
        _privileged = false;
        emit ForcedTransfer(from, to, amount, justificationHash, msg.sender);
    }

    // ------------------------------------------------------------------
    // Maturity and redemption accounting
    // ------------------------------------------------------------------

    /// @notice Burns `units` and records a pending redemption claim. The
    ///         amount payable per unit is set by the dissolution terms of the
    ///         sukuk off-chain and is not computed here.
    function requestRedemption(uint256 units)
        external
        whenNotPaused
        returns (uint256 redemptionId)
    {
        if (block.timestamp < maturity) revert NotMatured();
        if (units == 0 || units > type(uint128).max || frozen[msg.sender]) {
            revert InvalidRedemption();
        }

        _privileged = true;
        _burn(msg.sender, units);
        _privileged = false;

        pendingRedemptionUnits += units;
        redemptionId = nextRedemptionId++;
        redemptions[redemptionId] = Redemption(msg.sender, uint128(units), 0);
        emit RedemptionRequested(redemptionId, msg.sender, units);
    }

    /// @notice Records an authorised confirmation that `units` of a pending
    ///         claim have been paid. It does not prove payment finality.
    function confirmSettlement(
        uint256 redemptionId,
        uint256 units,
        bytes32 paymentReference
    ) external onlyRole(SETTLEMENT_ROLE) {
        Redemption storage redemption = redemptions[redemptionId];
        if (
            units == 0 ||
            redemption.holder == address(0) ||
            uint256(redemption.settledUnits) + units > redemption.units
        ) revert InvalidRedemption();

        redemption.settledUnits += uint128(units);
        pendingRedemptionUnits -= units;
        settledRedemptionUnits += units;
        emit RedemptionSettled(
            redemptionId,
            units,
            redemption.settledUnits,
            paymentReference
        );
    }
}
