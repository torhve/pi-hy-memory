/**
 * Development-only raw OpenAI-compatible writer.
 *
 * The extension itself never talks HTTP: it resolves a model from pi's registry
 * (see `src/llm.ts`). But `poc.ts` and `export-judge.ts` replay captured payloads
 * from a shell, with no session and therefore no registry, so they need a
 * standalone client. Keeping it here rather than in `src/` is deliberate: two
 * request paths in the shipped extension would drift.
 *
 *   POC_MODEL=… POC_ORIGIN=… POC_KEY=… npx tsx dev/poc.ts
 */

import type { Completion, Writer } from "../src/llm.js";
import type { CallUsage } from "../src/types.js";

export interface RawWriterOptions {
	origin: string;
	apiKey?: string;
	model: string;
	maxTokens?: number;
	temperature?: number;
	/** llama.cpp-only sampling passthrough; `false` omits it. */
	chatTemplateKwargs?: Record<string, unknown> | false;
	extraBody?: Record<string, unknown>;
	timeoutMs?: number;
}

export function rawWriter(options: RawWriterOptions): Writer {
	const base = options.origin.replace(/\/+$/, "");
	const url = base.endsWith("/v1") ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
	const timeoutMs = options.timeoutMs ?? 600_000;

	const buildBody = (compat: boolean): Record<string, unknown> => {
		const body: Record<string, unknown> = {
			model: options.model,
			messages: [
				{ role: "system", content: "" },
				{ role: "user", content: "" },
			],
			stream: false,
			temperature: options.temperature ?? 0,
			[compat ? "max_tokens" : "max_completion_tokens"]: options.maxTokens ?? 8000,
		};
		if (!compat && options.chatTemplateKwargs !== false) {
			body.chat_template_kwargs = options.chatTemplateKwargs ?? { reasoning_effort: "no_think" };
		}
		return { ...body, ...(options.extraBody ?? {}) };
	};

	return {
		model: options.model,
		async complete(system, user, label): Promise<Completion> {
			const send = async (compat: boolean): Promise<Response> => {
				const controller = new AbortController();
				const timer = setTimeout(() => controller.abort(), timeoutMs);
				const body = buildBody(compat);
				body.messages = [
					{ role: "system", content: system },
					{ role: "user", content: user },
				];
				try {
					return await fetch(url, {
						method: "POST",
						headers: {
							"content-type": "application/json",
							...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
						},
						body: JSON.stringify(body),
						signal: controller.signal,
					});
				} finally {
					clearTimeout(timer);
				}
			};

			const started = Date.now();
			let res = await send(false);
			if (res.status === 400) {
				// Strict servers reject unknown fields such as chat_template_kwargs.
				await res.text().catch(() => "");
				res = await send(true);
			}
			if (!res.ok) {
				const text = await res.text().catch(() => "");
				throw new Error(`${label}: HTTP ${res.status} ${text.slice(0, 300)}`);
			}
			const data = (await res.json()) as {
				choices?: { message?: { content?: string }; finish_reason?: string }[];
				usage?: { prompt_tokens?: number; completion_tokens?: number };
			};
			const choice = data.choices?.[0];
			const content = choice?.message?.content ?? "";
			if (!content.trim()) throw new Error(`${label}: empty completion (finish_reason=${choice?.finish_reason})`);
			const usage: CallUsage = {
				inTokens: data.usage?.prompt_tokens ?? 0,
				outTokens: data.usage?.completion_tokens ?? 0,
				wallS: (Date.now() - started) / 1000,
			};
			return { content, usage };
		},
	};
}
