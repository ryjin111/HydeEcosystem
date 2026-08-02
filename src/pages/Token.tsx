// Token / trade page (Wave A screen 2) — HYDEOUT_DESIGN_SPEC §2.B. Real feed via
// useHydeLaunches (honest 404 if not on the board). Chart = real DEXScreener
// embed when the token has a robinhood/uniswap pair, else a designed full-size
// fallback (never a collapsed hole). Swap = the EXISTING verified V4SwapCard
// (reskin/reuse only — no trade-logic change). Top holders via Blockscout, fail
// neutral. Restrictions copy = 3%→1% anti-snipe decay ONLY. No protocol touched.
import { useEffect, useMemo, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useAccount, usePublicClient } from "wagmi";
import { formatUnits } from "viem";
import {
  ArrowTopRightOnSquareIcon,
  ArrowsRightLeftIcon,
  SignalIcon,
  UserGroupIcon,
} from "@heroicons/react/24/outline";
import type { NetworkConfig, TokenInfo } from "../utils/constants";
import {
  ARBITRUM_MAINNET,
  isGatewayLive,
  NETWORKS,
  ROBINHOOD_MAINNET,
  STABLE_MAINNET,
  V4_CONTRACTS_BY_CHAIN,
} from "../utils/constants";
import { WETH_CONTAINMENT } from "../utils/containment";
import { useHydeLaunches, useHydeToken } from "../hooks/useDopplerTokens";
import {
  useGeckoPoolActivity,
  type GeckoCandle,
  type GeckoRange,
} from "../hooks/useGeckoPoolActivity";
import { useTokenActivity } from "../hooks/useTokenActivity";
import { useTokenPosition } from "../hooks/useTokenPosition";
import { V4SwapCard } from "../components/V4SwapCard";
import { HoodieSwapCard } from "../components/HoodieSwapCard";
import { StableV3SwapCard } from "../components/StableV3SwapCard";
import { StableV3FeeCollector } from "../components/StableV3FeeCollector";
import { TrenchV5FeeCollector } from "../components/TrenchV5FeeCollector";
import { TrenchV5V4SwapCard } from "../components/TrenchV5V4SwapCard";
import { YourPositionCard } from "../components/YourPositionCard";
import { TokenImage } from "../components/TokenImage";
import { LaunchMetadataEditor } from "../components/LaunchMetadataEditor";
import { fetchLaunchMeta, type LaunchMeta } from "../utils/launchMeta";
import { chainV3Capability, ENGINE_META, v3ChainRow } from "../utils/chainRegistry";
import { protocolVersionOf } from "../utils/dopplerConfig";
import { trenchV5Manifest } from "../utils/trenchV5";
import { Card, Button, Stat, SectionLabel } from "../components/ui/kit";

type Props = { network: NetworkConfig; tokens: TokenInfo[]; onAddCustomToken: (t: { address: `0x${string}`; symbol: string; name: string; decimals: number }) => void };

// DEXScreener / GeckoTerminal / Blockscout below index Robinhood MAINNET only. On any other chain
// (e.g. the 46630 testnet own-stack) they must NOT run — a same-looking address could otherwise
// surface a mainnet pair/chart/holders and even mark a testnet token "Graduated" (kami A-blocker #2).
const ROBINHOOD_MAINNET_ID = 4663;

type LiveDexMarket = {
  pair: string | null;
  priceUsd: number | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  volumeUsd: number | null;
  checked: boolean;
};

// Resolve a fresh DEXScreener market snapshot independently from the launch-list
// cache. This lets a newly traded pool show price immediately.
function useDexPair(address?: string, chainId?: number): LiveDexMarket {
  const [pair, setPair] = useState<string | null>(null);
  const [market, setMarket] = useState<Omit<LiveDexMarket, "pair" | "checked">>({
    priceUsd: null,
    marketCapUsd: null,
    liquidityUsd: null,
    volumeUsd: null,
  });
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    setChecked(false);
    setPair(null);
    setMarket({ priceUsd: null, marketCapUsd: null, liquidityUsd: null, volumeUsd: null });
    if (!address || chainId !== ROBINHOOD_MAINNET_ID) { setChecked(true); return; } // mainnet-only source
    let cancelled = false;
    fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        // DEXScreener's priceUsd belongs to baseToken, so require the requested
        // token to be the base before accepting the number.
        type Pair = {
          chainId?: string;
          dexId?: string;
          pairAddress?: string;
          baseToken?: { address?: string };
          priceUsd?: string;
          marketCap?: number;
          fdv?: number;
          liquidity?: { usd?: number };
          volume?: { h24?: number };
        };
        const cands: Pair[] = (d?.pairs ?? []).filter((x: Pair) => (
          x.chainId === "robinhood"
          && x.dexId === "uniswap"
          && x.baseToken?.address?.toLowerCase() === address.toLowerCase()
        ));
        cands.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
        const best = cands[0];
        if (!cancelled) {
          setPair(best?.pairAddress ?? null);
          setMarket({
            priceUsd: best?.priceUsd != null ? Number(best.priceUsd) : null,
            marketCapUsd: best?.marketCap ?? best?.fdv ?? null,
            liquidityUsd: best?.liquidity?.usd ?? null,
            volumeUsd: best?.volume?.h24 ?? null,
          });
          setChecked(true);
        }
      })
      .catch(() => { if (!cancelled) setChecked(true); });
    return () => { cancelled = true; };
  }, [address, chainId]);
  return { pair, ...market, checked };
}

