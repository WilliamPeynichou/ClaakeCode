import { useEffect, useRef, useState, type ReactNode } from "react";

/** iOS-style bottom sheet: slides up, closes on backdrop tap or a downward drag. */
export function Sheet({ open, title, onClose, children }: { open: boolean; title: string; onClose(): void; children: ReactNode }) {
  const [drag, setDrag] = useState(0);
  const start = useRef<number | null>(null);

  useEffect(() => {
    if (!open) setDrag(0);
  }, [open]);

  return (
    <div className="sheet" data-open={open ? "true" : "false"} aria-hidden={!open}>
      <div className="sheet__backdrop" onClick={onClose} />
      <section
        className="sheet__panel"
        role="dialog"
        aria-label={title}
        style={drag ? { transform: `translateY(${drag}px)`, transition: "none" } : undefined}
      >
        <header
          className="sheet__head"
          onTouchStart={(e) => (start.current = e.touches[0].clientY)}
          onTouchMove={(e) => start.current !== null && setDrag(Math.max(0, e.touches[0].clientY - start.current))}
          onTouchEnd={() => {
            if (drag > 90) onClose();
            setDrag(0);
            start.current = null;
          }}
        >
          <span className="sheet__grabber" />
          <h2>{title}</h2>
          <button type="button" className="sheet__done" onClick={onClose}>
            OK
          </button>
        </header>
        <div className="sheet__body">{children}</div>
      </section>
    </div>
  );
}
