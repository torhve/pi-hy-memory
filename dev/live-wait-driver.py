#!/usr/bin/env python3
"""Drive a headless pi RPC session and report what a compaction request did to a running write.

dev/live-wait.sh sets up the scratch session; this is the part that speaks JSONL to pi, follows the
audit file the extension appends to, and asks for the compaction at a chosen moment in a write. Two
failures made the earlier probes untrustworthy and both are handled here:

- Waiting for `agent_settled` after a `compact` command. A manual compaction is not an agent run, so
  that wait never returns and the probe dies 300s later, discarding a verdict the audit had already
  recorded. The audit lines are the record; the pi event stream is supporting evidence.
- sys.exit on the first hiccup. An endpoint that goes half way through a run is a real outcome, and
  printing it beats losing everything: every failure here is collected and reported.

Exit 0 means a wait was observed end to end. 1 means a real run that took a different branch (skip,
defer) or a run the endpoint broke. 3 means the probe never got into position.
"""

from __future__ import annotations

import json
import os
import select
import subprocess
import sys
import time

AUDIT = os.environ.get("PI_HY_MEMORY_STATE", "/tmp/hy-live-wait/state") + "/audit.ndjson"
ERR_LOG = os.environ.get("LIVE_WAIT_ERR", "/tmp/hy-live-wait/pi.err")

LIVE: list["Pi"] = []


def stderr_tail(chars: int = 600) -> str:
	"""pi's own stderr is where a dead or unreachable endpoint shows up."""
	try:
		with open(ERR_LOG, "rb") as f:
			return f.read()[-chars:].decode("utf-8", "replace").strip()
	except OSError:
		return "(no stderr log)"

def split_args(argv: list[str]) -> tuple[list[str], list[str]]:
	if "--" not in argv:
		sys.exit("usage: live-wait-driver.py <pi argv...> -- <prompt> <prompt>")
	return argv[: argv.index("--")], argv[argv.index("--") + 1 :]

PI_ARGS, PROMPTS = split_args(sys.argv[1:])
if len(PROMPTS) < 2:
	sys.exit("two prompts are required: one that completes a write, one that leaves a chunk running")

class Stall(Exception):
	"""pi went silent past the allowance. A stalled run must say so, not sit there."""

