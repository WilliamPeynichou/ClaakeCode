import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Starts `wrangler dev` on `port`, unless RELAY_URL (http://host:port) points to a running relay.
 * Each run gets a fresh local D1 with the migrations applied; `vars` are passed with --var.
 */
export async function startRelay(port, inspectorPort, vars = {}) {
  if (process.env.RELAY_URL) return { base: process.env.RELAY_URL, stop() {} };
  const base = `http://127.0.0.1:${port}`;
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "claake-relay-"));
  execFileSync("npx", ["wrangler", "d1", "migrations", "apply", "claake-ask", "--local", "--persist-to", state], {
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
    stdio: "ignore",
  });
  const args = ["wrangler", "dev", "--port", String(port), "--inspector-port", String(inspectorPort), "--persist-to", state];
  for (const [key, value] of Object.entries(vars)) args.push("--var", `${key}:${value}`);
  // A process group, so stopping it also stops workerd.
  const child = spawn("npx", args, {
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    stdio: "ignore",
    detached: true,
  });
  const stop = () => {
    try {
      process.kill(-child.pid);
    } catch {}
    fs.rmSync(state, { recursive: true, force: true });
  };
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) return { base, stop };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  stop();
  throw new Error("wrangler dev did not start");
}
