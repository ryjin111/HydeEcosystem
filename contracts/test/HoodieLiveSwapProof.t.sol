// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";

interface IUniversalRouter {
    // 4663 deployed UniversalRouter supports BOTH; the 2-arg is used by most live V4 swaps.
    function execute(bytes calldata commands, bytes[] calldata inputs) external payable;
}

/// @notice LIVE-4663 proof that the canonical UniversalRouter (0x8876…0904) can BUY (HOODIE->TOKEN) and
///         SELL (TOKEN->HOODIE) the real LILHOODIE / $HOODIE pool. gateway + V4Quoter are NOT deployed on
///         4663, so the production swap path is the canonical UniversalRouter directly.
///
///   forge test --match-contract HoodieLiveSwapProof --fork-url https://rpc.mainnet.chain.robinhood.com -vv
///
/// KEY ENCODING FINDING (verified against the router's own CalldataDecoder.sol on Blockscout):
///   - ExactInputSingleParams is the 6-FIELD variant (has minHopPriceX36). 5-field => SliceOutOfBounds.
///   - params[0] MUST be abi.encode(STRUCT) — a single tuple, so the first word is the 0x20 offset the
///     decoder dereferences (`swapParams := params.offset + calldataload(params.offset)`). Encoding the
///     fields comma-separated (no leading offset) makes the decoder read amountIn as 0 (OPEN_DELTA) and
///     revert. The frontend's src/utils/v4Encoding.ts uses the comma-separated form => must wrap in a tuple.
contract HoodieLiveSwapProof is Test {
    address constant PM      = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant UR      = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant HOODIE  = 0xC72c01AAB5f5678dc1d6f5C6d2B417d91D402Ba3; // numeraire, currency1
    address constant TOKEN   = 0x8a76FeeF3bb0140c122d146caCef6B1A4Ac145f7; // LILHOODIE, currency0 (TOKEN < HOODIE)
    address constant HOOK    = 0x41078B0012751e7E646DF9B6607e6C4fF8B570C0; // HydeHook
    address constant HOLDER  = 0xcbacfD51fB04bB996565F4B03c53BD0932fA740c; // real HOODIE holder

    uint8 constant V4_SWAP = 0x10;              // Commands.V4_SWAP
    uint8 constant SWAP_EXACT_IN_SINGLE = 0x06; // Actions
    uint8 constant SETTLE_ALL = 0x0c;
    uint8 constant TAKE_ALL = 0x0f;

    // 6-field struct matching the DEPLOYED router's IV4Router.ExactInputSingleParams.
    struct ExactInputSingleParams {
        PoolKey poolKey;
        bool zeroForOne;
        uint128 amountIn;
        uint128 amountOutMinimum;
        uint256 minHopPriceX36;
        bytes hookData;
    }

    PoolKey key;

    function setUp() public {
        key = PoolKey({
            currency0: Currency.wrap(TOKEN),
            currency1: Currency.wrap(HOODIE),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG, // 0x800000
            tickSpacing: 60,
            hooks: IHooks(HOOK)
        });
    }

    function _skip() internal returns (bool) {
        if (PM.code.length == 0) { vm.skip(true); return true; }
        return false;
    }

    function _permit2(address who, address token) internal {
        vm.startPrank(who);
        IERC20(token).approve(PERMIT2, type(uint256).max);
        IAllowanceTransfer(PERMIT2).approve(token, UR, type(uint160).max, uint48(block.timestamp + 3600));
        vm.stopPrank();
    }

    /// Build the V4_SWAP execute() calldata for an exact-in single-hop swap — the EXACT bytes kuro reproduces.
    function _swapCalldata(bool zeroForOne, address cIn, address cOut, uint128 amountIn, uint128 minOut)
        internal view returns (bytes memory commands, bytes[] memory inputs)
    {
        commands = abi.encodePacked(V4_SWAP);
        bytes memory actions = abi.encodePacked(SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL);
        ExactInputSingleParams memory sp = ExactInputSingleParams({
            poolKey: key, zeroForOne: zeroForOne, amountIn: amountIn,
            amountOutMinimum: minOut, minHopPriceX36: 0, hookData: ""
        });
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(sp);                                 // SINGLE tuple -> leading 0x20 offset
        params[1] = abi.encode(Currency.wrap(cIn), uint256(amountIn));   // SETTLE_ALL(currencyIn, maxAmount)
        params[2] = abi.encode(Currency.wrap(cOut), uint256(minOut));    // TAKE_ALL(currencyOut, minAmount)
        inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, params);
    }

    function test_fork_universalRouter_buy_and_sell() external {
        if (_skip()) return;
        require(IERC20(HOODIE).balanceOf(HOLDER) >= 5e18, "holder lacks HOODIE");

        // ── BUY: 1 HOODIE -> TOKEN (zeroForOne=false; ERC20 numeraire => Permit2, no msg.value) ──
        _permit2(HOLDER, HOODIE);
        (bytes memory bc, bytes[] memory bi) = _swapCalldata(false, HOODIE, TOKEN, 1e18, 0);
        // GOLDEN VECTOR for kuro's encoding gate: exact bytes of a proven buy (1e18 HOODIE in, minOut 0).
        console2.log("GOLDEN commands:"); console2.logBytes(bc);
        console2.log("GOLDEN inputs[0] (V4_SWAP payload):"); console2.logBytes(bi[0]);
        console2.log("GOLDEN full execute(bytes,bytes[]) calldata:");
        console2.logBytes(abi.encodeWithSelector(0x24856bc3, bc, bi));
        uint256 tBefore = IERC20(TOKEN).balanceOf(HOLDER);
        vm.prank(HOLDER);
        IUniversalRouter(UR).execute(bc, bi);
        uint256 bought = IERC20(TOKEN).balanceOf(HOLDER) - tBefore;
        console2.log("UR BUY  1 HOODIE -> TOKEN out:", bought);
        assertGt(bought, 0, "buy produced no TOKEN");

        // ── SELL: half the TOKEN back -> HOODIE (zeroForOne=true) ──
        _permit2(HOLDER, TOKEN);
        uint128 sellIn = uint128(bought / 2);
        (bytes memory sc, bytes[] memory si) = _swapCalldata(true, TOKEN, HOODIE, sellIn, 0);
        uint256 hBefore = IERC20(HOODIE).balanceOf(HOLDER);
        vm.prank(HOLDER);
        IUniversalRouter(UR).execute(sc, si);
        uint256 gotBack = IERC20(HOODIE).balanceOf(HOLDER) - hBefore;
        console2.log("UR SELL half TOKEN -> HOODIE out:", gotBack);
        assertGt(gotBack, 0, "sell produced no HOODIE");
    }
}
