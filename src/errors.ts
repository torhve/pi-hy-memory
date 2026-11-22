/**
 * A completion the model answered with, that this code could not parse.
 *
 * The class exists so a failure is classified by what it is rather than by how the
 * runtime worded it. `failureClass` once matched a handful of V8 message strings, and a
 * wording it did not know — `Bad escaped character`, which is what a copied regex
 * produces — was read as an endpoint outage.
 *
 * `strictMessage` and `repairedMessage` keep the two parse attempts apart, so an audit
 * line cannot name the first defect when the repaired text is what actually failed.
 * `position` is the offset the runtime reported, which names the character *after* a bad
 * escape, and it indexes the completion as the model wrote it — before any repair inserted
 * characters — which is what a capture window has to be centred on.
 */
export class OutputParseError extends Error {
	/** Repairs `repairJson` applied before the second parse, empty when none applied. */
	readonly repairs: string[];
	readonly strictMessage: string;
	/** Set only when a repair was applied and the repaired completion still failed. */
	readonly repairedMessage?: string;
	readonly position?: number;

	constructor(init: {
		strictMessage: string;
		repairs: string[];
		repairedMessage?: string;
		position?: number;
		cause?: unknown;
	}) {
		const message = init.repairedMessage
			? `unparseable completion: strict parse failed (${init.strictMessage}); repaired with ${init.repairs.join(", ")} and still failed (${init.repairedMessage})`
			: `unparseable completion: ${init.strictMessage}`;
		super(message, { cause: init.cause });
		this.name = "OutputParseError";
		this.repairs = init.repairs;
		this.strictMessage = init.strictMessage;
		this.repairedMessage = init.repairedMessage;
		this.position = init.position;
	}
}

/** The byte offset a JSON syntax error stopped at, or undefined when it named none. */
export function errorPosition(message: string): number | undefined {
	const at = /at position (\d+)/.exec(message);
	return at ? Number(at[1]) : undefined;
}
