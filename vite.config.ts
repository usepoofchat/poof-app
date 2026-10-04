import { defineConfig } from "vite";

// The smoke-test page (src/main.tsx). Vite serves it and proxies the API and the signaling socket
// to `wrangler dev`, so locally it's one origin. It is never deployed.
// POOF_WORKER_PORT lets the browser tests run a second pair (group rooms) next to the default one.
const worker = process.env.POOF_WORKER_PORT ?? "8787";

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      "/api": { target: `http://localhost:${worker}`, changeOrigin: false },
      "/ws": { target: `ws://localhost:${worker}`, ws: true, changeOrigin: false },
    },
  },
});
