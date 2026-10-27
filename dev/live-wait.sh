#!/bin/zsh
# Live step for the compaction wait: does a real session actually wait for the writer before it
# hands a compaction to pi's summariser, and does it then compact at the cursor that write left?
#
# `tools/compaction-wait-check.ts` proves the hook waits against a stubbed writer, and
# `dev/live-wait-replay.ts` shows 40 past deferrals that had a write in flight. Neither is a
# observation. This drives one real pi session over RPC and asks for the compaction at a chosen
# moment, so the answer is an audit line rather than an argument.
#
#   LIVE_MODEL=<provider/modelId> dev/live-wait.sh
#
# Two prompts, deliberately. The first is allowed to finish its write, because a wait needs a completed
# write behind it to price an ETA at all. The second reads enough that the backlog past the watermark
# ends up larger than `maxChunkTokens` — the only case where a compaction wants to drop unread entries
# — and leaves a chunk running. The driver asks for the compaction when the audit shows that chunk's
# reconcile stage opening, which is where the stage-aware estimate reads inside `compactWaitMs` and
# where pi is idle enough to answer the request at once. Asking earlier is the informative negative
# case: the estimate says the write is too far away, the wait skips, and pi pays for its own summary
# anyway, which is what the skip line exists to say.
#
# HOME is a scratch directory whose settings load no packages, so the live config and the installed
# packages are not what runs. The provider instance config and auth are symlinked from the real
# agent directory — symlinked, not copied, so no credential lands in the scratch tree — because the
# writer has to actually resolve here: a writer that does not resolve would skip the wait as
# unhealthy and prove nothing. PI_HY_MEMORY_CONFIG and PI_HY_MEMORY_STATE point at scratch files,
# so the live bank is untouched.

set -u
REPO=$(cd "$(dirname "$0")/.." && pwd)
EXTENSION=${HY_MEMORY_EXTENSION:-$REPO/src/index.ts}
LLAMA_SWAP=${LLAMA_SWAP_EXTENSION:-$(cd "$REPO/.." && pwd)/pi-llama-swap/index.ts}
MODEL=${LIVE_MODEL:?LIVE_MODEL is required: provider/modelId for the session model}
WRITER=${LIVE_WRITER:-kitxai/hy-memory-30b-a3b}
ROOT=${LIVE_ROOT:-/tmp/hy-live-wait}
AGENT_DIR=${LIVE_AGENT_DIR:-$HOME/.pi/agent}

# Each prompt must leave more conversation than `observeAfterTokens`, so a chunk starts on its own.
PROMPT_1='Read README.md and DESIGN.md with the read tool, whole files, then summarise each in ten bullets. Do not edit anything.'
PROMPT_2='Read src/index.ts and src/lag.ts and tools/compaction-wait-check.ts with the read tool, whole files, then list what each function is responsible for in ten bullets. Do not edit anything.'

rm -rf "$ROOT"
mkdir -p "$ROOT/.pi/agent" "$ROOT/sessions" "$ROOT/state"
: > "$ROOT/state/audit.ndjson"
# HOME is $ROOT, so the agent directory pi and the llama-swap extension read is $ROOT/.pi/agent.
[[ -f "$AGENT_DIR/pi-llama-swap.json" ]] || { echo "no provider config at $AGENT_DIR/pi-llama-swap.json: the writer would not resolve and the wait would skip as unhealthy"; exit 2; }
ln -sf "$AGENT_DIR/auth.json" "$ROOT/.pi/agent/auth.json"
# The provider instance config is copied, not symlinked, and only the instances that answer are kept.
# A dead instance in the list makes the extension fail its model listing outright — `pi --models
# 'llama-swap/*'` on this machine currently prints nothing but an unreachable-instance error — which is
# how a probe loses a run after its second prompt with nothing on the record. Auth is still symlinked,
# so no credential is copied. Both models are checked before anything runs: the writer is what gets
# waited for, and the session model is what asks, and a probe where either one cannot resolve proves
# nothing.
python3 - "$AGENT_DIR/pi-llama-swap.json" "$ROOT/.pi/agent/pi-llama-swap.json" "$MODEL" "$WRITER" <<'PY'
import json, sys, urllib.request
src, dst, *wanted = sys.argv[1:]
data = json.load(open(src))
kept, dead, other = [], [], []
for instance in data.get("instances", []):
	origin = str(instance.get("origin", "")).rstrip("/")
	if not origin.startswith("http"):
		# Not an addressable llama-swap origin; keep it exactly as it is.
		other.append(instance)
		continue
	request = urllib.request.Request(
		f"{origin}/v1/models", headers={"authorization": f"Bearer {instance.get('apiKey', '')}"}
	)
	try:
		served = [str(m.get("id")) for m in json.load(urllib.request.urlopen(request, timeout=15)).get("data", [])]
	except Exception as error:
		dead.append(f"port {instance.get('port')} ({type(error).__name__})")
		continue
	instance["served"] = served
	kept.append(instance)
