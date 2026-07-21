# Verify on-chain

Everything Hydeout claims is checkable directly on-chain. You don't have to trust the docs — read the contracts.

## Quick checks with `cast`

Point at the 4663 RPC:

```bash
RPC=https://rpc.mainnet.chain.robinhood.com
```

**The WETH factory is wired correctly:**

```bash
cast call 0x710fEa288266518528A4230771E07ee310ce509f 'WETH()(address)' --rpc-url $RPC
# → 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73  (real WETH)

cast call 0x710fEa288266518528A4230771E07ee310ce509f 'launchFeeAmount()(uint256)' --rpc-url $RPC
# → 400000000000000  (0.0004 ETH)

cast call 0x710fEa288266518528A4230771E07ee310ce509f 'owner()(address)' --rpc-url $RPC
# → 0x800557e7882b42ee49594fa2790300A9697a0e4D
```

**The vault / collector / hook all point back to the factory:**

```bash
cast call 0x04C204C264626Ad0067ac4317D54598286d2D791 'factory()(address)' --rpc-url $RPC
cast call 0xf36c173E0916057A72CAbd7857aE665742755674 'factory()(address)' --rpc-url $RPC
cast call 0xDaae8D1cC582D842304A98C9054E408f5e9730c0 'factory()(address)' --rpc-url $RPC
# → all three return 0x710fEa288266518528A4230771E07ee310ce509f
```

**The HOODIE engine is HOODIE-based and correctly wired:**

```bash
cast call 0x8062951c99CfFA5365f979D5139Cf96b5c77CFCc 'WETH()(address)' --rpc-url $RPC
# → 0xC72c01AAB5f5678dc1d6f5C6d2B417d91D402Ba3  (HOODIE is the base)

cast call 0x8062951c99CfFA5365f979D5139Cf96b5c77CFCc 'META_FACTORY()(address)' --rpc-url $RPC
# → 0x101Fe0c0328De00F6F6f928B79d512E899fE2fC0

cast call 0x101Fe0c0328De00F6F6f928B79d512E899fE2fC0 'ENGINE()(address)' --rpc-url $RPC
# → 0x8062951c99CfFA5365f979D5139Cf96b5c77CFCc
```

## Explorer

Browse any contract at `https://robinhoodchain.blockscout.com/address/<address>`. Launched tokens are EIP-1167 minimal proxies of the token implementation — a verification badge resolves via the proxy's verified implementation.

## Source

The contract sources and deploy drivers live in the repo (`origin/main`): WETH stack at commit `ec283a1`, HOODIE stack at `8fc931f`.
