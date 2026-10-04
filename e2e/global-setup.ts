import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { TestProject } from "vitest/node";

const PORT = 8798;
const WORKER_DIR = resolve(import.meta.dirname, "../worker");

let child: ChildProcess | null = null;
let stateDir = "";

async function healthy(): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${PORT}/api/health`);
    return res.ok;
  } catch {
    return false;
  }
}

/** Boot a real `wrangler dev` (workerd + Durable Objects) on a throwaway state dir. */
export async function setup(project: TestProject): Promise<void> {
  if (await healthy()) throw new Error(`port ${PORT} is already in use`);
  stateDir = mkdtempSync(join(tmpdir(), "poof-e2e-"));
  child = spawn(
    "pnpm",
    [
      "exec",
      "wrangler",
      "dev",
      "--port",
      String(PORT),
      "--persist-to",
      stateDir,
      "--ip",
      "127.0.0.1",
    ],
    // detached = own process group, so teardown can stop pnpm AND the wrangler/workerd it spawned.
    {
      cwd: WORKER_DIR,
      stdio: "ignore",
      detached: true,
      env: { ...process.env, CI: "1", NO_COLOR: "1" },
    },
  );
  child.on("error", (error) => {
    throw error;
  });

  const deadline = Date.now() + 80_000;
  while (!(await healthy())) {
    if (Date.now() > deadline) throw new Error("wrangler dev did not become healthy in time");
    await new Promise((r) => setTimeout(r, 500));
  }
  project.provide("baseUrl", `http://localhost:${PORT}`);
}

export function teardown(): void {
  if (child?.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
  child = null;
  if (stateDir) rmSync(stateDir, { recursive: true, force: true });
}

declare module "vitest" {
  export interface ProvidedContext {
    baseUrl: string;
  }
}