class Pi:
	"""JSONL over stdin/stdout. Records are split on LF only; U+2028/U+2029 are legal inside JSON."""

	def __init__(self, argv: list[str]) -> None:
		self.proc = subprocess.Popen(
			argv,
			stdin=subprocess.PIPE,
			stdout=subprocess.PIPE,
			stderr=open(ERR_LOG, "ab"),
			bufsize=0,
		)
		LIVE.append(self)
		self.buf = b""
		self.events: list[dict] = []
		self.ui_requests: list[dict] = []
		self.errors: list[str] = []
		self.seq = 0

	def send(self, record: dict) -> None:
		assert self.proc.stdin is not None
		self.proc.stdin.write((json.dumps(record) + "\n").encode("utf-8"))
		self.proc.stdin.flush()

	def read(self, deadline: float) -> dict | None:
		"""One record, or None once pi is gone, or a Stall if pi is silent past the deadline."""
		assert self.proc.stdout is not None
		fd = self.proc.stdout.fileno()
		while True:
			if b"\n" in self.buf:
				line, self.buf = self.buf.split(b"\n", 1)
				line = line.strip(b"\r").strip()
				if not line:
					continue
				try:
					return json.loads(line.decode("utf-8", "replace"))
				except Exception:
					continue
			if self.proc.poll() is not None:
				return None
			if deadline - time.time() <= 0:
				raise Stall("no record from pi and no exit within the allowance")
			ready, _, _ = select.select([fd], [], [], min(max(deadline - time.time(), 0.0), 5.0))
			if not ready:
				continue
			try:
				# os.read returns as soon as any bytes are available. A buffered read(4096) sits there
				# until 4096 bytes arrive, which is how the first two probes lost 25 and 30 minutes.
				chunk = os.read(fd, 65536)
			except (OSError, ValueError):
				return None
			if not chunk:
				return None
			self.buf += chunk

	def answer(self, rec: dict) -> None:
		"""Keep the UI request as evidence, then unblock it. `notify` and `setStatus` need no reply;
		only a dialog would wait, and nothing here should open one."""
		self.ui_requests.append(rec)
		if rec.get("method") in ("select", "confirm", "input", "editor"):
			self.send({"type": "extension_ui_response", "id": rec.get("id"), "cancelled": True})

	def absorb(self, rec: dict) -> None:
		if rec.get("type") == "extension_ui_request":
			self.answer(rec)
		else:
			self.events.append(rec)

	def command(self, record: dict, timeout: float = 120.0) -> dict | None:
		"""Send one command and return its response, keeping session events on the way. None means the
		command did not get a usable answer; `errors` says why and the run is reported, not abandoned."""
		cmd_id = record.setdefault("id", f"req-{self.seq}")
		self.seq += 1
		self.send(record)
		deadline = time.time() + timeout
		while time.time() < deadline:
			try:
				rec = self.read(deadline)
			except Stall as e:
				self.errors.append(f"{record.get('type')}: {e}: {stderr_tail()}")
				return None
			if rec is None:
				self.errors.append(f"{record.get('type')}: pi exited before answering: {stderr_tail()}")
				return None
			if rec.get("type") == "response" and rec.get("command") == record.get("type"):
				if rec.get("id") in (cmd_id, None):
					if not rec.get("success"):
						self.errors.append(
							f"{record.get('type')} failed: {rec.get('error') or json.dumps(rec)[:200]}"
						)
					return rec
				continue
			self.absorb(rec)
		self.errors.append(f"no response to {record.get('type')} within {timeout:.0f}s")
		return None

	def drain(self, idle_for: float, hard_limit: float = 600.0) -> None:
		"""Keep reading until pi has been quiet for `idle_for` seconds. A wait ends on the audit side,
		not on the event side, so this is how the events around it get collected."""
		deadline = time.time() + hard_limit
		quiet_since = time.time()
		while time.time() - quiet_since < idle_for and time.time() < deadline:
			try:
				rec = self.read(min(deadline, quiet_since + idle_for) + 5.0)
			except Stall:
				break
			if rec is None:
				break
			quiet_since = time.time()
			self.absorb(rec)

	def settled(self, timeout: float) -> bool:
		"""True when pi said it has no automatic work left. False when the allowance ran out or pi died.
		A manual compaction is not an agent run and never says this, so no caller may treat False as the
		end of the experiment: the audit is the record and the events are supporting evidence."""
		deadline = time.time() + timeout
		while time.time() < deadline:
			try:
				rec = self.read(deadline)
			except Stall as e:
				self.errors.append(f"no agent_settled within {timeout:.0f}s ({e}): {stderr_tail()}")
				return False
			if rec is None:
				self.errors.append(f"pi exited before the run settled: {stderr_tail()}")
				return False
			self.absorb(rec)
			if rec.get("type") == "agent_settled":
				return True
		self.errors.append(f"no agent_settled within {timeout:.0f}s: {stderr_tail()}")
		return False

	def shutdown(self) -> None:
		"""RPC mode has no terminate command; close the pipe and stop the child."""
		try:
			if self.proc.stdin:
				self.proc.stdin.close()
		except Exception:
			pass
		if self.proc.poll() is None:
			self.proc.terminate()
			try:
				self.proc.wait(timeout=10)
			except subprocess.TimeoutExpired:
				self.proc.kill()

