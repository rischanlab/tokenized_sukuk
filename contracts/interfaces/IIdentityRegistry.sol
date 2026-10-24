// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title Minimal identity registry interface
/// @notice Subset of the ERC-3643 IIdentityRegistry needed by SukukToken.
interface IIdentityRegistry {
    function isVerified(address wallet) external view returns (bool);
}
