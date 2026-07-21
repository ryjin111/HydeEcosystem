// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {HydeTokenFactory} from "./HydeTokenFactory.sol";

/// @notice Minimal call-surface of the engine the launcher forwards into.
interface IHoodieLaunchEngine {
    function launchFor(HydeTokenFactory.LaunchParams calldata lp, address creator)
        external
        payable
        returns (address token, uint256 tokenId);
}

/// @title HoodieLauncher — a thin, per-creator EIP-1167 launcher clone minted by `HoodieMetaFactory`
/// @notice NON-fund-bearing routing shell. It never deploys a hook, never touches the vault/collector/hook,
///         and holds no token balance beyond the in-flight `msg.value` it forwards in the same call. Its only
///         job: forward `(msg.sender = the human creator, msg.value = the flat launch fee)` into the shared
///         `HoodieLaunchEngine.launchFor`, which does the audited launch against the immutably HOODIE-paired
///         base. Because attribution is the ACTUAL caller (no `tx.origin`), the engine records the human in
///         the vault/collector, and this contract is safe to leave open (any caller is that call's creator).
contract HoodieLauncher {
    /// @notice The shared launch engine this launcher routes into (set once at clone init).
    address public engine;
    /// @notice The creator who minted this launcher via the meta-factory — recorded for UI/branding/attribution
    ///         only; it does NOT gate `launch` (the per-call creator is the actual caller).
    address public owner;
    bool private _initialized;

    event Initialized(address indexed engine, address indexed owner);

    /// @notice One-shot clone initializer (EIP-1167 clones have no constructor). Called atomically by the
    ///         meta-factory right after cloning, before the clone is registered/usable.
    function initialize(address engine_, address owner_) external {
        require(!_initialized, "INITIALIZED");
        require(engine_ != address(0), "ZERO_ENGINE");
        _initialized = true;
        engine = engine_;
        owner = owner_;
        emit Initialized(engine_, owner_);
    }

    /// @notice Launch a HOODIE-paired token. The caller is the creator; `msg.value` (the flat native-ETH
    ///         launch fee) is forwarded verbatim to the engine. One payable tx, all-or-revert in the engine.
    function launch(string calldata name, string calldata symbol, uint256 presetId)
        external
        payable
        returns (address token, uint256 tokenId)
    {
        require(_initialized, "NOT_INITIALIZED");
        return IHoodieLaunchEngine(engine).launchFor{value: msg.value}(
            HydeTokenFactory.LaunchParams({name: name, symbol: symbol, presetId: presetId}), msg.sender
        );
    }
}
