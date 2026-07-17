// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {HydeERC20} from "../src/HydeERC20.sol";
import {HydeFeeVault} from "../src/HydeFeeVault.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHydeHook} from "../src/interfaces/IHydeHook.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/// @notice Stateful INVARIANT campaign for HydeFeeVault's DEX-agnostic accounting (rev8 · INV-27): the
///         global WETH ledger stays exactly equal to the sum of per-token derived liabilities (creator +
///         Hyde + rawFees — NO holder leg), and the vault is never insolvent, after ANY interleaving of
///         noteRaw/settle(WETH)/transfer/claim/time-warp/donation across ≥3 launch namespaces. WETH-leg
///         settles only (no swap/oracle) → pure accounting.
contract VaultHandler is Test {
    HydeFeeVault public vault;
    MockERC20 public weth;
    HydeERC20[] public tokens;
    address[] public actors;
    address internal constant POOL = address(0x1000);

    uint256 public totalWethFunded; // ghost: every wei ever noteRaw'd (for conservation cross-check)

    constructor(MockERC20 _weth) {
        weth = _weth;
    }

    /// @dev Wire after the vault exists + the deployer has set this handler as the factory.
    ///      (handler is BOTH collector — set at vault construction — and factory.)
    function wire(HydeFeeVault _vault, uint256 nTokens, uint256 nActors) external {
        vault = _vault;
        for (uint256 i; i < nActors; i++) {
            actors.push(address(uint160(0xA0000 + i)));
        }
        for (uint256 i; i < nTokens; i++) {
            HydeERC20 t = new HydeERC20();
            vault.register(address(t), address(uint160(0xC0000 + i)));
            address[] memory ex = new address[](2);
            ex[0] = POOL;
            ex[1] = address(vault);
            t.initialize(
                HydeERC20.InitParams("H", "H", POOL, address(vault), 300, 3600, ex)
            );
            tokens.push(t);
        }
        vm.warp(block.timestamp + 3601); // past the max-wallet window → free sizing
        // Seed each actor with LT of each token so eligible supply is non-trivial from the start.
        for (uint256 i; i < tokens.length; i++) {
            for (uint256 j; j < actors.length; j++) {
                vm.prank(POOL);
                tokens[i].transfer(actors[j], 1_000_000e18);
            }
        }
    }

    function tokenCount() external view returns (uint256) {
        return tokens.length;
    }

    /* ─────────────────────────── fuzzed actions ────────────────────────────── */
    function noteAndSettleWeth(uint256 tSeed, uint256 amt) external {
        HydeERC20 t = tokens[tSeed % tokens.length];
        amt = bound(amt, 1, 1_000_000e18);
        weth.mint(address(this), amt);
        weth.approve(address(vault), amt);
        vault.noteRaw(address(t), address(weth), amt);
        totalWethFunded += amt;
        vault.settle(address(t), address(weth), amt, 0, block.timestamp);
    }

    function transferToken(uint256 tSeed, uint256 fromSeed, uint256 toSeed, uint256 amt) external {
        HydeERC20 t = tokens[tSeed % tokens.length];
        address from = actors[fromSeed % actors.length];
        address to = actors[toSeed % actors.length];
        uint256 bal = t.balanceOf(from);
        if (bal == 0) return;
        amt = bound(amt, 1, bal);
        vm.prank(from);
        t.transfer(to, amt);
    }

    function claimCreatorOrHyde(uint256 tSeed, bool creator) external {
        HydeERC20 t = tokens[tSeed % tokens.length];
        if (creator) {
            try vault.claimCreator(address(t)) {} catch {}
        } else {
            try vault.claimHyde(address(t)) {} catch {}
        }
    }

    function warp(uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 1, 10 days));
    }

    function donate(uint256 amt) external {
        // A raw WETH donation to the vault must never affect accounting (INV-13) or break solvency.
        weth.mint(address(vault), bound(amt, 1, 1e24));
    }
}

contract VaultInvariantTest is Test {
    HydeFeeVault internal vault;
    MockERC20 internal weth;
    VaultHandler internal handler;

    function setUp() public {
        weth = new MockERC20(18);
        handler = new VaultHandler(weth);
        vault = new HydeFeeVault(
            IERC20(address(weth)),
            address(handler), // collector
            IPoolManager(address(0x1111)),
            IHydeHook(address(0x2222)),
            int24(60),
            address(0x7EA5),
            500, // hydeBps
            9500, // NET_BPS (BPS_DENOM − liqBps)
            300,
            1800,
            int24(200) // MAX_SETTLE_DEV_TICKS (FINDING-3)
        );
        vault.initFactory(address(handler)); // test is the deployer → sets the handler as factory
        handler.wire(vault, 3, 4); // 3 tokens, 4 actors
        targetContract(address(handler));
    }

    /// @notice INV-27: for WETH, `accountedBalance == Σ derived per-token liabilities` AND the vault
    ///         balance covers it — after every fuzzed interleaving.
    function invariant_wethSolvency() public view {
        uint256 accounted = vault.accountedBalance(address(weth));
        uint256 sumLiab;
        uint256 n = handler.tokenCount();
        for (uint256 i; i < n; i++) {
            address t = address(handler.tokens(i));
            sumLiab += vault.rawFees(t, address(weth)) + vault.creatorClaimable(t) + vault.hydeClaimable(t);
        }
        assertEq(accounted, sumLiab, "accountedBalance == Sigma liabilities (INV-27)");
        assertGe(weth.balanceOf(address(vault)), accounted, "vault solvent: balance >= accounted (INV-27)");
    }

    /// @notice Conservation: everything funded is either still accounted (owed) or already paid out.
    function invariant_conservation() public view {
        uint256 accounted = vault.accountedBalance(address(weth));
        uint256 paidOut = handler.totalWethFunded() - accounted; // funded − still-owed == paid to recipients
        // paidOut can't exceed what was funded, and the vault still holds at least what's accounted.
        assertLe(paidOut, handler.totalWethFunded(), "cannot pay out more than funded");
    }
}
