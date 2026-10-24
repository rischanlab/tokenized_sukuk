// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ISukukCompliance} from "../interfaces/ISukukCompliance.sol";
import {ReasonCodes} from "../libraries/ReasonCodes.sol";

/// @title B0 compliance: generic regulated-token baseline
/// @notice Compliance contract with no modules. Together with SukukToken it
///         provides the ERC-3643-style controls of configuration B0 (receiver
///         eligibility, pause, freeze, agent-only issuance and forced
///         transfer) without any asset, rights or Shariah evidence. It is a
///         research baseline, not a model of any deployed product.
contract BasicCompliance is ISukukCompliance {
    address public immutable deployer;
    address public token;

    error AlreadyBound();
    error OnlyToken();
    error ZeroAddress();

    constructor() {
        deployer = msg.sender;
    }

    function bindToken(address token_) external {
        if (token_ == address(0)) revert ZeroAddress();
        if (msg.sender != deployer || token != address(0)) revert AlreadyBound();
        token = token_;
    }

    function canTransfer(address, address, uint256)
        external
        pure
        returns (bytes32)
    {
        return ReasonCodes.OK;
    }

    function authorizeIssuance(bytes calldata, uint256)
        external
        view
        returns (bytes32)
    {
        if (msg.sender != token) revert OnlyToken();
        return ReasonCodes.OK;
    }
}
