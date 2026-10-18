#!/usr/bin/env python3
"""
Head-to-head judge for a real pi session where both memory extensions ran.

Ground truth is the session transcript itself, serialized the way the incumbent
serializes it ("[Source entry id: X]" labels), so both arms are judged against
the identical chunk. Arm A/B labels are shuffled before judging.

Requires an external judge harness exposing a `judge.py` module with BASE/KEY/MODEL
and a rubric; point JUDGE_DIR at it (no default: this tool never reads a fixed path).

  python3 tools/ab-judge.py <run-dir> [--seed 7]

Expects <run-dir>/session.jsonl (pi export) and reads the pi-hy-memory bank
mirror from ~/.pi/agent/pi-hy-memory/state/sessions/<sessionId>.bank.json.
"""

import argparse
import json
import os
import random
import sys
from pathlib import Path

JUDGE_DIR = Path(os.environ.get("JUDGE_DIR", ""))
if not JUDGE_DIR.is_dir():
    raise SystemExit("set JUDGE_DIR to a directory containing judge.py and its rubric")
sys.path.insert(0, str(JUDGE_DIR))
import judge as J  # noqa: E402  (loads BASE/KEY/MODEL from the judge config)

STATE_DIR = Path(os.path.expanduser("~/.pi/agent/pi-hy-memory/state/sessions"))


def rows(path):
    out = []
    for line in Path(path).read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return out


def entry_list(rows):
    """pi export rows -> session entries, tolerant of wrapper shapes."""
    entries = []
    for row in rows:
        if isinstance(row, dict) and "entries" in row and isinstance(row["entries"], list):
            entries.extend(row["entries"])
        elif isinstance(row, dict) and row.get("type") in {"message", "custom", "custom_message", "compaction", "branch_summary", "model_change", "thinking_level_change", "label", "session_info"}:
            entries.append(row)
    return entries


def text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for part in content:
            if not isinstance(part, dict):
                continue
            if part.get("type") == "text":
                parts.append(part.get("text", ""))
            elif part.get("type") == "toolCall":
                parts.append(f"[called {part.get('name')} {json.dumps(part.get('arguments') or part.get('args') or {})[:240]}]")
        return "\n".join(parts).strip()
    return ""


def ground_truth(entries, max_entry_chars=3000):
    """Message entries -> the chunk, labelled the way the incumbent labels it."""
    blocks = []
    for entry in entries:
        if entry.get("type") != "message":
            continue
        message = entry.get("message") or {}
        role = message.get("role")
        if role in {"system", "developer"}:
            continue
        body = " ".join(text_of(message.get("content")).split())
        if not body:
            continue
        if role == "toolResult":
            head = f"[Tool result for {message.get('toolName', 'tool')}{' [error]' if message.get('isError') else ''}]"
        else:
            head = f"[{role.capitalize()}]"
        blocks.append(f"[Source entry id: {entry.get('id')}]\n{head} {body[:max_entry_chars]}")
    return "\n\n".join(blocks)


def arm_hy(session_id):
    bank_path = STATE_DIR / f"{session_id}.bank.json"
    if not bank_path.exists():
        return [], bank_path
    bank = json.loads(bank_path.read_text())
    obs = []
    for entry in bank:
        if entry.get("status") != "active":
            continue
        obs.append({
            "content": entry.get("statement", ""),
            "relevance": "medium",
            "sourceEntryIds": entry.get("sourceEntryIds", []),
        })
    return obs, bank_path

def arm_blackhole(entries):
    """pi-blackhole's durable memory: recorded observations minus drops, plus reflections."""
    observations = {}
    reflections = {}
    dropped = set()
    for entry in entries:
        if entry.get("type") != "custom":
            continue
        kind = entry.get("customType")
        data = entry.get("data") or {}
        if kind == "om.observations.recorded":
            for obs in data.get("observations") or []:
                observations[obs.get("id")] = obs
        elif kind == "om.observations.dropped":
            for oid in data.get("observationIds") or []:
                dropped.add(oid)
        elif kind == "om.reflections.recorded":
            for ref in data.get("reflections") or []:
                reflections[ref.get("id")] = ref
    active = []
    for oid, obs in observations.items():
        if oid in dropped:
            continue
        active.append({
            "content": obs.get("content", ""),
            "relevance": obs.get("relevance", "medium"),
            "sourceEntryIds": obs.get("sourceEntryIds", []),
        })
    for ref in reflections.values():
        active.append({
            "content": ref.get("content", ""),
            "relevance": "high",
            "sourceEntryIds": ref.get("supportingObservationIds", []),
        })
    stats = {"recorded": len(observations), "dropped": len(dropped), "reflections": len(reflections)}
    return active, stats

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("run_dir")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--max-tokens", type=int, default=None)
    ap.add_argument("--only", choices=("hy", "bh"), help="judge a single arm (solo runs)")
    args = ap.parse_args()

    run_dir = Path(args.run_dir)
    rows_ = rows(run_dir / "session.jsonl")
    entries = entry_list(rows_)
    session_id = None
    for row in rows_:
        if not isinstance(row, dict):
            continue
        if row.get("type") == "session" and isinstance(row.get("id"), str):
            session_id = row["id"]
            break
        for key in ("sessionId", "session_id"):
            if isinstance(row.get(key), str):
                session_id = row[key]
                break
        if session_id:
            break

    hy_obs, bank_path = arm_hy(session_id)
    bh_obs, bh_stats = arm_blackhole(entries)
    chunk = ground_truth(entries)

    print(f"session {session_id}")
    print(f"ground truth: {len(entries)} entries, {len(chunk)} chars (~{len(chunk)//4} tokens)")
    print(f"pi-hy-memory: {len(hy_obs)} active facts  ({bank_path})")
    print(f"pi-blackhole: {len(bh_obs)} active memories ({bh_stats})")

    cands = [("pi-hy-memory", hy_obs), ("pi-blackhole", bh_obs)]
    if args.only == "hy":
        cands = [c for c in cands if c[0] == "pi-hy-memory"]
    elif args.only == "bh":
        cands = [c for c in cands if c[0] == "pi-blackhole"]
    random.Random(args.seed).shuffle(cands)

    system = J.RUBRIC.read_text()
    out = {}
    for index, (name, obs) in enumerate(cands):
        label = chr(ord("A") + index)
        print(f"judging {name} as candidate {label} ({len(obs)} obs)...", flush=True)
        verdict, usage, seconds = J.judge(chunk, obs, label, system, args.max_tokens)
        print(f"  {seconds:.1f}s", flush=True)
        out[name] = {"label": label, "n_obs": len(obs), "judge": verdict, "judge_usage": usage, "judge_model": J.MODEL}

    (run_dir / "ab-judge.json").write_text(json.dumps(out, indent=1))
    for name, record in out.items():
        verdict = record["judge"]
        tally = {}
        for obs in verdict.get("observations", []):
            key = obs.get("verdict")
            tally[key] = tally.get(key, 0) + 1
        values = {}
        for obs in verdict.get("observations", []):
            values[obs.get("value")] = values.get(obs.get("value"), 0) + 1
        print(f"\n### {name} (candidate {record['label']})")
        print("  verdicts:", tally, " values:", values)
        print(f"  missed: {len(verdict.get('missed', []))}")
        for missed in verdict.get("missed", []):
            print("   -", missed.get("fact"))
        print("  overall:", verdict.get("overall"))
    print(f"\n-> {run_dir / 'ab-judge.json'}")


if __name__ == "__main__":
    main()
