// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title HydeERC20 — non-seizable fair-launch token (implementation, EIP-1167 cloned per launch)
/// @notice CONTRACT_SPEC_L3.md §2 (rev8). No owner. No mint-after-init. **No burn — supply is
///         constant 1e9 forever (INV-5).** No blacklist. No pause. Time-boxed max-wallet anti-snipe
///         (recipients only, never blocks selling; expiry immutable). EIP-2612 permit.
///         (rev8) The vault reward `sync` hook is REMOVED — max-wallet is fully self-contained in
///         `_update` and never depended on it. All economic fields set ONCE in `initialize` under
///         initializer + onlyFactory — no setters.
contract HydeERC20 {
    /* ─────────────────────────── ERC-20 core state ─────────────────────────── */
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;

    /// @dev fair launch: 1B supply, 100% minted at init, no mint AND no burn path after (INV-5).
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    /* ─────────────────────── anti-snipe (max-wallet) ───────────────────────── */
    /// @notice max holder balance while the window is active. Immutable after init.
    uint256 public maxWallet;
    /// @notice window is active while block.timestamp < maxWalletExpiry. Immutable after init.
    uint64 public maxWalletExpiry;
    /// @notice fixed exemption set frozen at init (pool, positionManager, factory, collector, vault,
    ///         swapRouter, 0). Serves BOTH max-wallet exemption AND reward-ineligibility (§2).
    ///         No setExempt — no owner-addable whitelist.
    mapping(address => bool) public exempt;

    /// @notice the shared HydeFeeVault address (§4b); part of the exempt infra set. Set once at init.
    ///         (rev8: the reward-index `sync` hook is removed — this is now just a recorded address.
    ///         The creator is paid in WETH, so no from==collector max-wallet bypass exists; INV-17.)
    address public vault;

    /* ─────────────────────────── init guard ────────────────────────────────── */
    /// @notice recorded factory; zero until `initialize`. First & only caller becomes factory
    ///         → doubles as the initializer once-guard (§2).
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
        address poolRecipient; // receives 100% of supply (the V3 seeding flow / factory transient)
        address vault; // HydeFeeVault address (recorded; exempt infra member)
        uint256 maxWalletBps; // maxWallet = TOTAL_SUPPLY * maxWalletBps / 1e4
        uint64 maxWalletWindowSecs; // window length; expiry = now + this
        address[] exemptAddrs; // pool, positionManager, factory, collector, vault, swapRouter, 0
    }

    /// @notice One-time init. Callable exactly once, by the first caller, which is recorded as the
    ///         factory. The factory clones + calls this atomically in one tx (§3 steps 2–4) so there
    ///         is no front-run window on a fresh clone. The factory MUST have `VAULT.register`ed this
    ///         token first (§3 step 3) so the mint-`sync` below is accepted (INV-30).
    function initialize(InitParams calldata p) external {
        require(factory == address(0), "INIT"); // initializer once-guard + onlyFactory (first caller)
        // Config bounds (INV-22): no zero recipients, sane cap/window.
        require(p.poolRecipient != address(0), "ZERO_POOL");
        require(p.vault != address(0), "ZERO_VAULT");
        // Anti-snipe LOCKED: max-wallet 0.01%–3% of supply, window 1s–1h. Neither 0 (disables the
        // guard) nor unbounded (traps holders). INV-22.
        require(p.maxWalletBps > 0 && p.maxWalletBps <= 300, "BPS_RANGE");
        require(p.maxWalletWindowSecs > 0 && p.maxWalletWindowSecs <= 3600, "WINDOW_RANGE");
        factory = msg.sender;

        name = p.name;
        symbol = p.symbol;
        vault = p.vault;

        maxWallet = (TOTAL_SUPPLY * p.maxWalletBps) / 1e4;
        maxWalletExpiry = uint64(block.timestamp) + p.maxWalletWindowSecs;

        // Frozen infra exempt set (max-wallet exemption AND reward-ineligibility).
        for (uint256 i; i < p.exemptAddrs.length; ++i) {
            exempt[p.exemptAddrs[i]] = true;
        }
        exempt[address(0)] = true; // mint sentinel always exempt

        // EIP-712 domain, now that `name` and this clone's address are known.
        _cachedChainId = block.chainid;
        _cachedDomainSeparator = _computeDomainSeparator();

        // Mint 100% of supply into the seeding flow. `poolRecipient` must be in the exempt set
        // (factory guarantees) so neither the cap nor reward-eligibility is affected by the mint.
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

    /// @dev The single transfer path (§2 · rev8). Order: (1) `to==0` reverts (supply constant);
    ///      (2) time-boxed max-wallet on the RECIPIENT only — no from==collector bypass (creator is
    ///      paid WETH, and the collector's only LT outflow is to the `to`-exempt vault, which skips
    ///      the cap without a bypass, INV-17); (3) move balances + emit. (rev8) The vault `sync`
    ///      that preceded max-wallet is REMOVED — enforcement here is byte-for-byte unchanged.
    function _update(address from, address to, uint256 amount) internal {
        require(to != address(0), "ZERO_TO"); // supply constant; no burn-to-zero

        // max-wallet: caps recipient accumulation only, only during the window, never blocks selling
        // (`from` unrestricted), never blocks fee handling (vault is `to`-exempt). Self-contained.
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

    /// @dev Init-only mint (§2 · rev8). Adds the full supply to the exempt seeder. No vault `sync`
    ///      (the reward system is gone). There is NO other supply mutation ever (INV-5).
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
