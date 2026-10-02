// Bundles the RLM chat engine: `prime-agent` (built from a pinned commit) and `uv` (pinned
// release, SHA-256 verified). Prime finds `uv` on PATH; the app puts the sidecar directory first.
//
// Opt-in because compiling Prime takes minutes: runs only when CLAAKECODE_BUNDLE_PRIME=1
// (release CI) or when invoked directly with --force. Windows is skipped: the daemon transport
// is a Unix socket and is not supported there yet.
import { execFile as execFileCallback, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export const PRIME_REPO = "https://github.com/WilliamPeynichou/prime-agent.git";
export const PRIME_SHA = "3358e0016bce7cf34a195af58bbd91a26e17d694";
export const UV_VERSION = "0.12.22";
const UV_SHA256 = {
  "aarch64-apple-darwin": "5d714de09501a59393ceca78f4bc232a50478729640d251907160299b2a93ddd",
  "x86_64-apple-darwin": "1b8a5b316883df2daf20fb9a446e5b230e01d947d57aba2694977c5ac5a7e98c",
  "x86_64-unknown-linux-gnu": "b9980552309f09c15172b8be828555e375097f16deb459795ce7bfd200380f0b",
  "aarch64-unknown-linux-gnu": "6f66a14e8239871fb477f9746c941fedfa77e8fe28a8bc7c07e1dc7f53a66712",
};

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const binariesDir = path.join(projectRoot, "src-tauri", "binaries");

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  if (process.env.CLAAKECODE_BUNDLE_PRIME === "1" || process.argv.includes("--force")) {
    await preparePrime();
  } else {
    console.log("prime sidecar skipped (set CLAAKECODE_BUNDLE_PRIME=1 to bundle the RLM engine)");
  }
}

export async function preparePrime() {
  if (process.platform === "win32") {
    console.log("prime sidecar skipped on Windows (transport not supported yet)");
    return;
  }
  await fs.mkdir(binariesDir, { recursive: true });
  const triples = targetTriples();
  for (const triple of triples) {
    await ensureUv(triple);
    await ensurePrime(triple);
  }
  if (process.platform === "darwin") {
    for (const name of ["uv", "prime-agent"]) {
      await lipo(name, triples);
    }
  }
}

export function targetTriples() {
  if (process.platform === "darwin") return ["aarch64-apple-darwin", "x86_64-apple-darwin"];
  if (process.platform === "linux") {
    if (process.arch === "x64") return ["x86_64-unknown-linux-gnu"];
    if (process.arch === "arm64") return ["aarch64-unknown-linux-gnu"];
  }
  throw new Error(`No prime sidecar target for ${process.platform}/${process.arch}`);
}

function outputPath(name, triple) {
  return path.join(binariesDir, `${name}-${triple}`);
}

async function ensureUv(triple) {
  const out = outputPath("uv", triple);
  if (await isFile(out)) return console.log(`uv already present: ${triple}`);
  const archive = `uv-${triple}.tar.gz`;
  const url = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${archive}`;
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`failed to download ${url}: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== UV_SHA256[triple]) {
    throw new Error(`uv checksum mismatch for ${triple}: got ${digest}`);
  }
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "claakecode-uv-"));
  await fs.writeFile(path.join(tmp, archive), bytes);
  await execFile("tar", ["-xzf", path.join(tmp, archive), "-C", tmp]);
  await fs.copyFile(path.join(tmp, `uv-${triple}`, "uv"), out);
  await fs.chmod(out, 0o755);
  await fs.rm(tmp, { recursive: true, force: true });
  console.log(`prepared ${path.relative(projectRoot, out)}`);
}

async function ensurePrime(triple) {
  const out = outputPath("prime-agent", triple);
  if (await isFile(out)) return console.log(`prime-agent already present: ${triple}`);
  const src = process.env.CLAAKECODE_PRIME_SRC ?? path.join(os.tmpdir(), `claakecode-prime-${PRIME_SHA.slice(0, 12)}`);
  if (!(await isFile(path.join(src, "Cargo.toml")))) {
    await run("git", ["init", "-q", src]);
    await run("git", ["-C", src, "fetch", "--depth", "1", PRIME_REPO, PRIME_SHA]);
    await run("git", ["-C", src, "checkout", "-q", "FETCH_HEAD"]);
  }
  const { stdout } = await execFile("git", ["-C", src, "rev-parse", "HEAD"]);
  if (stdout.trim() !== PRIME_SHA) {
    throw new Error(`prime sources at ${src} are ${stdout.trim()}, expected pinned ${PRIME_SHA}`);
  }
  // Prime's release profile keeps debuginfo (~2x size); strip it for the bundle only.
  await run("cargo", ["build", "--release", "--locked", "-p", "pa-cli", "--bin", "prime-agent", "--target", triple], src, {
    CARGO_PROFILE_RELEASE_DEBUG: "0",
    CARGO_PROFILE_RELEASE_STRIP: "symbols",
  });
  await fs.copyFile(path.join(src, "target", triple, "release", "prime-agent"), out);
  await fs.chmod(out, 0o755);
  console.log(`prepared ${path.relative(projectRoot, out)}`);
}

async function lipo(name, triples) {
  const out = outputPath(name, "universal-apple-darwin");
  if (await isFile(out)) return;
  await execFile("lipo", ["-create", "-output", out, ...triples.map((t) => outputPath(name, t))]);
  await fs.chmod(out, 0o755);
  console.log(`prepared ${path.relative(projectRoot, out)}`);
}

function run(cmd, args, cwd, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: "inherit", env: { ...process.env, ...extraEnv } });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(" ")} exited ${code}`))));
  });
}

async function isFile(p) {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}
