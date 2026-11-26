// Line icons drawn like SF Symbols (24-unit grid, round caps).
const PATHS = {
  back: "M15 5l-7 7 7 7",
  chevron: "M9 5l7 7-7 7",
  down: "M6 9l6 6 6-6",
  updown: "M8 9l4-4 4 4M8 15l4 4 4-4",
  plus: "M12 5v14M5 12h14",
  gear: "M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm7.4-2.1.1-1.4-.1-1.4 2-1.6-2-3.4-2.4 1a7 7 0 0 0-2.4-1.4L14.2 2h-4l-.4 2.7A7 7 0 0 0 7.4 6l-2.4-1-2 3.4 2 1.6-.1 1.4.1 1.4-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2.4 1.4l.4 2.7h4l.4-2.7a7 7 0 0 0 2.4-1.4l2.4 1 2-3.4Z",
  up: "M12 19V5M6 11l6-6 6 6",
  stop: "M7 7h10v10H7z",
  mic: "M9 6a3 3 0 1 1 6 0v5a3 3 0 0 1-6 0ZM5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M9 21h6",
  photo: "M4 6h16v12H4zM4 15l4.5-4.5 3.5 3.5 2.5-2.5L20 17M15.5 9.5h.01",
  play: "M8 5.5v13l10.5-6.5Z",
  pause: "M8 5h3v14H8zM13 5h3v14h-3z",
  check: "M5 12.5l4.5 4.5L19 7",
  close: "M6 6l12 12M18 6 6 18",
  folder: "M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5Z",
  terminal: "M4 5h16v14H4zM8 10l3 2.5L8 15M13 15h3",
  doc: "M7 3h7l4 4v14H7zM14 3v4h4M10 12h5M10 16h5",
  pencil: "M5 19l1-4L16 5l3 3L9 18Zm9-12 3 3",
  search: "M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13ZM15.5 15.5 20 20",
  globe: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM3 12h18M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9s1-6.5 3.5-9Z",
  sparkle: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8ZM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8Z",
  bubble: "M5 5h14a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-8l-4.5 3.5V17H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z",
  cube: "M12 3l8 4.5v9L12 21l-8-4.5v-9ZM12 12l8-4.5M12 12v9M12 12 4 7.5",
  trash: "M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13M10.5 11v5M13.5 11v5",
  more: "M6 12h.01M12 12h.01M18 12h.01",
  bell: "M6 16.5V11a6 6 0 1 1 12 0v5.5l1.5 2H4.5ZM10 20.5a2 2 0 0 0 4 0",
  bolt: "M13 3 5 13.5h6L10.5 21 19 10.5h-6Z",
  list: "M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01",
  flag: "M5 21V4M5 4h11l-2 4 2 4H5",
  ask: "M12 21a9 9 0 1 0-8-4.9L3 21l4.9-1A9 9 0 0 0 12 21ZM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17h.01",
  laptop: "M5 6h14v9H5zM2.5 18h19",
  warning: "M12 4 2.5 20h19ZM12 10v4.5M12 17.5h.01",
  agent: "M12 12a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM5 20a7 7 0 0 1 14 0",
  speaker: "M4 10h3l5-4v12l-5-4H4ZM16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11",
  compress: "M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 22, stroke = 1.9 }: { name: IconName; size?: number; stroke?: number }) {
  const filled = name === "stop" || name === "play" || name === "pause";
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
