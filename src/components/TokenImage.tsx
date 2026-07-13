import { useEffect, useState, type CSSProperties } from "react";
import { ipfsToGateway } from "../utils/ipfs";

/** Deterministic Hyde-palette color from a seed (symbol) for the monogram fallback. */
function monogramColor(seed: string): string {
  const palette = ["#2E9FE6", "#5B8DEF", "#7C6FE8", "#2FB6A8", "#E8A33D", "#E86A9F"];
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
}

/**
 * Token image with `ipfs://` → gateway rewriting and a monogram fallback
 * (HYDEOUT_DESIGN_SPEC §3.6 / kami 21155). Renders the resolved image; on load failure
 * (or when no src) falls back to a colored initials circle. Display-only — no pinning.
 */
export function TokenImage({
  src,
  symbol = "",
  className = "",
  style,
}: {
  src?: string | null;
  symbol?: string;
  className?: string;
  style?: CSSProperties;
}) {
  const resolved = ipfsToGateway(src);
  const [errored, setErrored] = useState(false);

  // A new source should get a fresh chance to load before we fall back.
  useEffect(() => setErrored(false), [resolved]);

  if (resolved && !errored) {
    return (
      <img
        src={resolved}
        alt={symbol || "Token"}
        className={`object-cover ${className}`}
        style={style}
        onError={() => setErrored(true)}
      />
    );
  }

  const color = monogramColor(symbol || "?");
  return (
    <div
      className={`flex items-center justify-center font-bold ${className}`}
      style={{ background: `${color}18`, border: `1.5px solid ${color}40`, color, ...style }}
      aria-label={symbol ? `${symbol} monogram` : "token monogram"}
    >
      {(symbol || "?").slice(0, 2).toUpperCase()}
    </div>
  );
}
