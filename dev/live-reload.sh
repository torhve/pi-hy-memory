#!/bin/zsh
# Does a flushed fact survive the moment the conversation is thrown away?
#
# The cadence arms showed *when* a write happens and what it costs. They never showed the thing
# `hy_flush` is for: a fact that is durable before the token threshold reaches it, and still
# readable after the context that carried it is gone. Restarting a session is not memory loss —
# pi replays the branch, so a restart proves the bank reloads and nothing else. The loss mechanism
# here is compaction, which is also the path this extension takes over: with a non-empty bank the
# hook supplies the summary (`fromHook: true` in the session file), and with an empty one pi pays
# its own model to write prose instead.
#
# Two arms, same conversation, same writer:
#
#   flush-on   the session model may call `hy_flush`. `observeAfterTokens` is out of range, so the
#              threshold cannot write: a flush is the only way anything becomes durable.
#   flush-off  same conversation, no tool, threshold also out of range. Nothing is ever written, so
#              compaction falls back to pi's summariser.
#
# The conversation settles eight checkable specifics (a path, a file mode, a rejected alternative,
# a ticket id, two exit codes…) plus some chatter, and the session model's window is pinned small
# enough that pi compacts mid-session. The last turn asks for the decisions without re-reading
# them. Scored: how many specifics survive in the summary the next request actually carried, and
# how many the model can still name.
#
#   LIVE_MODEL=<provider/modelId> LIVE_ORIGIN=<host> LIVE_PORT=<port> dev/live-reload.sh
#
# Environment: LIVE_WRITER (a writer pi can resolve), LIVE_WRITER_ORIGIN / LIVE_WRITER_PORT when it
# lives on a different box (default: the session route), LIVE_RUNS (default 3),
# LIVE_WRITER_TIMEOUT (default 240000), LIVE_CONTEXT (session model window, default 8000),
# LIVE_RESERVE (pi's compaction reserveTokens, default 2000 — the threshold is window − reserve, so
# a large reserve makes compaction fire early), LIVE_ROOT (default /tmp/hy-reload).
# Hosts stay in the environment; nothing here names one.
set -u
REPO=$(cd "$(dirname "$0")/.." && pwd)
EXTENSION=${HY_MEMORY_EXTENSION:-$REPO/src/index.ts}
LLAMA_SWAP=${LLAMA_SWAP_EXTENSION:-$(cd "$REPO/.." && pwd)/pi-llama-swap/index.ts}
MODEL=${LIVE_MODEL:?LIVE_MODEL is required: provider/modelId for the session model}
ORIGIN=${LIVE_ORIGIN:?LIVE_ORIGIN is required: the host the session and writer routes live on}
PORT=${LIVE_PORT:-8080}
ROOT=${LIVE_ROOT:-/tmp/hy-reload}
WRITER=${LIVE_WRITER:-test/writer}
RUNS=${LIVE_RUNS:-3}
WRITER_TIMEOUT=${LIVE_WRITER_TIMEOUT:-240000}
CONTEXT=${LIVE_CONTEXT:-8000}
RESERVE=${LIVE_RESERVE:-2000}

# Eight specifics the compressed view has to keep, as substrings, plus the reasons that make them
# load-bearing rather than incidental.
MESSAGES=(
	"We are designing the settings layer for a small CLI called tctl, a single binary people install with brew. Reason out loud about where its config lives; I will push back. Constraints: the file must be editable by hand, it must be settings.toml so it matches the other tools in this family, and it must never be written while another instance holds it, so lock it with flock on every write. Respect XDG_CONFIG_HOME when set, otherwise fall back to ~/.config/tctl."
	"Good. Now I reject one alternative explicitly: YAML. We rejected YAML because tctl's config is a flat key list and a YAML parser is a dependency we would carry for twelve keys. Keep the rejection in the record, not just the choice. Next: permissions and the write strategy. Pick a file mode — 0o600, since the file will hold tokens — and say how you write it."
	"Before you continue, an incident from last spring: the ticket was MIGRATE-2024, and the failure was that a partial write left a truncated file that the next run silently re-created with defaults, so the user lost their settings and never noticed. Whatever you choose has to make a truncated file loud rather than quiet. Fold that into the rule."
	"Unrelated chatter: the coffee machine is being serviced Thursday and the standing meeting moved to Friday because the room is double-booked — ignore that for the design. Back to it: when the settings file exists but is unreadable or half-written, what should tctl do, and what should it exit with? Specific codes, not generic ones: exit code 3 for settings errors so scripts can tell them apart from usage errors, exit code 4 for lock contention."
	"One more thing to settle: an environment override. TOR_TOOL_SETTINGS points at an explicit path and wins over everything else, including XDG. State the precedence order in one line, highest to lowest, then restate every decision as a single rule a teammate could follow."
	"Now, without re-reading our conversation above, write a summary for someone who joined late: where tctl stores settings, in what format, what file mode and write strategy, which alternative we rejected and why, the ticket id of the incident, the two exit codes, the environment override, and the precedence order. If something is not available to you, say so rather than guessing."
)
PROBES=(
	"settings.toml"
	"XDG_CONFIG_HOME"
	"flock"
	"YAML"
	"MIGRATE-2024"
	"exit code 3"
	"TOR_TOOL_SETTINGS"
	"0o600"
)

