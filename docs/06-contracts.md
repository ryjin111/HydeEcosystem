# Live contracts & addresses

All addresses are on **Robinhood Chain 4663** (`rpc.mainnet.chain.robinhood.com`, explorer `robinhoodchain.blockscout.com`). Deployed 2026-07-21.

## WETH stack

| Contract | Address |
|---|---|
| **Factory** (launch here) | `0x710fEa288266518528A4230771E07ee310ce509f` |
| Fee Vault | `0x04C204C264626Ad0067ac4317D54598286d2D791` |
| Fee Collector | `0xf36c173E0916057A72CAbd7857aE665742755674` |
| Hook | `0xDaae8D1cC582D842304A98C9054E408f5e9730c0` |
| Coordinator (deploy, finalized) | `0xCA5C4C7cc97C9aA3ea56B5F3a5c50Eb1c086615b` |
| Base token (WETH) | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |

## HOODIE launcher-launcher stack

| Contract | Address |
|---|---|
| **Meta-factory** (create your launcher here) | `0x101Fe0c0328De00F6F6f928B79d512E899fE2fC0` |
| Launch Engine (shared backend) | `0x8062951c99CfFA5365f979D5139Cf96b5c77CFCc` |
| Launcher implementation | `0x1713FCC00dD51d88B6124419Fac0B8025CC84e6a` |
| Fee Vault | `0x1ee72dCb5a18ddcC069e4E604Ba59ac5a0930DB4` |
| Fee Collector | `0x08610aE598a24799e1843C683695B0Fc63b1bd6f` |
| Hook | `0x41078B0012751e7E646DF9B6607e6C4fF8B570C0` |
| Token implementation | `0xaa0069e82F616e60B0376f569F75b5B2114Fd6EE` |
| Coordinator (deploy, finalized) | `0x144Ee4A0B605B038F085518231A414b0BD00ef23` |
| Base token ($HOODIE) | `0xC72c01AAB5f5678dc1d6f5C6d2B417d91D402Ba3` |

## Roles

| Role | Address |
|---|---|
| Owner (pause/unpause new launches + transfer/renounce ownership only — no fee/preset config, no power over live tokens) | `0x800557e7882b42ee49594fa2790300A9697a0e4D` |
| Treasury (Hyde + launch fee) | `0x3132c30135BC13BFbFa75523Ec96A746E5B7Ddb3` |

## Uniswap V4 core (canonical, on 4663)

| Contract | Address |
|---|---|
| PoolManager | `0x8366a39CC670B4001A1121B8F6A443A643e40951` |
| PositionManager | `0x58daec3116aae6D93017bAAea7749052E8a04fA7` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| UniversalRouter | `0x8876789976dEcBfCbBbe364623C63652db8C0904` |
| StateView | `0xF3334192D15450CdD385c8B70e03f9A6bD9E673b` |
| V4Quoter | `0x7232686FC954f12079cadFC5e9F755a9fEAeb3Ca` |
