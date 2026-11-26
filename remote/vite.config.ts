import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The iPhone app is static files served by the relay (worker/index.ts) from dist/.
// `npm run dev` serves it with hot reload and forwards the relay routes to `npm run relay`.
const relay = process.env.RELAY_HTTP_URL ?? "http://localhost:8787";

export default defineConfig({
  root: "app",
  plugins: [react()],
  build: { outDir: "../dist", emptyOutDir: true, target: "safari16" },
  server: {
    host: true,
    fs: { allow: [".."] },
    proxy: {
      "/ws": { target: relay, ws: true },
      "/vapid-public-key": relay,
      "/healthz": relay,
    },
  },
});
