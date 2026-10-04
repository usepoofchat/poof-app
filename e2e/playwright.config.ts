import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

// Throwaway Durable Object / rate-limit state, so the tests neither read nor pollute the local
// `pnpm dev` state in worker/.wrangler. The env var makes Playwright's worker processes (which
// re-evaluate this file) reuse the main process's directory instead of creating their own.
process.env.POOF_BROWSER_STATE ??= mkdtempSync(join(tmpdir(), "poof-browser-"));
const stateDir = process.env.POOF_BROWSER_STATE;

const wrangler = (port: number, origin: string, extra = "") =>
  `pnpm exec wrangler dev --port ${port} --ip 127.0.0.1 --persist-to ${stateDir}/${port} --var ALLOWED_ORIGINS:${origin} ${extra}`.trim();

/**
 * Real-browser smoke tests: isolated Chrome contexts talk through real WebRTC, the Vite dev server
 * and a real `wrangler dev`. Uses the installed Google Chrome (channel "chrome"), so no browser
 * download is needed. Run with `pnpm test:browser` from the repository root.
 *
 * Two server pairs: the default one (2-person rooms, :5173 → :8787; reused if `pnpm dev` is
 * running) and a group one where free rooms hold 4 people and may send files (:5174 → :8788),
 * until super rooms exist.
 */
export default defineConfig({
  testDir: "./browser",
  timeout: 60_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    channel: "chrome",
    headless: true,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "pairs", testMatch: "smoke.spec.ts", use: { baseURL: "http://localhost:5173" } },
    { name: "groups", testMatch: "group.spec.ts", use: { baseURL: "http://localhost:5174" } },
  ],
  webServer: [
    {
      command: wrangler(8787, "http://localhost:5173"),
      cwd: "../worker",
      url: "http://localhost:8787/api/health",
      reuseExistingServer: !process.env.CI,
      timeout: 90_000,
    },
    {
      command: "pnpm exec vite --strictPort",
      cwd: "..",
      url: "http://localhost:5173",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: wrangler(
        8788,
        "http://localhost:5174",
        "--var ROOM_MAX_PEERS_FREE:4 --var ROOM_FILES_FREE:1",
      ),
      cwd: "../worker",
      url: "http://localhost:8788/api/health",
      reuseExistingServer: false,
      timeout: 90_000,
    },
    {
      command: "pnpm exec vite --strictPort --port 5174",
      cwd: "..",
      url: "http://localhost:5174",
      env: { POOF_WORKER_PORT: "8788" },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
