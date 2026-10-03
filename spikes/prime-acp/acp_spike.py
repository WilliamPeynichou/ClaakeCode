#!/usr/bin/env python3
"""Spike P0 — piloter le sidecar Prime Agent en ACP depuis un hôte.

Prouve (ou réfute) que Claake Code peut utiliser `prime-agent --mode acp`
comme moteur du chat RLM : handshake, session, streaming, annulation,
kernel Python persistant et récursion `rlm.spawn` (in-process vs daemon).

Le provider « faux » scriptable de Prime (`PRIME_AGENT_FAUX_SCRIPT` /
`PRIME_AGENT_ACP_DAEMON_SCRIPT`) remplace le LLM : aucune clé API, résultats
déterministes. Chaque scénario tourne dans un HOME temporaire isolé,
télémétrie coupée ; le daemon sandboxé est arrêté en fin de scénario.

Usage :
    python3 acp_spike.py --bin /chemin/prime-agent [--uv-dir DIR] [--only NOM ...]
                         [--report rapport.json]

Stdlib uniquement, compatible Python >= 3.9. Ce n'est pas du code produit :
le client définitif sera en Rust/Tokio dans claakecode-app (lot P1).
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
from typing import Any, Callable, Dict, List, Optional, Tuple

DAEMON_PROTOCOL = {"name": "prime-agent.daemon", "version": 7}
TIMEOUT_S = 90.0
KERNEL_TIMEOUT_S = 600.0  # premier boot : uv construit le venv du kernel


class AcpClient:
    """Client JSON-RPC ligne à ligne sur stdio, avec lecteurs non bloquants."""

    def __init__(self, argv: List[str], env: Dict[str, str], cwd: str) -> None:
        self.proc = subprocess.Popen(
            argv,
            env=env,
            cwd=cwd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        self.lines: "queue.Queue[str]" = queue.Queue()
        self.stderr: List[str] = []
        self.next_id = 0
        threading.Thread(target=self._pump_stdout, daemon=True).start()
        threading.Thread(target=self._pump_stderr, daemon=True).start()

    def _pump_stdout(self) -> None:
        assert self.proc.stdout is not None
        for line in self.proc.stdout:
            self.lines.put(line.rstrip("\n"))

    def _pump_stderr(self) -> None:
        assert self.proc.stderr is not None
        for line in self.proc.stderr:
            self.stderr.append(line.rstrip("\n"))

    def send(self, frame: Dict[str, Any]) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write(json.dumps(frame) + "\n")
        self.proc.stdin.flush()

    def request(self, method: str, params: Dict[str, Any]) -> int:
        self.next_id += 1
        self.send({"jsonrpc": "2.0", "id": self.next_id, "method": method, "params": params})
        return self.next_id

    def notify(self, method: str, params: Dict[str, Any]) -> None:
        self.send({"jsonrpc": "2.0", "method": method, "params": params})

    def wait(self, req_id: int, timeout: float = TIMEOUT_S) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
        """Lit jusqu'à la réponse `req_id` ; renvoie (réponse, notifications vues)."""
        deadline = time.monotonic() + timeout
        seen: List[Dict[str, Any]] = []
        while True:
            left = deadline - time.monotonic()
            if left <= 0:
                raise TimeoutError(f"pas de réponse à la requête {req_id} en {timeout:.0f}s")
            try:
                line = self.lines.get(timeout=left)
            except queue.Empty:
                continue
            try:
                frame = json.loads(line)
            except ValueError:
                seen.append({"_non_json_stdout": line})
                continue
            if frame.get("id") == req_id and "method" not in frame:
                return frame, seen
            seen.append(frame)

    def close(self) -> None:
        try:
            if self.proc.stdin:
                self.proc.stdin.close()
            self.proc.wait(timeout=10)
        except Exception:
            self.proc.kill()
            self.proc.wait()


def shutdown_daemon(sock_path: str) -> bool:
    """Envoie la commande `shutdown` au superviseur sandboxé (protocole daemon v7)."""
    if not os.path.exists(sock_path):
        return False
    frame = {"type": "command", "id": "spike-shutdown", "protocol": DAEMON_PROTOCOL,
             "command": {"type": "shutdown"}}
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
            s.settimeout(5)
            s.connect(sock_path)
            s.sendall((json.dumps(frame) + "\n").encode())
            time.sleep(0.5)
        return True
    except OSError:
        return False


