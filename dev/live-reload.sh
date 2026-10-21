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
#   flush-on   the session model may call `hy_flush`. `observeAfterTokens` is out of range, so the
#              threshold cannot write: a flush is the only way anything becomes durable. The token
#              floor is the shipped 2 000 tokens: at 0 the model flushed almost every turn and the arm
#              ran out of wall clock before the closing question. A filler turn is ~1 200 tokens, so
#              the floor still admits a flush every second turn — the treatment is flush-vs-no-flush.
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
# LIVE_WRITER_TIMEOUT (default 240000), LIVE_CONTEXT (session model window, default 20000),
# LIVE_MAX_TOKENS (output budget for the session model, default 4000),
# LIVE_RESERVE (pi's compaction reserveTokens, default 6000 — the threshold is window − reserve, so
# a large reserve makes compaction fire early), LIVE_ROOT (default /tmp/hy-reload), LIVE_ARMS
# (which arms to run, default `on off` — one process per arm overlaps them).
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
# The window has to be wide enough that the cut lands *after* the design turns. At 20 000 with a
# 6 000 reserve the threshold is 14 000, which the five design answers cross on their own: the cut
# then fell inside the design, and the answers that followed it restated every decision. At 30 000
# the threshold is 24 000, which the design turns (~12 000 tokens) stay under and the notifyd turns
# push past.
CONTEXT=${LIVE_CONTEXT:-30000}
RESERVE=${LIVE_RESERVE:-6000}
# The session model emits a thinking block as content even with `--thinking off` — measured at up to
# 2 100 tokens per turn — so a window that only covers the prose leaves pi no output budget at all:
# the last request came back `stopReason: length, output: 1`, which is why an arm scored 0/8 answers.
# Output is pinned so thinking cannot spend the whole window.
MAX_TOKENS=${LIVE_MAX_TOKENS:-4000}
# A session that thrashes compaction would otherwise run until the harness timeout: one pi run is
# A session that thrashes compaction would otherwise run until the harness timeout: one pi run is
# cut off here and the run is reported with its exit code rather than silently missing. Nine turns on
# a quantized model at a 30 000-token context, plus one tool turn per flush and recall, is past 20
# minutes, and every run that ended at rc=124 never reached the closing question.
SESSION_TIMEOUT=${LIVE_SESSION_TIMEOUT:-3600}
# Thinking off by default: a reasoning model spends thousands of tokens per answer, which makes the
# request overflow on output rather than compact on the threshold the experiment is about.
THINKING=${LIVE_THINKING:-off}
# Which arms to run: `on`, `off`, or both. One process per arm overlaps them.
ARMS=${LIVE_ARMS:-on off}

# Eight specifics the compressed view has to keep, as substrings, plus the reasons that make them
# load-bearing rather than incidental.
# Bulk that carries the session past the compaction threshold and contains no design content, so
# what the summary is asked to drop is mostly noise.
VERBS=(read lock write stat reload parse fsync rename)
STATUSES=(ok would-block short-read enoent partial-write retry stale-handle ignored)
FILLER=""
for i in {1..40}; do
	FILLER+="2026-04-$(( (i % 28) + 1 ))T0$((i % 9)):$((10 + (i % 49)))Z notifyd[$((800 + i))] dispatch: ${VERBS[((i % 8) + 1)]} ${STATUSES[((i % 8) + 1)]} bytes=$((300 + i * 17)) uid=$((i % 2 == 0 ? 1000 : 0))"$'\n'