/** Compact USD for MCAP/volume/liquidity — only called with a real number ≥ ~1. */
function fmtUsd(n: number): string {
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toLocaleString("en-US", { maximumSignificantDigits: 3 })}`;
}

/** Token price — compact so it never overflows its column (shiro layout-break fix). Micro-cap
 *  prices use the DEX subscript-zero convention ($0.0₆204 = 0.000000204), not a long decimal that
 *  collided with the next stat, and never scientific notation. */
const SUBSCRIPT = "₀₁₂₃₄₅₆₇₈₉";
const subNum = (k: number): string => String(k).split("").map((d) => SUBSCRIPT[+d]).join("");
function fmtPrice(n: number): string {
  if (n >= 1) return `$${n.toLocaleString("en-US", { maximumFractionDigits: 4 })}`;
  if (n >= 0.0001) return `$${parseFloat(n.toPrecision(4))}`;
  const exp = Math.floor(Math.log10(n)); // negative
  const zeros = -exp - 1;                // leading zeros after the decimal point
  const sig = String(Math.round((n / Math.pow(10, exp)) * 100) / 100).replace(".", ""); // 3 sig figs
  return `$0.0${subNum(zeros)}${sig}`;
}

const short = (a: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");

function fmtTokenAmount(value: string, decimals: number): string {
  try {
    const amount = Number(formatUnits(BigInt(value), decimals));
    if (!Number.isFinite(amount)) return "—";
    if (amount >= 1_000_000) return `${(amount / 1_000_000).toFixed(amount >= 10_000_000 ? 1 : 2)}M`;
    if (amount >= 1_000) return `${(amount / 1_000).toFixed(amount >= 100_000 ? 1 : 2)}K`;
    return amount.toLocaleString("en-US", { maximumFractionDigits: amount < 1 ? 4 : 2 });
  } catch {
    return "—";
  }
}

type HolderKind = "curve" | "lp" | "locker" | "contract" | "wallet" | "address";
type HolderIdentity = { kind: HolderKind; badge: string; detail: string };

function useContractHolderAddresses(addresses: string[], chainId: number): { contracts: Set<string>; checked: boolean } {
  const publicClient = usePublicClient({ chainId });
  const [state, setState] = useState<{ contracts: Set<string>; checked: boolean }>({
    contracts: new Set(),
    checked: false,
  });
  const key = addresses.map((address) => address.toLowerCase()).sort().join(",");
  useEffect(() => {
    let cancelled = false;
    setState({ contracts: new Set(), checked: false });
    if (!publicClient || addresses.length === 0) {
      setState({ contracts: new Set(), checked: true });
      return;
    }
    Promise.all(addresses.map(async (address) => {
      try {
        const code = await publicClient.getBytecode({ address: address as `0x${string}` });
        return code && code !== "0x" ? address.toLowerCase() : null;
      } catch {
        return null;
      }
    })).then((results) => {
      if (!cancelled) setState({ contracts: new Set(results.filter((value): value is string => !!value)), checked: true });
    });
    return () => { cancelled = true; };
    // `key` is the stable identity of the ranked address set; depending on the array itself would rescan each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chainId, key, publicClient]);
  return state;
}

function holderIdentity(
  address: string,
  known: Map<string, HolderIdentity>,
  contractAddresses: Set<string>,
  contractsChecked: boolean,
  networkName: string,
): HolderIdentity {
  const normalized = address.toLowerCase();
  const protocolIdentity = known.get(normalized);
  if (protocolIdentity) return protocolIdentity;
  if (contractAddresses.has(normalized)) {
    return { kind: "contract", badge: "CONTRACT", detail: "Smart contract balance · not a wallet" };
  }
  if (!contractsChecked) return { kind: "address", badge: "ADDRESS", detail: "Checking address type on-chain" };
  return { kind: "wallet", badge: "WALLET", detail: `Wallet on ${networkName}` };
}

function timeAgo(iso: string): string | null {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t) || new Date(iso).getUTCFullYear() <= 2020) return null; // unindexed create time → omit
  const m = Math.floor((Date.now() - t) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
// Own-stack Hyde launches are a fixed 1,000,000,000 supply (protocol constant — not fabricated).
function buildChartGeometry(candles: GeckoCandle[]) {
  const width = 800;
  const height = 220;
  const xPad = 18;
  const yPad = 18;
  const chartBottom = 174;
  if (candles.length === 0) return null;
  const min = Math.min(...candles.map((candle) => candle.low));
  const max = Math.max(...candles.map((candle) => candle.high));
  const spread = Math.max(max - min, Math.max(max, 1) * 0.002);
  const point = (candle: GeckoCandle, index: number) => {
    const x = candles.length === 1
      ? width / 2
      : xPad + (index / (candles.length - 1)) * (width - xPad * 2);
    const y = yPad + ((max - candle.close) / spread) * (chartBottom - yPad);
    return { x, y };
  };
  const points = candles.map(point);
  const line = points.map(({ x, y }, index) => `${index === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
  const area = `${line} L${points[points.length - 1]?.x ?? width - xPad},${chartBottom} L${points[0]?.x ?? xPad},${chartBottom} Z`;
  const maxVolume = Math.max(...candles.map((candle) => candle.volumeUsd), 1);
  const barWidth = Math.max(2, Math.min(16, (width - xPad * 2) / Math.max(candles.length, 1) - 3));
  const volumes = candles.map((candle, index) => {
    const { x } = point(candle, index);
    const barHeight = Math.max(1.5, (candle.volumeUsd / maxVolume) * 28);
    return { x: x - barWidth / 2, y: height - 10 - barHeight, width: barWidth, height: barHeight };
  });
  return { width, height, line, area, min, max, volumes };
}

function fmtCompactToken(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  return n.toLocaleString("en-US", { maximumFractionDigits: n < 1 ? 4 : 2 });
}

const OWN_STACK_SUPPLY = "1,000,000,000";

/**
 * TokenDetail — the full token-detail layout rendered by the canonical /token/:address route.
 * Legacy /swap?out links redirect here, and the trade widget stays embedded beside token data.
 */
