import { Link } from "react-router-dom";
import { useVerifiedStatus } from "../hooks/useVerifiedStatus";
import { VerifiedBadge } from "../components/ui/kit";
import { ROBINHOOD_TESTNET } from "../utils/constants";

/* ── Trust / Security page ────────────────────────────────────────────────────
 * The category's four documented failure classes (gojo's Robinhood-launchpad
 * survey) → how Hyde's architecture closes each, EACH with a receipt you can
 * check yourself. Copy is precise-not-absolute (shiro/casper locked); the footer
 * is the non-negotiable honesty gate. Network-aware (#6): on testnet the receipts
 * are LIVE reads of the deployed own-stack; on mainnet the own-stack isn't
 * deployed yet, so receipts read "at mainnet deploy" — never leak testnet data
 * into the mainnet view.
 */

const RH_TESTNET_ID = ROBINHOOD_TESTNET.id;
const EXPLORER = ROBINHOOD_TESTNET.explorerUrl.replace(/\/$/, "");

// Deployed 46630 own-stack receipt targets (verified on-chain).
const OWN_STACK = {
  impl: "0xE43314319675eF26724a7d4381D95ac31c246d90", // HydeERC20 impl — every token is a clone of this (verified FULL)
  collector: "0x0EFdd4ABc4Baa9A6d5b777DA9486D7b638C958b5", // permanent custodian of the locked LP position NFT
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3", // canonical Permit2 — the only approval spender
  lockedPositionId: 202, // HYDE1's single seeded position, custody-held by the collector (ownerOf(202)==collector)
  exampleToken: "0xE2c7316e8115D1c682fb0a4b6b128A8821AffF33", // HYDE1 — an EIP-1167 clone of the verified impl
};

function ExtLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-pcs-primary hover:underline break-all">
      {children}
    </a>
  );
}

/** One receipt line under a card — live link(s) on testnet, "at mainnet deploy" pill on mainnet. */
function Receipt({ isTestnet, children }: { isTestnet: boolean; children: React.ReactNode }) {
  return (
    <div className="mt-3 flex items-start gap-2 rounded-xl px-3 py-2.5 text-[12px]" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid #22252D" }}>
      <span className="mt-[1px] flex-shrink-0">🧾</span>
      {isTestnet ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-pcs-textSub">{children}</div>
      ) : (
        <span className="text-pcs-textDim">
          Receipt goes live at mainnet deploy — <span className="text-pcs-textSub">verifiable on testnet now</span>.
        </span>
      )}
    </div>
  );
}

function TrustCard({ n, title, children }: { n: string; title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl p-5 flex flex-col" style={{ background: "#121419", border: "1px solid #22252D" }}>
      <div className="flex items-center gap-2.5 mb-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-lg text-xs font-bold flex-shrink-0" style={{ background: "rgba(46,159,230,0.14)", color: "#54B4F0" }}>{n}</span>
        <h3 className="font-display text-[15px] font-semibold text-pcs-text">{title}</h3>
      </div>
      {children}
    </div>
  );
}

