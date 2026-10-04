import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// The D1 schema (migrations/), read by vitest.config.ts and passed in as a test-only binding.
const { TEST_MIGRATIONS } = env as unknown as { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
await applyD1Migrations(env.LEDGER, TEST_MIGRATIONS);
