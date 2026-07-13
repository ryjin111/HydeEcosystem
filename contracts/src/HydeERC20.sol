// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title HydeERC20 — non-seizable fair-launch token (implementation, EIP-1167 cloned per launch)
/// @notice CONTRACT_SPEC_L3.md §2. No owner. No mint-after-init. No blacklist. No pause.
///         Time-boxed max-wallet anti-snipe (recipients only, never blocks selling; expiry immutable).
///         EIP-2612 permit for holder UX. All economic fields set ONCE in `initialize` under an
///         initializer + onlyFactory guard — no setters exist.
contract HydeERC20 {
    /* ─────────────────────────── ERC-20 core state ─────────────────────────── */
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;

    /// @dev fair launch: 1B supply, 100% minted at init, no mint path after.
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    /* ─────────────────────── anti-snipe (max-wallet) ───────────────────────── */
    /// @notice max holder balance while the window is active (0 once expired-check passes).
    uint256 public maxWallet;
    /// @notice window is active while block.timestamp < maxWalletExpiry. Immutable after init.
    uint64 public maxWalletExpiry;
    /// @notice fixed exemption set frozen at init (pool, positionManager, factory, collector, 0).
    ///         No setExempt — no owner-addable whitelist (spec §2 / kami audit pt.4).
    mapping(address => bool) public exempt;
    /// @notice the fee collector; a transfer FROM the collector bypasses the cap (kami audit pt.8)
    ///         so a fee payout to a non-exempt creator during the window can't revert `collect`.
    address public collector;

    /* ─────────────────────────── init guard ────────────────────────────────── */
    /// @notice recorded factory; zero until `initialize`. First & only caller becomes factory
    ///         → doubles as the initializer once-guard (kami audit pt.2, §2).
    address public factory;

    /* ─────────────────────────── EIP-2612 ──────────────────────────────────── */
    mapping(address => uint256) public nonces;
    bytes32 private constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    // Domain separator is chain- & address-dependent (and clones share bytecode), so cache it
    // and recompute on a chain fork.
    uint256 private _cachedChainId;
    bytes32 private _cachedDomainSeparator;

    /* ─────────────────────────── events ────────────────────────────────────── */
    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);

    struct InitParams {
        string name;
        string symbol;
        address poolRecipient; // receives 100% of supply (the V3 seeding flow / factory transient)
        address collector; // HydeFeeCollector — sender-side cap bypass
        uint256 maxWalletBps; // maxWallet = TOTAL_SUPPLY * maxWalletBps / 1e4
        uint64 maxWalletWindowSecs; // window length; expiry = now + this
        address[] exemptAddrs; // pool, positionManager, factory, collector, address(0)
    }

    /// @notice One-time init. Callable exactly once, by the first caller, which is recorded as the
    ///         factory. The factory clones + calls this atomically in one tx (§3 steps 2–3) so there
    ///         is no front-run window on a fresh clone.
    function initialize(InitParams calldata p) external {
        require(factory == address(0), "INIT"); // initializer once-guard + onlyFactory (first caller)
        // Config bounds (kami audit 21162.3): no zero recipients, sane cap/window.
        require(p.poolRecipient != address(0), "ZERO_POOL");
        require(p.collector != address(0), "ZERO_COLLECTOR");
        // Anti-snipe is LOCKED (kami 8c64405): max-wallet 0.01%–3% of supply, window 1s–1h.
        // Neither can be 0 (would disable the guard) nor unbounded (would trap holders). INV-22.
        require(p.maxWalletBps > 0 && p.maxWalletBps <= 300, "BPS_RANGE");
        require(p.maxWalletWindowSecs > 0 && p.maxWalletWindowSecs <= 3600, "WINDOW_RANGE");
        factory = msg.sender;

        name = p.name;
        symbol = p.symbol;
        collector = p.collector;

        maxWallet = (TOTAL_SUPPLY * p.maxWalletBps) / 1e4;
        maxWalletExpiry = uint64(block.timestamp) + p.maxWalletWindowSecs;

        for (uint256 i; i < p.exemptAddrs.length; ++i) {
            exempt[p.exemptAddrs[i]] = true;
        }
        exempt[address(0)] = true; // mint/burn sentinel always exempt

        // EIP-712 domain, now that `name` and this clone's address are known.
        _cachedChainId = block.chainid;
        _cachedDomainSeparator = _computeDomainSeparator();

        // Mint 100% of supply into the seeding flow. poolRecipient must be in the exempt set
        // (factory guarantees) so the mint itself is never blocked by the cap.
        _mint(p.poolRecipient, TOTAL_SUPPLY);
    }

    /* ─────────────────────────── ERC-20 logic ──────────────────────────────── */
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, "ALLOWANCE");
            allowance[from][msg.sender] = allowed - amount;
        }
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        // Never allow transfers to the zero address — it would trap tokens without reducing
        // totalSupply and break the burn/supply invariant (kami audit 21162.2). Burning is a
        // distinct onlyCollector `burn` path that DOES decrement supply.
        require(to != address(0), "ZERO_TO");
        // Max-wallet: only caps *recipient accumulation*, only during the window, never blocks
        // selling (`from` unrestricted), and lets fee distribution through (from == collector).
        if (block.timestamp < maxWalletExpiry && !exempt[to] && from != collector) {
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

    function _mint(address to, uint256 amount) internal {
        totalSupply += amount;
        unchecked {
            balanceOf[to] += amount;
        }
        emit Transfer(address(0), to, amount);
    }

    /// @notice The ONLY post-init supply mutation (spec §2 / §4 buyback&burn leg). Restricted to the
    ///         collector; burns the collector's OWN accrued fee balance, decreasing totalSupply.
    ///         One-directional (can never mint), no recipient, cannot burn a third party (INV-19).
    ///         Supply is therefore monotonically non-increasing after launch (INV-5).
    function burn(uint256 amount) external {
        require(msg.sender == collector, "ONLY_COLLECTOR");
        uint256 bal = balanceOf[msg.sender];
        require(bal >= amount, "BALANCE");
        unchecked {
            balanceOf[msg.sender] = bal - amount;
            totalSupply -= amount;
        }
        emit Transfer(msg.sender, address(0), amount);
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