class Audit:
	"""Follows the audit file the extension appends to, filtered to one session. Rows are never
	dropped: a write emits its lines in the same second and the driver wants all of them."""

	def __init__(self, session_id: str) -> None:
		self.session_id = session_id
		self.f = open(AUDIT, "r")
		self.rows: list[dict] = []

	def poll(self) -> list[dict]:
		out = []
		while True:
			line = self.f.readline()
			if not line:
				return out
			try:
				row = json.loads(line)
			except Exception:
				continue
			if row.get("sessionId") != self.session_id:
				continue
			self.rows.append(row)
			out.append(row)

	def find(self, cursor: int, event: str, chunk_id: str | None = None) -> tuple[int, dict] | None:
		"""The first row at or after `cursor` carrying this event, for this chunk if one is named."""
		for index in range(cursor, len(self.rows)):
			row = self.rows[index]
			if row.get("event") == event and (chunk_id is None or row.get("chunkId") == chunk_id):
				return index, row
		return None

	def wait_for(
		self,
		event: str,
		timeout: float,
		*,
		after: int = 0,
		chunk_id: str | None = None,
	) -> tuple[dict | None, int]:
		"""Poll until a row at or after `after` carries `event`, and return it with the index just past
		it. `after` comes from the previous search, not from how many rows happen to be read: a write
		writes its three lines in the same second, and a search that started by skipping everything
		already read would miss the middle one."""
		deadline = time.time() + timeout
		while time.time() < deadline:
			self.poll()
			found = self.find(after, event, chunk_id)
			if found:
				return found[1], found[0] + 1
			time.sleep(0.5)
		self.poll()
		return None, after

def rows_named(rows: list[dict], event: str) -> list[dict]:
	return [r for r in rows if r.get("event") == event]

def main() -> int:
	pi = Pi(PI_ARGS)

	# The audit is followed from the start of this process, not from the point the session id is
	# known, because the first lines are already written by then.
	audit = Audit("*")

	state = pi.command({"type": "get_state"})
	if not state:
		print(f"get_state: {json.dumps(state)} | {'; '.join(pi.errors)}")
		return 3
	session_id = (state.get("data") or {}).get("sessionId")
	if not session_id:
		print("pi reported no sessionId; the probe needs a session file")
		return 3
	audit.session_id = session_id
	print(f"session {session_id}", flush=True)

	# 1. A prompt long enough to start a write, then let that write finish. A wait is priced from
	#    completed writes: with no timing history the policy has nothing to estimate from and skips.
	pi.command({"type": "prompt", "message": PROMPTS[0]})
	pi.settled(600)
	started, cursor = audit.wait_for("write_start", 60)
	if started is None:
		print(f"no write started from the first prompt; audit so far: {[r.get('event') for r in audit.rows]}")
		return 3
	print(f"write 1 {started.get('chunkId')} {started.get('chunkTokens')} tokens", flush=True)
	done, cursor = audit.wait_for("write_end", 600, after=cursor)
	if done is None:
		print("write 1 never finished; the endpoint is not answering, so a wait would skip anyway")
		report(pi, audit)
		return 3
	print(f"write 1 landed in {done.get('wallS')}s (this is what prices the ETA)", flush=True)

	# 2. A second prompt, so there is a backlog again and a second chunk to catch mid-flight.
	pi.command({"type": "prompt", "message": PROMPTS[1]})
	pi.settled(600)
	second, cursor = audit.wait_for("write_start", 60, after=cursor)
	if second is None:
		print("no write started from the second prompt; nothing to catch mid-flight")
		report(pi, audit)
		return 3
	chunk = second.get("chunkId")
	print(f"write 2 {chunk} {second.get('chunkTokens')} tokens", flush=True)

	# 3. Ask at the moment the estimate turns favourable. `extract_persisted` is where the write
	#    switches from "everything ahead of you" to "one call ahead of you": the reconcile median is
	#    what the ETA reads from there and it sits inside the budget. The agent is idle at this point,
	#    so pi answers the request there instead of queueing it behind a run. The chunk id is pinned,
	#    and so is the pairing: the previous probe matched an earlier chunk's `extract_persisted` and
	#    reported a reconcile stage for a write that had already landed.
	stage = "still extracting"
	stage_deadline = time.time() + 900
	while time.time() < stage_deadline:
		audit.poll()
		found = audit.find(cursor, "extract_persisted", chunk)
		if found:
			stage = "reconcile open"
			cursor = found[0] + 1
			break
		if audit.find(cursor, "write_end", chunk):
			stage = "already landed"
			break
		time.sleep(0.2)
	print(f"{stage} for {chunk}; asking pi to compact now", flush=True)

	response = pi.command({"type": "compact"}, timeout=120)

	# The wait, if there is one, ends on the audit side. Collect events while that happens, then look
	# for the wait line. There is deliberately no agent_settled wait here: a manual compaction is not
	# an agent run and never emits one, and waiting for it is what lost the previous probe its verdict.
	deadline = time.time() + 240
	while time.time() < deadline:
		pi.drain(5.0, hard_limit=max(0.0, deadline - time.time()))
		audit.poll()
		if audit.find(cursor, "compact_wait") or audit.find(cursor, "compact_wait_skipped"):
			break
		if pi.proc.poll() is not None:
			break
		time.sleep(0.5)

	# The compact line itself: it is written right after the wait line, inside the same call.
	for _ in range(20):
		audit.poll()
		if audit.find(cursor, "compact") or audit.find(cursor, "compact_deferred"):
			break
		time.sleep(0.5)

	return report(pi, audit, response, cursor)

