// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title Reason codes returned by compliance checks
/// @notice Short ASCII codes stored as bytes32 so that a denial can be logged,
///         returned by a pre-check and matched against the test oracle.
library ReasonCodes {
    bytes32 internal constant OK = bytes32(0);

    // Token-level (common to B0, B1 and B2)
    bytes32 internal constant TOKEN_PAUSED = "TOKEN_PAUSED";
    bytes32 internal constant WALLET_FROZEN = "WALLET_FROZEN";
    bytes32 internal constant RECEIVER_NOT_VERIFIED = "RECEIVER_NOT_VERIFIED";
    bytes32 internal constant INSTRUMENT_MATURED = "INSTRUMENT_MATURED";

    // Policy-engine level (B1 and B2)
    bytes32 internal constant INSTRUMENT_SUSPENDED = "INSTRUMENT_SUSPENDED";
    bytes32 internal constant BACKING_EVIDENCE_INVALID = "BACKING_EVIDENCE_INVALID";
    bytes32 internal constant NON_DEBT_COMPONENT_UNVERIFIED =
        "NON_DEBT_COMPONENT_UNVERIFIED";
    bytes32 internal constant SHARIAH_STATUS_INVALID = "SHARIAH_STATUS_INVALID";

    // Issuance
    bytes32 internal constant TRANCHE_INVALID = "TRANCHE_INVALID";
    bytes32 internal constant TRANCHE_REPLAYED = "TRANCHE_REPLAYED";
    bytes32 internal constant TRANCHE_AMOUNT_MISMATCH = "TRANCHE_AMOUNT_MISMATCH";
    bytes32 internal constant TRANCHE_POLICY_MISMATCH = "TRANCHE_POLICY_MISMATCH";
    bytes32 internal constant ALLOCATION_INVALID = "ALLOCATION_INVALID";
    bytes32 internal constant NON_DEBT_RATIO_BELOW_MINIMUM =
        "NON_DEBT_RATIO_BELOW_MINIMUM";
}
