/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Hyde Pro-Terminal — dense teal-on-near-black instrument palette (approved mock 24229).
        pcs: {
          bg: "#08090B",
          card: "#0E1114",
          cardLight: "#111519",
          input: "#0B0D10",
          border: "#1B1F25",
          hover: "#14191D",
          text: "#E8EBEE",
          textSub: "#8B93A0",
          textDim: "#5A6270",
          primary: "#2AD4A6",
          primaryDark: "#1BBF92",
          primaryBright: "#4FE3BE",
          secondary: "#8B93A3",
          success: "#2AD4A6",
          warning: "#E8A33D",
          failure: "#F6465D",
          accentGlow: "rgba(42,212,166,0.14)",
        },
        brand: {
          yellow: "#E8A33D",
          blue: "#2AD4A6"
        },
      },
      boxShadow: {
        card: "0 1px 2px rgba(0, 0, 0, 0.4), 0 8px 24px rgba(0, 0, 0, 0.25)",
        swap: "0 1px 2px rgba(0, 0, 0, 0.4), 0 8px 24px rgba(0, 0, 0, 0.25)",
        neon: "0 1px 2px rgba(0, 0, 0, 0.4)",
        neonPink: "0 1px 2px rgba(0, 0, 0, 0.4)",
        // hero/active glow-border (the one premium tell — used sparingly)
        glow: "inset 0 0 0 1px rgba(42,212,166,0.35), 0 0 44px rgba(42,212,166,0.14)",
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
