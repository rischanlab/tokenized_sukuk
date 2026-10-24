// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title Compliance hook used by SukukToken
/// @notice Mirrors the role of the ERC-3643 compliance contract: the token asks
///         it whether a transfer may proceed and whether an issuance is
///         authorised. A zero reason code means "allowed"; any other value is a
///         machine-readable reason for the denial.
interface ISukukCompliance {
    /// @notice Pre-check for an ordinary (non-privileged) transfer.
    function canTransfer(address from, address to, uint256 amount)
        external
        view
        returns (bytes32 reason);

    /// @notice Called by the bound token inside `issue`. Must revert, or return
    ///         a non-zero reason, when the issuance is not authorised.
    /// @param evidence ABI-encoded, configuration-specific issuance evidence.
    /// @param totalAmount Sum of the token amounts to be minted.
    function authorizeIssuance(bytes calldata evidence, uint256 totalAmount)
        external
        returns (bytes32 reason);
}
