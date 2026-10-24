// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IIdentityRegistry} from "../interfaces/IIdentityRegistry.sol";

/// @title Simplified investor identity registry
/// @notice Research stand-in for the ERC-3643 Identity Registry. An agent
///         records that a wallet has passed off-chain eligibility checks, the
///         investor's ISO-3166 country code and the expiry of that check. The
///         ERC-3643 ONCHAINID claim-topic and trusted-issuer machinery is not
///         reproduced; no personal data is stored on-chain.
contract IdentityRegistry is AccessControl, IIdentityRegistry {
    bytes32 public constant AGENT_ROLE = keccak256("AGENT_ROLE");

    struct Investor {
        bool registered;
        uint16 country;
        uint64 eligibleUntil;
    }

    mapping(address => Investor) public investors;

    event IdentityRegistered(
        address indexed wallet,
        uint16 country,
        uint64 eligibleUntil
    );
    event IdentityRemoved(address indexed wallet);

    error ZeroAddress();

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(AGENT_ROLE, admin);
    }

    function registerIdentity(
        address wallet,
        uint16 country,
        uint64 eligibleUntil
    ) external onlyRole(AGENT_ROLE) {
        if (wallet == address(0)) revert ZeroAddress();
        investors[wallet] = Investor(true, country, eligibleUntil);
        emit IdentityRegistered(wallet, country, eligibleUntil);
    }

    function removeIdentity(address wallet) external onlyRole(AGENT_ROLE) {
        delete investors[wallet];
        emit IdentityRemoved(wallet);
    }

    function isVerified(address wallet) external view returns (bool) {
        Investor memory investor = investors[wallet];
        return investor.registered && block.timestamp <= investor.eligibleUntil;
    }
}
