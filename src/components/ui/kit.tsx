// Hydeout design-system primitives (Wave A foundation, per HYDEOUT_DESIGN_SPEC.md).
// Presentational + responsive only — NO data, NO protocol, NO fee/copy strings.
// One card system + amber-CTA/blue-ghost buttons + mono numbers + glow-on-hero-only.
import type { ReactNode, ButtonHTMLAttributes } from 'react';

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(' ');

/* ---------------- Card (ONE system) ---------------- */
type CardVariant = 'default' | 'hero' | 'stat' | 'token' | 'panel';
export function Card({
  variant = 'default', className, children, interactive, ...rest
}: { variant?: CardVariant; className?: string; children: ReactNode; interactive?: boolean } & React.HTMLAttributes<HTMLDivElement>) {
  const base = 'rounded-2xl border bg-pcs-card border-pcs-border shadow-card';
  const byVariant: Record<CardVariant, string> = {
    default: 'p-5',
    hero: 'p-6 shadow-glow border-pcs-primary/40', // glow ONLY on hero/active
    stat: 'p-4',
    token: 'p-4',
    panel: 'p-5 bg-pcs-cardLight',
  };
  return (
    <div
      className={cx(base, byVariant[variant], interactive && 'transition hover:border-pcs-primary/50 hover:bg-pcs-hover cursor-pointer', className)}
      {...rest}
    >
      {children}
    </div>
  );
}

/* ---------------- Button (amber primary / blue ghost) ---------------- */
type BtnVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type BtnSize = 'lg' | 'md' | 'sm';
export function Button({
  variant = 'primary', size = 'md', className, children, ...rest
}: { variant?: BtnVariant; size?: BtnSize; children: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) {
  const sizes: Record<BtnSize, string> = { lg: 'h-12 px-6 text-[15px]', md: 'h-10 px-4 text-sm', sm: 'h-8 px-3 text-[13px]' };
  const variants: Record<BtnVariant, string> = {
    primary: 'bg-brand-yellow text-black hover:brightness-105 font-semibold',
    secondary: 'border border-pcs-primary/60 text-pcs-primary hover:bg-pcs-primary/10',
    ghost: 'text-pcs-textSub hover:text-pcs-text hover:bg-white/[0.04]',
    danger: 'bg-pcs-failure text-white hover:brightness-105',
  };
  return (
    <button
      className={cx('inline-flex items-center justify-center gap-2 rounded-xl font-medium transition disabled:opacity-50 disabled:cursor-not-allowed',
        sizes[size], variants[variant], className)}
      {...rest}
    >
      {children}
    </button>
  );
}

/* ---------------- Stat (mono value + tracked label) ---------------- */
export function Stat({ label, value, sub, className }: { label: string; value: ReactNode; sub?: ReactNode; className?: string }) {
  return (
    <div className={className}>
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-widest text-pcs-textSub">{label}</p>
      <p className="font-mono text-xl font-bold leading-none text-pcs-text sm:text-2xl">{value}</p>
      {sub != null && <p className="mt-1 font-mono text-xs text-pcs-textDim">{sub}</p>}
    </div>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return <p className="text-[11px] font-semibold uppercase tracking-widest text-pcs-textSub">{children}</p>;
}

/* ---------------- Graduation progress bar ---------------- */
export function Progress({ pct, className, showLabel }: { pct: number; className?: string; showLabel?: boolean }) {
  const p = Math.max(0, Math.min(100, pct));
  return (
    <div className={className}>
      {showLabel && (
        <div className="mb-1 flex items-center justify-between text-xs">
          <span className="uppercase tracking-wide text-pcs-textSub">Graduation</span>
          <span className="font-mono text-pcs-primary">{p.toFixed(1)}%</span>
        </div>
      )}
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-pcs-input">
        <span className="block h-full rounded-full bg-gradient-to-r from-pcs-primary to-pcs-primaryBright transition-[width] duration-500" style={{ width: p + '%' }} />
      </div>
    </div>
  );
}

/* ---------------- Filter pill ---------------- */
export function Pill({ active, children, ...rest }: { active?: boolean; children: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={cx('h-8 shrink-0 rounded-full border px-3.5 text-[13px] font-medium transition',
        active ? 'border-pcs-primary bg-pcs-primary/20 text-pcs-primaryBright' : 'border-pcs-border text-pcs-textSub hover:text-pcs-text hover:border-pcs-hover')}
      {...rest}
    >
      {children}
    </button>
  );
}

/* ---------------- Badge / tag ---------------- */
type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';
export function Badge({ tone = 'neutral', children }: { tone?: BadgeTone; children: ReactNode }) {
  const tones: Record<BadgeTone, string> = {
    neutral: 'border-pcs-border text-pcs-textSub',
    accent: 'border-pcs-primary/40 text-pcs-primary bg-pcs-primary/10',
    success: 'border-pcs-success/40 text-pcs-success bg-pcs-success/10',
    warning: 'border-pcs-warning/40 text-pcs-warning bg-pcs-warning/10',
    danger: 'border-pcs-failure/40 text-pcs-failure bg-pcs-failure/10',
  };
  return <span className={cx('inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium', tones[tone])}>{children}</span>;
}

/* ---------------- Verified-contract badge (live Blockscout is_verified) ----------------
   Presentational only — honest in every state. The live status hook (GET
   /api/v2/smart-contracts/{addr} → is_verified) is wired per-screen; a failed
   lookup is a NEUTRAL state, never an app error (kami gate). Never a blanket claim. */
export type VerifyStatus = 'verified' | 'unverified' | 'pending';
export function VerifiedBadge({ status }: { status: VerifyStatus }) {
  // Tooltip is explicit that this reflects ONLY Blockscout source-verification of the token's
  // contract — never a Hyde safety endorsement (kami boundary). Applies everywhere the badge renders.
  if (status === 'verified')
    return <span className="inline-flex" title="Contract source verified on Blockscout"><Badge tone="success">✓ Verified</Badge></span>;
  if (status === 'unverified')
    return <span className="inline-flex" title="Contract source not verified on Blockscout"><Badge tone="neutral">Unverified</Badge></span>;
  return <span className="inline-flex" title="Contract verification status unavailable"><Badge tone="neutral">Verification: —</Badge></span>;
}

/* ---------------- Live trades ticker (shell; feed wired later) ---------------- */
export type TradeRow = { kind: 'buy' | 'sell'; who: string; amount: string; token: string };
export function LiveTicker({ trades, floating }: { trades: TradeRow[]; floating?: boolean }) {
  return (
    <div className={cx('w-72 overflow-hidden rounded-2xl border border-pcs-border bg-pcs-card shadow-card',
      floating && 'fixed bottom-4 right-4 z-40 hidden md:block')}>
      <div className="flex items-center gap-2 border-b border-pcs-border px-3 py-2">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-pcs-success" />
        <span className="text-[11px] font-semibold uppercase tracking-widest text-pcs-textSub">Live Trades</span>
      </div>
      <div className="max-h-64 divide-y divide-pcs-border/60 overflow-y-auto">
        {trades.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-pcs-textDim">No recent trades</p>
        ) : trades.map((t, i) => (
          <div key={i} className="flex items-center justify-between px-3 py-2 text-xs">
            <span className={t.kind === 'buy' ? 'text-pcs-success' : 'text-pcs-failure'}>{t.kind === 'buy' ? 'Buy' : 'Sell'}</span>
            <span className="font-mono text-pcs-textSub">{t.who}</span>
            <span className="font-mono text-pcs-text">{t.amount} <span className="text-pcs-textDim">{t.token}</span></span>
          </div>
        ))}
      </div>
    </div>
  );
}
