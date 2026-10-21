#!/bin/zsh
# Who writes first: the session model or the token threshold?
#
# `dev/live-flush.sh` showed the model calls `hy_flush` when the tool exists, but its control had a
# threshold that could never fire, so it says nothing about the shipped cadence. This runs a
# multi-turn session and compares three configurations over the same four-message conversation:
#
#   flush-only      model-initiated writes only (threshold raised out of range)
#   threshold-only token threshold only (no flush tool registered)
#   both            the shipped default: whichever arrives first
#
# The writer is a model id that does not resolve, so every arm fails its writes identically and what
# is measured is when a write was attempted and how much of the transcript it carried — not bank
# quality, which the corpus harness measures.
#
#   LIVE_MODEL=<provider/modelId> dev/live-cadence.sh
#
# Environment: LIVE_THRESHOLD (default 1200) is the threshold arms' `observeAfterTokens`;
# LIVE_RUNS (default 3) is runs per arm.
set -u
REPO=$(cd "$(dirname "$0")/.." && pwd)
EXTENSION=${HY_MEMORY_EXTENSION:-$REPO/src/index.ts}
LLAMA_SWAP=${LLAMA_SWAP_EXTENSION:-$(cd "$REPO/.." && pwd)/pi-llama-swap/index.ts}
MODEL=${LIVE_MODEL:?LIVE_MODEL is required: provider/modelId for the session model}
ROOT=${LIVE_ROOT:-/tmp/hy-live}
WRITER=${LIVE_WRITER:-test/writer}
THRESHOLD=${LIVE_THRESHOLD:-1200}
RUNS=${LIVE_RUNS:-3}

MESSAGES=(
	"Pick where a small CLI tool should store its settings and in what format. Give the reason."
	"Now decide what happens when that file is missing or unreadable. Give the reason, then restate the two decisions as one rule."
	"Name one thing a future session must not re-litigate, and one thing still undecided."
	"Write the final rule in a single sentence a teammate could follow."
)

mkdir -p "$ROOT/sessions" "$ROOT/work"

arm() {
	local name=$1 flush=$2 observe=$3
	local cfg="$ROOT/config-$name.json" state="$ROOT/state-$name"
	mkdir -p "$state"
	cat > "$cfg" <<EOF
{
  "model": "$WRITER",
  "observeAfterTokens": $observe,
  "timeoutMs": 2000,
  "writeCooldownS": 0,
  "flushTool": $flush
}
EOF
	for i in $(seq 1 "$RUNS"); do
		# Fresh audit per run: the state directory is shared, so without this the counts of the
		# previous run would be read as this run's.
		: > "$state/audit.ndjson"
		local load=(--no-extensions -e "$EXTENSION")
		[[ -f "$LLAMA_SWAP" ]] && load+=(-e "$LLAMA_SWAP")
		(
			cd "$ROOT/work" && HOME=$ROOT PI_HY_MEMORY_CONFIG=$cfg PI_HY_MEMORY_STATE=$state \
				pi -p --mode json "${load[@]}" \
				--no-builtin-tools --no-skills --no-context-files --no-prompt-templates \
				--no-session --session-dir "$ROOT/sessions" \
				--model "$MODEL" -- "${MESSAGES[@]}" > "$ROOT/$name-$i.json" 2> "$ROOT/$name-$i.err"
		)
		python3 - "$name" "$i" "$ROOT/$name-$i.json" "$state/audit.ndjson" "$THRESHOLD" <<'PY'
import json, sys
from datetime import datetime

name, i, transcript_path, audit_path, threshold = sys.argv[1:6]


def rows(path):
    out = []
    try:
        for line in open(path):
            line = line.strip()
            if line:
                try:
                    out.append(json.loads(line))
                except Exception:
                    pass
    except FileNotFoundError:
        pass
    return out


# pi's turn events carry no timestamps, but every message does. Position in the message stream is
# therefore the turn coordinate: a write audited at time ts belongs to the turn whose messages had
# already been emitted when it started.
timeline = []
turns = 0
seen = 0
flush_at = []
for e in rows(transcript_path):
    t = e.get("type")
    if t == "turn_start":
        turns += 1
    elif t == "message_end":
        ts = (e.get("message") or {}).get("timestamp")
        if ts:
            timeline.append(ts)
        seen += 1
    elif t == "tool_execution_start" and e.get("toolName") == "hy_flush":
        flush_at.append((seen, (e.get("args") or {}).get("to")))


def epoch(iso):
    return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp() * 1000


def position(ms):
    return sum(1 for ts in timeline if ts <= ms)


audit = rows(audit_path)
starts = [a for a in audit if a.get("event") == "write_start"]
flushed = [a for a in audit if a.get("event") == "hy_flush"]
refused = [a for a in audit if a.get("event") == "flush_skipped"]
deferred = [a for a in audit if a.get("event") in ("write_deferred", "write_cooldown")]

write_at = [position(epoch(a["ts"])) for a in starts]
print(
    f"{name} {i}: messages {seen} | writes {len(starts)} after message {write_at} | "
    f"written {sum(a.get('chunkTokens') or 0 for a in starts)} tokens | "
    f"flush calls {len(flush_at)} after message {[p for p, _ in flush_at]} | "
    f"refused {len(refused)} | deferred {len(deferred)} | threshold {threshold}"
)
for a in flushed:
    print(
        f"   flush to={a.get('requestedTo')} applied={a.get('applied')} entries={a.get('entries')} "
        f"chunkTokens={a.get('chunkTokens')} windowTokens={a.get('windowTokens')}"
    )
PY
	done
}

arm flush-only true 200000
arm threshold-only false "$THRESHOLD"
arm both true "$THRESHOLD"
