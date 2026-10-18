/**
 * Footer status bar.
 *
 * Adapted from pi-blackhole's footer, which this project deliberately keeps the
 * shape of: one bar per budget that fills as the window grows, a braille spinner
 * while a worker runs, and a short "✓ +N" flash when it finishes.
 *
 * What is different here is *which* budgets matter. pi-blackhole watches its
 * observation window, its observation pool and the context; pi-hy-memory watches
 * the pending window that triggers a write, and the bank the write has to fit in:
 *
 *   hy ▕███░░░░░▏ 9.2k/15k   ▕█░░░░░░░▏ 1.4k/5k   ⠼ extract
 *   hy ▕████░░░░▏ 12k/15k    ▕██░░░░░░▏ 2.1k/5k   ✓ +6 ~2
 *
 * Everything is best-effort: a stale ctx must never break a session, so every
 * ui call is wrapped and the timers stop on the first failure.
 */

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_MS = 80;
const REFRESH_MS = 1000;
const DONE_FLASH_MS = 5000;
const CELLS = 8;
const WARN_AT = 0.8;

type Fg = (color: string, text: string) => string;

/** Fallback theme: colours stripped, so the bar still renders outside the TUI. */
const PLAIN: Fg = (_c, text) => text;

export type StatusSnapshot = {
	/** Tokens accumulated since the write watermark. */
	pending: number;
	/** observeAfterTokens: the threshold that triggers a write. */
	budget: number;
	/** Tokens held by active bank entries. */
	bank: number;
	/** poolMaxTokens: the bank budget. */
	pool: number;
	stage?: "extract" | "reconcile" | "waiting";
	detail?: string;
};

export type StatusBar = {
	attach(ui: { setStatus?: (key: string, text: string | undefined) => void; theme?: { fg: Fg } } | undefined): void;
	detach(): void;
	/** Window/bank numbers, pushed whenever they are cheap to compute. */
	snapshot(values: Omit<StatusSnapshot, "stage" | "detail">): void;
	/** A write started: spinner on, stage shown. */
	stage(stage: "extract" | "reconcile" | "waiting", detail?: string): void;
	/** A write finished: flash the delta for a few seconds, then fall back to idle. */
	done(added: number, updated: number, note?: string): void;
	failed(reason: string): void;
	/** Force a redraw (used by the refresh timer). */
	redraw(): void;
	text(): string;
};

function bar(fg: Fg, value: number, budget: number): string {
	const ratio = budget > 0 ? value / budget : 0;
	const filled = Math.max(0, Math.min(CELLS, Math.round(Math.min(1.2, ratio) * CELLS)));
	const colour = ratio >= 1 ? "error" : ratio >= WARN_AT ? "warning" : "dim";
	return fg(colour, "▕") + fg(colour, "█".repeat(filled)) + fg(colour, "░".repeat(CELLS - filled)) + fg(colour, "▏");
}

function compact(value: number): string {
	if (value >= 1000) {
		const k = (value / 1000).toFixed(value >= 10_000 ? 0 : 1).replace(/\.0$/, "");
		return `${k}k`;
	}
	return String(value);
}

export function createStatusBar(key = "hy"): StatusBar {
	let ui: Parameters<StatusBar["attach"]>[0];
	let fg: Fg = PLAIN;
	let values: Omit<StatusSnapshot, "stage" | "detail"> = { pending: 0, budget: 15000, bank: 0, pool: 5000 };
	let stage: StatusSnapshot["stage"];
	let detail: string | undefined;
	let flash: { added: number; updated: number; note?: string } | undefined;
	let failedReason: string | undefined;
	let spinner: ReturnType<typeof setInterval> | undefined;
	let refresh: ReturnType<typeof setInterval> | undefined;
	let flashTimer: ReturnType<typeof setTimeout> | undefined;
	let frame = 0;
	let last = "";
	let attached = false;

	const stopSpinner = () => {
		if (spinner) clearInterval(spinner);
		spinner = undefined;
	};

	const detach = () => {
		attached = false;
		stopSpinner();
		if (refresh) clearInterval(refresh);
		refresh = undefined;
		if (flashTimer) clearTimeout(flashTimer);
		flashTimer = undefined;
		try {
			ui?.setStatus?.(key, undefined);
		} catch {
			/* stale ctx */
		}
		ui = undefined;
		last = "";
	};

	const render = (): string => {
		if (!values.budget && !values.bank) return "";
		const parts: string[] = [
			`${fg("success", "hy")} ${bar(fg, values.pending, values.budget)} ${fg("muted", `${compact(values.pending)}/${compact(values.budget)}`)}`,
			`${bar(fg, values.bank, values.pool)} ${fg("muted", `${compact(values.bank)}/${compact(values.pool)}`)}`,
		];
		if (stage) {
			const label = stage === "waiting" ? "wait" : stage;
			const suffix = detail ? ` ${fg("muted", detail)}` : "";
			parts.push(`${fg("accent", FRAMES[frame % FRAMES.length])} ${fg("accent", label)}${suffix}`);
		} else if (failedReason) {
			parts.push(`${fg("error", "✗")} ${fg("error", failedReason.slice(0, 40))}`);
		} else if (flash) {
			const tail = flash.note ? ` ${fg("muted", flash.note)}` : "";
			parts.push(
				`${fg("success", "✓")} ${fg("success", `+${flash.added}`)} ${fg("muted", `~${flash.updated}`)}${tail}`,
			);
		}
		return parts.join("  ");
	};

	const redraw = (): void => {
		if (!attached) return;
		const text = render();
		if (text === last) return;
		last = text;
		try {
			ui?.setStatus?.(key, text || undefined);
		} catch {
			// A replaced or closed session makes ctx.ui throw; drop the bar quietly.
			detach();
		}
	};

	const ensureSpinner = (): void => {
		if (spinner || !attached) return;
		spinner = setInterval(() => {
			frame = (frame + 1) % FRAMES.length;
			redraw();
		}, SPINNER_MS);
		spinner.unref?.();
	};

	return {
		attach(next) {
			if (attached) detach();
			ui = next;
			fg = next?.theme?.fg?.bind(next.theme) ?? PLAIN;
			attached = Boolean(next?.setStatus);
			if (!attached) return;
			refresh = setInterval(() => redraw(), REFRESH_MS);
			refresh.unref?.();
			redraw();
		},
		detach,
		snapshot(next) {
			values = { ...values, ...next };
			redraw();
		},
		stage(nextStage, nextDetail) {
			if (flashTimer) clearTimeout(flashTimer);
			flashTimer = undefined;
			flash = undefined;
			failedReason = undefined;
			stage = nextStage;
			detail = nextDetail;
			ensureSpinner();
			redraw();
		},
		done(added, updated, note) {
			stage = undefined;
			detail = undefined;
			failedReason = undefined;
			stopSpinner();
			flash = { added, updated, note };
			redraw();
			if (flashTimer) clearTimeout(flashTimer);
			flashTimer = setTimeout(() => {
				flash = undefined;
				redraw();
			}, DONE_FLASH_MS);
			flashTimer.unref?.();
		},
		failed(reason) {
			stage = undefined;
			detail = undefined;
			stopSpinner();
			flash = undefined;
			failedReason = reason;
			redraw();
		},
		redraw,
		text: render,
	};
}
