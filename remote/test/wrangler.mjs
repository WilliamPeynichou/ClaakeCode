import { spawn } from "node:child_process";

/** Starts `wrangler dev` on `port`, unless RELAY_URL (http://host:port) points to a running relay. */
export async function startRelay(port, inspectorPort) {
  if (process.env.RELAY_URL) return { base: process.env.RELAY_URL, stop() {} };
  const base = `http://127.0.0.1:${port}`;
  // A process group, so stopping it also stops workerd.
  const child = spawn("npx", ["wrangler", "dev", "--port", String(port), "--inspector-port", String(inspectorPort)], {
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    stdio: "ignore",
    detached: true,
  });
  const stop = () => {
    try {
      process.kill(-child.pid);
    } catch {}
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
