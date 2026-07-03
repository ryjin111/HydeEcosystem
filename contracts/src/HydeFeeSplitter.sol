// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

/**
 * @notice Per-creator fee splitter — the `buybackDestination` for Hydeout
 * launches on Robinhood Chain. Doppler's Rehype migrator pushes the creator
 * fee stream (post 5%-protocol-skim) to this address; anyone can then call
 * `split` to forward HYDE_BPS to the Hydeout treasury and the rest to the
 * creator.
 *
 * Security model (per Reviewer audit bar):
 *  - No registry, no registrar: the creator is fixed at initialization and
 *    the clone address is CREATE2-derived from the creator (see factory), so
 *    nothing can be hijacked or front-run.
 *  - Funds can never strand: the clone address is deterministic — fees sent
 *    before deployment sit at an address only the factory's own bytecode can
 *    ever control; anyone can materialize the clone and split.
 *  - Treasury and split are immutable per deployment (read from the factory,
 *    which fixes them in its constructor).
 */
contract HydeFeeSplitter {
    uint256 public constant BPS_DENOMINATOR = 10_000;

    IHydeSplitterFactory public factory;
    address public creator;

    error AlreadyInitialized();
    error NotFactory();
    error ETHTransferFailed();

    event Split(address indexed token, uint256 toCreator, uint256 toTreasury);

    /// @dev Called once by the factory in the same transaction as the clone deploy.
    function initialize(address creator_) external {
        if (creator != address(0)) revert AlreadyInitialized();
        // The factory deploys + initializes atomically; anything else racing a
        // not-yet-deployed clone cannot exist because only the factory can put
        // code at the CREATE2 address.
        factory = IHydeSplitterFactory(msg.sender);
        creator = creator_;
    }

    /// @notice Split this contract's full balance of each token (and ETH) between
    /// the creator and the Hydeout treasury. Callable by anyone.
    function split(address[] calldata tokens) external {
        address creator_ = creator;
        address treasury = factory.treasury();
        uint256 hydeBps = factory.hydeBps();

        for (uint256 i = 0; i < tokens.length; i++) {
            IERC20 token = IERC20(tokens[i]);
            uint256 balance = token.balanceOf(address(this));
            if (balance == 0) continue;
            uint256 toTreasury = (balance * hydeBps) / BPS_DENOMINATOR;
            uint256 toCreator = balance - toTreasury;
            if (toTreasury > 0) token.transfer(treasury, toTreasury);
            token.transfer(creator_, toCreator);
            emit Split(tokens[i], toCreator, toTreasury);
        }

        uint256 ethBalance = address(this).balance;
        if (ethBalance > 0) {
            uint256 toTreasury = (ethBalance * hydeBps) / BPS_DENOMINATOR;
            uint256 toCreator = ethBalance - toTreasury;
            if (toTreasury > 0) {
                (bool ok1, ) = treasury.call{ value: toTreasury }("");
                if (!ok1) revert ETHTransferFailed();
            }
            (bool ok2, ) = creator_.call{ value: toCreator }("");
            if (!ok2) revert ETHTransferFailed();
            emit Split(address(0), toCreator, toTreasury);
        }
    }

    receive() external payable {}
}

interface IHydeSplitterFactory {
    function treasury() external view returns (address);
    function hydeBps() external view returns (uint256);
}

/**
 * @notice Deploys one deterministic HydeFeeSplitter clone per creator
 * (EIP-1167, CREATE2 salt = creator address). `predictClone(creator)` is
 * known before deployment, so the launch flow can use it as
 * `buybackDestination` without any prior transaction — the clone is
 * materialized lazily by whoever claims first.
 */
contract HydeSplitterFactory {
    address public immutable implementation;
    address public immutable treasury;
    uint256 public immutable hydeBps;

    error InvalidTreasury();
    error InvalidBps();
    error ZeroCreator();

    event SplitterDeployed(address indexed creator, address splitter);

    constructor(address treasury_, uint256 hydeBps_) {
        if (treasury_ == address(0)) revert InvalidTreasury();
        if (hydeBps_ == 0 || hydeBps_ > 1_000) revert InvalidBps(); // hard cap 10%
        treasury = treasury_;
        hydeBps = hydeBps_;
        implementation = address(new HydeFeeSplitter());
    }

    /// @notice Deploy (or return the existing) splitter clone for a creator.
    function cloneFor(address creator) external returns (address splitter) {
        if (creator == address(0)) revert ZeroCreator();
        splitter = predictClone(creator);
        if (splitter.code.length > 0) return splitter; // idempotent

        bytes20 impl = bytes20(implementation);
        bytes32 salt = bytes32(uint256(uint160(creator)));
        assembly {
            let ptr := mload(0x40)
            // EIP-1167 minimal proxy initcode
            mstore(ptr, 0x3d602d80600a3d3981f3363d3d373d3d3d363d73000000000000000000000000)
            mstore(add(ptr, 0x14), impl)
            mstore(add(ptr, 0x28), 0x5af43d82803e903d91602b57fd5bf30000000000000000000000000000000000)
            splitter := create2(0, ptr, 0x37, salt)
        }
        require(splitter != address(0), "CREATE2 failed");
        HydeFeeSplitter(payable(splitter)).initialize(creator);
        emit SplitterDeployed(creator, splitter);
    }

    /// @notice The deterministic clone address for a creator — safe to use as
    /// `buybackDestination` before the clone exists.
    function predictClone(address creator) public view returns (address) {
        bytes32 initCodeHash = keccak256(
            abi.encodePacked(
                hex"3d602d80600a3d3981f3363d3d373d3d3d363d73",
                bytes20(implementation),
                hex"5af43d82803e903d91602b57fd5bf3"
            )
        );
        bytes32 salt = bytes32(uint256(uint160(creator)));
        return address(uint160(uint256(keccak256(abi.encodePacked(hex"ff", address(this), salt, initCodeHash)))));
    }
}
