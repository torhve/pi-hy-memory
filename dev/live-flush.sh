#!/bin/zsh
# Live step for hy_flush: does a quantized session model actually call it, and does
# it need the listing before it can name a range?
#
# The corpus cannot answer this: its boundaries are already fixed and no session model
# is involved. `tools/flush-tool-check.ts` proves the wiring accepts a call. This runs
# pi headless against a real local model with the extension loaded, and the writer is a
# model id that does not resolve, so nothing lands in a bank and no writer slot is
# touched — the measurement is the call, not the write.
#
# Two arms, same prompt, same model, same sandbox: `flush` on (the shipped default) and
# off (no tool registered at all). The audit file is the record; the JSON transcript is
# the argument list.
#
#   LIVE_MODEL=<provider/modelId> dev/live-flush.sh
#
# Nothing here reads the live config: HOME points at a scratch directory whose settings
# load no packages, and PI_HY_MEMORY_CONFIG / PI_HY_MEMORY_STATE point at scratch files.
set -u
REPO=$(cd "$(dirname "$0")/.." && pwd)
EXTENSION=${HY_MEMORY_EXTENSION:-$REPO/src/index.ts}
LLAMA_SWAP=${LLAMA_SWAP_EXTENSION:-$(cd "$REPO/.." && pwd)/pi-llama-swap/index.ts}
MODEL=${LIVE_MODEL:?LIVE_MODEL is required: provider/modelId for the session model}
ROOT=${LIVE_ROOT:-/tmp/hy-live}
PROMPT='You are deciding how a small CLI tool should store its settings. Pick a file location, a format, and the behaviour when the file is missing. Then state the decision and the reason for each choice.'
WRITER=${LIVE_WRITER:-test/writer}

mkdir -p "$ROOT/sessions" "$ROOT/work"

arm() {
	local name=$1 flush=$2
	local cfg="$ROOT/config-$name.json" state="$ROOT/state-$name"
	mkdir -p "$state"
	cat > "$cfg" <<EOF
{
  "model": "$WRITER",
  "observeAfterTokens": 200000,
  "timeoutMs": 2000,
  "writeCooldownS": 0,
  "flushTool": $flush
}
EOF
	for i in 1 2 3; do
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
				--model "$MODEL" -- "$PROMPT" > "$ROOT/$name-$i.json" 2> "$ROOT/$name-$i.err"
		)
		python3 - "$name" "$i" "$ROOT/$name-$i.json" "$state/audit.ndjson" <<'PY'
import json, sys, collections

name, i, transcript, audit_path = sys.argv[1:5]


def events(path):
    out = []
    try:
        for line in open(path):
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except Exception:
                pass
    except FileNotFoundError:
        pass
    return out


calls = []
for e in events(transcript):
    if e.get("type") == "tool_execution_start":
        calls.append((e.get("toolName"), e.get("args")))
audit = []
try:
    for line in open(audit_path):
        line = line.strip()
        if line:
            audit.append(json.loads(line))
except FileNotFoundError:
    pass

flushed = [a for a in audit if a.get("event") == "hy_flush"]
refused = [a for a in audit if a.get("event") == "flush_skipped"]
tools = collections.Counter(n for n, _ in calls)
print(f"{name} {i}: tool calls {dict(tools)} | accepted writes {len(flushed)} | refused {len(refused)}")
for n, args in calls:
    print(f"   {n} {json.dumps(args)[:120]}")
for a in flushed:
    print(
        f"   accepted to={a.get('requestedTo')} applied={a.get('applied')} entries={a.get('entries')} chunkTokens={a.get('chunkTokens')}"
    )
for a in refused:
    print(f"   refused reason={a.get('reason')} to={a.get('to')}")
PY
	done
}

arm flush-on true
arm flush-off false