export function TrustPage({ chainId }: { chainId: number }) {
  const isTestnet = chainId === RH_TESTNET_ID;
  // The impl receipt reads REAL Blockscout status on testnet; skip the query on mainnet (own-stack not there).
  const implVerify = useVerifiedStatus(isTestnet ? OWN_STACK.impl : undefined, RH_TESTNET_ID);

  return (
    <div className="max-w-3xl mx-auto px-4 w-full">
      {/* Header */}
      <div className="mb-6">
        <p className="text-[11px] font-semibold uppercase tracking-widest text-pcs-textDim mb-1">Security</p>
        <h1 className="font-display text-2xl font-semibold text-pcs-text">Built so the category's failures can't happen here.</h1>
        <p className="text-sm text-pcs-textSub mt-2">
          The Robinhood launchpad category has four documented ways to lose money. Here's how Hyde is built so each
          can't occur — each with a receipt you can check yourself.
        </p>
        {isTestnet ? (
          <div className="mt-3 inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs" style={{ background: "rgba(224,163,46,0.10)", border: "1px solid rgba(224,163,46,0.35)", color: "#E0A32E" }}>
            🧪 <span>Receipts below are LIVE reads of the deployed own-stack on Robinhood Testnet (46630).</span>
          </div>
        ) : (
          <div className="mt-3 inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs" style={{ background: "rgba(46,159,230,0.08)", border: "1px solid rgba(46,159,230,0.25)", color: "#54B4F0" }}>
            The Hyde own-stack is live on testnet today; on mainnet these receipts go live at deploy.
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4">
        {/* ① Honeypots */}
        <TrustCard n="①" title="Honeypots — impossible by construction.">
          <p className="text-[13px] text-pcs-textSub leading-relaxed">
            Every token launched on Hyde is byte-identical, source-verified code — an EIP-1167 clone of one audited
            HydeERC20. Creators supply only a <span className="text-pcs-text">name, symbol, and a pre-vetted preset</span> —
            never contract code or pool settings. So hidden sell-blocks, transfer-taxes, mint-backdoors, and blacklists
            are impossible, and creators receive <span className="text-pcs-text">zero premine</span> (all 1B pool-seeded —
            no insider bag to dump).
          </p>
          <Receipt isTestnet={isTestnet}>
            <span className="inline-flex items-center gap-1.5">
              <VerifiedBadge status={implVerify} />
              <ExtLink href={`${EXPLORER}/address/${OWN_STACK.impl}`}>HydeERC20 impl</ExtLink>
            </span>
            <span className="text-pcs-textDim">· your token = an EIP-1167 clone of this exact code</span>
          </Receipt>
        </TrustCard>

        {/* ② Approval drains */}
        <TrustCard n="②" title="Approval drains — never a public multicall.">
          <p className="text-[13px] text-pcs-textSub leading-relaxed">
            The category: approve your tokens to Multicall3 — a public, no-auth contract anyone can drain (the pons
            disclosure). Hyde: approvals go to <span className="text-pcs-text">canonical Permit2</span>, the Uniswap-standard
            allowance layer — every transfer is gated by a per-swap signed permit with a deadline, and you can revoke
            anytime. Never a public multicall.
          </p>
          <Receipt isTestnet={isTestnet}>
            <ExtLink href={`${EXPLORER}/address/${OWN_STACK.permit2}`}>Permit2 spender ✓</ExtLink>
            <span className="text-pcs-textDim">·</span>
            <ExtLink href="https://revoke.cash">Revoke anytime → revoke.cash</ExtLink>
          </Receipt>
        </TrustCard>

        {/* ③ Fake LP-locks */}
        <TrustCard n="③" title="Fake LP-locks — custody-locked from block 1.">
          <p className="text-[13px] text-pcs-textSub leading-relaxed">
            The category: "locked" liquidity that's actually owner-withdrawable or migrates out. Hyde: the LP is
            <span className="text-pcs-text"> custody-locked from block 1</span> — the position NFT is held by the collector
            and never migrates, with no decrease, transfer, or burn selector that could pull it. It grows as it earns fees.
          </p>
          <Receipt isTestnet={isTestnet}>
            <ExtLink href={`${EXPLORER}/address/${OWN_STACK.collector}`}>Locked-LP position #{OWN_STACK.lockedPositionId} ✓</ExtLink>
            <span className="text-pcs-textDim">· NFT owned by the collector, permanently</span>
          </Receipt>
        </TrustCard>

        {/* ④ Owner backdoors */}
        <TrustCard n="④" title="Owner backdoors — no-owner tokens.">
          <p className="text-[13px] text-pcs-textSub leading-relaxed">
            The category: the deployer can mint / blacklist / pause / upgrade, and a founder-key hack rugs everyone
            (NOXA, ~$12M). Hyde: token clones are <span className="text-pcs-text">no-owner</span> — no mint, blacklist,
            pause, or upgrade selector exists to abuse. The factory's only power is pause/unpause of <span className="text-pcs-text">new</span> launches
            (never any live token, pool, fee, or claim) and it's renounceable.
          </p>
          <Receipt isTestnet={isTestnet}>
            <ExtLink href={`${EXPLORER}/token/${OWN_STACK.exampleToken}`}>Token = no-owner ✓</ExtLink>
            <span className="text-pcs-textDim">· factory = pause-only, renounces at mainnet</span>
          </Receipt>
        </TrustCard>
      </div>

      {/* Honesty footer — the non-negotiable gate */}
      <div className="mt-6 rounded-2xl p-5" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid #22252D" }}>
        <p className="text-xs font-semibold uppercase tracking-widest text-pcs-textDim mb-2">What we don't claim</p>
        <p className="text-[13px] text-pcs-textSub leading-relaxed">
          No contract is risk-free. Hyde removes the failure modes that plague this category by construction — it does
          <span className="text-pcs-text"> not</span> remove market risk, phishing, or a bug no audit caught.
          Read the source. Check the receipts. DYOR.
        </p>
      </div>

      <div className="mt-5 mb-2 text-center">
        <Link to="/launchpad" className="text-sm font-semibold text-pcs-primary hover:underline">
          Explore the launchpad →
        </Link>
      </div>
    </div>
  );
}
