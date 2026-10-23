import type { ChatBlock } from "../chat/stream";

export type TestRun = "running" | "passed" | "failed";
type ToolLike = Extract<ChatBlock, { kind: "tool" }>;

export function testCommandOf(argsPretty?: string): string | null {
  if (!argsPretty) return null;
  try {
    const input = JSON.parse(argsPretty) as { command?: unknown };
    return typeof input.command === "string" ? input.command : null;
  } catch {
    return null;
  }
}

/** Match executable positions, not mentions in echo/grep/file names or comments. */
export function isTestCommand(command: string): boolean {
  // Tokenize quotes before separators so `echo "npm test"` cannot activate the machine.
  const tokens = command.match(/"(?:\\.|[^"\\])*"|'[^']*'|&&|\|\||[;|\n]|[^\s;|&]+/g) ?? [];
  let start = true;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (["&&", "||", ";", "|", "\n"].includes(token)) { start = true; continue; }
    if (!start) continue;
    if (token.startsWith("#")) break;
    if (/^[A-Za-z_][\w]*=/.test(token) || ["env", "command", "exec"].includes(token)) continue;
    start = false;
    const exe = token.replace(/^.*\//, "");
    const args = tokens.slice(i + 1, i + 8);
    if (["vitest", "jest", "mocha", "pytest", "pytest-3"].includes(exe)) return true;
    if (["npx", "pnpm", "bun", "yarn"].includes(exe) && args[0] === "exec") args.shift();
    if (["npx", "pnpm", "bun", "yarn"].includes(exe) && ["vitest", "jest", "mocha", "pytest"].includes(args[0])) return true;
    if (["npm", "pnpm", "yarn", "bun"].includes(exe)) {
      // npm --prefix app run test, pnpm -C app test, etc.
      while (args[0]?.startsWith("-")) {
        const option = args.shift();
        if (["--prefix", "--workspace", "-w", "-C", "--dir", "--filter"].includes(option ?? "")) args.shift();
      }
      if (args[0] === "run") args.shift();
      if (/^test(?::[\w:-]+)?$/.test(args[0] ?? "")) return true;
    }
    if (["cargo", "go", "playwright"].includes(exe) && args[0] === "test") return true;
    if (exe === "npx" && args[0] === "playwright" && args[1] === "test") return true;
    if (/^python[\d.]*$/.test(exe) && args[0] === "-m" && ["pytest", "unittest"].includes(args[1])) return true;
    if (exe === "node" && args.some((arg) => arg === "--test")) return true;
    if (exe === "e2e" && args[0] === "run") return true;
  }
  return false;
}

export function testRunFromBlock(block: ToolLike): TestRun | undefined {
  if (block.name.split(".").at(-1) !== "bash") return undefined;
  const command = testCommandOf(block.argsPretty ?? block.argsRaw);
  if (!command || !isTestCommand(command)) return undefined;
  if (block.status === "running") return "running";
  // Stream merges bash_input output back into the original block. A live shell session
  // is still running even though the first tool invocation already returned.
  if (/\[process still running: (?:bash|PowerShell) session \d+\]/.test(block.output ?? "")) return "running";
  if (block.status === "error" || block.isError) return "failed";
  const exit = block.output?.match(/\[exit status: (\d+)\]/);
  if (exit && Number(exit[1]) !== 0) return "failed";
  return "passed";
}

/** Any live test takes precedence over a later completed parallel test. */
export function latestTestRun(blocks: readonly ChatBlock[]): TestRun | undefined {
  let latest: TestRun | undefined;
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i];
    if (block.kind !== "tool" || block.hidden) continue;
    const run = testRunFromBlock(block);
    if (run === "running") return run;
    latest ??= run;
  }
  return latest;
}
