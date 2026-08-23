# Hydeout Flywheel Vault

The official `FlywheelVault` turns a Flywheel token's 90% trading-fee allocation into time-weighted rewards for people staking that launched token.

## Fee flow

1. Trading fees enter the token's permanent V3 or V4 locker.
2. The locker assigns 90% to its immutable Flywheel receiver, 5% to the creator, and 5% to Hydeout.
3. Anyone calls `pullAllFees()` on the official vault.
4. The vault pulls both fee legs. Launched-token fees always remain launched-token rewards.
5. In native mode, numeraire fees stream unchanged. In selected-reward mode, numeraire fees queue for
   conversion into the creator's immutable reward asset through the currently approved adapter.
6. Anyone can call `convertPending(minimumOutput)` or `claimAll()`; conversion and collection are permissionless.

Keeping launched-token fees native avoids an automatic sell loop against the project token. On Robinhood Chain,
the intended selected-reward catalog is canonical Robinhood Stock Tokens with adequate Uniswap liquidity.

V4 Flywheel launches do not create an additional auto-LP fee bucket. Graduation liquidity remains permanently locked by the existing launcher.

## Launch sequence

1. Choose either native rewards or one factory-approved reward asset. The UI must never accept an arbitrary
   reward-token address.
2. Deploy an official vault through `FlywheelVaultFactory.createVault(...)` with the launcher's locker,
   numeraire, immutable reward choice, creator/controller, reward duration, and a user salt.
3. Call the Trench factory's `launchFlywheel(...)`, supplying the deployed vault as `flywheelRecipient`.
4. The launcher verifies the vault registry, active reward route, controller, fee source, and numeraire, then atomically binds
   and initializes the vault to the newly launched token.
5. Stakers approve the launched token and call `stake(amount)`.

Only vaults deployed by the launcher's configured official `FlywheelVaultFactory` are accepted. Each official
vault and each launched token can be bound exactly once. The one-time initialization verifies on-chain that the
selected locker registered this exact vault as the token's immutable Flywheel receiver. The controller has no
rescue, upgrade, reward-change, allocation, duration-change, or user-withdrawal authority.

## Reward-route policy

Reward selection and swap execution are deliberately separate:

- The creator chooses the reward asset. That choice is immutable for the vault.
- Hydeout's factory owner chooses the audited adapter for each exact `numeraire -> rewardAsset` pair.
- New and replacement adapters have a mandatory two-day on-chain activation delay.
- Unsafe adapters can be disabled immediately. Existing stake, native token rewards, and already-converted
  rewards remain withdrawable while conversion is disabled.
- Replacing an adapter automatically restores conversion for every existing vault using that asset pair;
  vault upgrades or migrations are not required.
- The factory owner is set explicitly at deployment, cannot renounce ownership, and should be a multisig.

A production adapter must use an independent oracle or manipulation-resistant TWAP to produce
`minimumOutput`. A quote read only from the pool being traded is not an acceptable price floor. Router address,
path, fee tier, and oracle inputs belong inside an audited adapter; creators cannot provide arbitrary calldata.

### Chain reward policy

| Chain | Initial creator choice | Converted-reward policy |
| --- | --- | --- |
| Robinhood Chain | Native fees or an approved canonical Stock Token | Uniswap-first; stock must be canonical, active, liquid, oracle-covered, and factory-approved. |
| HyperEVM | Native launch token + canonical WHYPE | No converted rewards initially. A HyperSwap route may be proposed only after a specific asset, pool, and independent oracle are verified. |
| Arbitrum | Native launch token + WETH | No converted catalog initially. |
| Stable | Native launch token + USDT0 | No converted catalog initially. |
| Arc | Native launch token + USDC | Release-gated; no converted catalog. |

The application policy is fail-closed in `src/utils/flywheelRewardPolicy.ts`. It is only presentation metadata:
an option still must have a live `rewardConverterFor(numeraire, rewardAsset)` route in the chain's official
factory. HyperEVM configuration is prepared with chain ID `999` and canonical WHYPE
`0x5555555555555555555555555555555555555555`, but it remains outside the public `NETWORKS` list until the
launcher deployment, live fork, runtime evidence, and release gate pass.

## Anti-sniping behavior

Rewards are streamed over an immutable duration instead of being assigned at the instant fees are pulled. A wallet therefore earns according to stake size and time in the vault, rather than receiving the entire historical fee bucket by entering immediately before a funding transaction.

- Allowed duration: 1 hour to 30 days.
- Recommended UI default: 7 days.
- New funding received during an active stream is queued for a fresh full-duration epoch. It cannot extend or
  compress the active epoch.
- Funding received with no stakers is queued.
- If the last staker exits, the unvested stream pauses and resumes when staking restarts.
- Staking opens only after the launched token's max-wallet protection window expires, so principal
  and token rewards cannot become temporarily trapped by the launch-window transfer limit.

## Safety properties

- Staked principal is accounted separately from rewards, even when the launched token is itself a reward asset.
- Fee pulls and conversions use measured balance deltas; adapter-reported output is not trusted.
- Converter allowance is exact and reset to zero after every successful conversion.
- A caller can make the adapter's oracle minimum stricter but cannot weaken it.
- Pending numeraire is separately accounted and cannot be mistaken for distributable rewards.
- Fees forwarded directly before initialization or outside `pullFees()` are recovered automatically as surplus rewards.
- Direct token donations become rewards and cannot inflate recorded stake principal.
- Withdrawals are always available; there is no creator-controlled lock.
- All external token-moving functions are reentrancy guarded.
- The vault and deployer factory are non-upgradeable.

## Pinned build and deployment

```bash
FOUNDRY_PROFILE=flywheel forge build
FOUNDRY_PROFILE=flywheel forge test
FOUNDRY_PROFILE=flywheel forge script script/flywheel/DeployFlywheelVaultFactory.s.sol --rpc-url "$RPC_URL" --broadcast
```

Required vault-factory deployment environment variables are `EXPECTED_CHAIN_ID`, `EXPECTED_DEPLOYER`, and
`FLYWHEEL_POLICY_OWNER`; optionally set `SENDER` when it is identical to the expected deployer. V3/V4 stack
deployment additionally requires the resulting `FLYWHEEL_VAULT_FACTORY` address.

Before exposing a selected reward in the UI, confirm the canonical token address, active asset status,
oracle/multiplier handling, live liquidity, and jurisdictional product restrictions. Enabling a route is a
two-transaction operation: `proposeRewardRoute(...)`, wait two days, then `activateRewardRoute(...)`.
