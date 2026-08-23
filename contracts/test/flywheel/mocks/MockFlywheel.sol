// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IFlywheelFeeSource} from "../../../src/flywheel/interfaces/IFlywheelFeeSource.sol";
import {IFlywheelRewardConverter} from "../../../src/flywheel/interfaces/IFlywheelRewardConverter.sol";
import {MockERC20} from "../../mocks/MockERC20.sol";

contract MockFlywheelToken is MockERC20 {
    uint256 public maxWalletExpiry;

    constructor() MockERC20(18) {}

    function setMaxWalletExpiry(uint256 expiry) external {
        maxWalletExpiry = expiry;
    }
}

contract MockFlywheelFeeSource is IFlywheelFeeSource {
    mapping(address token => address recipient) public override flywheelRecipient;
    mapping(address token => mapping(address asset => uint256)) public claimable;

    function configure(address token, address recipient) external {
        flywheelRecipient[token] = recipient;
    }

    function accrue(address token, address asset, uint256 amount) external {
        claimable[token][asset] += amount;
    }

    function fundFlywheel(address token, address asset) external returns (uint256 amount) {
        amount = claimable[token][asset];
        claimable[token][asset] = 0;
        if (amount != 0) {
            require(IERC20(asset).transfer(flywheelRecipient[token], amount), "TRANSFER");
        }
    }
}

contract MockFlywheelRewardConverter is IFlywheelRewardConverter {
    uint256 public rateNumerator = 1;
    uint256 public rateDenominator = 1;
    uint256 public oracleFloorBps = 9_900;
    bool public misreport;

    function configure(uint256 numerator, uint256 denominator, uint256 floorBps) external {
        require(numerator != 0 && denominator != 0 && floorBps <= 10_000, "CONFIG");
        rateNumerator = numerator;
        rateDenominator = denominator;
        oracleFloorBps = floorBps;
    }

    function setMisreport(bool enabled) external {
        misreport = enabled;
    }

    function minimumOutput(address, address, uint256 inputAmount) external view returns (uint256) {
        return inputAmount * rateNumerator / rateDenominator * oracleFloorBps / 10_000;
    }

    function convert(
        address inputAsset,
        address rewardAsset,
        uint256 inputAmount,
        uint256 minimumAmountOut,
        address recipient
    ) external returns (uint256 outputAmount) {
        outputAmount = inputAmount * rateNumerator / rateDenominator;
        require(outputAmount >= minimumAmountOut, "SLIPPAGE");
        require(IERC20(inputAsset).transferFrom(msg.sender, address(this), inputAmount), "INPUT");
        require(IERC20(rewardAsset).transfer(recipient, outputAmount), "OUTPUT");
        if (misreport) ++outputAmount;
    }
}
