import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// In development, /api is proxied to `wrangler pages dev` (port 8788), which runs the
// real Pages Function and reaches the agent Worker through its service binding.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/api": { target: process.env.TALORYS_API_PROXY || "http://127.0.0.1:8788", changeOrigin: false },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    chunkSizeWarningLimit: 800,
  },
});
