/**
 * dsh-bionic-bridge — LLM adapter for local OpenAI-compatible servers
 * (Bionic / LM Studio MLX runtime, llama.cpp servers, etc.).
 *
 * Zero runtime dependencies: the adapter is duck-typed against the `llm`
 * service contract (registerAdapter never requires the base class), reads
 * request images through the attachments service, and classifies failures
 * with `error.failure` + `error.code` pairs the harness normalizes.
 *
 * Registers one provider route (default: `bionic-mlx`) plus a
 * `bionic_bridge_status` diagnostic tool (probe / list / selftest).
 */
import { readFile } from "node:fs/promises";

export const inject = ["llm", "attachments", "tools", "credentials"];

const FALLBACK = {
	providerName: "bionic-mlx",
	displayName: "Bionic / LM Studio (MLX, local)",
	statusToolName: "bionic_bridge_status",
	baseURL: "http://127.0.0.1:1234/v1",
	apiKey: "lm-studio",
	apiKeyRef: undefined,
	liveCatalogLimit: 40,
	defaultContextWindow: 262144,
	defaultMaxTokens: 16384,
	liveProbeTimeoutMs: 1500,
	liveCacheMs: 30000,
	idleStreamMs: 240000,
	models: [],
};

function resolveConfig(raw) {
	const source = raw && typeof raw === "object" ? raw : {};
	const config = { ...FALLBACK, ...pickStrings(source), models: normalizeModels(source.models) };
	if (config.providerName.length === 0) throw new Error("dsh-bionic-bridge: providerName must be non-empty");
	if (!/^https?:\/\//.test(config.baseURL)) throw new Error(`dsh-bionic-bridge: baseURL must be an http(s) URL, got ${JSON.stringify(config.baseURL)}`);
	return config;
}

function pickStrings(source) {
	const out = {};
	for (const key of ["providerName", "displayName", "baseURL", "apiKey", "apiKeyRef", "statusToolName"]) {
		if (typeof source[key] === "string" && source[key].length > 0) out[key] = source[key].trim();
	}
	for (const key of ["defaultContextWindow", "defaultMaxTokens", "liveProbeTimeoutMs", "liveCacheMs", "idleStreamMs", "liveCatalogLimit"]) {
		if (Number.isSafeInteger(source[key]) && source[key] > 0) out[key] = source[key];
	}
	return out;
}

function normalizeModels(models) {
	if (!Array.isArray(models)) return [];
	const out = [];
	for (const entry of models) {
		if (typeof entry !== "object" || entry === null || typeof entry.id !== "string" || entry.id.length === 0) continue;
		out.push({
			id: entry.id,
			name: typeof entry.name === "string" && entry.name.length > 0 ? entry.name : entry.id,
			contextWindow: Number.isSafeInteger(entry.contextWindow) && entry.contextWindow > 0 ? entry.contextWindow : undefined,
			maxTokens: Number.isSafeInteger(entry.maxTokens) && entry.maxTokens > 0 ? entry.maxTokens : undefined,
			input: Array.isArray(entry.input) && entry.input.includes("image") ? ["text", "image"] : ["text"],
		});
	}
	return out;
}

function joinUrl(base, path) {
	return `${base.replace(/\/+$/, "")}${path}`;
}

function bridgeError(message, code, extra = {}) {
	const error = new Error(message);
	error.code = code;
	error.failure = { message, code, ...extra };
	return error;
}

function classifyStatus(status, detail) {
	const extra = detail === undefined ? {} : { detail };
	if (status === 401 || status === 403) return { code: "AUTH", ...extra };
	if (status === 429) return { code: "RATE_LIMIT", ...extra };
	if (status >= 500) return { code: "SERVER", ...extra };
	return { code: "REQUEST", ...extra };
}

function textOf(content) {
	return content.filter((block) => block.type === "text").map((block) => block.text).join("");
}

export function apply(ctx, raw) {
	const config = resolveConfig(raw);
	let live = { at: 0, models: [] };

	async function resolveApiKey() {
		if (config.apiKeyRef === undefined) return config.apiKey;
		try {
			const resolved = await ctx.credentials.resolve(config.apiKeyRef);
			const value = typeof resolved === "string" ? resolved : (resolved?.value ?? resolved?.secret);
			if (typeof value === "string" && value.length > 0) return value;
		} catch {}
		return "";
	}

	async function authHeaders() {
		const key = await resolveApiKey();
		const headers = { "user-agent": "dsh-bionic-bridge/0.1.0 (+https://github.com/deepseek-ai/deepseek-harness)" };
		if (key.length > 0) headers.authorization = `Bearer ${key}`;
		return headers;
	}

	async function probeLive(signal) {
		const now = Date.now();
		if (now - live.at < config.liveCacheMs) return live.models;
		try {
			const signals = [AbortSignal.timeout(config.liveProbeTimeoutMs)];
			if (signal !== undefined && signal !== null) signals.push(signal);
			const response = await fetch(joinUrl(config.baseURL, "/models"), {
				headers: await authHeaders(),
				signal: AbortSignal.any(signals),
			});
			if (!response.ok) throw bridgeError(`model listing failed with HTTP ${response.status}`, classifyStatus(response.status).code, { status: response.status });
			const body = await response.json();
			const entries = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? Object.entries(body.models).map(([id, meta]) => ({ id, ...meta })) : [];
			live = {
				at: now,
				models: entries
					.map((entry) => ({
						id: String(entry.id ?? ""),
						name: typeof entry.name === "string" && entry.name.length > 0 ? entry.name : String(entry.id ?? ""),
					}))
					.filter((entry) => entry.id.length > 0),
			};
		} catch (error) {
			// A closed server must not blank the static catalog; only refresh the timestamp
			// occasionally so the picker retries a dead endpoint without hammering it.
			// When the window forces a refresh, drop stale live entries: the probe result
			// must reflect reachability, not a previous server's list.
			if (now - live.at > 2 * config.liveCacheMs) live = { at: now, models: [] };
		}
		return live.models;
	}

	async function catalog(signal) {
		const served = await probeLive(signal);
		const merged = [...config.models];
		let added = 0;
		for (const servedEntry of served) {
			if (added >= config.liveCatalogLimit) break;
			if (!merged.some((entry) => entry.id === servedEntry.id)) {
				merged.push({ id: servedEntry.id, name: servedEntry.name, contextWindow: config.defaultContextWindow, maxTokens: config.defaultMaxTokens, input: ["text", "image"] });
				added += 1;
			}
		}
		return merged;
	}

	const adapter = {
		providerInfo(provider) {
			return { id: provider, name: config.displayName };
		},
		providerRetryPolicy() {
			return undefined; // normal defaults: RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT / EMPTY_RESPONSE
		},
		imageRequestTarget(_provider, _model, image) {
			return { width: image.width, height: image.height, maxBytes: image.bytes };
		},
		async listModels(provider) {
			const models = await catalog();
			return models.map((entry) => ({ provider, id: entry.id, name: entry.name, inputModalities: entry.input }));
		},
		async resolveModel(provider, model, signal) {
			const models = await catalog(signal);
			const entry = models.find((candidate) => candidate.id === model);
			return {
				provider,
				id: model,
				name: entry?.name ?? model,
				inputModalities: entry?.input ?? ["text", "image"],
				context: { contextWindow: entry?.contextWindow ?? config.defaultContextWindow },
				defaultMaxTokens: entry?.maxTokens ?? config.defaultMaxTokens,
			};
		},
		async prepareCall(provider, model, signal) {
			const resolved = await this.resolveModel(provider, model, signal);
			return { model: resolved, stream: (options) => streamCall(options) };
		},
		stream: (options) => streamCall(options),
	};

	async function* streamCall(options) {
		const info = await adapter.resolveModel(options.provider, options.model, options.signal);
		const messages = [];
		if (typeof options.system === "string" && options.system.length > 0) messages.push({ role: "system", content: options.system });
		for (const message of options.messages) {
			switch (message.role) {
				case "system":
				case "developer": {
					const text = textOf(message.content);
					if (text.length > 0) messages.push({ role: "system", content: text });
					continue;
				}
				case "user": {
					const parts = [];
					for (const block of message.content) {
						if (block.type === "text") {
							if (block.text.length > 0) parts.push({ type: "text", text: block.text });
							continue;
						}
						if (block.type === "image") {
							const url = await imageToDataUrl(block);
							if (url === undefined) parts.push({ type: "text", text: `[image omitted: attachment ${String(block.attachment.attachmentId)} has no readable host copy]` });
							else parts.push({ type: "image_url", image_url: { url } });
							continue;
						}
						if (block.type === "file") parts.push({ type: "text", text: ctx.llm.fileRequestText(block.attachment) });
					}
					if (parts.length === 0) continue;
					const textOnly = parts.every((part) => part.type === "text");
					messages.push({ role: "user", content: textOnly ? parts.map((part) => part.text).join("\n") : parts });
					continue;
				}
				case "assistant": {
					const text = message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
					const toolCalls = message.content
						.filter((block) => block.type === "tool-call")
						.map((block) => ({ id: block.id, type: "function", function: { name: block.name, arguments: block.arguments || "{}" } }));
					if (text.length === 0 && toolCalls.length === 0) {
						messages.push({ role: "assistant", content: "" });
						continue;
					}
					messages.push({ role: "assistant", ...(text.length > 0 ? { content: text } : { content: null }), ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) });
					continue;
				}
				case "tool": {
					const text = textOf(message.content) || "(empty result)";
					messages.push({ role: "tool", tool_call_id: message.toolCallId, content: message.isError ? `Error: ${text}` : text });
					continue;
				}
				default:
					continue;
			}
		}

		const body = {
			model: options.model,
			messages,
			stream: true,
			stream_options: { include_usage: true },
		};
		if (typeof options.temperature === "number") body.temperature = options.temperature;
		if (typeof options.maxTokens === "number") body.max_tokens = options.maxTokens;
		if (Array.isArray(options.stop) && options.stop.length > 0) body.stop = options.stop;
		if (Array.isArray(options.tools) && options.tools.length > 0) {
			body.tools = options.tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description ?? "", parameters: tool.parameters ?? { type: "object", properties: {} } } }));
		}

		let response;
		try {
			response = await fetch(joinUrl(config.baseURL, "/chat/completions"), {
				method: "POST",
				headers: { "content-type": "application/json", ...(await authHeaders()) },
				body: JSON.stringify(body),
				signal: options.signal,
			});
		} catch (error) {
			if (options.signal?.aborted) throw bridgeError(`bionic-bridge: request aborted: ${error?.message ?? error}`, "ABORTED");
			throw bridgeError(`bionic-bridge: cannot reach ${config.baseURL} — start the model server in Bionic/LM Studio (${error?.message ?? error})`, "TRANSPORT", { cause: error });
		}
		if (!response.ok) {
			const detail = (await response.text().catch(() => "")).slice(0, 400);
			const classified = classifyStatus(response.status, detail);
			throw bridgeError(`bionic-bridge: HTTP ${response.status} from ${config.baseURL}/chat/completions${classified.detail ? `: ${classified.detail}` : ""}`, classified.code, { status: response.status });
		}
		if (info.inputModalities?.includes("image") === false && messages.some((message) => Array.isArray(message.content) && message.content.some((part) => part.type === "image_url"))) {
			// The shared runtime projects images for text-only routes before dispatch; this guard only fires when the catalog mislabels.
			throw bridgeError(`bionic-bridge: model ${options.model} was declared text-only but the request still carries images`, "INVALID_REQUEST");
		}

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		let nextIndex = 0;
		let openText = null; // { index, text }
		let openReasoning = null;
		const toolBlocks = new Map(); // wire tool_call index -> { index, id, name, args }
		let sawContent = false;
		let usage;
		let finishReason;

		const closeText = function* () {
			if (openText) {
				yield { type: "block-end", index: openText.index, block: { type: "text", text: openText.text } };
				openText = null;
			}
		};
		const closeReasoning = function* () {
			if (openReasoning) {
				yield { type: "block-end", index: openReasoning.index, block: { type: "reasoning", text: openReasoning.text } };
				openReasoning = null;
			}
		};

		try {
			for (;;) {
				let chunk;
				const read = reader.read();
				try {
					chunk = await withTimeout(read, config.idleStreamMs, options.signal);
				} catch (error) {
					if (error && error.code === "TIMEOUT") {
						yield* closeText();
						yield* closeReasoning();
						yield { type: "finish", reason: { kind: "error", failure: bridgeError(`bionic-bridge: no stream data for ${config.idleStreamMs} ms`, "TIMEOUT").failure } };
						return;
					}
					throw error;
				}
				if (chunk.done) break;
				buffer += decoder.decode(chunk.value, { stream: true });
				for (;;) {
					const newline = buffer.indexOf("\n");
					if (newline < 0) break;
					const line = buffer.slice(0, newline).trim();
					buffer = buffer.slice(newline + 1);
					if (!line.startsWith("data:")) continue;
					const payload = line.slice(5).trim();
					if (payload.length === 0 || payload === "[DONE]") {
						if (payload === "[DONE]") break;
						continue;
					}
					let event;
					try {
						event = JSON.parse(payload);
					} catch {
						continue;
					}
					if (event.usage) usage = event.usage;
					const choice = Array.isArray(event.choices) ? event.choices[0] : undefined;
					if (!choice) continue;
					if (choice.finish_reason) finishReason = choice.finish_reason;
					const delta = choice.delta ?? choice.message;
					if (!delta) continue;
					const reasoningText = typeof delta.reasoning_content === "string" ? delta.reasoning_content : typeof delta.reasoning === "string" ? delta.reasoning : undefined;
					if (reasoningText && reasoningText.length > 0) {
						if (!openReasoning) {
							yield* closeText();
							openReasoning = { index: nextIndex++, text: "" };
							yield { type: "block-start", index: openReasoning.index, blockType: "reasoning" };
						}
						openReasoning.text += reasoningText;
						sawContent = true;
						yield { type: "reasoning-delta", index: openReasoning.index, text: reasoningText };
					}
					if (typeof delta.content === "string" && delta.content.length > 0) {
						if (!openText) {
							yield* closeReasoning();
							openText = { index: nextIndex++, text: "" };
							yield { type: "block-start", index: openText.index, blockType: "text" };
						}
						openText.text += delta.content;
						sawContent = true;
						yield { type: "text-delta", index: openText.index, text: delta.content };
					}
					if (Array.isArray(delta.tool_calls)) {
						for (const call of delta.tool_calls) {
							const wireIndex = Number.isSafeInteger(call.index) ? call.index : 0;
							let entry = toolBlocks.get(wireIndex);
							if (!entry) {
								yield* closeText();
								yield* closeReasoning();
								entry = { index: nextIndex++, id: typeof call.id === "string" && call.id.length > 0 ? call.id : `bionic-call-${Date.now()}-${wireIndex}`, name: "", args: "" };
								toolBlocks.set(wireIndex, entry);
								yield { type: "block-start", index: entry.index, blockType: "tool-call" };
							}
							const name = call.function?.name;
							const argsDelta = typeof call.function?.arguments === "string" ? call.function.arguments : "";
							if (typeof call.id === "string" && call.id.length > 0) entry.id = call.id;
							if (typeof name === "string" && name.length > 0) entry.name = name;
							entry.args += argsDelta;
							if (argsDelta.length > 0 || (typeof name === "string" && name.length > 0)) sawContent = true;
							yield { type: "tool-call-delta", index: entry.index, id: entry.id, ...(typeof name === "string" && name.length > 0 ? { name } : {}), argumentsDelta: argsDelta };
						}
					}
				}
			}
			yield* closeText();
			yield* closeReasoning();
			for (const entry of toolBlocks.values()) {
				yield { type: "block-end", index: entry.index, block: { type: "tool-call", id: entry.id, name: entry.name, arguments: entry.args.trim().length > 0 ? entry.args : "{}" } };
			}
			if (usage) {
				yield {
					type: "usage",
					usage: {
						inputTokens: usage.prompt_tokens ?? usage.input_tokens ?? 0,
						outputTokens: usage.completion_tokens ?? usage.output_tokens ?? 0,
						...(Number.isSafeInteger(usage.total_tokens) ? { totalTokens: usage.total_tokens } : {}),
						...(Number.isSafeInteger(usage.prompt_cache_tokens) ? { cacheReadTokens: usage.prompt_cache_tokens } : {}),
					},
				};
			}
			if (!sawContent) {
				yield { type: "finish", reason: { kind: "error", failure: bridgeError(`bionic-bridge: model ${options.model} returned no content`, "EMPTY_RESPONSE").failure } };
				return;
			}
			yield { type: "finish", reason: finishKind(finishReason) };
		} finally {
			try {
				await reader.cancel().catch(() => {});
			} catch {}
		}
	}

	async function imageToDataUrl(block) {
		try {
			const hostPath = ctx.attachments.imageHostPath(block.attachment);
			if (hostPath === undefined) return undefined;
			const bytes = await readFile(hostPath);
			return `data:${block.attachment.mediaType};base64,${bytes.toString("base64")}`;
		} catch {
			return undefined;
		}
	}

	function finishKind(finishReason) {
		switch (finishReason) {
			case "tool_calls":
				return { kind: "tool-calls" };
			case "length":
				return { kind: "max-tokens" };
			default:
				return { kind: "stop" };
		}
	}

	function withTimeout(promise, ms, signal) {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(bridgeError(`bionic-bridge: stream idle for ${ms} ms`, "TIMEOUT")), ms);
			const onAbort = () => reject(bridgeError("bionic-bridge: aborted", "ABORTED"));
			signal?.addEventListener("abort", onAbort, { once: true });
			promise.then(
				(value) => {
					clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
					resolve(value);
				},
				(error) => {
					clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
					if (signal?.aborted) reject(bridgeError("bionic-bridge: aborted", "ABORTED", { cause: error }));
					else if (error?.message === "Failed to fetch" || error?.name === "TypeError") reject(bridgeError(`bionic-bridge: transport failure: ${error.message}`, "TRANSPORT", { cause: error }));
					else reject(error);
				},
			);
		});
	}

	const handle = ctx.llm.registerAdapter([config.providerName], adapter);
	ctx.effect(() => () => handle());

	const disposeTool = ctx.tools.register({
		name: /^[a-z0-9_]{1,64}$/.test(config.statusToolName) ? config.statusToolName : `${config.providerName.replace(/[^a-z0-9_]/gi, "_")}_status`,
		description:
			`Diagnose the "${config.displayName}" bridge (provider route ${config.providerName}, endpoint ${config.baseURL}): 'probe' checks the model server and lists served models, 'list' shows the merged catalog, 'selftest' runs a tiny end-to-end turn through the registered route and reports finish reason and text. Use before blaming the agent for model problems.`,
		parameters: {
			type: "object",
			properties: {
				action: { type: "string", enum: ["probe", "list", "selftest"], description: "probe = reachability + served ids; list = static + live catalog; selftest = one small streamed turn." },
				model: { type: "string", description: "Optional model id for selftest; defaults to the first catalog entry." },
			},
			required: ["action"],
			additionalProperties: false,
		},
		output: {
			schema: { type: "object", additionalProperties: true },
			render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }],
		},
		timeoutMs: 60000,
		isConcurrencySafe: () => true,
		async execute(args, exec) {
			const action = args.action;
			if (action === "probe") {
				live = { at: 0, models: live.models };
				const served = await probeLive(exec.signal);
				return { ok: served.length > 0, baseURL: config.baseURL, provider: config.providerName, served };
			}
			if (action === "list") {
				return { provider: config.providerName, baseURL: config.baseURL, models: await catalog(exec.signal) };
			}
			const models = await catalog(exec.signal);
			const model = typeof args.model === "string" && args.model.length > 0 ? args.model : models[0]?.id;
			if (model === undefined) return { ok: false, provider: config.providerName, error: "no models in catalog; start the server in Bionic/LM Studio and retry probe" };
			const textParts = [];
			let finish = null;
			let usageSeen = null;
			for await (const chunk of ctx.llm.stream({
				provider: config.providerName,
				model,
				messages: [{ role: "user", content: [{ type: "text", text: "Reply with exactly: BRIDGE OK" }] }],
				maxTokens: 24,
				signal: exec.signal,
				purpose: "diagnostics",
			})) {
				if (chunk.type === "text-delta") textParts.push(chunk.text);
				else if (chunk.type === "usage") usageSeen = chunk.usage;
				else if (chunk.type === "finish") finish = chunk.reason;
			}
			return { ok: finish?.kind === "stop" || finish?.kind === "tool-calls", provider: config.providerName, model, finish: finish?.kind ?? null, failure: finish?.failure ?? null, text: textParts.join(""), usage: usageSeen };
		},
	});
	ctx.effect(() => () => disposeTool());
}
