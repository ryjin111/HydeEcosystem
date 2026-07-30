# Hydeout V5 Trench Curve release gate

Last verified: 2026-07-30

Status: contract implementation and local/fork verification complete. Arc, Arbitrum, Stable, and Robinhood
V5 stacks were deployed and independently read back on-chain on 2026-07-30. Production UI publication, source
verification, the independent review, and the small-value lifecycle rehearsals remain outstanding.

The deployment JSON files under `deployments/` are authoritative. The historical dry-run section is retained
only to show the pre-audit predictions that were superseded by the mined manifests.

Internal audit update (2026-07-30): `V5_INTERNAL_AUDIT_2026-07-30.md` records one fixed V4 oracle
availability defect and corrected fork-test reporting. Fresh post-fix hook salts and runtime hashes were used
for the mined Arbitrum and Robinhood deployments.

## Supported contract rails

| Chain | Chain ID | Rail | Quote |
| --- | ---: | --- | --- |
| Arc | 5042 | Uniswap V3 | native USDC |
| Stable | 988 | Uniswap V3 | USDT0 |
| Robinhood Chain | 4663 | Uniswap V4 + Hyde hook | WETH |
| Arbitrum One | 42161 | Uniswap V4 + Hyde hook | WETH |

All four rails are deployed. Their dependency and V5 runtime hashes are pinned below. The public app remains
fail-closed unless the verified manifest variables are present in its production build environment.

## Final economic inputs used for simulation

| Rail | Opening FDV | Graduation FDV | Minimum quote proceeds |
| --- | ---: | ---: | ---: |
| Arc V3 | 5,000 USD | 50,000 USD | 12,000 USDC |
| Stable V3 | 5,000 USD | 50,000 USD | 12,000 USDT0 |
| Robinhood / Arbitrum V4 | 1 WETH | 16 WETH | 3 WETH |

Common behavior:

- 1,000,000,000 fixed token supply;
- 80% curve allocation and 20% graduation reserve;
- five-minute graduation delay and mature TWAP requirement;
- V3 fees: 95% creator / 5% Hydeout;
- V4 fees: 90% creator / 5% Hydeout / 5% in-kind auto-LP;
- permanent position NFTs are held by selector-minimal lockers.

## Verification evidence

Pinned compiler profiles:

- V3: Solidity 0.8.24, Cancun, IR, metadata hash disabled;
- V4: Solidity 0.8.26, Cancun, IR, metadata hash disabled.

Passing checks:

- 11 V3 lifecycle/unit/fuzz/selector tests;
- 5 V3 post-graduation invariants, each 256 runs at depth 32 (8,192 handler calls);
- 2 Arc live-fork tests: dependency manifest and full launch-to-permanent-lock lifecycle;
- 2 Stable live-fork tests: dependency manifest and full launch-to-permanent-lock lifecycle;
- 13 V4 lifecycle/unit/fuzz/selector tests;
- 5 V4 post-graduation invariants, each 256 runs at depth 32 (8,192 handler calls);
- 4 V4 live-fork tests: dependency manifests and full production-topology lifecycles on Robinhood
  and Arbitrum;
- 20/20 total V3 pinned-profile tests and 35/35 total V4 pinned-profile tests with fork RPCs enabled;
- both token-order branches and full curve-to-graduation transitions;
- sell-driven progress reversal and stale-signal final-state rechecks on both rails;
- V4 in-kind auto-LP compounding and long-idle oracle interpolation;
- fixed supply, bounded/monotonic progress, fee conservation and claim solvency;
- temporary NFT burn, permanent NFT custody, and non-decreasing permanent liquidity;
- bytecode-size and initcode-size limits;
- zero high-severity `forge lint` findings.

Selector enumeration and direct-call probes confirm that neither permanent locker exposes NFT transfer,
approval, decrease-liquidity, burn, withdrawal, multicall, or arbitrary-execution entrypoints. V4 adds only
TWAP-gated, swap-free `compound(address,uint256)`, which can increase the primary locked position.

