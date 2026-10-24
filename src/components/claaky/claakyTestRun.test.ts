import { test } from "node:test";
import assert from "node:assert/strict";
import { isTestCommand, latestTestRun, testRunFromBlock } from "./claakyTestRun";
import { RoomDirector, MACHINE_FLASH_MS, type ClipManifest } from "./roomDirector";
import type { ClaakyActivity } from "./claakyAgentState";

type Tool = Parameters<typeof testRunFromBlock>[0];
const bash = (command: string, status: Tool["status"], isError = false): Tool => ({
  kind: "tool",
  name: "bash",
  status,
  argsPretty: JSON.stringify({ command }),
  isError,
} as Tool);

test("détection des commandes, pas de simple mention", () => {
  for (const command of ["echo 'npm test'", "grep pytest log.txt", "cat tests/vitest.ts", "npm run build", "# npm test", "echo test"]) {
    assert.equal(isTestCommand(command), false, command);
  }
  for (const command of ["cd app && npm test", "python3 -m pytest -q", "npm --prefix app run test:unit", "pnpm exec vitest run", "node --test src/*.test.ts", "cargo test", "go test ./..."]) {
    assert.equal(isTestCommand(command), true, command);
  }
});

test("les tests parallèles en cours ont priorité", () => {
  assert.equal(latestTestRun([bash("npm test", "running"), bash("cargo test", "done")]), "running");
});

test("session shell vivante et sortie non nulle", () => {
  assert.equal(testRunFromBlock({ ...bash("npm test", "done"), output: "[process still running: bash session 3]" }), "running");
  assert.equal(testRunFromBlock({ ...bash("npm test", "done"), output: "[exit status: 1]" }), "failed");
});

test("une commande de test en cours est « running »", () => {
  assert.equal(testRunFromBlock(bash("npx vitest run", "running")), "running");
});

test("code de sortie 0 = passed, erreur = failed", () => {
  assert.equal(testRunFromBlock(bash("npm test", "done")), "passed");
  assert.equal(testRunFromBlock(bash("cargo test -p x", "error", true)), "failed");
});

test("un build ou un typecheck n'est pas un test", () => {
  assert.equal(testRunFromBlock(bash("npx tsc --noEmit", "done")), undefined);
  assert.equal(testRunFromBlock(bash("npm run build", "done")), undefined);
  assert.equal(testRunFromBlock(bash("ls -la", "done")), undefined);
});

test("un outil autre que bash n'est jamais un test", () => {
  const block = { kind: "tool", name: "edit", status: "done", argsPretty: '{"command":"npm test"}' } as Tool;
  assert.equal(testRunFromBlock(block), undefined);
});

test("latestTestRun ignore les blocs cachés et prend le plus récent", () => {
  const blocks = [
    bash("npm test", "done"),
    bash("npm test", "error", true),
    { ...bash("npm test", "done"), hidden: true } as Tool,
  ] as never;
  assert.equal(latestTestRun(blocks), "failed");
});

const manifest: ClipManifest = {
  fps: 12,
  taille: 640,
  decor: "decor.png",
  machine: { x: 100, y: 200, r: 40 },
  clips: {
    attente: { planche: "a.png", x: 0, y: 0, l: 10, h: 10, colonnes: 1, images: 4, boucle: true, lieu: "centre", lieu_fin: "centre" },
    travail_clavier: { planche: "t.png", x: 0, y: 0, l: 10, h: 10, colonnes: 1, images: 4, boucle: true, lieu: "bureau", lieu_fin: "bureau" },
    erreur: { planche: "e.png", x: 0, y: 0, l: 10, h: 10, colonnes: 1, images: 4, boucle: false, lieu: "bureau", lieu_fin: "bureau" },
    autorisation: { planche: "u.png", x: 0, y: 0, l: 10, h: 10, colonnes: 1, images: 4, boucle: false, lieu: "bureau", lieu_fin: "bureau" },
  },
};

const act = (partial: Partial<ClaakyActivity>): ClaakyActivity => ({
  state: "idle",
  awaitingUser: false,
  toolErrors: 0,
  ...partial,
});

test("machine éteinte sans manifeste d'ancrage", () => {
  const d = new RoomDirector({ ...manifest, machine: undefined }, 0);
  d.update(act({ state: "working", testRun: "running" }), 0);
  assert.equal(d.machineLight(0, undefined), null);
});

test("machine allumée pendant un test réel, éteinte sans test", () => {
  const d = new RoomDirector(manifest, 0);
  assert.equal(d.machineLight(0, manifest.machine), null);
  d.update(act({ state: "working", tool: "bash", testRun: "running" }), 100);
  const on = d.machineLight(200, manifest.machine);
  assert.ok(on && on.alpha > 0.4, "allumée pendant le test");
});

test("un test réussi éteint la machine, sans flash", () => {
  const d = new RoomDirector(manifest, 0);
  d.update(act({ state: "working", testRun: "running" }), 0);
  d.update(act({ state: "working", testRun: "passed" }), 1000);
  assert.equal(d.machineLight(1000, manifest.machine), null);
});

test("un test échoué déclenche un flash orange", () => {
  const d = new RoomDirector(manifest, 0);
  d.update(act({ state: "working", testRun: "running" }), 0);
  d.update(act({ state: "working", testRun: "failed" }), 500);
  assert.equal(d.machineLight(500, manifest.machine)?.color, "#ff7a4a");
});

test("un ancien résultat déjà présent à l'ouverture ne déclenche aucun flash", () => {
  const d = new RoomDirector(manifest, 0);
  d.update(act({ state: "idle", testRun: "failed" }), 0);
  assert.equal(d.machineLight(0, manifest.machine), null);
});

test("un échec de test garde un flash orange qui s'éteint", () => {
  const d = new RoomDirector(manifest, 0);
  d.update(act({ state: "working", testRun: "running" }), 0);
  d.update(act({ state: "working", testRun: "failed" }), 500);
  assert.equal(d.machineLight(500 + MACHINE_FLASH_MS + 1, manifest.machine), null);
});

test("changement de lieu = téléportation avec fondu, sans trajet", () => {
  const d = new RoomDirector(manifest, 0);
  assert.equal(d.clip, "attente");
  d.update(act({ state: "working", tool: "bash" }), 3000);
  let fadeSeen = false;
  for (let t = 3000; t < 5000; t += 100) {
    d.step(t);
    if (d.fade?.clip === "attente") fadeSeen = true;
  }
  assert.equal(d.clip, "travail_clavier");
  assert.ok(fadeSeen, "l'ancien sprite s'efface");
  for (let t = 5000; t < 6000; t += 100) d.step(t);
  assert.equal(d.fade, null);
});

test("fin de tour : pas de célébration, il attend au centre", () => {
  const d = new RoomDirector(manifest, 0);
  d.update(act({ state: "working" }), 3000);
  for (let t = 3000; t < 5000; t += 100) d.step(t);
  d.update(act({ state: "done" }), 5000);
  const seen = new Set<string>();
  for (let t = 5000; t < 12000; t += 100) {
    d.step(t);
    seen.add(d.clip);
  }
  assert.equal(d.clip, "attente");
  assert.ok(!seen.has("celebrer"));
});

test("pas de téléportation tant que la planche cible n'est pas chargée", () => {
  const d = new RoomDirector(manifest, 0);
  d.update(act({ state: "working" }), 3000);
  for (let t = 3000; t < 6000; t += 100) d.step(t, (clip) => clip !== "travail_clavier");
  assert.equal(d.clip, "attente");
});
