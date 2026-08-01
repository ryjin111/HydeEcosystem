# Hydeout V5 indexer

Persistent [Ponder](https://ponder.sh/) indexer and read API for Hydeout V5 launches on Stable, Arbitrum One, and Robinhood Chain.

The service backfills factory, graduation, and creator-fee events into Postgres. API responses combine those indexed records with one live multicall per request for current curve progress and claimable creator fees. The frontend prefers this API and automatically falls back to direct RPC discovery if the service is unset or temporarily unavailable.

## Local development

Requires Node.js 22 or newer and PostgreSQL.

```bash
cd indexer
cp .env.example .env.local
npm ci
npm run codegen
npm run typecheck
npm run dev
```

Edit `.env.local` with a working `DATABASE_URL` and production-quality RPC URLs. Public RPC fallbacks are included for convenience, but they can be rate-limited during a full backfill.

## API

All public application routes are read-only and allow cross-origin GET requests.

| Route | Purpose |
|---|---|
| `GET /v1/status` | Supported chains and indexed launch counts. |
| `GET /v1/launches?chainId=4663&limit=60` | Newest launches for one chain. Optional `creator=0x...`. |
| `GET /v1/launches/:chainId/:token` | One indexed launch with current progress and claimable fees. |
| `GET /ready` | Ponder readiness endpoint used by the host. |

List and detail responses have a five-second application/CDN cache. The API caps list requests at 100 launches.

## Deploy on Railway

1. Create a Railway service from this GitHub repository.
2. Set its **Root Directory** to `/indexer`. Railway will then pick up `indexer/railway.json`.
3. Add a PostgreSQL database to the project and reference its `DATABASE_URL` from the indexer service.
4. Add `PONDER_RPC_URL_988`, `PONDER_RPC_URL_42161`, and `PONDER_RPC_URL_4663` to the service variables.
5. Generate a public domain for the service. The checked-in config starts Ponder with a deployment-specific schema and waits up to one hour for `/ready`, which lets the initial backfill finish before Railway switches traffic.
6. Verify `https://<domain>/v1/status`.
7. In Vercel, set `VITE_V5_INDEXER_URL=https://<domain>` for Preview and Production, then redeploy the frontend.

Do not add a trailing path to `VITE_V5_INDEXER_URL`; the frontend appends `/v1/...` itself. If the variable is missing, malformed, or the request exceeds four seconds, the UI continues using its existing direct-RPC path.

## Indexed deployments

Addresses and deployment start blocks live in `src/chains.ts`; contract sources are defined in `ponder.config.ts`. When a new V5 stack is deployed, add its chain configuration there and add the matching frontend registry entry before enabling it in the UI.
