#!/usr/bin/env bash
# llama-watchdog - SIGKILL wedged llama-server instances that stop answering /health.
#
# Why this exists: a llama-server whose HTTP loop has wedged (client-abort
# deadlock classes, e.g. llama.cpp #27604) keeps accepting connections and
# answers nothing, ignores SIGTERM, and llama-swap keeps queueing requests
# behind it forever (its healthCheckTimeout is start-only and
# timeouts.responseHeader defaults to 0). llama-swap's own health page cannot
# see this because the proxy queue hides the wedge - so the probe goes to each
# llama-server child's OWN port.
#
# Busy is NOT wedged: /health posts no task and is barred from touching the
# server context, so a fully-loaded server answers it in microseconds even
# mid-prefill. A refused connection means "not listening yet" (cold load or
# already exiting) and is never treated as a wedge. Only HTTP-level timeouts
# count, and only FAIL_BUDGET consecutive ones trigger a kill.
#
# After the kill, llama-swap notices its child died and cold-starts a fresh
# server on the next request - self-healing without touching llama-swap.
#
# Tunables (env):
#   LLAMA_WATCHDOG_FAIL_BUDGET   consecutive timeouts before kill  (default 3)
#   LLAMA_WATCHDOG_PROBE_TIMEOUT seconds per probe                 (default 10)
#   LLAMA_WATCHDOG_PROBE_HOST    host to probe                    (default 127.0.0.1)
#   LLAMA_WATCHDOG_STATE_DIR     failure-counter directory        (default /var/lib/llama-watchdog)

set -u

FAIL_BUDGET="${LLAMA_WATCHDOG_FAIL_BUDGET:-3}"
PROBE_TIMEOUT="${LLAMA_WATCHDOG_PROBE_TIMEOUT:-10}"
PROBE_HOST="${LLAMA_WATCHDOG_PROBE_HOST:-127.0.0.1}"
STATE_DIR="${LLAMA_WATCHDOG_STATE_DIR:-/var/lib/llama-watchdog}"

mkdir -p "$STATE_DIR"

log() {
	if command -v logger >/dev/null 2>&1; then
		logger -t llama-watchdog -- "$*"
	else
		printf '%s\n' "$*"
	fi
}

cmdline_of() {
	tr '\0' '\n' <"/proc/$1/cmdline" 2>/dev/null
}

port_of() {
	# --port N | --port=N | -P N (old short form)
	printf '%s\n' "$1" | awk '
		/^--port$/     { getline; print; exit }
		/^--port=/     { sub(/^--port=/, ""); print; exit }
		/^-P$/         { getline; print; exit }
		/^-P=/         { sub(/^-P=/, ""); print; exit }
	'
}

model_of() {
	printf '%s\n' "$1" | awk '
		/^--model$/    { getline; print; exit }
		/^--model=/    { sub(/^--model=/, ""); print; exit }
	'
}

counted_failure() {
	pid="$1"
	reason="$2"
	counter="$STATE_DIR/fail-$pid"
	fails=$(($(cat "$counter" 2>/dev/null || echo 0) + 1))
	echo "$fails" >"$counter"
	log "pid=$pid port=$port health probe failed: $reason ($fails/$FAIL_BUDGET)"
	if [ "$fails" -ge "$FAIL_BUDGET" ]; then
		# PID-reuse guard: confirm this pid is still the same llama-server before killing.
		if cmdline_of "$pid" | grep -q 'llama-server'; then
			log "pid=$pid port=$port model=${model:-?}: wedged ($fails consecutive probe failures); SIGKILL"
			kill -9 "$pid" && log "killed pid=$pid; llama-swap will cold-start a fresh server on the next request"
		else
			log "pid=$pid disappeared before kill; skipped"
		fi
		rm -f "$counter"
	fi
}

for pid in $(pgrep -x llama-server); do
	[ -r "/proc/$pid/cmdline" ] || continue
	cmdline=$(cmdline_of "$pid")
	port=$(port_of "$cmdline")
	model=$(model_of "$cmdline")
	if [ -z "$port" ]; then
		log "pid=$pid has no --port in its cmdline; skipping (not a llama-swap-managed server)"
		continue
	fi

	curl -s -o /dev/null -m "$PROBE_TIMEOUT" "http://$PROBE_HOST:$port/health" >/dev/null 2>&1
	rc=$?
	case "$rc" in
		0)
			# Any completed HTTP exchange (200, 503 mid-load, even 404) proves the
			# HTTP loop is alive. Not wedged.
			if [ -f "$STATE_DIR/fail-$pid" ]; then
				log "pid=$pid port=$port recovered"
				rm -f "$STATE_DIR/fail-$pid"
			fi
			;;
		7)
			# Connection refused: not listening yet (cold load) or already exiting. Never a wedge.
			rm -f "$STATE_DIR/fail-$pid"
			;;
		28 | 52 | 56 | 55)
			counted_failure "$pid" "curl rc=$rc (timeout/empty reply/closed)"
			;;
		*)
			counted_failure "$pid" "curl rc=$rc"
			;;
	esac
done

# Sweep counters belonging to processes that are gone.
for f in "$STATE_DIR"/fail-*; do
	[ -e "$f" ] || continue
	pid=${f##*fail-}
	pgrep -x llama-server | grep -qx "$pid" || rm -f "$f"
done

exit 0
