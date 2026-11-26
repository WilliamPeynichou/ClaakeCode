import type { AgentEvent, ChatMessage, FileChange, Part } from "../../../../src/types";

export type ToolStatus = "running" | "done" | "error";

export type ToolBlock = {
  kind: "tool";
  key: string;
  id: string;
  name: string;
  /** Pretty JSON arguments (streamed raw until the tool is ready). */
  args: string;
  output: string;
  status: ToolStatus;
  files: FileChange[];
};

export type Block =
  | { kind: "user"; key: string; text: string; images: number }
  | { kind: "text"; key: string; text: string; streaming: boolean }
  | { kind: "thinking"; key: string; text: string; streaming: boolean }
  | ToolBlock
  | { kind: "agent"; key: string; name: string; status: ToolStatus }
  | { kind: "notice"; key: string; tone: "error" | "info"; text: string };

// Live tool output can be huge; the phone keeps the start, the Mac keeps everything.
const OUTPUT_LIMIT = 8_000;

const HIDDEN_META = ["attachment_context", "plan_control", "system_reminder"];

function visibleText(part: Part): string | null {
  if (part.type !== "text" || !part.text.trim()) return null;
  const meta = part.meta ?? {};
  return HIDDEN_META.some((key) => key in meta && meta[key]) ? null : part.text;
}

function appendCapped(current: string, delta: string): string {
  if (current.length >= OUTPUT_LIMIT) return current;
  const next = current + delta;
  return next.length > OUTPUT_LIMIT ? `${next.slice(0, OUTPUT_LIMIT)}\n…` : next;
}

export function blocksFromHistory(history: ChatMessage[]): Block[] {
  const blocks: Block[] = [];
  const tools = new Map<string, ToolBlock>();
  history.forEach((message, m) => {
    if (message.role === "user") {
      const texts: string[] = [];
      let images = 0;
      for (const part of message.parts) {
        if (part.type === "tool_result") {
          const tool = tools.get(part.tool_call_id);
          if (tool) {
            tool.output = part.content.length > OUTPUT_LIMIT ? `${part.content.slice(0, OUTPUT_LIMIT)}\n…` : part.content;
            tool.status = part.is_error ? "error" : "done";
            tool.files = part.meta?.file_changes ?? [];
          }
        } else if (part.type === "image") {
          images += 1;
        } else {
          const text = visibleText(part);
          if (text) texts.push(text);
        }
      }
      if (texts.length > 0 || images > 0) blocks.push({ kind: "user", key: `h${m}`, text: texts.join("\n").trim(), images });
      return;
    }
    message.parts.forEach((part, p) => {
      const key = `h${m}-${p}`;
      if (part.type === "text" && part.text.trim()) blocks.push({ kind: "text", key, text: part.text, streaming: false });
      else if (part.type === "thinking" && part.text.trim()) blocks.push({ kind: "thinking", key, text: part.text, streaming: false });
      else if (part.type === "tool_call") {
        const tool: ToolBlock = {
          kind: "tool",
          key,
          id: part.id,
          name: part.name,
          args: JSON.stringify(part.input ?? {}, null, 2),
          output: "",
          status: "done",
          files: [],
        };
        tools.set(part.id, tool);
        blocks.push(tool);
      }
    });
  });
  return blocks;
}