done
MESSAGES=(
	"We are designing the settings layer for a small CLI called tctl, a single binary people install with brew. Reason out loud about where its config lives; I will push back. Constraints: the file must be editable by hand, it must be settings.toml so it matches the other tools in this family, and it must never be written while another instance holds it, so lock it with flock on every write. Respect XDG_CONFIG_HOME when set, otherwise fall back to ~/.config/tctl."
	"Good. Now I reject one alternative explicitly: YAML. We rejected YAML because tctl's config is a flat key list and a YAML parser is a dependency we would carry for twelve keys. Keep the rejection in the record, not just the choice. Next: permissions and the write strategy. Pick a file mode — 0o600, since the file will hold tokens — and say how you write it."
	"Before you continue, an incident from last spring: the ticket was MIGRATE-2024, and the failure was that a partial write left a truncated file that the next run silently re-created with defaults, so the user lost their settings and never noticed. Whatever you choose has to make a truncated file loud rather than quiet. Fold that into the rule."
	"Unrelated chatter: the coffee machine is being serviced Thursday and the standing meeting moved to Friday because the room is double-booked — ignore that for the design. Back to it: when the settings file exists but is unreadable or half-written, what should tctl do, and what should it exit with? Specific codes, not generic ones: exit code 3 for settings errors so scripts can tell them apart from usage errors, exit code 4 for lock contention."
	"One more thing to settle: an environment override. TOR_TOOL_SETTINGS points at an explicit path and wins over everything else, including XDG. State the precedence order in one line, highest to lowest, then restate every decision as a single rule a teammate could follow."
	# Three turns on an unrelated service. They carry the bulk that pushes the context past the
	# threshold, so the cut lands here — and because they are about something else, the answers that
	# survive the cut cannot restate the design decisions, which is what made the last runs unscorable.
	"Switching to a different task, and tctl is not part of it: this is notifyd's dispatch log from last night. Which lines show a retry loop rather than a clean run, and which show a permission problem? Answer only about notifyd, and do not bring up the earlier design discussion.
$FILLER"
	"In that same log, which lines suggest the queue was full rather than the worker being slow? Keep it to notifyd."
	"Last one on notifyd: does anything here indicate a write that stopped short of its intended size, or a queue that drained cleanly? notifyd only."
	"Now, without re-reading our conversation above and without opening any files, write a short handover note for someone who joined late: where the tool keeps its configuration, in what format, what permissions and write strategy it uses, which format we turned down and for what reason, the reference from the incident we learned from, the two numeric statuses a script can branch on, the environment override, and the order the locations are checked in. If something is not available to you, say so rather than guessing."
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
python3 - "$ROOT" "$MODEL" "$ORIGIN" "$PORT" "$CONTEXT" "$MAX_TOKENS" "$WRITER" "${LIVE_WRITER_ORIGIN:-$ORIGIN}" "${LIVE_WRITER_PORT:-$PORT}" <<'PY'
import json, os, sys

root, model, origin, port, context, max_tokens, writer, w_origin, w_port = sys.argv[1:10]
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
		# Capabilities carry the output budget. The model spends up to 2 100 tokens thinking per turn
		# regardless of the thinking level, so leaving the budget at half the window means a request
		# can arrive with nothing left to answer with.
		"modelCapabilities": {model_id: {"contextWindow": int(context), "maxTokens": int(max_tokens)}},
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
  "flushMinTokens": 2000,
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
				timeout "$SESSION_TIMEOUT" pi -p --mode json "${load[@]}" \
				--no-builtin-tools --no-skills --no-context-files --no-prompt-templates \
				--session-dir "$ROOT/sessions" --session-id "$sid" \
				--model "$MODEL" --thinking "$THINKING" -- "${MESSAGES[@]}" > "$ROOT/$name-$i.json" 2> "$ROOT/$name-$i.err"
		)
		local rc=$?
		local session_file
		session_file=$(printf '%s\n' "$ROOT/sessions"/*"$sid"*.jsonl(N) | head -1)
		python3 - "$name" "$i" "$ROOT/$name-$i.json" "$state" "$session_file" "$rc" "${PROBES[@]}" <<'PY'
import json, os, sys
from datetime import datetime

name, i, transcript, state, session_file, rc = sys.argv[1:7]
probes = sys.argv[7:]


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
entry_rows = rows(session_file)
compactions = [e for e in entry_rows if e.get("type") == "compaction"]
summary = text(compactions[-1].get("summary")) if compactions else ""
from_hook = bool(compactions and compactions[-1].get("fromHook"))
kept_id = compactions[-1].get("firstKeptEntryId") if compactions else None
kept_index = next((n for n, e in enumerate(entry_rows) if e.get("id") == kept_id), None) if kept_id else None


def blob(entry):
    message = entry.get("message")
    if message:
        return text(message.get("content"))
    return json.dumps(entry.get("summary") or entry.get("data") or entry.get("value") or "")


prefix_rows = entry_rows[:kept_index] if kept_index is not None else entry_rows
# Only what the model actually receives counts. A `custom` entry is metadata — pi does not put it in
# the request — so counting the extension's own extract records would mark its drafts as remembered.
# Tool results are the bank being retrieved, which is the treatment working, not history that
# escaped the cut. And the summary is the thing being scored, so it cannot be its own evidence.
def visible(entry):
    if entry.get("type") in ("compaction", "custom"):
        return False
    return (entry.get("message") or {}).get("role") != "toolResult"


tail_rows = [e for e in entry_rows[kept_index:] if visible(e)] if kept_index is not None else []
prefix_rows = [e for e in entry_rows[:kept_index] if visible(e)] if kept_index is not None else entry_rows
prefix_text = "\n".join(blob(e) for e in prefix_rows)
tail_text = "\n".join(blob(e) for e in tail_rows)
# A probe is only scoreable if the conversation settled it before the cut, and a probe the kept tail
# still carries verbatim scores nothing: reading it off surviving context is not surviving compaction.
settled = [p for p in probes if p.lower() in prefix_text.lower()]
tail_leak = [p for p in settled if p.lower() in tail_text.lower()]

tool_calls = [e for e in events if e.get("type") == "tool_execution_start"]
flush_calls = sum(1 for e in tool_calls if e.get("toolName") == "hy_flush")
recall_calls = sum(1 for e in tool_calls if e.get("toolName") == "hy_recall")
writes = [a for a in audit if a.get("event") == "write_end"]
trim_events = sum(1 for a in audit if a.get("event") == "compact_trimmed")


def stamp(value):
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except Exception:
        return None


comp_stamp = stamp(compactions[-1].get("timestamp")) if compactions else None
# The treatment arm only counts as treated if a write landed before the cut that discarded the
# conversation; a flush that arrived afterwards proves nothing about survival.
writes_before = [a for a in writes if comp_stamp is None or (stamp(a.get("ts")) or 0) <= comp_stamp]
last_compact_event = max((n for n, e in enumerate(events) if e.get("type") == "compaction_end"), default=-1)
# Retrieval after the cut is legitimate product behaviour, but it is a different claim from the
# summary carrying the decision, so it is counted separately rather than folded into the score.
recall_after = sum(
    1
    for n, e in enumerate(events)
    if n > last_compact_event
    and e.get("type") == "tool_execution_start"
    and e.get("toolName") == "hy_recall"
)
writer_tokens = sum((a.get("inTokens") or 0) + (a.get("outTokens") or 0) for a in writes)
facts = sum(a.get("added") or 0 for a in writes)

# The answer to score is what came back after the final question. The model's last messages are
# often tool calls with no text at all, and scoring those scored 0/8 in both arms of the smoke run.
seq = []
for e in events:
    if e.get("type") == "message_end":
        m = e.get("message") or {}
        if m.get("role") in ("user", "assistant"):
            t = text(m.get("content"))
            if t.strip():
                seq.append((m.get("role"), t))
last_question = max((i for i, (role, _) in enumerate(seq) if role == "user"), default=-1)
final = " ".join(t for role, t in seq[last_question + 1:] if role == "assistant")
# A probe the question itself names can be echoed rather than remembered, so it is not scored.
question = seq[last_question][1] if last_question >= 0 else ""
asked = [p for p in settled if p.lower() not in question.lower()]
answer_hits = [p for p in asked if p.lower() in final.lower()]
summary_hits = [p for p in settled if p.lower() in summary.lower()]
print(
    f"{name} {i}: rc={rc} compactions {len(compactions)} (trim {trim_events}) fromHook={from_hook} | "
    f"summary keeps {len(summary_hits)}/{len(settled)} | answer keeps {len(answer_hits)}/{len(asked)}"
    f"{' (retrieval-assisted)' if recall_after else ''} | "
    f"writes {len(writes)} ({len(writes_before)} before the cut) writer {writer_tokens} tok / "
    f"{round(sum(a.get('wallS') or 0 for a in writes))}s | facts {facts} | "
    f"flush {flush_calls} | recall {recall_calls} ({recall_after} after the cut)"
)
# What the cut actually left behind, in the units pi's threshold is written in. If this is larger
# than keepRecentTokens, the harness did not discard what it claims to have discarded.
tail_tokens = sum(len(blob(e)) for e in tail_rows) // 4
print(f"   settled {len(settled)}/{len(probes)}, verbatim in kept tail {len(tail_leak)} {tail_leak}")
print(f"   visible tail: {len(tail_rows)} entries ~{tail_tokens} tokens (keepRecentTokens 1500)")
print(f"   missing from summary: {[p for p in settled if p not in summary_hits]}")
print(f"   missing from answer:  {[p for p in asked if p not in answer_hits]}")
if compactions and name == "flush-on" and not writes_before:
    print("   INVALID: the treatment arm compacted before any write landed")
if tail_leak:
    print("   SUSPECT: the kept tail still carries a probe verbatim, so that one was never discarded")
PY
	done
}

# Arms run sequentially here; launch one process per arm with `LIVE_ARMS` to overlap them, which is
# how this is normally run — a flush-on session spends most of its wall clock on the writer.
for name in ${=ARMS}; do
	arm "flush-$name" "$([[ $name == on ]] && echo true || echo false)"
done
