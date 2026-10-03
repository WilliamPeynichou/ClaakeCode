#!/usr/bin/env python3
"""Spike P0 (suite) — récursion RLM via le protocole daemon Prime (v7).

`acp_spike.py` montre que la récursion `rlm.spawn` échoue en ACP au pin
`3358e00` : le transport ACP daemon-attached crée toujours une session
`no_session`, sans fichier parent, et le ledger RLM refuse l'arête.
Ce script parle directement au superviseur (socket Unix, JSONL) :

1. lance `prime-agent --mode daemon --daemon-socket <sock>` (sandbox HOME) ;
2. `create` une session **persistée** (sans `noSession`) avec le provider faux ;
3. `prompt_and_wait` : la cellule ipython appelle `rlm.spawn` puis `collect` ;
4. `get_rlm_children`, lecture des fichiers de session ;
5. `kill` puis `shutdown` et vérification qu'aucun processus ne reste.

Usage : python3 daemon_spike.py --bin /chemin/prime-agent --uv-dir DIR [--env K=V ...] [--keep]
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from typing import Any, Dict, List, Optional

PROTOCOL = {"name": "prime-agent.daemon", "version": 7}


class DaemonConn:
    """Connexion JSONL au superviseur ; lit jusqu'à la réponse de l'id voulu."""

    def __init__(self, path: str) -> None:
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect(path)
        self.buf = b""
        self.n = 0
        self.events: List[Dict[str, Any]] = []

    def call(self, command: Dict[str, Any], timeout: float = 120.0) -> Dict[str, Any]:
        self.n += 1
        cid = f"spike-{self.n}"
        frame = {"type": "command", "id": cid, "protocol": PROTOCOL, "command": command}
        self.sock.sendall((json.dumps(frame) + "\n").encode())
        deadline = time.monotonic() + timeout
        while True:
            left = deadline - time.monotonic()
            if left <= 0:
                raise TimeoutError(f"{command['type']} sans réponse en {timeout:.0f}s")
            self.sock.settimeout(left)
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ConnectionError("socket fermé par le superviseur")
            self.buf += chunk
            while b"\n" in self.buf:
                line, self.buf = self.buf.split(b"\n", 1)
                if not line.strip():
                    continue
                msg = json.loads(line)
                if msg.get("type") == "response" and msg.get("id") == cid:
                    return msg
                self.events.append(msg)

    def close(self) -> None:
        self.sock.close()


def wait_socket(path: str, proc: subprocess.Popen, timeout: float = 30.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if os.path.exists(path):
            try:
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
                    s.connect(path)
                return
            except OSError:
                pass
        if proc.poll() is not None:
            raise RuntimeError(f"le superviseur s'est arrêté (code {proc.returncode})")
        time.sleep(0.2)
    raise TimeoutError("socket du superviseur indisponible")


def prime_pids(root: str) -> List[str]:
    """PIDs des processus dont la ligne de commande ou l'env référence la sandbox."""
    out = subprocess.run(["ps", "-axo", "pid=,command="], capture_output=True, text=True).stdout
    return [l.split()[0] for l in out.splitlines() if root in l and "daemon_spike.py" not in l]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bin", required=True)
    ap.add_argument("--uv-dir")
    ap.add_argument("--kernel-venv", default="/tmp/pas-kernel-venv")
    ap.add_argument("--env", action="append", metavar="CLE=VALEUR")
    ap.add_argument("--keep", action="store_true")
    ap.add_argument("--report")
    args = ap.parse_args()

    # realpath : sur macOS /tmp -> /private/tmp ; Prime canonicalise les chemins.
    root = os.path.realpath(tempfile.mkdtemp(prefix="pas-dmn-", dir="/tmp"))
    sock = os.path.join(root, "d.sock")
    flag = os.path.join(root, "spawned.flag")
    env = {
        "PATH": (args.uv_dir + os.pathsep if args.uv_dir else "") + os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": root,
        "PRIME_AGENT_TELEMETRY": "0", "DO_NOT_TRACK": "1", "PI_OFFLINE": "1",
        "PRIME_AGENT_KERNEL_VENV": args.kernel_venv,
        "PRIME_AGENT_INTERNAL_WORKER_SUPERVISOR_LOST_EXIT_MS": "15000",
    }
    for item in args.env or []:
        k, _, v = item.partition("=")
        env[k] = v

    # Même script pour parent et enfant (le daemon le propage via childScript).
    # Le fichier drapeau fait que seule la première exécution spawn : l'enfant
    # exécute la branche CHILD puis rend le texte final.
    cell = (
        "import os, asyncio\n"
        "from rlm import rlm as R\n"
        f"flag = {flag!r}\n"
        "if os.path.exists(flag):\n"
        "    print('CHILD_' + 'RAN')\n"
        "else:\n"
        "    open(flag, 'w').write('1')\n"
        "    try:\n"
        "        h = await R.spawn('child task', name='spike_child')\n"
        "        print('SPAWN_' + 'ADMITTED', h)\n"
        "        res = await R.collect(h, timeout_ms=120000)\n"
        "        for _ in range(240):\n"
        "            if all(r.settled for r in res):\n"
        "                break\n"
        "            await asyncio.sleep(0.5)\n"
        "            res = await R.collect(h, timeout_ms=5000)\n"
        "        print('COLL' + 'ECTED', res)\n"
        "    except Exception as e:\n"
        "        print('SPAWN_' + 'ERROR', type(e).__name__, e)\n"
    )
    script = {"engine": "faux", "responses": [
        {"content": [{"type": "toolCall", "name": "ipython", "arguments": {"code": cell}}]},
        {"text": "FINAL-TEXT"},
    ]}
    script_path = os.path.join(root, "script.json")
    with open(script_path, "w") as f:
        json.dump(script, f)

    log = open(os.path.join(root, "supervisor.log"), "w")
    proc = subprocess.Popen([args.bin, "--mode", "daemon", "--daemon-socket", sock], env=env, cwd=root,
                            stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                            start_new_session=True)
    report: Dict[str, Any] = {"sandbox": root}
    conn: Optional[DaemonConn] = None
    ok = False
    try:
        wait_socket(sock, proc)
        conn = DaemonConn(sock)
        t0 = time.monotonic()
        created = conn.call({"type": "create", "name": "spike-root",
                             "config": {"cwd": root, "script": script_path,
                                        # childScript : propagé aux enfants (sinon ils n'ont pas d'engine).
                                        "childScript": script_path}})
        report["create"] = {k: created.get(k) for k in ("success", "error")}
        data = created.get("data") or {}
        sid = data.get("activeSessionId") or data.get("id") or (data.get("session") or {}).get("activeSessionId")
        report["createDataKeys"] = sorted(data.keys())
        if not sid:
            raise RuntimeError(f"pas d'activeSessionId dans create : {json.dumps(created)[:400]}")
        report["activeSessionId"] = sid
        waited = conn.call({"type": "prompt_and_wait", "activeSessionId": sid, "message": "spawn a child"}, 600)
        report["promptAndWait"] = {"success": waited.get("success"), "error": waited.get("error"),
                                   "seconds": round(time.monotonic() - t0, 1)}
        # prompt_and_wait rend la main à l'admission ; la fin du tour ET de la
        # famille RLM s'attend avec wait_for_headless_completion + quiescence.
        done = conn.call({"type": "wait_for_headless_completion", "activeSessionId": sid,
                          "waitForRlmQuiescence": True}, 600)
        report["headlessCompletion"] = {"success": done.get("success"), "error": done.get("error"),
                                        "data": done.get("data"),
                                        "seconds": round(time.monotonic() - t0, 1)}
        children = conn.call({"type": "get_rlm_children", "activeSessionId": sid})
        report["rlmChildren"] = children.get("data")

        # Transcripts live côté worker : get_messages (parent + chaque enfant).
        transcripts: Dict[str, Any] = {}
        targets = [sid] + [c.get("activeSessionId") for c in (children.get("data") or {}).get("children", [])]
        for target in filter(None, targets):
            msgs = conn.call({"type": "get_messages", "activeSessionId": target})
            transcripts[target] = msgs.get("data") if msgs.get("success") else {"error": msgs.get("error")}
        with open(os.path.join(root, "transcripts.json"), "w") as f:
            json.dump(transcripts, f, ensure_ascii=False, indent=1)
        live = json.dumps(transcripts, ensure_ascii=False)

        files = glob.glob(os.path.join(root, ".prime", "agent", "**", "*.jsonl"), recursive=True)
        texts = {p: open(p, encoding="utf-8", errors="replace").read() for p in files}
        everything = "\n".join(texts.values()) + "\n" + live
        report["sessionFiles"] = [os.path.relpath(p, root) for p in files]
        report["spawnAdmitted"] = "SPAWN_ADMITTED" in everything
        report["childRan"] = "CHILD_RAN" in everything
        report["collected"] = "COLLECTED" in everything
        i = everything.find("SPAWN_ERROR")
        report["spawnError"] = everything[i:i + 300] if i >= 0 else None
        j = everything.find("COLLECTED")
        report["collectedExcerpt"] = everything[j:j + 400] if j >= 0 else None
        ok = report["spawnAdmitted"] and report["childRan"] and report["collected"]

        killed = conn.call({"type": "kill", "activeSessionId": sid})
        report["kill"] = {"success": killed.get("success"), "error": killed.get("error")}
        conn.call({"type": "shutdown"}, 30)
    except Exception as e:
        report["error"] = f"{type(e).__name__}: {e}"
    finally:
        if conn:
            conn.close()
        try:
            proc.wait(timeout=20)
        except subprocess.TimeoutExpired:
            proc.kill()
        time.sleep(1.0)
        leftovers = prime_pids(root)
        report["leftoverProcesses"] = leftovers
        if leftovers:
            ok = False
        log.close()
        if not args.keep:
            shutil.rmtree(root, ignore_errors=True)

    report["ok"] = ok
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if args.report:
        with open(args.report, "w") as f:
            json.dump(report, f, ensure_ascii=False, indent=2)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
