import type * as MonacoTypes from "monaco-editor";

type Monaco = typeof MonacoTypes;

export const MONACO_DARK_THEME = "claakecode-warm";
export const MONACO_LIGHT_THEME = "claakecode-warm-light";

/**
 * Defines both the dark and light Monaco editor themes that match the
 * "Soft" design system (src/styles.css). Safe to call multiple times (Monaco overwrites).
 */
export function registerClaakeCodeThemes(monaco: Monaco): void {
  monaco.editor.defineTheme(MONACO_DARK_THEME, {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "6b6b74", fontStyle: "italic" },
      { token: "keyword", foreground: "c792ea" },
      { token: "string", foreground: "8ee0ae" },
      { token: "number", foreground: "f5b93f" },
      { token: "type", foreground: "5fb0ee" },
      { token: "function", foreground: "82aaff" },
      { token: "variable", foreground: "ececef" },
      { token: "constant", foreground: "f2875a" },
      { token: "regexp", foreground: "8ee0ae" },
      { token: "tag", foreground: "ff8fa3" },
      { token: "attribute.name", foreground: "a68bf7" },
    ],
    colors: {
      "editor.background": "#111113",
      "editor.foreground": "#ececef",
      "editor.lineHighlightBackground": "#18181b",
      "editorLineNumber.foreground": "#46464d",
      "editorLineNumber.activeForeground": "#a1a1aa",
      "editorCursor.foreground": "#4fb477",
      "editor.selectionBackground": "#2f7a4d66",
      "editor.inactiveSelectionBackground": "#25252899",
      "editorIndentGuide.background1": "#1e1e21",
      "editorIndentGuide.activeBackground1": "#36363b",
      "editorGutter.background": "#111113",
      "editorWidget.background": "#1c1c1f",
      "editorWidget.border": "#2d2d31",
      "editorHoverWidget.background": "#1c1c1f",
      "editorHoverWidget.border": "#2d2d31",
      "editorSuggestWidget.background": "#1c1c1f",
      "editorSuggestWidget.border": "#2d2d31",
      "editorSuggestWidget.selectedBackground": "#2d2d31",
      "editorSuggestWidget.highlightForeground": "#6fcf94",
      "editorBracketMatch.background": "#2f7a4d55",
      "editorBracketMatch.border": "#4fb477",
      "scrollbarSlider.background": "#ffffff14",
      "scrollbarSlider.hoverBackground": "#ffffff24",
      "scrollbarSlider.activeBackground": "#ffffff33",
    },
  });

  monaco.editor.defineTheme(MONACO_LIGHT_THEME, {
    base: "vs",
    inherit: true,
    rules: [
      { token: "comment", foreground: "9a9aa2", fontStyle: "italic" },
      { token: "keyword", foreground: "8e44c4" },
      { token: "string", foreground: "23844c" },
      { token: "number", foreground: "c26a0c" },
      { token: "type", foreground: "2f86d6" },
      { token: "function", foreground: "3d5bd9" },
      { token: "variable", foreground: "111114" },
      { token: "constant", foreground: "c2521f" },
      { token: "regexp", foreground: "23844c" },
      { token: "tag", foreground: "c2335a" },
      { token: "attribute.name", foreground: "7a5be0" },
    ],
    colors: {
      "editor.background": "#ffffff",
      "editor.foreground": "#111114",
      "editor.lineHighlightBackground": "#f7f7f8",
      "editorLineNumber.foreground": "#c8c8ce",
      "editorLineNumber.activeForeground": "#6e6e76",
      "editorCursor.foreground": "#2f9e5e",
      "editor.selectionBackground": "#2f9e5e2e",
      "editor.inactiveSelectionBackground": "#ebebee",
      "editorIndentGuide.background1": "#f1f1f3",
      "editorIndentGuide.activeBackground1": "#d9d9de",
      "editorGutter.background": "#ffffff",
      "editorWidget.background": "#ffffff",
      "editorWidget.border": "#e3e3e7",
      "editorHoverWidget.background": "#ffffff",
      "editorHoverWidget.border": "#e3e3e7",
      "editorSuggestWidget.background": "#ffffff",
      "editorSuggestWidget.border": "#e3e3e7",
      "editorSuggestWidget.selectedBackground": "#f1f1f3",
      "editorSuggestWidget.highlightForeground": "#23844c",
      "editorBracketMatch.background": "#2f9e5e1f",
      "editorBracketMatch.border": "#2f9e5e",
      "scrollbarSlider.background": "#1111141a",
      "scrollbarSlider.hoverBackground": "#1111142e",
      "scrollbarSlider.activeBackground": "#11111440",
    },
  });
}

export function monacoThemeForDocument(): string {
  if (typeof document === "undefined") return MONACO_DARK_THEME;
  return document.documentElement.getAttribute("data-theme") === "light"
    ? MONACO_LIGHT_THEME
    : MONACO_DARK_THEME;
}

let monacoInstance: Monaco | null = null;

/**
 * Register themes once and remember the Monaco instance so later theme
 * toggles can refresh every active editor at once via `setTheme`.
 */
export function attachMonacoTheme(monaco: Monaco): void {
  if (monacoInstance !== monaco) {
    monacoInstance = monaco;
    registerClaakeCodeThemes(monaco);
  }
  monaco.editor.setTheme(monacoThemeForDocument());
}

if (typeof window !== "undefined") {
  window.addEventListener("claakecode:theme-changed", () => {
    if (monacoInstance) {
      monacoInstance.editor.setTheme(monacoThemeForDocument());
    }
  });
}
