#!/usr/bin/env python3
"""
Compaction takeover test: run a real session in RPC mode with pi-hy-memory
loaded, let the bank fill, then force /compact and record what pi wrote.

  SEED_DIR=<dir with calc.py and test_calc.py> python3 dev/compact-test.py <run-dir>

Writes <run-dir>/rpc.jsonl (every protocol record), <run-dir>/session.jsonl
(pi export), and prints the compaction entry pi persisted.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

AUDIT = Path(os.environ.get("PI_HY_MEMORY_STATE", os.path.expanduser("~/.pi/agent/pi-hy-memory/state"))) / "audit.ndjson"
EXT = os.path.expanduser("~/.pi/agent/pi-hy-memory/src/index.ts")
LIVE_CONFIG = os.path.expanduser("~/.pi/agent/pi-hy-memory.json")
# Deliberately NOT the same model/server as the live session: two clients on one
# llama.cpp slot evict each other's KV cache and the user sees cache misses.
SESSION_MODEL = os.environ.get("COMPACT_TEST_MODEL", "deepseek/deepseek-v4-flash")

TASK = """Work in this Python project. Do all of the following in order.
1. Fix the bug in calc.py: add() currently subtracts.
2. Add divide(a, b) that raises ValueError on division by zero, and add tests for it.
3. Run the tests with `python3 -m unittest` and make sure everything passes.
4. We initially agreed to keep everything in a single calc.py file. After step 3, change course: split the module into a package `calc/` with `calc/__init__.py` and `calc/operations.py`, keep `from calc import add` working, and update the tests.
5. Add README.md documenting the API, and note that the deploy API key sk-SECRET-12345 must never be committed to this repository.
"""

FOLLOWUP = "Before anything else, restate what we have established in this session so far, then add a subtract(a, b) function with a test and run the tests."


def audit_session_id(after_ts: float) -> str | None:
    last = None
    for line in AUDIT.read_text().splitlines():
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if row.get("event") == "session_start":
            last = row.get("sessionId")
    return last


def audit_has_write_end(session_id: str) -> bool:
    if not AUDIT.exists():
        return False
    for line in AUDIT.read_text().splitlines():
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if row.get("event") == "write_end" and row.get("sessionId") == session_id:
            return True
    return False


def main():
    run_dir = Path(sys.argv[1])
    run_dir.mkdir(parents=True, exist_ok=True)
    proj = run_dir / "proj"
    proj.mkdir(exist_ok=True)
    seed = os.environ.get("SEED_DIR")
    if not seed:
        raise SystemExit("set SEED_DIR to a directory holding calc.py and test_calc.py")
    for name in ("calc.py", "test_calc.py"):
        (proj / name).write_text((Path(seed) / name).read_text())

    # Own config + state: a test must never rewrite the cadence of a live session,
    # and the writer's model must not be swapped in on a server the user is using.
    cfg = json.loads(Path(LIVE_CONFIG).read_text())
    cfg["observeAfterTokens"] = 600
    (run_dir / "hy-config.json").write_text(json.dumps(cfg, indent=1))
    env = dict(os.environ)
    env["PI_HY_MEMORY_CONFIG"] = str(run_dir / "hy-config.json")
    env["PI_HY_MEMORY_STATE"] = str(run_dir / "state")

    started = time.time()
    proc = subprocess.Popen(
        ["pi", "--mode", "rpc", "--no-extensions", "-e", EXT, "--model", SESSION_MODEL],
        cwd=proj,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=env,
    )

    records = []
    lock = threading.Lock()

    def reader():
        for line in proc.stdout:
            line = line.strip()
            if not line:
                continue
            with lock:
                records.append(line)
            try:
                kind = json.loads(line).get("type")
            except json.JSONDecodeError:
                kind = "?"
            print(f"[rpc] {kind}", flush=True)

    threading.Thread(target=reader, daemon=True).start()

    def write_command(payload):
        proc.stdin.write(json.dumps(payload) + "\n")
        proc.stdin.flush()

    write_command({"id": "req-1", "type": "prompt", "message": TASK})

    session_id = None
    deadline = time.time() + 900
    compacted = False
    cursor = 0
    settled = False
    while time.time() < deadline:
        with lock:
            tail = records[cursor:]
            cursor = len(records)
        for line in tail:
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            if row.get("type") == "agent_settled":
                settled = True
        if settled and not compacted:
            session_id = audit_session_id(started)
            # wait for the bank write to land before compacting, so the summary has facts
            for _ in range(60):
                if session_id and audit_has_write_end(session_id):
                    break
                time.sleep(2)
            write_command({"id": "req-2", "type": "compact"})
            compacted = True
            settled = False
            continue
        if compacted and settled:
            break
        time.sleep(1)

    write_command({"type": "get_state"})
    time.sleep(2)
    write_command({"type": "exit"})
    try:
        proc.wait(timeout=30)
    except subprocess.TimeoutExpired:
        proc.kill()

    (run_dir / "rpc.jsonl").write_text("\n".join(records) + "\n")
    if session_id is None:
        session_id = audit_session_id(started)
    sessions = sorted(Path(os.path.expanduser("~/.pi/agent/sessions")).rglob(f"*{session_id}*.jsonl")) if session_id else []
    if sessions:
        (run_dir / "session.jsonl").write_text(sessions[-1].read_text())
        print(f"session file: {sessions[-1]}")
    else:
        print(f"session file not found for {session_id}")
    print(f"\nsession {session_id}")
    compactions = []
    for line in (run_dir / "session.jsonl").read_text().splitlines():
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        entry = row.get("entry") if isinstance(row.get("entry"), dict) else row
        if entry.get("type") == "compaction":
            compactions.append(entry)
    if not compactions:
        print("NO compaction entry found in the export")
    for entry in compactions:
        summary = entry.get("summary", "")
        print(f"--- compaction entry: tokensBefore={entry.get('tokensBefore')} details={json.dumps(entry.get('details'))}")
        print(f"summary ({len(summary)} chars):\n{summary[:1500]}")
    print(f"\n-> {run_dir}/rpc.jsonl, {run_dir}/session.jsonl")


if __name__ == "__main__":
    main()
