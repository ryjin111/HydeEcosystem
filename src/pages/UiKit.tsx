// Foundation preview (/_ui) — a design-system GALLERY for shiro/kami to look-gate
// the Wave A primitives before the real screens are built. All data here is
// clearly-labeled SAMPLE (a component showcase, not fabricated live stats).
import { Card, Button, Stat, Progress, Pill, Badge, LiveTicker, SectionLabel, VerifiedBadge } from '../components/ui/kit';
import type { TradeRow } from '../components/ui/kit';

const SAMPLE_TRADES: TradeRow[] = [
  { kind: 'buy', who: '0x12…9f', amount: '0.42', token: 'ETH' },
  { kind: 'sell', who: '0x8a…3c', amount: '1.1M', token: 'HYDE' },
  { kind: 'buy', who: '0x4d…71', amount: '0.08', token: 'ETH' },
];

function Swatch({ name, cls }: { name: string; cls: string }) {
  return (
    <div className="text-center">
      <div className={`h-12 w-full rounded-lg border border-white/5 ${cls}`} />
      <p className="mt-1 font-mono text-[10px] text-pcs-textDim">{name}</p>
    </div>
  );
}

export function UiKitPage() {
  return (
    <div className="mx-auto w-full max-w-[1200px] space-y-8">
      <div>
        <h1 className="font-display text-3xl font-bold text-pcs-text">Hydeout Design System</h1>
        <p className="mt-1 text-pcs-textSub">Wave A foundation preview — <span className="text-pcs-warning">SAMPLE data</span>, component gallery for look-gate. No live values, no protocol copy.</p>
      </div>

      {/* palette */}
      <Card variant="panel">
        <SectionLabel>Color</SectionLabel>
        <div className="mt-3 grid grid-cols-4 gap-3 sm:grid-cols-8">
          <Swatch name="bg" cls="bg-pcs-bg" /><Swatch name="card" cls="bg-pcs-card" /><Swatch name="cardLight" cls="bg-pcs-cardLight" />
          <Swatch name="border" cls="bg-pcs-border" /><Swatch name="primary" cls="bg-pcs-primary" /><Swatch name="amber CTA" cls="bg-brand-yellow" />
          <Swatch name="success" cls="bg-pcs-success" /><Swatch name="danger" cls="bg-pcs-failure" />
        </div>
      </Card>

      {/* buttons */}
      <Card variant="panel">
        <SectionLabel>Buttons — amber primary · blue ghost</SectionLabel>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button variant="primary" size="lg">Launch a Token</Button>
          <Button variant="primary">Buy</Button>
          <Button variant="secondary">Connect Wallet</Button>
          <Button variant="ghost">Cancel</Button>
          <Button variant="primary" size="sm">Small</Button>
          <Button variant="primary" disabled>Enter an amount</Button>
        </div>
      </Card>

      {/* stats + hero */}
      <div className="grid gap-5 lg:grid-cols-[2fr,1fr]">
        <Card variant="hero">
          <SectionLabel>Hero card (glow — the one premium tell)</SectionLabel>
          <div className="mt-4 grid grid-cols-2 gap-6 sm:grid-cols-4">
            <Stat label="Total Launched" value="35,081" />
            <Stat label="24h Volume" value="$186.7M" />
            <Stat label="Liquidity" value="$169.0M" />
            <Stat label="Today" value="410" />
          </div>
          <p className="mt-3 font-mono text-[10px] text-pcs-textDim">sample — real stats wired from hooks</p>
        </Card>
        <LiveTicker trades={SAMPLE_TRADES} />
      </div>

      {/* filter pills */}
      <Card variant="panel">
        <SectionLabel>Filter pills</SectionLabel>
        <div className="mt-3 flex flex-wrap gap-2">
          <Pill active>Newest</Pill><Pill>Trending</Pill><Pill>Top MCap</Pill><Pill>Graduating</Pill><Pill>Graduated</Pill><Pill>Live</Pill>
        </div>
      </Card>

      {/* verify badge states */}
      <Card variant="panel">
        <SectionLabel>Verified-contract badge — live Blockscout status, honest in every state</SectionLabel>
        <div className="mt-3 flex flex-wrap items-center gap-4">
          <VerifiedBadge status="verified" />
          <VerifiedBadge status="unverified" />
          <VerifiedBadge status="pending" />
          <span className="font-mono text-[11px] text-pcs-textDim">reads GET /api/v2/smart-contracts/&#123;addr&#125;.is_verified per token</span>
        </div>
      </Card>

      {/* token cards + progress + badges */}
      <div>
        <SectionLabel>Token cards · graduation bars · badges</SectionLabel>
        <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[{ n: 'Cool Cat', t: 'COOL', mc: '$41.2K', g: 62, tone: 'accent' as const, s: 'Auction' },
            { n: 'The Juggernaut', t: 'JUGG', mc: '$318K', g: 100, tone: 'success' as const, s: 'Graduated' },
            { n: 'your hood', t: 'HOOD', mc: '$9.1K', g: 14, tone: 'neutral' as const, s: 'Auction' }].map((x) => (
            <Card key={x.n} variant="token" interactive>
              <div className="flex items-center gap-3">
                <div className="h-11 w-11 shrink-0 rounded-xl bg-gradient-to-br from-pcs-primary/40 to-pcs-cardLight" />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold text-pcs-text">{x.n} <span className="font-mono text-xs text-pcs-textSub">${x.t}</span></p>
                  <p className="font-mono text-xs text-pcs-textDim">MCap {x.mc}</p>
                </div>
                <Badge tone={x.tone}>{x.s}</Badge>
              </div>
              <Progress className="mt-3" pct={x.g} showLabel />
            </Card>
          ))}
        </div>
      </div>

      {/* swap widget shell */}
      <Card variant="panel" className="max-w-md">
        <SectionLabel>Swap widget shell</SectionLabel>
        <div className="mt-3 space-y-2">
          <div className="rounded-xl border border-pcs-border bg-pcs-input p-3">
            <div className="flex items-center justify-between text-xs text-pcs-textSub"><span>You pay</span><div className="flex gap-1">{['25%','50%','75%','MAX'].map(p=>(<span key={p} className="rounded bg-pcs-hover px-1.5 py-0.5 text-[10px]">{p}</span>))}</div></div>
            <div className="mt-1 flex items-center justify-between"><span className="font-mono text-xl text-pcs-text">0.0</span><Badge>ETH</Badge></div>
          </div>
          <div className="rounded-xl border border-pcs-border bg-pcs-input p-3">
            <span className="text-xs text-pcs-textSub">You receive</span>
            <div className="mt-1 flex items-center justify-between"><span className="font-mono text-xl text-pcs-text">0.0</span><Badge tone="accent">TOKEN</Badge></div>
          </div>
          <Button variant="primary" size="lg" className="w-full" disabled>Enter an amount</Button>
          <p className="text-center font-mono text-[11px] text-pcs-textDim">fee/slippage line → gojo source-true copy (not shown here)</p>
        </div>
      </Card>
    </div>
  );
}
