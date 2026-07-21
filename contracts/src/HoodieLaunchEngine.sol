// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";

import {HydeTokenFactory} from "./HydeTokenFactory.sol";

/// @title HoodieLaunchEngine — the single shared launch engine for the $HOODIE "launcher-launcher" bounty
/// @notice Option-C shared-engine design (Reviewer-approved). This is the audited `HydeTokenFactory` core,
///         inherited unchanged, with its `WETH` immutable constructed as **$HOODIE** so every pool the engine
///         seeds is immutably HOODIE-paired. It is the ONE factory bound to the (unchanged) HydeHook / vault /
///         collector — thin per-creator `HoodieLauncher` clones never deploy a hook or call the hook/vault/
///         collector; they only forward `(caller, msg.value)` into `launchFor`, which reuses the shared
///         `_launch` core. That sidesteps the hook's 1:1 factory binding + un-mineable-on-chain hook address
///         entirely (a meta-factory can't stand up a hook per child), while keeping the immutable-HOODIE
///         guarantee at the launcher level.
///
///         ── Bounty invariants (Reviewer audit gate) ──
///         • INV-1  No base-asset setter/param: `HoodieMetaFactory.HOODIE` is a `constant`; this engine's base
///                  is the inherited `WETH` immutable (set once at construction). Neither can be retargeted.
///         • INV-2  Every child token is HOODIE-paired: the engine's `_poolKey`/register use `WETH == HOODIE`
///                  for ALL launches; there is no path that accepts an alternate pair.
///         • INV-3  `launchFor` derives the pool's counter-currency SOLELY from the inherited base — no caller
///                  supplies a pair.
///         • INV-4  Defense-in-depth already holds via the UNCHANGED hook: its `beforeInitialize` only permits
///                  initializing the exact factory-pre-registered pool, and `registerPendingPool` is
///                  factory-only ⇒ every hook-bearing launched pool is provably base(=HOODIE)-paired.
///         • INV-5  No proxy/upgrade path can retarget the base: engine is non-upgradeable; the base is an
///                  immutable; children carry no base at all (they only hold the engine address).
contract HoodieLaunchEngine is HydeTokenFactory {
    /// @notice The canonical Robinhood 4663 $HOODIE token — the engine's base is fail-closed to THIS address
    ///         (constructor assert below), so an engine can never be stood up on a non-HOODIE base even if a
    ///         mis-configured deploy tried (defense over the meta-factory's own HOODIE-assert; INV-1/2).
    address public constant HOODIE = 0xC72c01AAB5f5678dc1d6f5C6d2B417d91D402Ba3;

    /// @notice The ONLY address permitted to register launcher clones. Set once at construction (immutable),
    ///         so the launcher-allowlist authority can never be retargeted (mirrors the hook's set-once bind).
    address public immutable META_FACTORY;

    /// @notice Registry of meta-factory-minted launcher clones authorized to call `launchFor`.
    mapping(address => bool) public isLauncher;

    /// @dev Per-(launcher, creator) clone-salt nonce. Keyed by BOTH so an unrelated launcher OR an unrelated
    ///      creator sharing a launcher can never perturb a user's `predictNextFor` preview (the launcher/
    ///      per-creator FINDING-8 analogue for the shared engine).
    mapping(address => mapping(address => uint256)) private _hoodieNonce;

    event LauncherRegistered(address indexed launcher);
    /// @notice Carries BOTH identities the base `LaunchCreated` cannot (routing launcher + human creator),
    ///         plus the `poolId` the token-terminal UI/trade layer resolves against (required, kami 23407)
    ///         and the `tokenId` custody reference for the collector-held locked position NFT.
    event HoodieLaunchCreated(
        address indexed launcher, address indexed creator, address indexed token, PoolId poolId, uint256 tokenId
    );

    /// @param p           the standard Hyde stack params — `p.weth` MUST be the $HOODIE token (INV-1/2).
    /// @param presets     the validated single-sided seed presets (identical shape to the WETH factory).
    /// @param metaFactory the sole authority allowed to `registerLauncher`; typically CREATE-address-predicted
    ///                     so it can be a true immutable despite the engine↔meta-factory construction cycle.
    constructor(ConstructorParams memory p, PresetInput[] memory presets, address metaFactory)
        HydeTokenFactory(p, presets)
    {
        require(metaFactory != address(0), "ZERO_META_FACTORY");
        // Fail-closed: the base (parent's `WETH` immutable, == p.weth) MUST be the canonical $HOODIE (INV-1/2).
        require(WETH == HOODIE, "ENGINE_NOT_HOODIE");
        META_FACTORY = metaFactory;
    }

    /// @notice Authorize a launcher clone. Only the meta-factory (which mints them) may call this, so the
    ///         `launchFor` caller-set is exactly the set of meta-factory-minted clones.
    function registerLauncher(address launcher) external {
        require(msg.sender == META_FACTORY, "ONLY_META_FACTORY");
        require(launcher != address(0), "ZERO_LAUNCHER");
        require(!isLauncher[launcher], "ALREADY_LAUNCHER");
        isLauncher[launcher] = true;
        emit LauncherRegistered(launcher);
    }

    /// @notice Launch a HOODIE-paired token on behalf of a human `creator`, callable ONLY by a registered
    ///         launcher clone (which forwards the human caller + `msg.value`). No `tx.origin`. Reentrancy is
    ///         guarded HERE (the base `_launch` core is unguarded internal). The clone-salt is domained by
    ///         `(launcher, creator)` so nobody else's launches can drift this user's predicted address.
    function launchFor(LaunchParams calldata lp, address creator)
        external
        payable
        nonReentrant
        returns (address token, uint256 tokenId)
    {
        require(isLauncher[msg.sender], "NOT_LAUNCHER");
        require(creator != address(0), "ZERO_CREATOR");
        address launcher = msg.sender;
        bytes32 salt = keccak256(abi.encode(launcher, creator, lp.symbol, _hoodieNonce[launcher][creator]++));
        (token, tokenId) = _launch(lp, creator, salt);
        // poolId = the token/HOODIE pool the launch created (base is HOODIE ⇒ `_poolKey` pairs against it).
        PoolId poolId = _poolKey(token).toId();
        emit HoodieLaunchCreated(launcher, creator, token, poolId, tokenId);
    }

    /// @notice Predict the token clone address for the CURRENT (launcher, creator) nonce — UX/off-chain prep.
    ///         Equals the address `launchFor` would deploy next for that pair, and is invariant to any other
    ///         launcher's or creator's activity (proved by the drift-regression test).
    function predictNextFor(address launcher, address creator, string calldata symbol)
        external
        view
        returns (address)
    {
        bytes32 salt = keccak256(abi.encode(launcher, creator, symbol, _hoodieNonce[launcher][creator]));
        return Clones.predictDeterministicAddress(IMPL, salt, address(this));
    }

    /// @notice Current clone-salt nonce for a (launcher, creator) pair (test/UX introspection).
    function hoodieNonce(address launcher, address creator) external view returns (uint256) {
        return _hoodieNonce[launcher][creator];
    }
}
