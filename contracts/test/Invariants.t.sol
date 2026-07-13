// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, StdInvariant} from "forge-std/Test.sol";
import {HydeFeeCollector} from "../src/HydeFeeCollector.sol";
import {HydeERC20} from "../src/HydeERC20.sol";
import {MockPositionManager} from "./mocks/MockPositionManager.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/// @notice Drives random sequences of collect / transfer / burn-attack / register-attack /
///         forbidden-selector-attack against a registered launch to stress the immutability,
///         supply and custody invariants.
contract Handler is Test {
    HydeFeeCollector public collector;
    HydeERC20 public lt;
    MockERC20 public num;
    MockPositionManager public pm;
    uint256 public tokenId;

    address[4] public actors = [address(0xA1), address(0xA2), address(0xA3), address(0xA4)];

    uint256 public initialSupply;
    uint256 public lastSupply; // ghost: supply observed after the previous handler step
    bool public supplyIncreased; // ghost: trips if ANY handler step raised totalSupply
    bool public illegalBurnSucceeded; // ghost: a non-collector burn that did NOT revert
    bool public illegalRegisterSucceeded; // ghost: a non-factory register that did NOT revert
    bool public forbiddenSelectorSucceeded; // ghost: a custody/approval selector that did NOT revert

    // Selectors that MUST NOT exist on the collector (any success = a way to move/approve the LP).
    bytes[] internal forbidden;

    constructor(HydeFeeCollector _c, HydeERC20 _lt, MockERC20 _num, MockPositionManager _pm, uint256 _tokenId) {
        collector = _c;
        lt = _lt;
        num = _num;
        pm = _pm;
        tokenId = _tokenId;
        initialSupply = lt.totalSupply();
        lastSupply = initialSupply;

        forbidden.push(abi.encodeWithSignature("approve(address,uint256)", address(0xBEEF), tokenId));
        forbidden.push(abi.encodeWithSignature("setApprovalForAll(address,bool)", address(0xBEEF), true));
        forbidden.push(
            abi.encodeWithSignature("transferFrom(address,address,uint256)", address(_c), address(0xBEEF), tokenId)
        );
        forbidden.push(
            abi.encodeWithSignature("safeTransferFrom(address,address,uint256)", address(_c), address(0xBEEF), tokenId)
        );
        forbidden.push(
            abi.encodeWithSignature(
                "decreaseLiquidity(uint256,uint128,uint256,uint256,uint256)", tokenId, uint128(1), 0, 0, block.timestamp
            )
        );
        forbidden.push(abi.encodeWithSignature("burn(uint256)", tokenId));
        forbidden.push(abi.encodeWithSignature("withdraw(uint256)", tokenId));
        forbidden.push(abi.encodeWithSignature("execute(address,bytes)", address(_lt), ""));
        forbidden.push(abi.encodeWithSignature("multicall(bytes[])", new bytes[](0)));
    }

    /// After each handler step, prove supply never went UP vs the previous observation.
    modifier tracked() {
        _;
        uint256 s = lt.totalSupply();
        if (s > lastSupply) supplyIncreased = true;
        lastSupply = s;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    /// Accrue random fees then collect (drives the 90/5/5 + burn path).
    function collect(uint128 fee0, uint128 fee1) external tracked {
        fee0 = uint128(bound(fee0, 0, uint128(lt.balanceOf(address(pm)))));
        pm.setPosition(tokenId, address(lt), address(num), fee0, fee1);
        num.mint(address(pm), fee1);
        collector.collect(address(lt));
    }

    /// Seed an actor with launch tokens from the pm's pool balance (a "buy").
    function seedActor(uint256 who, uint128 amount) external tracked {
        address a = _actor(who);
        uint256 avail = lt.balanceOf(address(pm));
        amount = uint128(bound(amount, 0, avail));
        vm.prank(address(pm));
        lt.transfer(a, amount);
    }

    /// Move tokens between actors (a "sell"/transfer).
    function moveTokens(uint256 from, uint256 to, uint128 amount) external tracked {
        address f = _actor(from);
        address t = _actor(to);
        amount = uint128(bound(amount, 0, uint128(lt.balanceOf(f))));
        vm.prank(f);
        lt.transfer(t, amount);
    }

    /// Adversary: a non-collector tries to burn (must always revert — INV-19).
    function attackBurn(uint256 who, uint128 amount) external tracked {
        address a = _actor(who);
        try lt.burn(amount) {
            illegalBurnSucceeded = true; // only reachable if msg.sender == collector, which it isn't
        } catch {}
        vm.prank(a);
        try lt.burn(amount) {
            illegalBurnSucceeded = true;
        } catch {}
    }

    /// Adversary: a non-factory tries to register / re-register (must always revert).
    function attackRegister(uint256 who) external tracked {
        address a = _actor(who);
        vm.prank(a);
        try collector.register(address(lt), a, tokenId, address(num), 1) {
            illegalRegisterSucceeded = true;
        } catch {}
    }

    /// Adversary: fire each forbidden custody/approval selector at the collector. None may succeed —
    /// the collector exposes no approve/transfer/withdraw/decreaseLiquidity/burn/generic-call path.
    function attackForbiddenSelector(uint256 who, uint256 idx) external tracked {
        address a = _actor(who);
        bytes memory data = forbidden[idx % forbidden.length];
        vm.prank(a);
        (bool ok,) = address(collector).call(data);
        if (ok) forbiddenSelectorSucceeded = true;
    }
}

contract InvariantsTest is StdInvariant, Test {
    HydeFeeCollector internal collector;
    HydeERC20 internal lt;
    MockERC20 internal num;
    MockPositionManager internal pm;
    Handler internal handler;

    address internal creator = address(0xCEA1);
    address internal hydeout = address(0x7EA0);
    address internal sink = address(0x5111);
    uint256 internal constant TOKEN_ID = 7;

    function setUp() public {
        pm = new MockPositionManager();
        collector = new HydeFeeCollector(pm, hydeout, sink, 500, 500);
        collector.initFactory(address(this));
        num = new MockERC20(6);

        lt = new HydeERC20();
        address[] memory exempt = new address[](2);
        exempt[0] = address(pm);
        exempt[1] = address(collector);
        lt.initialize(HydeERC20.InitParams("LT", "LT", address(pm), address(collector), 300, 3600, exempt));

        pm.setPosition(TOKEN_ID, address(lt), address(num), 0, 0);
        collector.register(address(lt), creator, TOKEN_ID, address(num), 1_000e18);

        handler = new Handler(collector, lt, num, pm, TOKEN_ID);
        targetContract(address(handler));
    }

    /// INV-3: fee recipients + split bps are immutable across any call sequence.
    function invariant_config_immutable() public view {
        assertEq(collector.hydeoutTreasury(), hydeout);
        assertEq(collector.buybackSink(), sink);
        assertEq(collector.hydeoutBps(), 500);
        assertEq(collector.buybackBps(), 500);
        (,, address regCreator,,,) = collector.positionOf(address(lt));
        assertEq(regCreator, creator);
    }

    /// INV-5 / INV-19: supply is bounded by the launch amount AND no single step ever raised it
    /// (burn-only, ghost-checkpointed) — not merely ≤ initial at the end.
    function invariant_supply_never_increases() public view {
        assertLe(lt.totalSupply(), handler.initialSupply());
        assertFalse(handler.supplyIncreased());
    }

    /// INV-19: no non-collector burn and no non-factory register ever succeeded.
    function invariant_no_illegal_privileged_calls() public view {
        assertEq(handler.illegalBurnSucceeded(), false);
        assertEq(handler.illegalRegisterSucceeded(), false);
    }

    /// INV-14 (PARTIAL — pre-fork): the collector grants no ERC-20 approvals AND exposes none of the
    /// custody/approval/withdraw selectors that could move the position. Full "NFT never leaves"
    /// custody proof requires the real Uniswap V3 fork (the mock does not model NFT ownership).
    function invariant_collector_grants_no_approvals() public view {
        assertEq(lt.allowance(address(collector), address(pm)), 0);
        assertEq(num.allowance(address(collector), address(pm)), 0);
        assertEq(lt.allowance(address(collector), creator), 0);
    }

    /// INV-14 (PARTIAL — pre-fork): no forbidden custody/approval selector on the collector ever
    /// succeeded under fuzzed callers.
    function invariant_no_forbidden_selector_succeeds() public view {
        assertFalse(handler.forbiddenSelectorSucceeded());
    }
}