mkdir -p "$ROOT/sessions" "$ROOT/work" "$ROOT/.pi/agent"
cat > "$ROOT/.pi/agent/settings.json" <<EOF
{
  "packages": [],
  "quietStartup": true,
  "compaction": { "enabled": true, "reserveTokens": $RESERVE, "keepRecentTokens": 1500 }
}
EOF
python3 - "$ROOT" "$MODEL" "$ORIGIN" "$PORT" "$CONTEXT" "$WRITER" "${LIVE_WRITER_ORIGIN:-$ORIGIN}" "${LIVE_WRITER_PORT:-$PORT}" <<'PY'
import json, os, sys

root, model, origin, port, context, writer, w_origin, w_port = sys.argv[1:9]
provider, _, model_id = model.partition("/")
w_provider, _, w_id = writer.partition("/")
agent = os.path.join(root, ".pi", "agent")
os.makedirs(agent, exist_ok=True)
instances = [
	{
		"id": provider,
		"origin": origin,
		"port": int(port),
		# `contextOverrides` is what pi-llama-swap reports as the model's window, which is what
		# pi's compaction rule measures against. Pinning it small is how this harness makes
		# compaction fire inside a short conversation.
		"contextOverrides": {model_id: int(context)},
	}
]
if w_id and w_provider and w_provider != provider:
	# The writer is usually a different box than the session model, so it needs its own route.
	instances.append({"id": w_provider, "origin": w_origin, "port": int(w_port)})
with open(os.path.join(agent, "pi-llama-swap.json"), "w") as fh:
	json.dump({"instances": instances}, fh, indent=2)
if not os.path.exists(os.path.join(agent, "auth.json")):
	with open(os.path.join(agent, "auth.json"), "w") as fh:
		json.dump({}, fh)
PY

arm() {
	local name=$1 flush=$2
	local cfg="$ROOT/config-$name.json" state="$ROOT/state-$name"
	mkdir -p "$state"
	cat > "$cfg" <<EOF
{
  "model": "$WRITER",
  "observeAfterTokens": 200000,
  "flushTool": $flush,
  "flushMinTokens": 0,
  "timeoutMs": $WRITER_TIMEOUT,
  "writeCooldownS": 0,
  "keepRecentTokens": 1500,
  "summaryMaxTokens": 3000
}
EOF
	for i in $(seq 1 "$RUNS"); do
		: > "$state/audit.ndjson"
		local sid=$(uuidgen | tr "A-Z" "a-z")
		local load=(--no-extensions -e "$EXTENSION")
		[[ -f "$LLAMA_SWAP" ]] && load+=(-e "$LLAMA_SWAP")
		(
			cd "$ROOT/work" && HOME=$ROOT PI_HY_MEMORY_CONFIG=$cfg PI_HY_MEMORY_STATE=$state \
				pi -p --mode json "${load[@]}" \
				--no-builtin-tools --no-skills --no-context-files --no-prompt-templates \
				--session-dir "$ROOT/sessions" --session-id "$sid" \
				--model "$MODEL" -- "${MESSAGES[@]}" > "$ROOT/$name-$i.json" 2> "$ROOT/$name-$i.err"
		)
		local session_file
		session_file=$(printf '%s\n' "$ROOT/sessions"/*"$sid"*.jsonl(N) | head -1)
		python3 - "$name" "$i" "$ROOT/$name-$i.json" "$state" "$session_file" "${PROBES[@]}" <<'PY'
import json, os, sys

name, i, transcript, state, session_file = sys.argv[1:6]
probes = sys.argv[6:]


def rows(path):
    out = []
    if not path or not os.path.isfile(path):
        return out
    with open(path) as fh:
        for line in fh:
            line = line.strip()
            if line:
                try:
                    out.append(json.loads(line))
                except Exception:
                    pass
    return out


def text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(p.get("text", "") for p in content if isinstance(p, dict))
    return ""


events = rows(transcript)
audit = rows(os.path.join(state, "audit.ndjson"))

# The compressed view the last request carried is the summary recorded in the session file.
# `fromHook` says who wrote it: this extension's bank render, or pi's summariser model.
compactions = [e for e in rows(session_file) if e.get("type") == "compaction"]
summary = text(compactions[-1].get("summary")) if compactions else ""
from_hook = bool(compactions and compactions[-1].get("fromHook"))

tool_calls = [e for e in events if e.get("type") == "tool_execution_start"]
flush_calls = sum(1 for e in tool_calls if e.get("toolName") == "hy_flush")
recall_calls = sum(1 for e in tool_calls if e.get("toolName") == "hy_recall")
writes = [a for a in audit if a.get("event") == "write_end"]
writer_tokens = sum((a.get("inTokens") or 0) + (a.get("outTokens") or 0) for a in writes)
facts = sum(a.get("added") or 0 for a in writes)

final = ""
for e in events:
    if e.get("type") == "message_end":
        m = e.get("message") or {}
        if m.get("role") == "assistant":
            final = text(m.get("content"))

answer_hits = [p for p in probes if p.lower() in final.lower()]
summary_hits = [p for p in probes if p.lower() in summary.lower()]
print(
    f"{name} {i}: compactions {len(compactions)} fromHook={from_hook} | summary keeps "
    f"{len(summary_hits)}/{len(probes)} | answer keeps {len(answer_hits)}/{len(probes)} | "
    f"writes {len(writes)} writer {writer_tokens} tok / {round(sum(a.get('wallS') or 0 for a in writes))}s | "
    f"facts {facts} | flush {flush_calls} | recall {recall_calls}"
)
print(f"   missing from summary: {[p for p in probes if p not in summary_hits]}")
print(f"   missing from answer:  {[p for p in probes if p not in answer_hits]}")
PY
	done
}

arm flush-on true
arm flush-off false