export function TokenDetail({ address, network, tokens, onAddCustomToken }: Props & { address: string }) {
  // Chain-scoped to the active network (clint #4): testnet and mainnet each read only their configured
  // own-stack launch sources — never cross-chain data.
  const { pools } = useHydeLaunches(network.id);
  const liveMarket = useDexPair(address, network.id);
  const { pair } = liveMarket;
  const [copied, setCopied] = useState(false);
  const [feedTab, setFeedTab] = useState<"trades" | "holders">("trades"); // coin-mockup: Trades/Holders tabs
  const [chartRange, setChartRange] = useState<GeckoRange>("24h");
  // Off-chain metadata (own-stack tokens store no tokenURI) — fetched by (chain, address); fail-neutral.
  const [meta, setMeta] = useState<LaunchMeta | null>(null);
  useEffect(() => {
    let cancelled = false;
    setMeta(null);
    if (address) fetchLaunchMeta(network.id, address).then((m) => { if (!cancelled) setMeta(m); });
    return () => { cancelled = true; };
  }, [address, network.id]);

  // Prefer the board pool (richer: precise graduation %); else read the token
  // directly by address so launches OUTSIDE the newest-60 page still render.
  const boardPool = useMemo(() => pools.find((p) => p.address.toLowerCase() === address.toLowerCase()), [pools, address]);
  // Resolve both live launch rails explicitly. The selected chain stays the
  // authority for actions; another-chain result only powers a safe notice.
  const selectedLookup = useHydeToken(address, network.id);
  const searchOtherChains = !selectedLookup.loading && !selectedLookup.pool && !selectedLookup.error;
  const robinhoodLookup = useHydeToken(
    address,
    ROBINHOOD_MAINNET.id,
    searchOtherChains && network.id !== ROBINHOOD_MAINNET.id,
  );
  const stableLookup = useHydeToken(
    address,
    STABLE_MAINNET.id,
    searchOtherChains && network.id !== STABLE_MAINNET.id,
  );
  const arbitrumLookup = useHydeToken(
    address,
    ARBITRUM_MAINNET.id,
    searchOtherChains && network.id !== ARBITRUM_MAINNET.id,
  );
  const fetchedPool = selectedLookup.pool;
  const pool = boardPool ?? fetchedPool;
  const geckoPoolAddress = pool?.poolAddress ?? pool?.poolId ?? pair;
  const gecko = useGeckoPoolActivity(network.id, geckoPoolAddress, address, chartRange);
  const activity = useTokenActivity({
    chainId: network.id,
    token: pool?.address,
    quote: pool?.quoteToken.address,
    poolId: pool?.poolId,
    tokenDecimals: pool?.baseToken.decimals,
    quoteDecimals: pool?.quoteToken.decimals,
  });
  const activityTrades = activity.trades.length > 0 ? activity.trades : gecko.trades;
  const tradesLoading = activityTrades.length === 0 && (activity.loading || gecko.loading);
  const holderAddresses = useMemo(
    () => activity.holders.map((holder) => holder.address),
    [activity.holders],
  );
  const contractHolderScan = useContractHolderAddresses(holderAddresses, network.id);
  const wrongChainPool = pool || selectedLookup.loading
    ? null
    : [robinhoodLookup.pool, stableLookup.pool, arbitrumLookup.pool]
      .find((candidate) => candidate && candidate.chainId !== network.id) ?? null;
  const locatingToken = !pool && !wrongChainPool && (
    selectedLookup.loading
    || (searchOtherChains && (robinhoodLookup.loading || stableLookup.loading || arbitrumLookup.loading))
  );
  const tokenError = selectedLookup.error;

  // HOODIE-numeraire own-stack pool → live in-app Buy/Sell + per-wallet PnL via the canonical UniversalRouter
  // (the Hyde gateway isn't deployed on 4663). Detected by the pool's quote token matching the configured
  // $HOODIE numeraire — inherently mainnet-only (only 4663 has `hoodieNumeraire` set). WETH pairs keep the
  // gateway-gated / reference-only rail below, untouched. Computed (+ position hook called) BEFORE the early
  // returns so hook order stays stable; `pool?` guards the still-loading case.
  const hoodieNumeraire = V4_CONTRACTS_BY_CHAIN[network.id]?.hoodieNumeraire;
  const isHoodiePair = !!hoodieNumeraire && pool?.quoteToken?.address?.toLowerCase() === hoodieNumeraire.toLowerCase();
  const { address: walletAddress, isConnected } = useAccount();
  const { position, error: positionError } = useTokenPosition(pool?.address ?? "", network.id, isHoodiePair);

  if (locatingToken && !boardPool) {
    return (
      <div className="hyde-page hyde-token mx-auto w-full max-w-[1200px]" data-depth-label="Token depth · on-chain signal">
        <div className="py-12 text-center text-pcs-textSub">Loading token…</div>
      </div>
    );
  }
  if (wrongChainPool) {
    const actualNetwork = NETWORKS.find((candidate) => candidate.id === wrongChainPool.chainId);
    const actualName = actualNetwork?.name ?? `Chain ${wrongChainPool.chainId}`;
    const actualEngine = ENGINE_META[wrongChainPool.launchEngine];
    return (
      <div className="hyde-page hyde-token mx-auto w-full max-w-[1200px]" data-depth-label="Token depth · chain signal">
        <Card variant="panel" className="mx-auto max-w-xl text-center" data-testid="wrong-chain-token">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl border border-pcs-primary/25 bg-pcs-primary/[0.08] font-display text-lg font-bold text-pcs-primary">
            {wrongChainPool.baseToken.symbol.slice(0, 1)}
          </div>
          <p className="mt-4 font-display text-xl font-semibold text-pcs-text">
            {wrongChainPool.baseToken.name} lives on {actualName}.
          </p>
          <p className="mt-2 text-sm leading-6 text-pcs-textSub">
            You’re currently viewing {network.name}. Hydeout keeps price, trade, position, and fee
            reads chain-scoped so the wrong network can never show misleading token data.
          </p>
          <div className="mx-auto mt-4 flex w-fit flex-wrap justify-center gap-2">
            <span className="rounded-md border border-pcs-primary/25 bg-pcs-primary/[0.06] px-2 py-1 font-code text-[10px] text-pcs-primary">
              {actualEngine.title}
            </span>
            <span className="rounded-md border border-pcs-border px-2 py-1 font-code text-[10px] text-pcs-textSub">
              {actualEngine.feeSplitLabel}
            </span>
          </div>
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            <Link to={`/token/${address}?network=${wrongChainPool.chainId}`}>
              <Button variant="primary">View on {actualName}</Button>
            </Link>
            <Link to="/discover"><Button variant="secondary">Back to Discover</Button></Link>
          </div>
        </Card>
      </div>
    );
  }
  if (tokenError && !boardPool) {
    return (
      <div className="hyde-page hyde-token mx-auto w-full max-w-[1200px]" data-depth-label="Token depth · on-chain signal">
        <Card variant="panel" className="mx-auto max-w-lg text-center">
          <p className="py-5 text-pcs-textSub">Token data is temporarily unavailable.</p>
          <Link to="/discover"><Button variant="secondary">Back to Discover</Button></Link>
        </Card>
      </div>
    );
  }
  if (!pool) {
    return (
      <div className="hyde-page hyde-token mx-auto w-full max-w-[1200px]" data-depth-label="Token depth · on-chain signal">
        <Card variant="panel" className="mx-auto max-w-lg text-center">
          <p className="py-5 text-pcs-textSub">This isn’t a Hydeout launch token.</p>
          <Link to="/discover"><Button variant="secondary">Back to Discover</Button></Link>
        </Card>
      </div>
    );
  }

  const sym = pool.baseToken.symbol || "?";
  const engineMeta = ENGINE_META[pool.launchEngine];
  const isV4Launch = pool.launchEngine === "v4-hook";
  const isV5 = protocolVersionOf(pool) === "v5-trench";
  const curveState = pool.curveState ?? "curve-active";
  const knownHolderIdentities = new Map<string, HolderIdentity>();
  const addKnownHolder = (holderAddress: string | null | undefined, identity: HolderIdentity) => {
    if (holderAddress && !/^0x0{40}$/i.test(holderAddress)) {
      knownHolderIdentities.set(holderAddress.toLowerCase(), identity);
    }
  };
  const liquidityIdentity: HolderIdentity = isV5 && curveState !== "graduated"
    ? { kind: "curve", badge: "CURVE", detail: "Bonding-curve liquidity · protocol custody" }
    : { kind: "lp", badge: "LP", detail: "Locked liquidity · not a whale wallet" };
  addKnownHolder(pool.poolAddress, liquidityIdentity);
  addKnownHolder(V4_CONTRACTS_BY_CHAIN[network.id]?.poolManager, liquidityIdentity);
  addKnownHolder(pool.address, { kind: "contract", badge: "TOKEN", detail: "Token contract balance" });
  const v3System = v3ChainRow(network.id)?.launchpad;
  addKnownHolder(v3System?.locker, { kind: "locker", badge: "LOCKER", detail: "Protocol liquidity locker" });
  addKnownHolder(v3System?.pad, { kind: "contract", badge: "LAUNCH", detail: "Hyde launch contract" });
  const v4System = V4_CONTRACTS_BY_CHAIN[network.id];
  addKnownHolder(v4System?.positionManager, { kind: "contract", badge: "POSITION", detail: "Uniswap position manager" });
  addKnownHolder(v4System?.hydeTokenFactory, { kind: "contract", badge: "LAUNCH", detail: "Hyde launch factory" });
  addKnownHolder(v4System?.hoodieEngine, { kind: "contract", badge: "LAUNCH", detail: "Hyde launch engine" });
  addKnownHolder(v4System?.hydeHook, { kind: "contract", badge: "HOOK", detail: "Hyde pool hook" });
  addKnownHolder(v4System?.hoodieHook, { kind: "contract", badge: "HOOK", detail: "Hyde pool hook" });
  addKnownHolder(trenchV5Manifest(network.id)?.factory, { kind: "contract", badge: "LAUNCH", detail: "V5 launch factory" });
  const curveProgress = Math.max(0, Math.min(100, pool.progress ?? 0));
  const curveStatusLabel = curveState === "graduated"
    ? "GRADUATED · LP LOCKED"
    : curveState === "graduation-signaled"
      ? "GRADUATION QUEUED"
      : `CURVE LIVE · ${curveProgress.toFixed(curveProgress >= 10 ? 1 : 2)}% FILLED`;
  const stableV3SwapReady = chainV3Capability(network.id)?.trade?.engine === "v3-single-sided";
  // WETH-only containment (kami 24019): a non-HOODIE (WETH-paired) token while WETH_CONTAINMENT is active.
  // Its chart/Trades empty-states must NOT claim "trading is live on-chain" (contradicts the amber pause card),
  // and the green LIVE badge is swapped for a paused one. HOODIE pages keep the live copy unchanged.
  const wethContained = isV4Launch && !isHoodiePair && WETH_CONTAINMENT.active;
  const creatorAddr = (pool as { creator?: string }).creator;
  const launchedAgo = timeAgo(pool.createdAt);
  const priceUsd = liveMarket.priceUsd ?? gecko.priceUsd ?? pool.priceUsd;
  const marketCapUsd = liveMarket.marketCapUsd ?? gecko.marketCapUsd ?? pool.marketCapUsd;
  const liquidityUsd = liveMarket.liquidityUsd ?? gecko.liquidityUsd
    ?? (pool.dollarLiquidity != null ? Number(pool.dollarLiquidity) : null);
  const volumeUsd = liveMarket.volumeUsd ?? gecko.volumeUsd
    ?? (pool.volumeUsd != null ? Number(pool.volumeUsd) : null);
  const chart = buildChartGeometry(gecko.candles);

  return (
    <div className="hyde-page hyde-token mx-auto w-full max-w-[1200px]" data-depth-label="Token depth · on-chain signal">
      {/* Breadcrumb (coin-mockup) */}
      <nav className="mb-3 flex items-center gap-1.5 text-xs text-pcs-textDim">
        <Link to="/discover" className="transition hover:text-pcs-textSub">Board</Link>
        <span aria-hidden>›</span>
        <span className="truncate text-pcs-textSub">{pool.baseToken.name}</span>
      </nav>

      <div className="grid gap-4 lg:grid-cols-[1fr,380px]">
        {/* ---------- main ---------- */}
        <div className="min-w-0 space-y-4">
          {/* Header — image · name · by creator · time · address · right-aligned price (coin-mockup) */}
          <Card>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                {meta?.image ? (
                  <TokenImage src={meta.image} symbol={sym} className="h-14 w-14 rounded-xl text-2xl" style={{ border: "1px solid #22252D" }} />
                ) : (
                  <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-gradient-to-br from-pcs-primary/40 to-pcs-cardLight font-display text-2xl font-bold text-pcs-text">{sym.slice(0, 1).toUpperCase()}</div>
                )}
                <div className="min-w-0">
                  <h1 className="truncate font-display text-2xl font-bold text-pcs-text">{pool.baseToken.name} <span className="font-mono text-sm text-pcs-textSub">${sym}</span></h1>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-pcs-textDim">
                    {creatorAddr && <span>by {short(creatorAddr)}</span>}
                    {launchedAgo && <span>· {launchedAgo}</span>}
                    <button type="button" onClick={() => { navigator.clipboard?.writeText(pool.address); setCopied(true); setTimeout(() => setCopied(false), 1200); }} className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono transition hover:text-pcs-textSub" style={{ border: "1px solid #22252D" }}>{copied ? "Copied" : short(pool.address)} ⧉</button>
                    <span className="rounded-md border border-pcs-primary/25 bg-pcs-primary/10 px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wide text-pcs-primaryBright">
                      {engineMeta.title}
                    </span>
                    <span className="rounded-md border border-pcs-primary/25 bg-pcs-primary/[0.07] px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wide text-pcs-primary">
                      {isV5 ? "V5 · Trench Curve" : "Legacy · Instant"}
                    </span>
                    <span className="rounded-md border border-pcs-border bg-white/[0.025] px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wide text-pcs-textSub">
                      {network.name} · {network.id}
                    </span>
                    <span className="rounded-md px-1.5 py-0.5 text-[10px] font-semibold" style={{ background: "rgba(52,199,123,0.12)", color: "#34C77B", border: "1px solid #34C77B40" }}>
                      {isV5 ? curveStatusLabel : "LEGACY · LIVE"}
                    </span>
                  </div>
                </div>
              </div>
              <div className="shrink-0 text-right">
                <div data-testid="token-price" className="font-mono text-xl font-bold text-pcs-text">{priceUsd != null && priceUsd > 0 ? fmtPrice(priceUsd) : "—"}</div>
                <a href={`${network.explorerUrl}/address/${pool.address}`} target="_blank" rel="noreferrer" className="text-[11px] text-pcs-textDim transition hover:text-pcs-textSub">Explorer ↗</a>
              </div>
            </div>
            {meta?.description?.trim() && (
              <p className="mt-3 text-xs text-pcs-textSub leading-relaxed">{meta.description}</p>
            )}
          </Card>

          {creatorAddr && walletAddress?.toLowerCase() === creatorAddr.toLowerCase() && (
            <LaunchMetadataEditor
              chainId={network.id}
              token={pool.address}
              symbol={sym}
              creator={creatorAddr}
              initialMeta={meta}
              onSaved={setMeta}
            />
          )}

        {/* Canonical-pool OHLCV. Gecko is display-only; trading still routes through Hydeout's
            verified contracts and the selected chain remains authoritative for every action. */}
        <Card className="p-0 overflow-hidden">
          <div className="flex items-center justify-between gap-3 px-4 pt-4">
            <div className="flex items-center gap-1" aria-label="Chart range">
            {(["5m", "1h", "24h", "7d"] as const).map((tf) => (
                <button
                  key={tf}
                  type="button"
                  disabled={!gecko.url || wethContained}
                  onClick={() => setChartRange(tf)}
                  className="rounded-lg px-2.5 py-1 text-[11px] font-semibold transition disabled:cursor-default disabled:opacity-50"
                  style={chartRange === tf
                    ? { background: "rgba(52,199,123,0.10)", color: "#34C77B" }
                    : { color: "#707784" }}
                >
                  {tf}
                </button>
            ))}
            </div>
            {gecko.url && (
              <a
                href={gecko.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 font-code text-[9px] uppercase tracking-wider text-pcs-textDim transition hover:text-pcs-primary"
              >
                GeckoTerminal <ArrowTopRightOnSquareIcon className="h-3 w-3" />
              </a>
            )}
          </div>
          {chart && !wethContained ? (
            <div className="relative mt-2 h-[250px] overflow-hidden bg-[#0E1013]">
              <div className="pointer-events-none absolute inset-0 opacity-[0.05]"
                style={{ backgroundImage: "linear-gradient(#fff 1px, transparent 1px), linear-gradient(90deg, #fff 1px, transparent 1px)", backgroundSize: "52px 44px" }} />
              <div className="absolute left-4 top-3 z-10">
                <p className="font-code text-[9px] uppercase tracking-wider text-pcs-textDim">{chartRange} pool price</p>
                <p className="mt-1 font-mono text-sm font-semibold text-pcs-text">
                  {gecko.candles[gecko.candles.length - 1]?.close
                    ? fmtPrice(gecko.candles[gecko.candles.length - 1].close)
                    : "—"}
                </p>
              </div>
              <div className="absolute right-4 top-3 z-10 text-right font-code text-[9px] text-pcs-textDim">
                <p>{fmtPrice(chart.max)}</p>
                <p className="mt-[138px]">{fmtPrice(chart.min)}</p>
              </div>
              <svg
                className="absolute inset-x-0 bottom-0 h-[220px] w-full"
                viewBox={`0 0 ${chart.width} ${chart.height}`}
                preserveAspectRatio="none"
                role="img"
                aria-label={`${pool.baseToken.symbol} ${chartRange} price chart`}
              >
                <defs>
                  <linearGradient id="gecko-price-fill" x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0%" stopColor="#34C77B" stopOpacity="0.24" />
                    <stop offset="100%" stopColor="#34C77B" stopOpacity="0" />
                  </linearGradient>
                </defs>
                <path d={chart.area} fill="url(#gecko-price-fill)" />
                <path d={chart.line} fill="none" stroke="#34C77B" strokeWidth="2.2" vectorEffect="non-scaling-stroke" />
                {chart.volumes.map((bar, index) => (
                  <rect key={index} {...bar} rx="1" fill="#34C77B" opacity="0.22" />
                ))}
              </svg>
            </div>
          ) : (
            <div className="relative flex h-[250px] flex-col items-center justify-center gap-3 px-6 text-center"
              style={{ background: "radial-gradient(120% 90% at 50% 0%, rgba(52,199,123,0.05), transparent 60%), #0E1013" }}>
              <div className="flex h-12 items-end gap-1.5" aria-hidden="true">
                {[9, 5, 12, 7, 14, 6, 11, 8].map((h, index) => (
                  <span key={index} className={gecko.loading ? "hyde-shimmer w-2 rounded-sm" : "w-2 rounded-sm"}
                    style={{ height: `${h * 3}px`, background: "rgba(255,255,255,0.06)", animationDelay: `${index * 90}ms` }} />
                ))}
              </div>
              <div>
                <p className="font-display text-sm font-semibold text-pcs-text">
                  {wethContained ? "Chart paused" : gecko.loading ? "Loading pool history…" : "Pool history unavailable"}
                </p>
                <p className="mt-1 max-w-sm text-xs text-pcs-textSub">
                  {wethContained
                    ? "Trading is paused while this pool’s launch price is under review."
                    : gecko.error ?? "No indexed OHLCV candles were returned for this canonical pool yet."}
                </p>
              </div>
            </div>
          )}
          <div className="flex items-center justify-between gap-3 border-t px-4 py-2.5" style={{ borderColor: "#1C1F26" }}>
            <div className="flex min-w-0 items-center gap-2">
            <span className="inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full" style={{ background: "#34C77B" }} />
              <p className="truncate font-mono text-[11px] text-pcs-textDim">
              {isV5
                ? curveState === "graduated"
                  ? `${isV4Launch ? "V4" : "V3"} graduated liquidity is permanently custodied; principal cannot be withdrawn.`
                  : `V5 ${isV4Launch ? "V4" : "V3"} Trench Curve · 80% curve allocation · 20% graduation reserve.`
                : isV4Launch
                  ? "Legacy V4 instant pool · 5% of fees auto-compounds into locked LP."
                  : "Legacy V3 instant pool · principal permanently locked."}
            </p>
            </div>
            {gecko.url && <span className="shrink-0 font-code text-[8px] uppercase tracking-wider text-pcs-textDim">Market data: GeckoTerminal</span>}
          </div>
        </Card>

        {/* Honest activity surface: the trade tape remains explicit about indexing, while holders are a
            Blockscout snapshot rather than an implied total holder count. */}
        <Card className="token-activity-panel overflow-hidden p-0">
          <div className="flex flex-col gap-3 border-b border-pcs-border px-4 pb-3 pt-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="flex items-center gap-2">
                <SignalIcon className="h-4 w-4 text-pcs-primary" />
                <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-pcs-textSub">On-chain activity</p>
              </div>
              <p className="mt-1 text-[11px] text-pcs-textDim">Live pool context and indexed wallet distribution.</p>
            </div>
            <div className="token-feed-tabs" role="tablist" aria-label="Token activity">
              {(["trades", "holders"] as const).map((tab) => {
                const active = feedTab === tab;
                const Icon = tab === "trades" ? ArrowsRightLeftIcon : UserGroupIcon;
                return (
                  <button
                    key={tab}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setFeedTab(tab)}
                    className={`token-feed-tab ${active ? "token-feed-tab-active" : ""}`}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {tab === "trades" ? "Trades" : "Top holders"}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="min-h-[178px] p-4">
            {feedTab === "trades" ? (
              wethContained ? (
                <div className="token-feed-empty">
                  <div className="token-feed-radar" aria-hidden="true">
                    <ArrowsRightLeftIcon className="h-5 w-5" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-pcs-text">Trade feed paused</p>
                    <p className="mt-1 max-w-md text-xs leading-5 text-pcs-textDim">
                      Activity is hidden while this pool’s launch price is under review.
                    </p>
                  </div>
                </div>
              ) : tradesLoading ? (
                <div className="space-y-2">
                  {[0, 1, 2].map((row) => (
                    <div key={row} className="h-[48px] animate-pulse rounded-lg border border-pcs-border bg-white/[0.02]" />
                  ))}
                </div>
              ) : activityTrades.length > 0 ? (
                <div className="space-y-2">
                  {activityTrades.slice(0, 12).map((trade) => (
                    <a
                      key={`${trade.txHash}-${trade.timestamp}`}
                      href={`${network.explorerUrl}/tx/${trade.txHash}`}
                      target="_blank"
                      rel="noreferrer"
                      className="token-holder-row group"
                    >
                      <span
                        className="w-10 shrink-0 rounded-md border px-1.5 py-1 text-center font-code text-[9px] font-semibold uppercase"
                        style={trade.kind === "buy"
                          ? { color: "#34C77B", borderColor: "rgba(52,199,123,0.25)", background: "rgba(52,199,123,0.07)" }
                          : { color: "#F06A6A", borderColor: "rgba(240,106,106,0.25)", background: "rgba(240,106,106,0.07)" }}
                      >
                        {trade.kind}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block font-code text-xs font-semibold tabular-nums text-pcs-text">
                          {fmtCompactToken(trade.tokenAmount)} {sym}
                        </span>
                        <span className="mt-0.5 block truncate font-code text-[9px] uppercase tracking-wider text-pcs-textDim">
                          {trade.trader ? short(trade.trader) : short(trade.txHash)} · {timeAgo(trade.timestamp) ?? "on-chain"}
                        </span>
                      </span>
                      <span className="text-right">
                        <span className="block font-code text-xs font-semibold tabular-nums text-pcs-text">
                          {trade.volumeUsd > 0
                            ? fmtUsd(trade.volumeUsd)
                            : `${fmtCompactToken(trade.quoteAmount)} ${pool.quoteToken.symbol}`}
                        </span>
                        <span className="mt-0.5 block font-code text-[9px] uppercase tracking-wider text-pcs-textDim">
                          {trade.priceUsd ? fmtPrice(trade.priceUsd) : "on-chain swap"}
                        </span>
                      </span>
                      <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5 text-pcs-textDim transition group-hover:text-pcs-primary" />
                    </a>
                  ))}
                  <p className="pt-1 text-right font-code text-[9px] uppercase tracking-wider text-pcs-textDim">
                    Recent pool swaps via {activity.tradeSource === "indexer"
                      ? "Hyde indexer"
                      : activity.tradeSource === "explorer" ? "chain explorer" : "GeckoTerminal"}
                  </p>
                </div>
              ) : (
                <div className="token-feed-empty">
                  <div className="token-feed-radar" aria-hidden="true">
                    <ArrowsRightLeftIcon className="h-5 w-5" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-pcs-text">No indexed swaps yet</p>
                    <p className="mt-1 max-w-md text-xs leading-5 text-pcs-textDim">
                      {gecko.error ?? "No recent trades were returned for this canonical pool."}
                    </p>
                  </div>
                  {gecko.url && (
                    <a href={gecko.url} target="_blank" rel="noreferrer"
                      className="font-code text-[9px] uppercase tracking-wider text-pcs-primary transition hover:text-pcs-primaryBright">
                      Open market ↗
                    </a>
                  )}
                </div>
              )
            ) : activity.loading ? (
              <div className="space-y-2">
                {[0, 1, 2].map((row) => (
                  <div key={row} className="h-[46px] animate-pulse rounded-lg border border-pcs-border bg-white/[0.02]" />
                ))}
              </div>
            ) : activity.holders.length === 0 ? (
              <div className="token-feed-empty">
                <div className="token-feed-radar" aria-hidden="true">
                  <UserGroupIcon className="h-5 w-5" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-pcs-text">Holder snapshot unavailable</p>
                  <p className="mt-1 max-w-md text-xs leading-5 text-pcs-textDim">
                    The activity index has not returned ranked ERC-20 holder rows for this token yet.
                  </p>
                </div>
                <a
                  href={`${network.explorerUrl}/address/${pool.address}`}
                  target="_blank"
                  rel="noreferrer"
                  className="font-code text-[9px] uppercase tracking-wider text-pcs-primary transition hover:text-pcs-primaryBright"
                >
                  View contract ↗
                </a>
              </div>
            ) : (
              <div className="space-y-2">
                {activity.holders.map((holder, index) => {
                  const identity = holderIdentity(
                    holder.address,
                    knownHolderIdentities,
                    contractHolderScan.contracts,
                    contractHolderScan.checked,
                    network.name,
                  );
                  return (
                    <a
                      key={holder.address + index}
                      href={`${network.explorerUrl}/address/${holder.address}`}
                      target="_blank"
                      rel="noreferrer"
                      className="token-holder-row group"
                    >
                      <span className={`token-holder-rank ${index < 3 ? "token-holder-rank-top" : ""}`}>
                        {String(index + 1).padStart(2, "0")}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="truncate font-code text-xs text-pcs-text">{short(holder.address)}</span>
                          <span className={`token-holder-kind token-holder-kind-${identity.kind}`}>{identity.badge}</span>
                        </span>
                        <span className="mt-0.5 block truncate text-[10px] uppercase tracking-wider text-pcs-textDim">
                          {identity.detail}
                        </span>
                      </span>
                      <span className="text-right">
                        <span className="block font-code text-xs font-semibold tabular-nums text-pcs-text">
                          {fmtTokenAmount(holder.value, pool.baseToken.decimals)}
                        </span>
                        <span className="mt-0.5 block font-code text-[9px] uppercase tracking-wider text-pcs-textDim">{sym}</span>
                      </span>
                      <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5 text-pcs-textDim transition group-hover:text-pcs-primary" />
                    </a>
                  );
                })}
                <div className="flex flex-col gap-1 pt-1 font-code text-[9px] uppercase tracking-wider text-pcs-textDim sm:flex-row sm:justify-between">
                  <span>Curve / LP balances are protocol liquidity custody</span>
                  <span>Snapshot via {activity.holderSource === "indexer" ? "Hyde indexer" : "chain explorer"}</span>
                </div>
              </div>
            )}
          </div>
        </Card>
      </div>

      {/* ---------- right rail ---------- */}
      <div className="min-w-0 space-y-4">
        {/* Rail-aware trade widget (§3.2). When the router genuinely goes live, the reused
           V4SwapCard executes; otherwise the primary action routes to the live pair and the
           in-app Buy/Sell is shown REFERENCE-ONLY (dimmed, non-interactive) — never implying
           Hyde submits/pre-fills an order it can't carry. Graduation is NEVER cited as a reason. */}
        {isV5 && isV4Launch ? (
          <TrenchV5V4SwapCard
            network={network}
            token={{ address: pool.address as `0x${string}`, symbol: sym, name: pool.baseToken.name, decimals: pool.baseToken.decimals }}
          />
        ) : !isV4Launch && stableV3SwapReady ? (
          <StableV3SwapCard
            network={network}
            token={{ address: pool.address as `0x${string}`, symbol: sym, name: pool.baseToken.name, decimals: pool.baseToken.decimals }}
          />
        ) : isV4Launch && isHoodiePair ? (
          <HoodieSwapCard
            network={network}
            token={{ address: pool.address as `0x${string}`, symbol: sym, name: pool.baseToken.name, decimals: pool.baseToken.decimals }}
          />
        ) : isV4Launch && isGatewayLive(network.id) && !WETH_CONTAINMENT.active ? (
          <V4SwapCard network={network} tokens={tokens} onAddCustomToken={onAddCustomToken} forceTokenOut={pool.address.toLowerCase()} />
        ) : (
          <Card variant="panel">
            <SectionLabel>Trade</SectionLabel>
            {/* WETH CONTAINMENT (kami 24005/24008): this branch is the non-HOODIE (WETH-paired) path — its preset
                seeded the ~$1.9T pool. No audited in-app sell → the whole external trade link is removed (routing
                users to the broken pool is the same harm); price/FDV stays truthful. HOODIE pairs never reach here. */}
            {isV4Launch && WETH_CONTAINMENT.active ? (
              <p className="mt-3 rounded-lg px-2.5 py-2 text-center text-sm leading-relaxed" style={{ background: "rgba(232,163,61,0.08)", border: "1px solid rgba(232,163,61,0.28)", color: "#E0A32E" }}>
                {WETH_CONTAINMENT.noSell}
              </p>
            ) : isV4Launch && pair ? (
              <>
                <a
                  href={`https://dexscreener.com/robinhood/${pair}`}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-3 block rounded-xl py-2.5 text-center text-sm font-semibold transition hover:opacity-90"
                  style={{ background: "#2E9FE6", color: "#04121C" }}
                >
                  Trade on live pair ↗
                </a>
                <p className="mt-2 text-xs text-pcs-textSub">Trading is live on this token’s pair.</p>
              </>
            ) : (
              <>
                <p className="mt-2 text-sm text-pcs-textSub">
                  {isV4Launch
                    ? "In-app swap for this token is coming shortly. It trades live now on its locked-liquidity pool, on-chain."
                    : "This token trades through its canonical Stable V3 pool. In-app execution is temporarily unavailable because the verified router gate did not pass."}
                </p>
                {!isV4Launch && pool.poolAddress && (
                  <a
                    href={`${network.explorerUrl.replace(/\/$/, "")}/address/${pool.poolAddress}`}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-3 block rounded-xl border border-pcs-primary/30 bg-pcs-primary/[0.09] py-2.5 text-center text-sm font-semibold text-pcs-primaryBright transition hover:bg-pcs-primary/[0.13]"
                  >
                    View canonical V3 pool ↗
                  </a>
                )}
              </>
            )}
            {/* Disabled Buy/Sell preview removed (kami 23517) — it read as a working swap; the live-pair
                link above is the single trade action until the native swap actually executes. */}
          </Card>
        )}

        {/* Market — consolidated stats (coin-mockup): real feed values or an honest "—", never fabricated. */}
        {isV5 ? (
          <TrenchV5FeeCollector
            network={network}
            token={{
              address: pool.address as `0x${string}`,
              symbol: sym,
              decimals: pool.baseToken.decimals,
            }}
            graduated={pool.curveState === "graduated"}
          />
        ) : !isV4Launch && (
          <StableV3FeeCollector
            network={network}
            token={{
              address: pool.address as `0x${string}`,
              symbol: sym,
              decimals: pool.baseToken.decimals,
            }}
          />
        )}

        {isV5 && (
          <Card variant="panel">
            <SectionLabel>Trench Curve</SectionLabel>
            <div className="mt-3">
              <div className="flex items-center justify-between text-xs">
                <span className="text-pcs-textDim">State</span>
                <span className="font-code text-pcs-primary">{curveStatusLabel}</span>
              </div>
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/[0.05]">
                <div
                  className="h-full rounded-full bg-pcs-primary transition-[width]"
                  style={{ width: `${curveState === "graduated" ? 100 : curveProgress}%` }}
                />
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2 text-center">
                <div className="rounded-lg border border-pcs-border bg-white/[0.02] px-2 py-2">
                  <p className="font-mono text-sm font-semibold text-pcs-text">80%</p>
                  <p className="mt-0.5 text-[10px] text-pcs-textDim">Live curve</p>
                </div>
                <div className="rounded-lg border border-pcs-border bg-white/[0.02] px-2 py-2">
                  <p className="font-mono text-sm font-semibold text-pcs-text">20%</p>
                  <p className="mt-0.5 text-[10px] text-pcs-textDim">LP reserve</p>
                </div>
              </div>
              <p className="mt-3 text-[11px] leading-relaxed text-pcs-textSub">
                Graduation is permissionless after the terminal price, delay, and TWAP checks pass.
                The resulting {isV4Launch ? "V4" : "V3"} LP remains permanently custodied.
              </p>
            </div>
          </Card>
        )}

        <Card variant="panel">
          <SectionLabel>Market</SectionLabel>
          <div className="mt-3 space-y-2 text-xs">
            {([
              ["Market cap", marketCapUsd != null && marketCapUsd > 0 ? fmtUsd(marketCapUsd) : "—"],
              ["Price", priceUsd != null && priceUsd > 0 ? fmtPrice(priceUsd) : "—"],
              ["24h volume", volumeUsd != null && volumeUsd > 0 ? fmtUsd(volumeUsd) : "—"],
              ["Liquidity", liquidityUsd != null && liquidityUsd > 0 ? fmtUsd(liquidityUsd) : "—"],
              ["Total supply", OWN_STACK_SUPPLY],
            ] as [string, string][]).map(([label, value]) => (
              <div key={label} className="flex items-center justify-between">
                <span className="text-pcs-textDim">{label}</span>
                <span className="font-mono tabular-nums text-pcs-text">{value}</span>
              </div>
            ))}
          </div>
        </Card>

        {/* Your Position — per-wallet covered-only PnL for HOODIE launches; net-of-slippage exit-sim mark,
            honest about uncovered/unprovable basis. Only for HOODIE pairs (the reconcilable own-stack pool). */}
        {isHoodiePair && <YourPositionCard connected={isConnected} position={position} error={positionError} symbol={sym} />}

        <Card variant="panel">
          <SectionLabel>Trust</SectionLabel>
          <div className="mt-2 space-y-2 text-xs">
            <div className="flex items-center gap-2">
              <span className="rounded-md px-1.5 py-0.5 text-[10px] font-semibold" style={{ background: "rgba(52,199,123,0.12)", color: "#34C77B", border: "1px solid #34C77B40" }}>
                {isV5 ? "V5 TRENCH CURVE" : "LEGACY INSTANT"}
              </span>
            </div>
            <p className="font-mono text-[11px] text-pcs-text">{engineMeta.feeSplitLabel}</p>
            <p className="text-[11px] leading-relaxed text-pcs-textSub">
              {isV5
                ? `80% begins in the live curve; 20% is reserved for graduation. ${engineMeta.trustLine}`
                : engineMeta.trustLine}
            </p>
            {isV4Launch && !isV5 && (
              <p className="text-[11px] leading-relaxed text-pcs-textDim">
                <span className="font-semibold text-pcs-textSub">Launch protection:</span> swap fee decays 3%→1% over 5 minutes; 1% max-wallet for 5 minutes. Selling remains unrestricted.
              </p>
            )}
          </div>
        </Card>

      </div>
      </div>
    </div>
  );
}

/** Canonical /token/:address entry: resolves the param and renders TokenDetail with embedded trading. */
export function TokenPage(props: Props) {
  const { address = "" } = useParams();
  return <TokenDetail address={address} {...props} />;
}
