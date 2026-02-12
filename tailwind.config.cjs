/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Cyberpunk Neon Dark palette
        pcs: {
          bg: "#0a0f1e",
          card: "#111827",
          cardLight: "#1a2236",
          input: "#0d1426",
          border: "#1e2d44",
          hover: "#1a2540",
          text: "#e0f7ff",
          textSub: "#94a3b8",
          textDim: "#4a6080",
          primary: "#00d4ff",
          primaryDark: "#0098b8",
          primaryBright: "#00ffff",
          secondary: "#7c3aed",
          success: "#00ff9f",
          warning: "#ffb237",
          failure: "#ff4081",
        },
        brand: {
          yellow: "#ff4081",
          blue: "#00d4ff"
        },
      },
      boxShadow: {
        card: "0 0 1px rgba(0, 212, 255, 0.05), 0 4px 16px rgba(0, 0, 0, 0.3), 0 8px 32px rgba(0, 0, 0, 0.2)",
        swap: "0 0 20px rgba(0, 212, 255, 0.08)",
        neon: "0 0 8px rgba(0, 212, 255, 0.3), 0 0 20px rgba(0, 212, 255, 0.1)",
        neonPink: "0 0 8px rgba(255, 64, 129, 0.3), 0 0 20px rgba(255, 64, 129, 0.1)",
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
        sans: ['Exo 2', 'Inter', 'sans-serif'],
      },
    }
  },
  plugins: []
};
