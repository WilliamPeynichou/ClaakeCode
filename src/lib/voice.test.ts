import { test } from "node:test";
import assert from "node:assert/strict";
import { extractSpoken, splitSpoken } from "./spoken";
import {
  PhraseDetector,
  detectLanguage,
  interpretTranscript,
  joinDraft,
  normalizeSpeech,
  resampleTo16k,
  rms,
} from "./voiceLogic";

test("splitSpoken removes a closed block", () => {
  const r = splitSpoken("Done.\n\n<spoken>I fixed it.\nAll green.</spoken>");
  assert.deepEqual(r, { body: "Done.", spoken: "I fixed it. All green.", pending: false });
});

test("splitSpoken handles a streaming block", () => {
  const r = splitSpoken("Done.\n<spoken>I fix");
  assert.deepEqual(r, { body: "Done.", spoken: "I fix", pending: true });
  assert.equal(splitSpoken("Done.\n<spo").pending, false);
});

test("splitSpoken strips only the last of several blocks", () => {
  const r = splitSpoken("a <spoken>one</spoken> b <spoken>two</spoken>");
  assert.equal(r.spoken, "two");
  assert.equal(r.body, "a <spoken>one</spoken> b");
  assert.equal(extractSpoken("a <spoken>one</spoken> b <spoken> two  x </spoken>"), "two x");
});

test("no block", () => {
  assert.deepEqual(splitSpoken("plain"), { body: "plain", spoken: null, pending: false });
  assert.equal(extractSpoken("plain <spoken>open"), null);
  assert.equal(extractSpoken("<spoken>  </spoken>"), null);
});

test("normalizeSpeech and commands", () => {
  assert.equal(normalizeSpeech("  Arrête ! "), "arrete");
  assert.deepEqual(interpretTranscript("Stop."), { kind: "command", command: "stop" });
  assert.deepEqual(interpretTranscript("Répète"), { kind: "command", command: "repeat" });
  assert.deepEqual(interpretTranscript("Passe à l'écrit."), { kind: "command", command: "exit" });
  assert.deepEqual(interpretTranscript("Mode écrit"), { kind: "command", command: "exit" });
});

test("commands only count as the whole phrase", () => {
  assert.deepEqual(interpretTranscript("stop the build now"), { kind: "message", text: "stop the build now" });
  assert.deepEqual(interpretTranscript("ok"), { kind: "ignore" });
  assert.deepEqual(interpretTranscript(" ... "), { kind: "ignore" });
  assert.deepEqual(interpretTranscript("lance les tests"), { kind: "message", text: "lance les tests" });
});

test("resampleTo16k", () => {
  const input = new Float32Array(48_000).fill(0.5);
  const out = resampleTo16k(input, 48_000);
  assert.equal(out.length, 16_000);
  assert.ok(out.every((v) => Math.abs(v - 0.5) < 1e-6));
  const same = new Float32Array(10);
  assert.equal(resampleTo16k(same, 16_000), same);
  assert.equal(resampleTo16k(new Float32Array(44_100), 44_100).length, 16_000);
});

test("rms", () => {
  assert.equal(rms(new Float32Array(0)), 0);
  assert.ok(Math.abs(rms(new Float32Array([0.5, -0.5])) - 0.5) < 1e-6);
});

const feed = (d: PhraseDetector, level: number, ms: number, step = 100) => {
  const events: string[] = [];
  for (let t = 0; t < ms; t += step) {
    const e = d.push(level, step);
    if (e) events.push(e);
  }
  return events;
};

test("phrase ends after 2000 ms of silence", () => {
  const d = new PhraseDetector();
  assert.deepEqual(feed(d, 0.003, 1000), []);
  assert.deepEqual(feed(d, 0.2, 1000), ["start"]);
  assert.deepEqual(feed(d, 0.003, 1900), []);
  assert.deepEqual(feed(d, 0.003, 100), ["end"]);
  assert.equal(d.inPhrase, false);
});

test("a pause shorter than 2000 ms keeps the phrase", () => {
  const d = new PhraseDetector();
  assert.deepEqual(feed(d, 0.2, 500), ["start"]);
  assert.deepEqual(feed(d, 0.003, 1800), []);
  assert.deepEqual(feed(d, 0.2, 500), []);
  assert.deepEqual(feed(d, 0.003, 2000), ["end"]);
});

test("a short blip is discarded", () => {
  const d = new PhraseDetector();
  assert.deepEqual(feed(d, 0.2, 200), ["start"]);
  assert.deepEqual(feed(d, 0.003, 2100), ["discard"]);
});

test("a long phrase is split every 30 s and only ends on silence", () => {
  const d = new PhraseDetector();
  assert.deepEqual(feed(d, 0.2, 61_000), ["start", "split", "split"]);
  assert.equal(d.inPhrase, true);
  assert.deepEqual(feed(d, 0.003, 2000), ["end"]);
});

test("joinDraft keeps typed text first", () => {
  assert.equal(joinDraft("  regarde ", "", "le fichier main"), "regarde le fichier main");
  assert.equal(joinDraft("", "  "), "");
});

test("threshold adapts to background noise", () => {
  const d = new PhraseDetector();
  feed(d, 0.014, 5000);
  assert.ok(d.threshold > 0.03);
  assert.deepEqual(feed(d, 0.025, 500), []);
  assert.deepEqual(feed(d, 0.2, 100), ["start"]);
});

test("detectLanguage", () => {
  assert.equal(detectLanguage("J'ai corrigé le bug."), "fr");
  assert.equal(detectLanguage("Les fichiers sont dans le dossier"), "fr");
  assert.equal(detectLanguage("I fixed the bug and the tests pass."), "en");
});