## Arc 5042 deployed V5 stack

| Contract | Address | Runtime code hash |
| --- | --- | --- |
| Implementation | `0xCA5C4C7cc97C9aA3ea56B5F3a5c50Eb1c086615b` | `0xce745b5eba4a683f85e250477ced81eb3f04e5ba9a7ed705ef117e2acad6f012` |
| Factory | `0xE79F17Fe61F9c76824D74C496f122f0AB483ec6A` | `0x12a6ffbe4c4caafb5ed334e72d93b85eaa466f367a1547149c8c8796e537feb1` |
| Graduator | `0x94Aaf8D4548D957deB8618fcAb5c21577002036E` | `0x17efcc3e3cb575f546f8ad77d8005c794b24e88762bcf0812e9f8437cd51173e` |
| Locker | `0xE43314319675eF26724a7d4381D95ac31c246d90` | `0xd0e2468f6b8fde8d0d19f89d4f4f3bb665525596e49e94041ffa14c144fd470d` |

Implementation transaction:
`0x5e9c1d6d94e67a6c4cfe2b47d62305a478cf15750758d3f47f36b94d572ba04f` at block 12959698.
Factory transaction:
`0xe2bc5a96d4e6bfaaebfac2b7d1448d73bc45b3a0de01fe6ce85ddc75c4916aec` at block 12959704.

Post-deploy readback matched all four runtime hashes and the factory, implementation, graduator, locker,
owner, treasury, native-USDC, V3 factory, and PositionManager bindings. Both receipts have status 1.
The deployment consumed 0.3379198 native USDC.

### Other deployed V5 stacks

| Chain | Factory | Hook | Stack deployment block | Manifest |
| --- | --- | --- | ---: | --- |
| Arbitrum One | `0x1713FCC00dD51d88B6124419Fac0B8025CC84e6a` | `0xE490d9991Fe22052f820aC5059Cb438a8AC730c0` | 489243637 | `deployments/arbitrum-42161-v5.json` |
| Stable | `0xCf9023b509bf2c1FD53b3FF7Cd9dD5D1E88A5458` | n/a | 33659980 | `deployments/stable-988-v5.json` |
| Robinhood Chain | `0x55957848ECeF5Ef38E527596Fd1E7eB583A46579` | `0x046dEb34ad0785C2bF1d9858D0d47d756FE5b0C0` | 23198932 | `deployments/robinhood-4663-v5.json` |

Each stack has two successful receipts, matched runtime hashes, correct owner and treasury bindings, canonical
DEX dependencies, and an unpaused factory. No token was launched during deployment.

## Live dependency manifests

The fork tests compare every address below byte-for-byte with live runtime code.

### Arc 5042

| Dependency | Address | Runtime code hash |
| --- | --- | --- |
| Native USDC facade | `0x3600000000000000000000000000000000000000` | `0xc9987bd3af6b26a030951faa7eacc017b68343aeedf3ce5fe68f821c4b93939d` |
| V3 factory | `0xf0db7b58379503491d857dB50AC9ece64c653918` | `0x621c4819f7b62d7ddb153206bc30950bcc3f5cc9d24c45661f8c2f31dcbd166d` |
| Position manager | `0x39654A85A4C05127f5Fd6ED22CAeC077A0fB1377` | `0xcad0552151ba7675afe512ebe77fcc6eed68a0cb65775d31e38d44823e6796a0` |
| SwapRouter02 | `0x53bf6b0684ec7ef91e1387da3d1a1769bc5a6f77` | `0xc53680bc70e67f7e8818a0e1302e9b70a4460493bc6dd6db056575b17cb3af25` |
| Quoter V2 | `0x7dfd4f31be6814d2906bde155c3e1b146eac1468` | `0xf222999269407743c526ee7c9d0c9b4fabec26773d48fd6fd257c5ebca976ea7` |

Arc's native-USDC facade calls chain-specific native precompiles that Foundry does not implement.
The manifest test checks the live facade directly; the stateful lifecycle test etches a standard
6-decimal ERC-20 facade at the same address while retaining the live V3 factory, pool, and
PositionManager.

