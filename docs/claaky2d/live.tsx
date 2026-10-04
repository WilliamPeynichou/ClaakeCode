// Dev-only preview of the REAL <Claaky/> component (npx vite, then open /docs/claaky2d/live.html).
import { createRoot } from "react-dom/client";
import { Claaky, type ClaakyState } from "../../src/components/claaky/Claaky";
import "../../src/styles.css";
const S: ClaakyState[] = ["idle", "thinking", "working", "planning", "done", "error", "sleeping"];
const Block = ({ cls }: { cls: string }) => (
  <div className={cls}>
    <h2>Grand (168 px) — 7 poses animées</h2>
    <div className="row">{S.map((s) => <div className="card" key={s}><Claaky state={s} size={168} /><span>{s}</span></div>)}</div>
    <h2>Loader (26 px) et tailles intermédiaires</h2>
    <div className="row">{[26, 40, 56, 80].map((n) => <div className="card" key={n}><Claaky state="working" size={n} decorative /><span>{n}px</span></div>)}</div>
  </div>
);
createRoot(document.getElementById("root")!).render(<><Block cls="dark" /><Block cls="light" /></>);
