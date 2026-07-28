import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("@whetstone-research/doppler-sdk")) return "doppler-sdk";
          if (id.includes("clanker-sdk")) return "clanker-sdk";
          if (
            id.includes("@reown/")
            || id.includes("@walletconnect/")
            || id.includes("@coinbase/")
            || id.includes("@base-org/")
          ) return "wallet-connectors";
          if (id.includes("/wagmi/") || id.includes("/viem/") || id.includes("/ox/")) return "web3";
          if (
            id.includes("/react/")
            || id.includes("/react-dom/")
            || id.includes("/react-router")
            || id.includes("@tanstack/")
          ) return "react-vendor";
          return undefined;
        },
      },
    },
  },
});
