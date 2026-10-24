import { invoke } from "@tauri-apps/api/core";
import {
  COMPANION_COMMANDS,
  type CompanionAskInput,
  type CompanionAskStarted,
  type CompanionAttachment,
  type CompanionConversation,
  type CompanionConversationSummary,
} from "./companionContract";

/**
 * Appels Tauri de la bulle de chat (commandes du contrat companionContract.ts). Le compagnon
 * n'a pas de workspace : rien ici ne passe par ipc.ts ni par le chat de l'app principale.
 */
export const companionChatApi = {
  ask(input: CompanionAskInput) {
    return invoke<CompanionAskStarted>(COMPANION_COMMANDS.ask, { input });
  },
  cancel(turnId: string) {
    return invoke<void>(COMPANION_COMMANDS.cancel, { turnId });
  },
  historyList() {
    return invoke<CompanionConversationSummary[]>(COMPANION_COMMANDS.historyList);
  },
  historyLoad(id: string) {
    return invoke<CompanionConversation>(COMPANION_COMMANDS.historyLoad, { id });
  },
  historyDelete(id: string) {
    return invoke<void>(COMPANION_COMMANDS.historyDelete, { id });
  },
  captureRegion() {
    return invoke<CompanionAttachment | null>(COMPANION_COMMANDS.captureRegion);
  },
};

/** Texte collé ou fichier texte lu côté navigateur : devient une pièce jointe « text ». */
export async function textAttachmentFromFile(file: File): Promise<CompanionAttachment> {
  return { kind: "text", name: file.name, text: await file.text() };
}

/** Image collée : rendue en PNG (base64 sans préfixe) pour la pièce jointe image. */
export async function imageFileToPngBase64(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("canvas indisponible : image non convertie");
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((value) => (value ? resolve(value) : reject(new Error("conversion PNG impossible"))), "image/png"),
  );
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}
