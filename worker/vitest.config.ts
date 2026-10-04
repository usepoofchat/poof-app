import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Production limits (5 rooms/min/IP etc.) would throttle the test suite itself, which creates many
// rooms from one "IP". Raise them here; limiting behaviour is covered by test/ratelimit.test.ts,
// which injects its own limiter.
const generous = (namespace_id: string) => ({
  namespace_id,
  simple: { limit: 100_000, period: 60 as const },
});

// The D1 schema (migrations/), applied by test/setup.ts before every test file.
const migrations = await readD1Migrations("./migrations");

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        ratelimits: {
          RL_CREATE_ROOM: generous("1001"),
          RL_ROOM_READ: generous("1002"),
          RL_WS_JOIN: generous("1003"),
          RL_HANDSHAKE: generous("1004"),
          RL_PAY: generous("1005"),
        },
        bindings: {
          TEST_MIGRATIONS: migrations,
          // A throwaway sealing key for the pass keys made during tests.
          PASS_MASTER_KEY: "dGVzdC1vbmx5LXBhc3MtbWFzdGVyLWtleS0zMi1ieXRlcyEh",
        },
      },
    }),
  ],
  test: { setupFiles: ["./test/setup.ts"] },
});
