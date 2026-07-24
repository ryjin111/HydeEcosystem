// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title HydeERC20 — non-seizable fair-launch token (implementation, EIP-1167 cloned per launch)
/// @notice Fixed-supply fair-launch token, DEX-agnostic. There are NO holder rewards. No owner. No
///         mint-after-init. **No burn — supply is constant at 1e9 forever.** No blacklist. No pause.
///         Time-boxed max-wallet anti-snipe (caps recipients only, never blocks selling; expiry is
///         immutable). EIP-2612 permit. All economic fields are set ONCE in `initialize` under an
///         initializer + first-caller (factory) guard — no setters. `_update` performs no transfer
///         hook / external call (pure arithmetic) → no reentrancy surface during fee splits.
contract HydeERC20 {
    /* ─────────────────────────── ERC-20 core state ─────────────────────────── */
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;

    /// @dev fair launch: 1B supply, 100% minted at init, no mint AND no burn path after.
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    /* ─────────────────────── anti-snipe (max-wallet) ───────────────────────── */
    /// @notice max holder balance while the window is active. Immutable after init.
    uint256 public maxWallet;
    /// @notice window is active while block.timestamp < maxWalletExpiry. Immutable after init.
    uint64 public maxWalletExpiry;
    /// @notice fixed exemption set frozen at init. V3 line: {pool, positionManager, factory, locker,
    ///         swapRouter, universalRouter, 0}. No setExempt — no owner-addable whitelist.
    mapping(address => bool) public exempt;

    /// @notice recorded infra address; part of the exempt set. V3 line: the `HydeV3FeeLocker`
    ///         (custodies the locked LP + splits fees 95/5). Recorded only — no hook, no callback.
    address public feeLocker;

    /* ─────────────────────────── init guard ────────────────────────────────── */
    /// @notice recorded factory; zero until `initialize`. First & only caller becomes factory
    ///         → doubles as the initializer once-guard.
    address public factory;

    /* ─────────────────────────── EIP-2612 ──────────────────────────────────── */
    mapping(address => uint256) public nonces;
    bytes32 private constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    // Domain separator is chain- & address-dependent (clones share bytecode), so cache it and
    // recompute on a chain fork.
    uint256 private _cachedChainId;
    bytes32 private _cachedDomainSeparator;

    /* ─────────────────────────── events ────────────────────────────────────── */
    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);

    struct InitParams {
        string name;
        string symbol;
        address poolRecipient; // receives 100% of supply (the V3 single-sided seeding flow)
        address feeLocker; // HydeV3FeeLocker address (recorded; exempt infra member)
        uint256 maxWalletBps; // maxWallet = TOTAL_SUPPLY * maxWalletBps / 1e4
        uint64 maxWalletWindowSecs; // window length; expiry = now + this
        address[] exemptAddrs; // pool, positionManager, factory, locker, swapRouter, universalRouter, 0
    }

    /// @notice One-time init. Callable exactly once, by the first caller, which is recorded as the
    ///         factory. The factory clones + calls this atomically in one tx so there is no front-run
    ///         window on a fresh clone. The factory holds 100% of supply immediately after (it is the
    ///         exempt seeder) and mints it single-sided into the pool within the same launch tx.
    function initialize(InitParams calldata p) external {
        require(factory == address(0), "INIT"); // initializer once-guard + onlyFactory (first caller)
        // Config bounds: no zero recipients, sane cap/window.
        require(p.poolRecipient != address(0), "ZERO_POOL");
        require(p.feeLocker != address(0), "ZERO_LOCKER");
        // Anti-snipe LOCKED: max-wallet 0.01%–3% of supply, window 1s–1h. Neither 0 (disables the
        // guard) nor unbounded (traps holders).
        require(p.maxWalletBps > 0 && p.maxWalletBps <= 300, "BPS_RANGE");
        require(p.maxWalletWindowSecs > 0 && p.maxWalletWindowSecs <= 3600, "WINDOW_RANGE");
        factory = msg.sender;

        name = p.name;
        symbol = p.symbol;
        feeLocker = p.feeLocker;

        maxWallet = (TOTAL_SUPPLY * p.maxWalletBps) / 1e4;
        maxWalletExpiry = uint64(block.timestamp) + p.maxWalletWindowSecs;

        // Frozen infra exempt set (max-wallet exemption).
        for (uint256 i; i < p.exemptAddrs.length; ++i) {
            exempt[p.exemptAddrs[i]] = true;
        }
        exempt[address(0)] = true; // mint sentinel always exempt

        // EIP-712 domain, now that `name` and this clone's address are known.
        _cachedChainId = block.chainid;
        _cachedDomainSeparator = _computeDomainSeparator();

        // Mint 100% of supply into the seeding flow. `poolRecipient` must be in the exempt set
        // (factory guarantees) so the cap is not affected by the mint.
        _mint(p.poolRecipient, TOTAL_SUPPLY);
    }

    /* ─────────────────────────── ERC-20 logic ──────────────────────────────── */
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _update(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, "ALLOWANCE");
            allowance[from][msg.sender] = allowed - amount;
        }
        _update(from, to, amount);
        return true;
    }

    /// @dev The single transfer path. Order: (1) `to==0` reverts (supply constant); (2) time-boxed
    ///      max-wallet on the RECIPIENT only, never blocks selling; (3) move balances + emit. NO external
    ///      call / hook here — pure arithmetic (no reentrancy surface during a fee split).
    function _update(address from, address to, uint256 amount) internal {
        require(to != address(0), "ZERO_TO"); // supply constant; no burn-to-zero

        // max-wallet: caps recipient accumulation only, only during the window, never blocks selling
        // (`from` unrestricted), never blocks fee handling (locker is `to`-exempt). Self-contained.
        if (block.timestamp < maxWalletExpiry && !exempt[to]) {
            require(balanceOf[to] + amount <= maxWallet, "MAX_WALLET");
        }

        uint256 bal = balanceOf[from];
        require(bal >= amount, "BALANCE");
        unchecked {
            balanceOf[from] = bal - amount;
            balanceOf[to] += amount;
        }
        emit Transfer(from, to, amount);
    }

    /// @dev Init-only mint. Adds the full supply to the exempt seeder. There is NO other supply
    ///      mutation ever.
    function _mint(address to, uint256 amount) internal {
        totalSupply += amount;
        unchecked {
            balanceOf[to] += amount;
        }
        emit Transfer(address(0), to, amount);
    }

    /* ─────────────────────────── EIP-2612 permit ───────────────────────────── */
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
    {
        require(deadline >= block.timestamp, "PERMIT_EXPIRED");
        unchecked {
            bytes32 structHash =
                keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, nonces[owner]++, deadline));
            bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
            address recovered = ecrecover(digest, v, r, s);
            require(recovered != address(0) && recovered == owner, "PERMIT_SIG");
            allowance[owner][spender] = value;
            emit Approval(owner, spender, value);
        }
    }

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return block.chainid == _cachedChainId ? _cachedDomainSeparator : _computeDomainSeparator();
    }

    function _computeDomainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(name)),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
    }
}