class Sandbox:
    """HOME/agent-dir/socket isolés pour un scénario."""

    def __init__(self, args: argparse.Namespace, name: str) -> None:
        # Chemin court : la limite des sockets Unix est ~104 octets sur macOS.
        self.root = tempfile.mkdtemp(prefix=f"pas-{name[:6]}-", dir="/tmp")
        self.socket = os.path.join(self.root, "d.sock")
        self.args = args
        self.client: Optional[AcpClient] = None

    def env(self, extra: Dict[str, str]) -> Dict[str, str]:
        env = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": self.root,
            "PRIME_AGENT_AGENT_DIR": os.path.join(self.root, "agent"),
            # Télémétrie : coupée par les trois overrides reconnus par pa-telemetry.
            "PRIME_AGENT_TELEMETRY": "0",
            "DO_NOT_TRACK": "1",
            "PI_OFFLINE": "1",
            # Venv kernel partagé entre scénarios pour ne payer le boot uv qu'une fois.
            "PRIME_AGENT_KERNEL_VENV": self.args.kernel_venv,
            # Le worker orphelin s'arrête vite si le superviseur disparaît.
            "PRIME_AGENT_INTERNAL_WORKER_SUPERVISOR_LOST_EXIT_MS": "15000",
        }
        if self.args.uv_dir:
            env["PATH"] = self.args.uv_dir + os.pathsep + env["PATH"]
        for item in self.args.env or []:
            key, _, value = item.partition("=")
            env[key] = value
        env.update(extra)
        return env

    def cleanup(self, keep: bool) -> None:
        shutdown_daemon(self.socket)
        if not keep:
            shutil.rmtree(self.root, ignore_errors=True)


def init_params() -> Dict[str, Any]:
    return {"protocolVersion": 1, "clientCapabilities": {},
            "clientInfo": {"name": "claakecode-spike", "title": "Claake Code spike", "version": "0.0.0"}}


def start(args: argparse.Namespace, sb: Sandbox, script: Dict[str, Any], daemon: bool,
          persist: bool = False) -> AcpClient:
    # `--no-session` = session non persistée ; la récursion RLM exige un fichier
    # de session parent (le ledger refuse un parent vide), d'où `persist`.
    argv = [args.bin, "--mode", "acp"] + ([] if persist else ["--no-session"])
    if daemon:
        path = os.path.join(sb.root, "worker-script.json")
        # Le worker daemon exige le sélecteur d'engine explicite (cf. tests Prime).
        with open(path, "w") as f:
            json.dump(dict(script, engine="faux"), f)
        argv += ["--daemon-socket", sb.socket]
        env = sb.env({"PRIME_AGENT_ACP_DAEMON_SCRIPT": path})
    else:
        env = sb.env({"PRIME_AGENT_FAUX_SCRIPT": json.dumps(script)})
    sb.client = AcpClient(argv, env, sb.root)
    return sb.client


def open_session(c: AcpClient) -> Tuple[str, Dict[str, Any], Dict[str, Any]]:
    init, _ = c.wait(c.request("initialize", init_params()))
    new, _ = c.wait(c.request("session/new", {"mcpServers": []}))
    if "error" in new:
        raise RuntimeError(f"session/new a échoué : {new['error']}")
    return new["result"]["sessionId"], init, new


def prompt(c: AcpClient, sid: str, text: str, timeout: float = TIMEOUT_S):
    rid = c.request("session/prompt", {"sessionId": sid, "prompt": [{"type": "text", "text": text}]})
    return c.wait(rid, timeout)


def blob(frames: List[Dict[str, Any]]) -> str:
    return json.dumps(frames, ensure_ascii=False)


def dump(sb: "Sandbox", name: str, frames: List[Dict[str, Any]]) -> None:
    """Conserve les frames ACP du scénario dans la sandbox (utile avec --keep)."""
    with open(os.path.join(sb.root, name), "w") as f:
        json.dump(frames, f, ensure_ascii=False, indent=1)


