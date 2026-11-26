// Reads the agent's <spoken> reports aloud with the iPhone's own voices (no network).
let current: SpeechSynthesisUtterance | null = null;

function frenchVoice(): SpeechSynthesisVoice | undefined {
  const voices = speechSynthesis.getVoices();
  return voices.find((v) => v.lang === "fr-FR" && v.localService) ?? voices.find((v) => v.lang.startsWith("fr"));
}

export function speak(text: string, onEnd?: () => void) {
  stopSpeaking();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "fr-FR";
  const voice = frenchVoice();
  if (voice) utterance.voice = voice;
  utterance.onend = utterance.onerror = () => {
    if (current === utterance) current = null;
    onEnd?.();
  };
  current = utterance;
  speechSynthesis.speak(utterance);
}

export function stopSpeaking() {
  current = null;
  speechSynthesis.cancel();
}

export const speechSupported = () => "speechSynthesis" in window;
