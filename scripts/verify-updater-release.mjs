// Verify the actual published bytes before making a release available to updaters.
import { createHash, createPublicKey, verify } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function verifySignature(bytes, encodedSignature, encodedPublicKey) {
  const key = Buffer.from(Buffer.from(encodedPublicKey, "base64").toString().trim().split("\n")[1], "base64");
  const lines = Buffer.from(encodedSignature.trim(), "base64").toString().trim().split("\n");
  const signature = Buffer.from(lines[1] ?? "", "base64");
  if (key.length !== 42 || signature.length !== 74 || !key.subarray(2, 10).equals(signature.subarray(2, 10))) {
    throw new Error("Invalid updater signature or public key mismatch");
  }
  const publicKey = createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), key.subarray(10)]),
    format: "der", type: "spki",
  });
  const algorithm = signature.subarray(0, 2).toString();
  if (algorithm !== "ED" && algorithm !== "Ed") throw new Error("Unsupported signature algorithm");
  const message = algorithm === "ED" ? createHash("blake2b512").update(bytes).digest() : bytes;
  if (!verify(null, message, publicKey, signature.subarray(10))) throw new Error("Updater artifact signature verification failed");
  const comment = lines[2];
  if (!comment?.startsWith("trusted comment: ") || !verify(null,
    Buffer.concat([signature.subarray(10), Buffer.from(comment.slice("trusted comment: ".length))]),
    publicKey, Buffer.from(lines[3] ?? "", "base64"))) {
    throw new Error("Updater trusted comment verification failed");
  }
}

export function reconcileManifest(manifest, tag, publicKey, loadAsset) {
  if (manifest.version !== tag.replace(/^v/, "")) throw new Error("Release tag and manifest version differ");
  for (const target of ["darwin-aarch64", "darwin-x86_64", "windows-x86_64", "linux-x86_64"]) {
    if (!manifest.platforms?.[target]) throw new Error(`Missing updater platform: ${target}`);
  }
  const checked = new Map();
  for (const platform of Object.values(manifest.platforms)) {
    const url = new URL(platform.url);
    const prefix = "/WilliamPeynichou/ClaakeCode/releases/";
    if (url.origin !== "https://github.com" || !url.pathname.startsWith(prefix)) throw new Error("Unexpected updater URL");
    const name = decodeURIComponent(url.pathname.split("/").at(-1));
    if (!checked.has(name)) {
      const signature = loadAsset(`${name}.sig`).toString().trim();
      verifySignature(loadAsset(name), signature, publicKey);
      checked.set(name, signature);
    }
    platform.signature = checked.get(name);
    platform.url = `https://github.com${prefix}download/${tag}/${encodeURIComponent(name)}`;
  }
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [tag, output] = process.argv.slice(2);
  if (!/^v\d+\.\d+\.\d+$/.test(tag ?? "") || !output) throw new Error("Usage: node scripts/verify-updater-release.mjs vX.Y.Z output.json");
  const directory = mkdtempSync(path.join(tmpdir(), "claake-updater-"));
  function loadAsset(name) {
    const destination = path.join(directory, name);
    console.log(`Downloading ${name}`);
    execFileSync("gh", ["release", "download", tag, "--repo", "WilliamPeynichou/ClaakeCode", "--pattern", name, "--dir", directory, "--clobber"], { stdio: "inherit", timeout: 600_000 });
    return readFileSync(destination);
  }
  const manifest = JSON.parse(loadAsset("latest.json"));
  const config = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url)));
  reconcileManifest(manifest, tag, config.plugins.updater.pubkey, loadAsset);
  writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Verified all updater artifacts for ${tag}; manifest written to ${output}`);
}