def marker_line(b: str, marker: str, width: int = 300) -> Optional[str]:
    i = b.find(marker)
    return None if i < 0 else b[i:i + width]


def update_kinds(frames: List[Dict[str, Any]]) -> List[str]:
    kinds = []
    for f in frames:
        upd = f.get("params", {}).get("update", {}) if isinstance(f.get("params"), dict) else {}
        k = upd.get("sessionUpdate") or f.get("method")
        if k and k not in kinds:
            kinds.append(k)
    return kinds


def ipython_call(code: str) -> Dict[str, Any]:
    return {"content": [{"type": "toolCall", "name": "ipython", "arguments": {"code": code}}]}


# ---------------------------------------------------------------- scénarios


def sc_basic(args, sb, daemon=False):
    c = start(args, sb, {"responses": ["ACP-OK"]}, daemon)
    sid, init, _ = open_session(c)
    resp, updates = prompt(c, sid, "Reply with exactly: ACP-OK")
    close, _ = c.wait(c.request("session/close", {"sessionId": sid}))
    ok = resp.get("result", {}).get("stopReason") == "end_turn" and "ACP-OK" in blob(updates)
    return ok, {
        "agentInfo": init.get("result", {}).get("agentInfo"),
        "capabilities": init.get("result", {}).get("agentCapabilities"),
        "stopReason": resp.get("result", {}).get("stopReason"),
        "updateKinds": update_kinds(updates),
        "closeOk": "result" in close,
    }


def sc_cancel(args, sb, daemon=False):
    script = {"responses": [{"text": "réponse lente " * 50, "delayMs": 8000}]}
    c = start(args, sb, script, daemon)
    sid, _, _ = open_session(c)
    rid = c.request("session/prompt", {"sessionId": sid, "prompt": [{"type": "text", "text": "slow"}]})
    time.sleep(1.5)
    t0 = time.monotonic()
    c.notify("session/cancel", {"sessionId": sid})
    resp, updates = c.wait(rid)
    latency = round(time.monotonic() - t0, 2)
    stop = resp.get("result", {}).get("stopReason")
    return stop == "cancelled" and latency < 5, {"stopReason": stop, "cancelLatencyS": latency}


def sc_kernel(args, sb, daemon=False):
    script = {"responses": [
        # Marqueurs construits à l'exécution : la chaîne recherchée n'existe pas
        # dans le code envoyé, donc sa présence prouve une sortie réelle du kernel.
        ipython_call("x = 21 * 2\nprint('CELL1_' + 'OUT', x)"),
        ipython_call("print('CELL2_' + 'PERSIST', x + 1)"),
        {"text": "kernel ok"},
    ]}
    c = start(args, sb, script, daemon)
    sid, _, _ = open_session(c)
    t0 = time.monotonic()
    resp, updates = prompt(c, sid, "use python", KERNEL_TIMEOUT_S)
    b = blob(updates)
    cell1 = "CELL1_OUT 42" in b
    persisted = "CELL2_PERSIST 43" in b
    return cell1 and persisted, {"stopReason": resp.get("result", {}).get("stopReason"),
                "durationS": round(time.monotonic() - t0, 1),
                "cell1": cell1, "persistedAcrossCells": persisted,
                "updateKinds": update_kinds(updates)}


SPAWN_CELL = (
    "from rlm import rlm as R\n"
    "try:\n"
    "    h = await R.spawn('Reply with exactly: CHILD-OK', name='spike_child')\n"
    "    print('SPAWN_' + 'ADMITTED', h)\n"
    "    res = await R.collect(timeout_ms=60000)\n"
    "    print('COLL' + 'ECTED', res)\n"
    "except Exception as e:\n"
    "    print('SPAWN_' + 'ERROR', type(e).__name__, e)\n"
)