/** Blocks of the turn that is running now, rebuilt from its events. */
export function blocksFromEvents(events: AgentEvent[]): Block[] {
  const blocks: Block[] = [];
  const tools = new Map<string, ToolBlock>();
  const agents = new Map<string, Extract<Block, { kind: "agent" }>>();
  let text: Extract<Block, { kind: "text" }> | null = null;
  let thinking: Extract<Block, { kind: "thinking" }> | null = null;

  events.forEach((event, index) => {
    const key = `l${index}`;
    switch (event.type) {
      case "text_started":
        text = { kind: "text", key, text: "", streaming: true };
        blocks.push(text);
        break;
      case "text_chunk":
        if (!text) {
          text = { kind: "text", key, text: "", streaming: true };
          blocks.push(text);
        }
        text.text += event.delta;
        break;
      case "text_finished":
        if (text) text.streaming = false;
        text = null;
        break;
      case "thinking_started":
        thinking = { kind: "thinking", key, text: "", streaming: true };
        blocks.push(thinking);
        break;
      case "thinking_chunk":
        if (!thinking) {
          thinking = { kind: "thinking", key, text: "", streaming: true };
          blocks.push(thinking);
        }
        thinking.text += event.delta;
        break;
      case "thinking_finished":
        if (thinking) thinking.streaming = false;
        thinking = null;
        break;
      case "tool_started": {
        const tool: ToolBlock = { kind: "tool", key, id: event.id, name: event.name, args: "", output: "", status: "running", files: [] };
        tools.set(event.id, tool);
        blocks.push(tool);
        break;
      }
      case "tool_args_delta": {
        const tool = tools.get(event.id);
        if (tool) tool.args += event.delta;
        break;
      }
      case "tool_ready": {
        const tool = tools.get(event.id);
        if (tool) tool.args = event.args_pretty || tool.args;
        break;
      }
      case "tool_output_delta": {
        const tool = tools.get(event.id);
        if (tool) tool.output = appendCapped(tool.output, event.delta);
        break;
      }
      case "tool_finished": {
        const tool = tools.get(event.id);
        if (tool) {
          tool.status = event.is_error ? "error" : "done";
          tool.output = appendCapped("", event.output || tool.output);
          tool.files = event.file_changes ?? [];
        }
        break;
      }
      case "sub_agent_event": {
        let agent = agents.get(event.id);
        if (!agent) {
          agent = { kind: "agent", key, name: event.agent_name || "Agent", status: "running" };
          agents.set(event.id, agent);
          blocks.push(agent);
        }
        if (event.event.type === "turn_finished") agent.status = "done";
        if (event.event.type === "error") agent.status = "error";
        break;
      }
      case "approval_requested":
        blocks.push({ kind: "notice", key, tone: "info", text: `Le Mac attend ton accord pour « ${event.name} ». Réponds sur le Mac.` });
        break;
      case "rate_limited":
        blocks.push({ kind: "notice", key, tone: "info", text: `Limite du fournisseur atteinte. Nouvel essai dans ${Math.ceil(event.retry_in_ms / 1000)} s.` });
        break;
      case "interrupted":
        blocks.push({ kind: "notice", key, tone: "info", text: "Arrêté." });
        break;
      case "error":
        blocks.push({ kind: "notice", key, tone: "error", text: event.message || "Erreur." });
        break;
      default:
        break;
    }
  });
  return blocks;
}

export type Question = { question: string; multiple: boolean; options: { label: string; description?: string }[] };

/** Arguments of the "question" tool, in the shapes the agent uses. */
export function parseQuestions(raw: string): Question[] {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const records = Array.isArray(parsed.questions) ? parsed.questions : [parsed];
    return records.flatMap((record): Question[] => {
      if (!record || typeof record !== "object") return [];
      const r = record as Record<string, unknown>;
      const question = String(r.question ?? r.prompt ?? r.title ?? "").trim();
      if (!question) return [];
      const rawOptions = Array.isArray(r.options) ? r.options : Array.isArray(r.choices) ? r.choices : [];
      const options = rawOptions.flatMap((option) => {
        if (typeof option === "string" || typeof option === "number") return [{ label: String(option) }];
        if (!option || typeof option !== "object") return [];
        const o = option as Record<string, unknown>;
        const label = String(o.label ?? o.text ?? o.value ?? "").trim();
        return label ? [{ label, description: o.description ? String(o.description) : undefined }] : [];
      });
      const kind = String(r.type ?? r.mode ?? r.kind ?? "").toLowerCase();
      return [{ question, options, multiple: kind.includes("multiple") || Boolean(r.multiple || r.allowMultiple) }];
    });
  } catch {
    return [];
  }
}
