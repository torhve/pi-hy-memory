/**
 * The model object a dev harness hands to `hifiSummary`.
 *
 * `reasoning: true` is load-bearing: with `reasoning: false` pi sends no reasoning field at
 * all, which leaves the server free to think whatever its default is. Turning thinking off
 * needs the dialect that *this* server answers to — `thinkingLevelMap.off` for an OpenAI-style
 * one, `compat.thinkingFormat` for a chat-template one — and the two are not interchangeable.
 * `chatTemplateKwargs` is mapped to the call's own thinking state rather than set to a
 * literal, so an off request carries `enable_thinking: false` instead of omitting the field,
 * which is what let a server think by default.
 */

import type { Model } from "@earendil-works/pi-ai";

export type ProbeModelOptions = {
	maxTokens: number;
	/** `qwen-chat-template` or similar; empty sends no thinking-format hint. */
	thinkingFormat?: string;
	/** The endpoint's own word for off, e.g. `none`. */
	offValue?: string;
	/** Field name the server takes a thinking budget in, e.g. `thinking_budget`. */
	budgetField?: string;
};

export function probeModel(route: { origin: string; model: string }, options: ProbeModelOptions): Model<any> {
	const thinkingFormat = options.thinkingFormat ?? "";
	const offValue = options.offValue ?? "";
	const budgetField = options.budgetField ?? "";
	return {
		id: route.model,
		name: route.model,
		api: "openai-completions",
		provider: "probe",
		baseUrl: route.origin,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		reasoning: true,
		...(offValue ? { thinkingLevelMap: { off: offValue } } : {}),
		compat: {
			...(thinkingFormat ? { thinkingFormat: thinkingFormat as "qwen" } : {}),
			...(offValue ? { supportsReasoningEffort: true } : {}),
			...(budgetField ? { thinkingTokenBudgetField: budgetField as "thinking_budget" } : {}),
			...(thinkingFormat.includes("chat-template")
				? { chatTemplateKwargs: { enable_thinking: { $var: "thinking.enabled" } } }
				: {}),
		} as Model<any>["compat"],
		contextWindow: 131072,
		maxTokens: options.maxTokens,
	};
}