def report(pi: Pi, audit: Audit, response: dict | None = None, cursor: int = 0) -> int:
	"""Print what the audit recorded, what pi reported, and the verdict. This runs whether or not the
	endpoint cooperated: the audit lines are written when the decisions happen, so they are the part of
	a broken run that is still worth reading."""
	waited = rows_named(audit.rows, "compact_wait")
	skipped = rows_named(audit.rows, "compact_wait_skipped")
	landed = rows_named(audit.rows, "boundary_recomputed")
	compacted = rows_named(audit.rows, "compact")
	deferred = rows_named(audit.rows, "compact_deferred")
	ended = [e for e in pi.events if e.get("type") == "compaction_end"]

	print("--- audit ---")
	for row in waited + landed + skipped + compacted + deferred:
		print(json.dumps(row), flush=True)
	if not (waited or skipped or compacted or deferred):
		print(f"no compaction line: {[r.get('event') for r in audit.rows]}")

	print("--- pi reported ---")
	if response:
		print(json.dumps(response)[:900], flush=True)
	if ended:
		print(json.dumps(ended[-1])[:900], flush=True)
	notices = [u for u in pi.ui_requests if "hy-memory" in json.dumps(u)]
	if notices:
		print("--- what the user would have been told ---")
		for n in notices:
			print(json.dumps(n)[:400], flush=True)
	if pi.errors:
		print("--- failures seen ---")
		for e in pi.errors:
			print(e, flush=True)

	print("--- verdict ---")
	if waited:
		last = waited[-1]
		print(
			f"LIVE WAIT observed: stage={last.get('stage')} entries={last.get('entries')} "
			f"tokens={last.get('tokens')} etaS={last.get('etaS')} budgetMs={last.get('budgetMs')} "
			f"waitedMs={last.get('waitedMs')} cursorAdvanced={last.get('cursorAdvanced')} "
			f"outcome={last.get('outcome')}",
			flush=True,
		)
		if landed:
			print(f"boundary recomputed at the landed cursor: {json.dumps(landed[-1])}", flush=True)
		if compacted:
			print(f"compacted with the extension's summary: {json.dumps(compacted[-1])}", flush=True)
		if response:
			print(f"pi's compaction usage: {json.dumps((response.get('data') or {}).get('usage') or {})}")
		return 0
	if skipped:
		last = skipped[-1]
		print(
			f"skipped, not waited: reason={last.get('reason')} stage={last.get('stage')} "
			f"etaS={last.get('etaS')} budgetMs={last.get('budgetMs')}",
			flush=True,
		)
		return 1
	if deferred:
		last = deferred[-1]
		print(f"deferred with no wait: reason={last.get('reason')}", flush=True)
		return 1
	print("the compaction never reached the wait path: no write in flight, or pi did not compact", flush=True)
	return 1

if __name__ == "__main__":
	try:
		sys.exit(main())
	finally:
		for child in LIVE:
			child.shutdown()
