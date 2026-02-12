/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        cyber: {
          cyan: "#53ebe4",
          teal: "#0f9595",
          tealDeep: "#084f64",
          navy: "#03274c",
          navyDeep: "#08173d",
          black: "#0b001b",
          purple: "#4d004f",
          magenta: "#c1115a",
          pinkHot: "#e13a6a",
          pinkSoft: "#e46a87",
          pinkLight: "#eca6c0"
        },
        brand: {
          yellow: "#e13a6a",
          blue: "#53ebe4"
        },
        success: "#00ff9f",
        error: "#ff3366",
        neutral: {
          50: "#aaaaaa",
          100: "#8e8e8e",
          200: "#737373",
          300: "#5d5d5d",
          400: "#494949",
          500: "#383838",
          600: "#2a2a2a",
          700: "#1f1f1f",
          800: "#161616",
          900: "#111111"
        },
        app: {
          bg: "#0b001b",
          card: "#08173d"
        }
      },
      boxShadow: {
        card: "0 14px 34px rgba(8, 79, 100, 0.35)"
      }
    }
  },
  plugins: []
};
