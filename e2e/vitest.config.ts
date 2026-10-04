import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // browser/ holds the Playwright smoke test (pnpm test:browser); vitest must not pick it up.
    include: ["test/**/*.test.ts"],
    globalSetup: ["./global-setup.ts"],
    testTimeout: 20_000,
    hookTimeout: 90_000,
    // One wrangler dev instance shared by all files; keep files sequential so rooms don't interfere
    // with the per-IP rate limits of the real worker.
    fileParallelism: false,
  },
});
