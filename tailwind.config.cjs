/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Hyde dark — flat, credible-finance palette. One accent, no neon.
        pcs: {
          bg: "#0B0C0F",
          card: "#121419",
          cardLight: "#181B22",
          input: "#0E1014",
          border: "#22252D",
          hover: "#1A1D24",
          text: "#EDEFF3",
          textSub: "#9BA1AC",
          textDim: "#5D6470",
          primary: "#2E9FE6",
          primaryDark: "#1F81C0",
          primaryBright: "#54B4F0",
          secondary: "#8B93A3",
          success: "#34C77B",
          warning: "#E8A33D",
          failure: "#E5484D",
          accentGlow: "rgba(46,159,230,0.14)", // hero/active card glow only
        },
        brand: {
          yellow: "#E8A33D",
          blue: "#2E9FE6"
        },
        trench: {
          ink: "#05090D",
          deep: "#07131A",
          aqua: "#43E6C2",
          blue: "#2E9FE6",
        },
      },
      boxShadow: {
        card: "0 1px 2px rgba(0, 0, 0, 0.4), 0 8px 24px rgba(0, 0, 0, 0.25)",
        swap: "0 1px 2px rgba(0, 0, 0, 0.4), 0 8px 24px rgba(0, 0, 0, 0.25)",
        neon: "0 1px 2px rgba(0, 0, 0, 0.4)",
        neonPink: "0 1px 2px rgba(0, 0, 0, 0.4)",
        // hero/active glow-border (the one premium tell — used sparingly)
        glow: "inset 0 0 0 1px rgba(46,159,230,0.35), 0 0 44px rgba(46,159,230,0.14)",
      },
      borderRadius: {
        '2.5xl': '1.25rem',
        '3xl': '1.5rem',
        '4xl': '2rem',
      },
      maxWidth: {
        'swap': '480px',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        display: ['Space Grotesk', 'Inter', 'system-ui', 'sans-serif'],
        mono: ['IBM Plex Mono', 'JetBrains Mono', 'monospace'],
      },
    }
  },
  plugins: []
};
