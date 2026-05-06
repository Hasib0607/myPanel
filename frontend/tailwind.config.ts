import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        panel: {
          bg: "#f7f8fb",
          ink: "#111827",
          muted: "#6b7280",
          line: "#d9dee8",
          accent: "#0f766e",
          warn: "#b45309",
          danger: "#b91c1c"
        }
      }
    }
  },
  plugins: []
};

export default config;