data["instances"] = [{k: v for k, v in i.items() if k != "served"} for i in kept] + other
json.dump(data, open(dst, "w"))
print(f"instances answering: {len(kept)}; not answering: {', '.join(dead) if dead else 'none'}")
missing = [model for model in wanted if not any(model.split('/', 1)[-1] in i.get("served", []) for i in kept)]
for instance in kept:
	print(f"  port {instance.get('port')}: {len(instance.get('served', []))} models")
if missing:
	print(f"not served by any answering instance: {', '.join(missing)}")
	for instance in kept:
		print(f"  available on port {instance.get('port')}: {', '.join(sorted(instance.get('served', [])))}")
	sys.exit(2)
PY
[[ $? -eq 0 ]] || { echo "preflight failed: pick LIVE_MODEL and LIVE_WRITER from the models listed above"; exit 2; }
cat > "$ROOT/.pi/agent/settings.json" <<'EOF'
{ "theme": "cendre", "hideThinkingBlock": true, "compaction": { "enabled": true } }
EOF

# The numbers mirror the live config, so what is observed here is what a real session would do. A
# backlog the clamp cannot cover — unread past the watermark above `maxChunkTokens` — is what makes a
# compaction *want* to drop unread entries, and that is the only case a wait is considered for. The
# reconcile stage (~35 s measured) is what lands inside the 60 s budget; the extract stage is
# deliberately not waited for.
cat > "$ROOT/config.json" <<EOF
{
	"enabled": true,
	"dryRun": false,
	"observeAfterTokens": 10000,
	"maxChunkTokens": 12000,
	"keepRecentTokens": 5000,
	"candidateLimit": 24,
	"bankMaxTokens": 60000,
	"summaryMaxTokens": 8000,
	"model": "$WRITER",
	"maxTokens": 8000,
	"timeoutMs": 600000,
	"chatTemplateKwargs": { "reasoning_effort": "none" },
	"busyRetries": 0,
	"writeCooldownS": 0,
	"idleDrainAfterMs": 900000,
	"flushTool": false,
	"hifiCompaction": false,
	"waitForWriteOnSettle": false,
	"waitForWriterBeforeCompact": true,
	"compactWaitMs": 60000
}
EOF

load=(--no-extensions -e "$EXTENSION")
[[ -f "$LLAMA_SWAP" ]] && load+=(-e "$LLAMA_SWAP")

cd "$REPO"
HOME=$ROOT PI_HY_MEMORY_CONFIG=$ROOT/config.json PI_HY_MEMORY_STATE=$ROOT/state \
	LIVE_WAIT_ERR=$ROOT/pi.err \
	python3 "$REPO/dev/live-wait-driver.py" \
		pi --mode rpc "${load[@]}" \
		--no-skills --no-context-files --no-prompt-templates \
		--tools read,grep \
		--session-dir "$ROOT/sessions" --model "$MODEL" -- \
		"$PROMPT_1" "$PROMPT_2"
code=$?
echo "exit $code; scratch tree in $ROOT (audit: $ROOT/state/audit.ndjson, pi stderr: $ROOT/pi.err)"
exit $code
