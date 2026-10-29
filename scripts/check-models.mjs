// Assertion checks for src/lib/models.ts (no test framework in this repo).
// Run: node scripts/check-models.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import Module, { createRequire } from "node:module";
import ts from "typescript";

const require = createRequire(import.meta.url);
function load() {
  const source = fs.readFileSync(new URL("../src/lib/models.ts", import.meta.url), "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = new Module("models-under-test");
  mod.require = (name) => (name === "react" ? { useSyncExternalStore: () => 0 } : require(name));
  mod._compile(js, "models-under-test.js");
  return mod.exports;
}

const m = load();
const catalog = JSON.parse(fs.readFileSync(new URL("../models.json", import.meta.url), "utf8")).models;
const cat = (extra = []) => [...catalog, ...extra];
const entry = (provider, id, thinking, extra = {}) => ({
  provider, id, label: id, thinking, defaultThinking: thinking.at(-1), ...extra,
});
const values = () => m.MODELS.map((e) => e.value);

// Order from the file, nothing duplicated, mistral untouched.
m.applyModelCatalog(cat());
assert.equal(new Set(values()).size, values().length);
assert.equal(values()[0], `${catalog[0].provider}:${catalog[0].id}`);
assert.ok(values().includes("mistral:mistral-large-latest"));

// Hidden entries never come back from the built-in list.
m.applyModelCatalog(catalog.map((e) => ({ ...e, hidden: true })));
assert.deepEqual([...new Set(m.MODELS.map((e) => e.provider))], ["mistral"]);

// A new model shows up, in file order, and empty catalog falls back to built-ins.
m.applyModelCatalog(cat([entry("openai", "zz-next", ["off", "max"])]));
assert.ok(values().includes("openai:zz-next"));
m.applyModelCatalog([]);
assert.ok(values().includes("anthropic:claude-opus-5-5"));

// Thinking follows the catalog, not the model name.
m.applyModelCatalog([
  entry("openai", "gpt-6-sol", ["off", "high"]), // as Rust sends it: remote entry replaces the built-in
  ...catalog.filter((e) => e.id !== "gpt-6-sol"),
  entry("openai", "zz-next", ["off", "max"]),
  entry("xai", "zz-xai", ["off", "high"]),
  entry("kimi", "zz-kimi", ["high"]),
]);
const round = (provider, name, level) =>
  m.thinkingFromRef(m.modelRefWithThinking({ provider, name }, level));
assert.equal(round("openai", "zz-next", "max"), "max");
assert.equal(round("openai", "gpt-6.1-sol", "max"), "max");
assert.equal(round("openai", "gpt-6-sol", "max"), "xhigh"); // catalog overrides the name rule
assert.equal(round("openai", "gpt-5.5", "max"), "xhigh");
assert.equal(round("xai", "zz-xai", "high"), "high");
assert.equal(round("xai", "composer-2.5", "high"), "off"); // catalog: off only
assert.equal(m.modelRefWithThinking({ provider: "kimi", name: "zz-kimi" }, "off").effort, "high");

// Replacement of a hidden/missing selection stays on the same provider.
const available = [
  { value: "anthropic:a", provider: "anthropic" },
  { value: "openai:b", provider: "openai" },
];
assert.equal(m.fallbackModelEntry(available, "openai:gone").value, "openai:b");
assert.equal(m.fallbackModelEntry(available, "google:gone").value, "anthropic:a");
assert.equal(m.fallbackModelEntry([], "openai:gone"), undefined);

// Startup sync: update before the local read wins; failures never throw.
const fresh = cat([entry("openai", "zz-fresh", ["off"])]);
const stale = catalog;
let push;
await m.startModelCatalogSync(
  async () => {
    push(fresh); // event lands while the local read is in flight
    return { models: stale };
  },
  async (cb) => { push = cb; },
);
assert.ok(values().includes("openai:zz-fresh"), "stale local read must not override the event");

await m.startModelCatalogSync(async () => ({ models: fresh }), async () => { throw new Error("no listener"); });
assert.ok(values().includes("openai:zz-fresh"));
await m.startModelCatalogSync(async () => { throw new Error("ipc down"); }, async () => {});

let after;
await m.startModelCatalogSync(async () => ({ models: stale }), async (cb) => { after = cb; });
assert.ok(!values().includes("openai:zz-fresh")); // local read applied
after(fresh); // later event
assert.ok(values().includes("openai:zz-fresh"));

console.log("models checks ok");