def sc_spawn(args, sb, daemon, persist=False):
    script = {"responses": [ipython_call(SPAWN_CELL), {"text": "spawn tested"}], "repeatLastResponse": True}
    c = start(args, sb, script, daemon, persist)
    sid, _, _ = open_session(c)
    resp, updates = prompt(c, sid, "spawn a child", KERNEL_TIMEOUT_S)
    dump(sb, "updates.json", updates)
    b = blob(updates)
    admitted = "SPAWN_ADMITTED" in b
    needs_daemon = "daemon-backed" in b
    detail = {"stopReason": resp.get("result", {}).get("stopReason"), "admitted": admitted,
              "collected": "COLLECTED" in b, "childOk": "CHILD-OK" in b.replace("exactly: CHILD-OK", ""),
              "spawnError": marker_line(b, "SPAWN_ERROR"),
              "refusedNeedsDaemon": needs_daemon}
    # In-process : le refus explicite est le résultat attendu ; daemon : l'admission.
    ok = admitted if daemon else (needs_daemon and not admitted)
    return ok, detail


SCENARIOS: Dict[str, Tuple[str, Callable]] = {
    "inproc-basic": ("ACP in-process : handshake, stream, end_turn, close", lambda a, s: sc_basic(a, s, False)),
    "inproc-cancel": ("ACP in-process : session/cancel interrompt le tour", lambda a, s: sc_cancel(a, s, False)),
    "inproc-kernel": ("ACP in-process : kernel Python persistant entre cellules", lambda a, s: sc_kernel(a, s, False)),
    "inproc-spawn": ("ACP in-process : rlm.spawn refusé explicitement (pas de daemon)", lambda a, s: sc_spawn(a, s, False)),
    "daemon-basic": ("ACP daemon-attached : handshake, stream, end_turn, close", lambda a, s: sc_basic(a, s, True)),
    "daemon-cancel": ("ACP daemon-attached : annulation", lambda a, s: sc_cancel(a, s, True)),
    "daemon-spawn": ("ACP daemon-attached, --no-session : rlm.spawn (parent non persisté)", lambda a, s: sc_spawn(a, s, True)),
    "daemon-spawn-persist": ("ACP daemon-attached, session persistée : rlm.spawn + collect réels",
                             lambda a, s: sc_spawn(a, s, True, True)),
}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bin", required=True, help="binaire prime-agent compilé au pin")
    ap.add_argument("--uv-dir", help="dossier contenant uv (requis pour les scénarios kernel/spawn)")
    ap.add_argument("--kernel-venv", default="/tmp/pas-kernel-venv")
    ap.add_argument("--env", action="append", metavar="CLE=VALEUR",
                    help="variable supplémentaire pour le sidecar (ex. UV_PYTHON=3.12)")
    ap.add_argument("--only", nargs="*", choices=list(SCENARIOS))
    ap.add_argument("--keep", action="store_true", help="conserver les sandboxes pour inspection")
    ap.add_argument("--report", help="écrit le rapport JSON à ce chemin")
    args = ap.parse_args()

    version = subprocess.run([args.bin, "--version"], capture_output=True, text=True).stdout.strip()
    results = []
    for name in args.only or list(SCENARIOS):
        label, fn = SCENARIOS[name]
        sb = Sandbox(args, name)
        t0 = time.monotonic()
        try:
            ok, detail = fn(args, sb)
            err = None
        except Exception as e:  # le spike doit rapporter, pas planter
            ok, detail, err = False, {}, f"{type(e).__name__}: {e}"
        stderr_tail: List[str] = []
        client = sb.client
        if client is not None:
            client.close()
            stderr_tail = client.stderr[-15:]
        sb.cleanup(args.keep)
        res = {"scenario": name, "label": label, "ok": bool(ok), "seconds": round(time.monotonic() - t0, 1),
               "detail": detail, "error": err, "stderrTail": stderr_tail if not ok else []}
        results.append(res)
        print(f"[{'PASS' if ok else 'FAIL'}] {name:14} {res['seconds']:>6}s  {label}")
        if detail:
            print("        " + json.dumps(detail, ensure_ascii=False))
        if err:
            print("        erreur : " + err)
        for line in res["stderrTail"]:
            print("        stderr | " + line)

    report = {"primeVersion": version, "bin": args.bin, "results": results,
              "passed": sum(r["ok"] for r in results), "total": len(results)}
    if args.report:
        with open(args.report, "w") as f:
            json.dump(report, f, ensure_ascii=False, indent=2)
    print(f"\n{report['passed']}/{report['total']} scénarios OK — prime-agent {version}")
    return 0 if report["passed"] == report["total"] else 1


if __name__ == "__main__":
    sys.exit(main())