### Stable 988

| Dependency | Address | Runtime code hash |
| --- | --- | --- |
| USDT0 | `0x779Ded0c9e1022225f8E0630b35a9b54bE713736` | `0x4d9be648c5bf39973670d9f8b481d5d0b971e6a2db2deccc6b98cde21c5dd83e` |
| V3 factory | `0x88F0a512eF09175D456bc9547f914f48C013E4aA` | `0x2616b5c05e19fc8931cdf2f08bf47e05a7db6859c23add2c32d226092409e939` |
| Position manager | `0x3BdC3437405f7D801b6036532713fc1F179136a6` | `0x553e7df57c6a17f6d65f05f5c3a3fa41ddaebeca6cf90a0b2b59da3152c41371` |

### Robinhood 4663

| Dependency | Address | Runtime code hash |
| --- | --- | --- |
| PoolManager | `0x8366a39CC670B4001A1121B8F6A443A643e40951` | `0xbd3881180b547f5fe817545743cfb4343e96b1bc6640dcd70c106b0066e95626` |
| PositionManager | `0x58daec3116aae6D93017bAAea7749052E8a04fA7` | `0xc873e135dc9aaec88489cfbad146b4cb49d6a32e0d80326377784b7ba17670b2` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | `0x5208783f52488f7d3493e5e38311ab707c1d75457fe472a19b0b4d57d66a7fca` |
| UniversalRouter | `0x8876789976dEcBfCbBbe364623C63652db8C0904` | `0x2ce6aaaf9f4151f5e1cbf774668772f17f532ae11b15e9284fd0a072a8b0fbde` |
| StateView | `0xF3334192D15450CdD385c8B70e03f9A6bD9E673b` | `0x7d9c591e0956fd89d98feb4ffcfe8bf1f7a62bd485edd979fa21d104b49878a6` |
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` | `0x5706be52f64875fee65a2cec0d80e47a23d8793cbe85d214b48445e2d05f5353` |

### Arbitrum 42161

| Dependency | Address | Runtime code hash |
| --- | --- | --- |
| PoolManager | `0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32` | `0xe4b2759e456c9c4ef763e3b4e257c5105e1ba283d7de8b131dd321197de794a4` |
| PositionManager | `0xd88F38F930b7952f2DB2432Cb002E7abbF3dD869` | `0x6156ddaa1c8cd2c26d37455a5dc57b1761dc2848856426c0ac261ae0c7fecd68` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | `0x9e51dcb64cf56fc09a82cb41edbc17c6a2250f18dbd1b91e884c0aca02acd57c` |
| UniversalRouter | `0xA51afAFe0263b40EdaEf0Df8781eA9aa03E381a3` | `0xc15e8e18812f640245cac34716a18270e3d3288e99b328a410401888ff484720` |
| StateView | `0x76Fd297e2D437cd7f76d50F01AfE6160f86e9990` | `0x4c0e823a0cd44b6b2d9485e774c421cf929db3996096d9b84ee6b23525184b9e` |
| WETH | `0x82aF49447D8a07e3bd95BD0d56f35241523fBab1` | `0x2d240bb4510ed1acfeaba905eb4bcc4524d63c8ae66e48fcccac55ea714db7a7` |

## Historical pre-fix dry-run outputs — superseded

The following entries are retained only as historical evidence. Do not publish their V4 hashes. The final
mined addresses and post-fix hashes are recorded in the authoritative deployment JSON files above.

### Stable

| Contract | Predicted address | Runtime code hash |
| --- | --- | --- |
| Implementation | `0x384951F77BD07bb3eCa992fcffb0AaDF972C2b1f` | `0xce745b5eba4a683f85e250477ced81eb3f04e5ba9a7ed705ef117e2acad6f012` |
| Factory | `0xCf9023b509bf2c1FD53b3FF7Cd9dD5D1E88A5458` | `0x15a6b4f1479e17251779dabc168f975c12561962c4f8eea41116bc407115ca08` |
| Graduator | `0x81d5A6B7433420F7011612771eA74Ef71e239206` | `0x3622e55d835552656aee12bbea6f81255708e757b588a95fdc4360c7d167c564` |
| Locker | `0x6422E1C4F696C17BA740595C17F6355496492751` | `0x50640fd8908094ba882f305abd8b80e5d28c03318b55ea2137de72dde39193b6` |

Expected terminal proceeds: 12,620.500222 USDT0. Estimated deployment cost: 0.021965972010982986
native gas token.

### Robinhood

| Contract | Predicted address | Runtime code hash |
| --- | --- | --- |
| Coordinator | `0xD38544b02Ac2f127445613610B85C13689813Ceb` | deployment-only |
| Implementation | `0xfeE7a8C364770c6615083348a08d209Ef7B8b27A` | `0xb963d4d054241cb40f5bd81fe7c7d274fe607a009059780e8a9f1399704c4de9` |
| Hook | `0xA3bEC2F687e9586C517a2Ed4e0587b8C040cB0c0` | `0xc975eb72e09ef3e62c7fe53cb3e284483f4bbf74a99b14c75cda086116ae1e00` |
| Factory | `0x55957848ECeF5Ef38E527596Fd1E7eB583A46579` | `0x52e6bbfdcfdd2c72ce09a147db0cacea60a9b3a0d218684bd30ed755638f62d3` |
| Graduator | `0xa5dC3CD280592abD9237C83Ce296a8504031F378` | `0x45f3a668c0aff266d9ccfba165fb07999728a69a3ec142ef4ad2e4576c73fd89` |
| Locker | `0x1016A8fEd8da59f6A8542c8886f4b4e2A94eBf3f` | `0x119d21a1944d1923202cf8cf34cc646a0e6064bc578cc84e16abab99e7d7fde9` |

Expected terminal proceeds: 3.199802602476988727 WETH. Estimated deployment cost:
0.000736561247179978 native gas token.

### Arbitrum

| Contract | Predicted address | Runtime code hash |
| --- | --- | --- |
| Coordinator | `0x144Ee4A0B605B038F085518231A414b0BD00ef23` | deployment-only |
| Implementation | `0xaa0069e82F616e60B0376f569F75b5B2114Fd6EE` | `0xb963d4d054241cb40f5bd81fe7c7d274fe607a009059780e8a9f1399704c4de9` |
| Hook | `0x6DFC6CB3d3CF81f5e2bcc6311f3705dfFbA0F0c0` | `0xb58cf3f857cde40fbb052bebd696ddeafb5dae6565f46076e6e8459dcec0a7f8` |
| Factory | `0x1713FCC00dD51d88B6124419Fac0B8025CC84e6a` | `0x8a8313b5d5ec720d90ae39374e301814862e8928ef658262aa1ebbf5e60536a2` |
| Graduator | `0x159A616E885955F5463D70E4807d1D71568d76AC` | `0x8d24e04f667d83c784f754801ff4e8cf313e5fb6b6616d369a191399f33de5e9` |
| Locker | `0x08610aE598a24799e1843C683695B0Fc63b1bd6f` | `0xee6952b57458a0352ac16cfc26fba75bc774dfe3eabaad1e43bf44e64338a4b8` |

Expected terminal proceeds: 3.199802602476988727 WETH. Estimated deployment cost:
0.000091036672879918 ETH.

## Remaining mandatory gates

1. Independent security review of the final commit and compiler artifacts.
2. Small-value mainnet rehearsal on each rail:
   launch, buy to terminal, signal, wait for the full TWAP/delay, finalize, verify every NFT and balance,
   harvest fees, claim creator/Hyde shares, and exercise V4 auto-LP compounding.
3. Submit and confirm explorer source verification for the mined contracts.
4. Publish the verified manifest variables in the production UI environment and deploy the UI without
   removing legacy discovery, trading, or claims.
