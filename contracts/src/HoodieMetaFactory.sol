// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

import {HydeTokenFactory} from "./HydeTokenFactory.sol";
import {HoodieLauncher} from "./HoodieLauncher.sol";

/// @notice Engine surface the meta-factory needs: authorize a freshly-minted launcher clone.
interface IHoodieLaunchEngineRegistry {
    function registerLauncher(address launcher) external;
}

/// @title HoodieMetaFactory — the "launcher launcher": mints thin `HoodieLauncher` clones, each permanently
///        wired to the shared HOODIE engine, so every token launched through them is immutably HOODIE-paired.
/// @notice INV-1 (no base-asset setter/param): the base is the compile-time `constant HOODIE`; there is NO
///         setter and NO caller-supplied pair anywhere in this contract or the launchers it mints. The
///         constructor ASSERTS the wired engine's base equals `HOODIE`, so a mis-based engine can't be fronted.
contract HoodieMetaFactory {
    using Clones for address;

    /// @notice The permanent base asset for every launcher this factory mints — Robinhood 4663 $HOODIE (a
    ///         Doppler DERC20, 18-dec, graduated/transferable, no fee-on-transfer). Compile-time `constant`:
    ///         no setter, no constructor param, grep-ably absent from the forbidden-selector set (INV-1).
    address public constant HOODIE = 0xC72c01AAB5f5678dc1d6f5C6d2B417d91D402Ba3;

    /// @notice The shared launch engine every minted launcher routes into (its `WETH` immutable == HOODIE).
    address public immutable ENGINE;
    /// @notice The `HoodieLauncher` implementation cloned per `createLauncher` (EIP-1167).
    address public immutable LAUNCHER_IMPL;

    /// @notice All launchers minted, in order (enumeration for UI / off-chain indexing).
    address[] public launchers;
    /// @notice Which human created each launcher (attribution/branding; does not gate launches).
    mapping(address => address) public launcherOwner;

    event LauncherCreated(address indexed launcher, address indexed creator, uint256 index);

    /// @param engine       the deployed `HoodieLaunchEngine` (already bound to the unchanged hook/vault/
    ///                      collector) whose base is $HOODIE. Asserted here so INV-1/INV-2 are deploy-verifiable.
    /// @param launcherImpl the `HoodieLauncher` implementation to clone.
    constructor(address engine, address launcherImpl) {
        require(engine != address(0), "ZERO_ENGINE");
        require(launcherImpl != address(0), "ZERO_LAUNCHER_IMPL");
        // INV-2 deploy assert: the engine we front MUST be HOODIE-based. `WETH` is the engine's (immutable)
        // sole pool numéraire; requiring it == HOODIE welds this meta-factory to a HOODIE engine only.
        require(HydeTokenFactory(engine).WETH() == HOODIE, "ENGINE_NOT_HOODIE");
        ENGINE = engine;
        LAUNCHER_IMPL = launcherImpl;
    }

    /// @notice Mint a new thin launcher for `msg.sender`, at a DETERMINISTIC address namespaced by
    ///         `(creator, userSalt)`: clone(CREATE2) → initialize (wire to the HOODIE engine) → register in the
    ///         engine's allowlist. Atomic: a launcher is never observable half-wired.
    /// @dev    CREATE2 (not plain `clone`) so `predictLauncher` is exact and a reused `(creator, userSalt)`
    ///         REVERTS on the duplicate-address create — a natural replay/collision gate. The salt binds
    ///         `msg.sender`, so one creator's userSalt can never collide with another's.
    function createLauncher(bytes32 userSalt) external returns (address launcher) {
        bytes32 salt = keccak256(abi.encode(msg.sender, userSalt));
        launcher = LAUNCHER_IMPL.cloneDeterministic(salt);
        HoodieLauncher(launcher).initialize(ENGINE, msg.sender);
        IHoodieLaunchEngineRegistry(ENGINE).registerLauncher(launcher);

        launcherOwner[launcher] = msg.sender;
        launchers.push(launcher);
        emit LauncherCreated(launcher, msg.sender, launchers.length - 1);
    }

    /// @notice Predict the launcher address for `(creator, userSalt)` — equals what `createLauncher` deploys,
    ///         and is invariant to any other creator's activity (the salt binds the creator).
    function predictLauncher(address creator, bytes32 userSalt) external view returns (address) {
        bytes32 salt = keccak256(abi.encode(creator, userSalt));
        return LAUNCHER_IMPL.predictDeterministicAddress(salt);
    }

    /// @notice Total launchers minted (UI enumeration bound).
    function launcherCount() external view returns (uint256) {
        return launchers.length;
    }
}
