// Builds the model request: system prompt, project instructions and documents, then the conversation.
import { askApi, base64ToText, type AskMessage, type DocumentRef, type Project } from "./api";
import type { ChatMessage, ContentPart, OrModel } from "./openrouter";

const SYSTEM =
  "Tu es Claake, l'assistant de Claake Code, utilisé depuis un iPhone. Réponds dans la langue de l'utilisateur, " +
  "de façon claire et directe. Utilise le Markdown quand il aide (listes, tableaux, code).";
const VOICE =
  "L'utilisateur te parle à voix haute et ta réponse sera lue par une voix de synthèse : réponds en une à quatre phrases " +
  "courtes et naturelles, sans Markdown, sans liste et sans code.";
/** Roughly 100k tokens of text documents; the rest is left out and the model is told so. */
const TEXT_BUDGET = 400_000;

const TEXT_EXT = /\.(md|markdown|txt|csv|tsv|json|jsonl|ya?ml|toml|xml|html?|css|scss|js|jsx|mjs|ts|tsx|py|rs|go|java|kt|swift|c|cc|cpp|h|hpp|cs|rb|php|sh|zsh|sql|ini|cfg|conf|env|log|tex|rst)$/i;

export const isImage = (d: DocumentRef) => d.mediaType.startsWith("image/");
export const isPdf = (d: DocumentRef) => d.mediaType === "application/pdf" || /\.pdf$/i.test(d.name);
export const isText = (d: DocumentRef) =>
  d.mediaType.startsWith("text/") || /^application\/(json|xml|javascript|x-yaml|yaml|toml|x-sh|sql)/.test(d.mediaType) || TEXT_EXT.test(d.name);

async function parts(docs: DocumentRef[], model: OrModel, budget: { left: number }, skipped: string[]): Promise<ContentPart[]> {
  const out: ContentPart[] = [];
  for (const doc of docs) {
    if (isImage(doc) && !model.images) {
      skipped.push(`${doc.name} (ce modèle ne voit pas les images)`);
      continue;
    }
    if (!isImage(doc) && !isPdf(doc) && !isText(doc)) {
      skipped.push(`${doc.name} (format non lu)`);
      continue;
    }
    const base64 = await askApi.documentContent(doc.id);
    if (isImage(doc)) out.push({ type: "image_url", image_url: { url: `data:${doc.mediaType};base64,${base64}` } });
    else if (isPdf(doc)) out.push({ type: "file", file: { filename: doc.name, file_data: `data:application/pdf;base64,${base64}` } });
    else {
      const content = base64ToText(base64);
      if (content.length > budget.left) {
        skipped.push(`${doc.name} (trop long)`);
        continue;
      }
      budget.left -= content.length;
      out.push({ type: "text", text: `<document name="${doc.name}">\n${content}\n</document>` });
    }
  }
  return out;
}

export async function buildMessages({ project, documents, history, model, voice }: {
  project: Project | null;
  documents: DocumentRef[];
  history: Pick<AskMessage, "role" | "text" | "attachments">[];
  model: OrModel;
  voice: boolean;
}): Promise<ChatMessage[]> {
  const budget = { left: TEXT_BUDGET };
  const skipped: string[] = [];
  let system = voice ? `${SYSTEM}\n\n${VOICE}` : SYSTEM;
  if (project) {
    system += `\n\nLa conversation fait partie du projet « ${project.name} ».`;
    if (project.instructions.trim()) system += ` Instructions du projet :\n${project.instructions.trim()}`;
  }

  const projectParts = await parts(documents, model, budget, skipped);
  const messages: ChatMessage[] = [];
  for (const [i, m] of history.entries()) {
    if (m.role === "assistant") {
      messages.push({ role: "assistant", content: m.text });
      continue;
    }
    const own = await parts(m.attachments, model, budget, skipped);
    const lead = i === history.findIndex((h) => h.role === "user") && projectParts.length
      ? [{ type: "text" as const, text: "Documents du projet :" }, ...projectParts]
      : [];
    const content = [...lead, ...own];
    messages.push({ role: "user", content: content.length ? [...content, { type: "text", text: m.text }] : m.text });
  }
  if (skipped.length) system += `\n\nCes documents n'ont pas pu t'être transmis : ${[...new Set(skipped)].join(", ")}.`;
  return [{ role: "system", content: system }, ...messages];
}

/** A short title from the first message, like the Mac does before the model names it. */
export function titleFrom(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 48 ? `${line.slice(0, 47).trimEnd()}…` : line || "Nouvelle conversation";
}
