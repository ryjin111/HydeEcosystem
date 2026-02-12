# Hyde (Frontend)

HydeSwap + HydeNFTs frontend with PancakeSwap V1-style UX and Uniswap V4 integration for two testnets:
- Tempo Moderato Testnet (`chainId: 42431`, RPC: `https://rpc.moderato.tempo.xyz`)
- Robinhood Testnet (placeholder RPC in `src/utils/constants.ts`, replace before use)

## Setup

```bash
npm create vite@latest my-pancake-ui -- --template react-ts
cd my-pancake-ui
npm install ethers@5 wagmi viem@2.x tailwindcss postcss autoprefixer react-hot-toast @headlessui/react @heroicons/react react-router-dom @tanstack/react-query
npx tailwindcss init -p
```

Or use this repository directly:

```bash
npm install
npm run dev
```

## Replace Placeholder Contract Addresses

Update per network in `src/utils/constants.ts`:
- `factory`
- `router`
- token addresses
- Robinhood RPC / explorer
 - `V4_CONTRACTS_BY_CHAIN` (`poolManager`, `universalRouter`, `quoter`, `positionManager`, `permit2`)

## MetaMask Network Add Snippet

```ts
await window.ethereum?.request({
  method: "wallet_addEthereumChain",
  params: [
    {
      chainId: "0xA5BF",
      chainName: "Tempo Moderato Testnet",
      rpcUrls: ["https://rpc.moderato.tempo.xyz"],
      nativeCurrency: { name: "USD", symbol: "USD", decimals: 18 },
      blockExplorerUrls: ["https://moderato.tempo.xyz"]
    }
  ]
});
```

## Features Included

- Swap page (token selectors, V4 quoter preview, Universal Router payload execution)
- Add/Remove Liquidity pages (V4 Position Manager multicall payload execution)
- One-click template payload builders for swap and liquidity (auto-fills bytes payloads)
- Connect wallet, selected chain indicator, add-network helper
- Hardcoded faucet tokens plus custom token add
- Responsive layout + toast notifications

## V4 Payload Auto-Builder Config

The UI now auto-builds payloads from form fields, but template encoding must match your deployed periphery.

Edit:
- `src/utils/constants.ts` -> `V4_ENCODING_TEMPLATES`

If your router/position manager expects different argument layouts or command bytes, update these templates.
