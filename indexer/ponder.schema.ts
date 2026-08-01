import { index, onchainTable, primaryKey } from "ponder";

export const launch = onchainTable(
  "launch",
  (t) => ({
    chainId: t.integer().notNull(),
    token: t.hex().notNull(),
    creator: t.hex().notNull(),
    poolAddress: t.hex(),
    poolId: t.hex(),
    name: t.text().notNull(),
    symbol: t.text().notNull(),
    decimals: t.integer().notNull(),
    engine: t.text().notNull(),
    numeraire: t.hex().notNull(),
    quoteSymbol: t.text().notNull(),
    quoteDecimals: t.integer().notNull(),
    curveState: t.text().notNull(),
    progressWad: t.bigint().notNull(),
    sold: t.bigint().notNull(),
    curveAllocation: t.bigint().notNull(),
    quotePrincipal: t.bigint().notNull(),
    minimumProceeds: t.bigint().notNull(),
    signaledAt: t.bigint().notNull(),
    finalizableAt: t.bigint().notNull(),
    creatorClaimableToken: t.bigint().notNull(),
    creatorClaimableNumeraire: t.bigint().notNull(),
    createdAt: t.bigint().notNull(),
    createdBlock: t.bigint().notNull(),
    createdTransaction: t.hex().notNull(),
    lastUpdatedBlock: t.bigint().notNull(),
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.chainId, table.token] }),
    chainCreatedIdx: index("launch_chain_created_idx").on(table.chainId, table.createdBlock),
    creatorIdx: index("launch_creator_idx").on(table.creator),
  }),
);

export const creatorFeeEvent = onchainTable(
  "creator_fee_event",
  (t) => ({
    id: t.text().primaryKey(),
    chainId: t.integer().notNull(),
    token: t.hex().notNull(),
    asset: t.hex().notNull(),
    creator: t.hex().notNull(),
    kind: t.text().notNull(),
    amount: t.bigint().notNull(),
    blockNumber: t.bigint().notNull(),
    timestamp: t.bigint().notNull(),
    transactionHash: t.hex().notNull(),
  }),
  (table) => ({
    tokenIdx: index("creator_fee_token_idx").on(table.chainId, table.token),
    creatorIdx: index("creator_fee_creator_idx").on(table.creator),
  }),
);
