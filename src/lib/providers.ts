import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

export type Provider =
  | "anthropic"
  | "openai"
  | "google"
  | "xai"
  | "deepseek"
  | "openrouter"
  | "lmstudio";

export const LMSTUDIO_BASE_URL =
  process.env.LMSTUDIO_BASE_URL ?? "http://localhost:1234/v1";

export interface ModelConfig {
  id: string;
  label: string;
  provider: Provider;
}

// Curated models: the fallback and the label overrides for live discovery
// (src/lib/discovery.ts), which lists discovered models newest first. Where a
// provider still lists one of these, it keeps this label. If a provider's
// query fails, or its key is missing, the picker shows these in this order.
// OpenRouter isn't discovered, so its entries here are the whole list.
export const MODELS: ModelConfig[] = [
  { id: "claude-haiku-4-5", label: "Haiku 4.5", provider: "anthropic" },
  { id: "claude-sonnet-5", label: "Sonnet 5", provider: "anthropic" },
  { id: "claude-opus-4-8", label: "Opus 4.8", provider: "anthropic" },
  { id: "claude-opus-5", label: "Opus 5", provider: "anthropic" },
  { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", provider: "openai" },
  { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", provider: "openai" },
  { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", provider: "openai" },
  { id: "gemini-3.5-flash-lite", label: "3.5 Flash Lite", provider: "google" },
  { id: "gemini-3.7-flash", label: "3.7 Flash", provider: "google" },
  { id: "gemini-3.1-pro-preview", label: "3.1 Pro (Preview)", provider: "google" },
  { id: "grok-4.6", label: "Grok 4.6", provider: "xai" },
  { id: "deepseek-v4-flash", label: "V4 Flash", provider: "deepseek" },
  { id: "deepseek-v4-pro", label: "V4 Pro", provider: "deepseek" },
  // Deliberately the small/flash tiers, not the flagships. The flagship open
  // models (Qwen3.8 Max, Kimi K3, GLM 5.3) are far too slow to sweep twelve
  // metres against; these trade accuracy for a turnaround that makes the sweep
  // usable. Expect metre and fidelity errors here — that is the accepted cost.
  { id: "mistralai/mistral-small-2603", label: "Mistral Small", provider: "openrouter" },
  { id: "qwen/qwen3.7-flash", label: "Qwen 3.7 Flash", provider: "openrouter" },
  { id: "z-ai/glm-4.7-flash", label: "GLM 4.7 Flash", provider: "openrouter" },
];

export function findModel(id: string): ModelConfig | undefined {
  return MODELS.find((m) => m.id === id);
}

/**
 * Probe the LM Studio server for currently-loaded models. Returns [] if the
 * server is unreachable (LM Studio not running) so the UI just silently
 * shows no Local chips.
 */
export async function discoverLMStudioModels(): Promise<ModelConfig[]> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const r = await fetch(`${LMSTUDIO_BASE_URL}/models`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return [];
    const body = (await r.json()) as { data?: Array<{ id: string }> };
    return (body.data ?? [])
      .filter((m) => isChatModel(m.id))
      .map((m) => ({
        id: m.id,
        label: humaniseLMStudioId(m.id),
        provider: "lmstudio" as const,
      }));
  } catch {
    return [];
  }
}

function isChatModel(id: string): boolean {
  // LM Studio's /v1/models lists every loaded model including embedding and
  // transcription models that can't do chat completions. Filter those out so
  // the picker only shows usable chips.
  return !/(\bembed\b|embedding|whisper|tts|asr|reranker|clip|vision[-_]encoder)/i.test(
    id
  );
}

function humaniseLMStudioId(id: string): string {
  // "lmstudio-community/Llama-3.2-3B-Instruct-GGUF" → "Llama 3.2 3B Instruct"
  const last = id.split("/").pop() ?? id;
  return last
    .replace(/[-_]/g, " ")
    .replace(/\bGGUF\b/i, "")
    .replace(/\bMLX\b/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

interface ProviderEndpoint {
  envKey: string | null; // null => no key required (e.g. local server)
  baseURL?: string;
}

// Google isn't here: it runs on its native API (generateGeminiNative), not the
// OpenAI-compatible endpoint.
const ENDPOINTS: Record<Exclude<Provider, "anthropic" | "google">, ProviderEndpoint> = {
  openai: { envKey: "OPENAI_API_KEY" },
  xai: { envKey: "XAI_API_KEY", baseURL: "https://api.x.ai/v1" },
  deepseek: { envKey: "DEEPSEEK_API_KEY", baseURL: "https://api.deepseek.com/v1" },
  openrouter: {
    envKey: "OPENROUTER_API_KEY",
    baseURL: "https://openrouter.ai/api/v1",
  },
  lmstudio: { envKey: null, baseURL: LMSTUDIO_BASE_URL },
};

export interface GenerateInput {
  model: ModelConfig;
  systemPrompt: string;
  userPrompt: string;
  schema: object;
  onChunk?: (delta: string) => void;
  // Visible reasoning text as it streams (DeepSeek/OpenRouter/LM Studio
  // reasoning_content, Claude's summarized thinking, OpenAI's reasoning
  // summaries, Gemini's thought summaries), with the running count of
  // reasoning deltas so far.
  onReasoning?: (delta: string, chunkCount: number) => void;
  // Aborts the upstream model request when the client disconnects/cancels, so a
  // long-thinking model stops burning tokens instead of running to maxDuration.
  signal?: AbortSignal;
}

export interface GenerateOutput {
  json: unknown;
  stopReason: string;
  usage: Record<string, number>;
}

export class ProviderError extends Error {
  status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.status = status;
  }
}

export async function generateVariants(input: GenerateInput): Promise<GenerateOutput> {
  switch (input.model.provider) {
    case "anthropic":
      return generateAnthropic(input);
    case "openai":
      return generateOpenAIResponses(input);
    case "google":
      return generateGeminiNative(input);
    case "xai":
      return generateOpenAICompat(input, input.model.provider, /* schemaSupport */ true);
    case "deepseek":
    case "openrouter":
    case "lmstudio":
      // DeepSeek's compat endpoint, OpenRouter's varied backends, and most
      // local LM Studio models don't reliably honour json_schema strict mode
      // — fall back to json_object.
      return generateOpenAICompat(input, input.model.provider, /* schemaSupport */ false);
  }
}

// Claude models before 4.6 only take the fixed-budget form of thinking (and no
// effort); 4.6 and later take adaptive thinking plus output_config.effort, and
// the newest (Fable, Mythos, Opus 5.5) reject anything else. Other claude-3
// models have no thinking at all; they are no longer served.
const CLAUDE_BUDGET_THINKING =
  /^claude-(?:3-7-|(?:haiku|sonnet|opus)-4(?:-[015])?(?:-\d{8})?$)/;
// Thinking effort for adaptive models. It governs the whole response's token
// spend, not only the thinking; "medium" keeps it modest without starving the
// rendering itself (thinking was off entirely before 2026-09-25).
const CLAUDE_EFFORT = "medium" as const;
// Budget for the pre-4.6 models, which must also stay below max_tokens.
const CLAUDE_THINKING_BUDGET = 2048;

type ClaudeThinkingStyle = "adaptive" | "budget";

function claudeThinkingParams(style: ClaudeThinkingStyle) {
  return style === "adaptive"
    ? {
        // display: "summarized" — the default on current models is "omitted",
        // which streams thinking blocks with empty text (a silent pause).
        thinking: { type: "adaptive", display: "summarized" } as const,
        effort: CLAUDE_EFFORT,
      }
    : {
        // Pre-4.6 models return summarized thinking by default.
        thinking: { type: "enabled", budget_tokens: CLAUDE_THINKING_BUDGET } as const,
        effort: undefined,
      };
}

async function generateAnthropic(input: GenerateInput): Promise<GenerateOutput> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new ProviderError("ANTHROPIC_API_KEY is not set", 401);

  const client = new Anthropic({ apiKey });
  let style: ClaudeThinkingStyle = CLAUDE_BUDGET_THINKING.test(input.model.id)
    ? "budget"
    : "adaptive";
  let emitted = false;
  let reasoningChunks = 0;

  for (let attempt = 0; ; attempt++) {
    const { thinking, effort } = claudeThinkingParams(style);
    const stream = client.messages.stream({
      model: input.model.id,
      // Thinking tokens count against max_tokens, so leave room for both.
      max_tokens: 32000,
      thinking,
      system: [
        {
          type: "text",
          text: input.systemPrompt,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: input.userPrompt }],
      output_config: {
        format: { type: "json_schema", schema: input.schema as { [k: string]: unknown } },
        ...(effort ? { effort } : {}),
      },
    }, { signal: input.signal });

    stream.on("text", (delta) => {
      emitted = true;
      input.onChunk?.(delta);
    });
    stream.on("thinking", (delta) => {
      if (!delta) return;
      emitted = true;
      reasoningChunks++;
      input.onReasoning?.(delta, reasoningChunks);
    });

    let final: Anthropic.Message;
    try {
      final = await stream.finalMessage();
    } catch (err) {
      // If the id-based guess picked the thinking form this model rejects, the
      // 400 comes back before any output (and is not billed): retry once with
      // the other form.
      if (
        attempt === 0 &&
        !emitted &&
        err instanceof Anthropic.BadRequestError &&
        /thinking|adaptive|budget|effort|display/i.test(err.message)
      ) {
        console.log(
          `[anthropic] ${input.model.id} rejected ${style} thinking, retrying: ${err.message}`
        );
        style = style === "adaptive" ? "budget" : "adaptive";
        continue;
      }
      throw err;
    }

    const text = final.content.find(
      (b): b is Anthropic.TextBlock => b.type === "text"
    )?.text;
    if (!text) {
      throw new ProviderError(
        `Anthropic returned no text content (stop_reason=${final.stop_reason})`,
        502
      );
    }

    return {
      json: safeParse(text),
      stopReason: final.stop_reason ?? "unknown",
      usage: {
        input_tokens: final.usage.input_tokens,
        output_tokens: final.usage.output_tokens,
        cache_read_input_tokens: final.usage.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: final.usage.cache_creation_input_tokens ?? 0,
      },
    };
  }
}

// OpenAI reasoning models: the o-series and GPT-5 family, except the -chat
// aliases, which are non-reasoning (as are gpt-4o / gpt-4.1). Non-reasoning
// models reject the `reasoning` parameter.
const OPENAI_REASONING = /^(?:o\d|gpt-5)/;
const OPENAI_NON_REASONING = /-chat\b|^chatgpt-/;
// Low effort keeps reasoning (and its summaries) on without much spend. GPT-5.1
// and later default to "none", which would think and summarise nothing; older
// reasoning models default to "medium".
const OPENAI_EFFORT = "low" as const;

// The openai provider runs on the Responses API rather than Chat Completions,
// because only Responses streams reasoning summaries.
async function generateOpenAIResponses(input: GenerateInput): Promise<GenerateOutput> {
  const k = process.env.OPENAI_API_KEY;
  if (!k) throw new ProviderError("OPENAI_API_KEY is not set", 401);
  const client = new OpenAI({ apiKey: k, timeout: 790_000, maxRetries: 0 });
  const id = input.model.id;

  const isReasoning = OPENAI_REASONING.test(id) && !OPENAI_NON_REASONING.test(id);
  // -pro models accept only their own default effort, so leave it unset there.
  let reasoning: { effort?: typeof OPENAI_EFFORT; summary?: "auto" } | undefined =
    isReasoning
      ? { ...(/-pro\b/.test(id) ? {} : { effort: OPENAI_EFFORT }), summary: "auto" }
      : undefined;

  const open = () =>
    client.responses.create({
      model: id,
      instructions: input.systemPrompt,
      input: input.userPrompt,
      text: {
        format: {
          type: "json_schema",
          name: "psalter_variants",
          schema: input.schema as Record<string, unknown>,
          strict: true,
        },
      },
      ...(reasoning ? { reasoning } : {}),
      // Chat Completions never stored requests; keep it that way.
      store: false,
      stream: true,
    }, { signal: input.signal });

  const t0 = Date.now();
  let stream: Awaited<ReturnType<typeof open>> | null = null;
  while (!stream) {
    try {
      stream = await open();
    } catch (err) {
      // A 400 on the reasoning options arrives before any output and is not
      // billed. Reasoning summaries need a verified organisation, and a model
      // the regex misjudges may reject `reasoning` outright: step down once
      // each rather than failing the render.
      if (!(err instanceof OpenAI.BadRequestError) || !reasoning) throw err;
      if (reasoning.summary && /summar|verif/i.test(err.message)) {
        console.log(`[openai] ${id}: reasoning summaries refused, retrying without: ${err.message}`);
        reasoning = reasoning.effort ? { effort: reasoning.effort } : undefined;
      } else if (/reasoning|effort/i.test(err.message)) {
        console.log(`[openai] ${id}: reasoning params refused, retrying without: ${err.message}`);
        reasoning = undefined;
      } else {
        throw err;
      }
    }
  }

  let text = "";
  let refusal = "";
  let reasoningChunks = 0;
  let reasoningChars = 0;
  let needBreak = false;
  let firstTokenAt: number | null = null;
  let finalResponse: OpenAI.Responses.Response | null = null;

  for await (const ev of stream) {
    switch (ev.type) {
      case "response.reasoning_summary_part.added":
        // Each summary part is its own paragraph.
        if (reasoningChars > 0) needBreak = true;
        break;
      case "response.reasoning_summary_text.delta": {
        if (!ev.delta) break;
        const delta = needBreak ? `\n\n${ev.delta}` : ev.delta;
        needBreak = false;
        reasoningChunks++;
        reasoningChars += delta.length;
        input.onReasoning?.(delta, reasoningChunks);
        break;
      }
      case "response.output_text.delta":
        if (firstTokenAt === null) {
          firstTokenAt = Date.now() - t0;
          console.log(`[openai] first content token after ${firstTokenAt}ms`);
        }
        text += ev.delta;
        input.onChunk?.(ev.delta);
        break;
      case "response.refusal.delta":
        refusal += ev.delta;
        break;
      case "response.completed":
      case "response.incomplete":
      case "response.failed":
        finalResponse = ev.response;
        break;
      case "error":
        throw new ProviderError(`openai stream error: ${ev.message}`, 502);
    }
  }

  const status = finalResponse?.status ?? "unknown";
  const stopReason =
    status === "incomplete"
      ? `incomplete:${finalResponse?.incomplete_details?.reason ?? "unknown"}`
      : status;
  console.log(
    `[openai] stream ended after ${Date.now() - t0}ms, status=${stopReason}, reasoning_chunks=${reasoningChunks}, chars=${text.length}`
  );

  if (status === "failed") {
    throw new ProviderError(
      `openai response failed: ${finalResponse?.error?.message ?? "unknown error"}`,
      502
    );
  }
  if (!text) {
    throw new ProviderError(
      refusal
        ? `openai refused: ${refusal.slice(0, 200)}`
        : `openai returned no message content (status=${stopReason})`,
      502
    );
  }

  const u = finalResponse?.usage;
  return {
    json: safeParse(text),
    stopReason,
    usage: {
      input_tokens: u?.input_tokens ?? 0,
      output_tokens: u?.output_tokens ?? 0,
      cache_read_input_tokens: u?.input_tokens_details?.cached_tokens ?? 0,
      reasoning_tokens: u?.output_tokens_details?.reasoning_tokens ?? 0,
    },
  };
}

// Gemini runs on the native generateContent API rather than Google's
// OpenAI-compatible endpoint, because only the native API returns thought
// summaries as their own parts (`thought: true`). The compat endpoint documents
// no separate thought field and appears to fold them into the message content,
// where they would break the JSON.
const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta/models";

// How much of the thinking config to send. "tuned" caps thinking low: Gemini
// 3.x otherwise defaults to a generous dynamic level, and a "Flash" model can
// sit silent for 90s+ before its first token. 3.x takes thinkingLevel, 2.x
// only thinkingBudget (thinkingLevel is an error there); 1,024 tokens is what
// reasoning_effort "low" mapped to on the compat endpoint. "summaries" drops
// the cap but still asks for thought summaries; "off" sends no thinking config,
// for a model that rejects it outright.
type GeminiThinking = "tuned" | "summaries" | "off";

function geminiThinkingConfig(id: string, mode: GeminiThinking) {
  if (mode === "off") return undefined;
  if (mode === "summaries") return { includeThoughts: true };
  return /^gemini-[12]\./.test(id)
    ? { includeThoughts: true, thinkingBudget: 1024 }
    : { includeThoughts: true, thinkingLevel: "LOW" };
}

interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
}

interface GeminiStreamChunk {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] };
    finishReason?: string;
    finishMessage?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    cachedContentTokenCount?: number;
  };
  promptFeedback?: { blockReason?: string };
  error?: { code?: number; message?: string; status?: string };
}

// Yields the parsed JSON of each `data:` event in a server-sent-event body.
// Events can arrive split across network chunks (or several to a chunk), so
// bytes are buffered until a blank line ends the event.
async function* readSSEJson(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const parse = (event: string): unknown => {
    const data = event
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data || data === "[DONE]") return undefined;
    try {
      return JSON.parse(data);
    } catch {
      throw new ProviderError(`google sent an unreadable stream event: ${data.slice(0, 200)}`, 502);
    }
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buf += decoder.decode(value, { stream: !done });
      let m: RegExpExecArray | null;
      while ((m = /\r?\n\r?\n/.exec(buf))) {
        const ev = parse(buf.slice(0, m.index));
        buf = buf.slice(m.index + m[0].length);
        if (ev !== undefined) yield ev;
      }
      if (done) break;
    }
    const tail = parse(buf);
    if (tail !== undefined) yield tail;
  } finally {
    // Also runs when the consumer stops early (an error event, a throw): close
    // the connection rather than leave the upstream stream running.
    await reader.cancel().catch(() => {});
  }
}

async function generateGeminiNative(input: GenerateInput): Promise<GenerateOutput> {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new ProviderError("GOOGLE_API_KEY is not set", 401);
  const id = input.model.id;

  let thinking: GeminiThinking = "tuned";
  const open = () => {
    const thinkingConfig = geminiThinkingConfig(id, thinking);
    return fetch(`${GEMINI_API}/${encodeURIComponent(id)}:streamGenerateContent?alt=sse`, {
      method: "POST",
      // The key goes in a header rather than ?key= so it stays out of URLs.
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: input.systemPrompt }] },
        contents: [{ role: "user", parts: [{ text: input.userPrompt }] }],
        // No maxOutputTokens: it counts thinking too, and the model's own limit
        // (what the compat endpoint used) leaves room for the longest psalms.
        generationConfig: {
          responseMimeType: "application/json",
          responseJsonSchema: input.schema,
          ...(thinkingConfig ? { thinkingConfig } : {}),
        },
      }),
      signal: input.signal,
    });
  };

  const t0 = Date.now();
  let res: Response;
  for (;;) {
    res = await open();
    if (res.ok) break;
    const raw = await res.text().catch(() => "");
    let message = raw.slice(0, 500);
    try {
      message = (JSON.parse(raw) as GeminiStreamChunk).error?.message ?? message;
    } catch {
      // Not JSON; keep the raw text.
    }
    // A 400 on the thinking config arrives before any output and is not
    // billed. A model that takes neither thinkingLevel nor thinkingBudget, or no
    // thinking config at all, steps down once each rather than failing.
    if (res.status === 400 && thinking !== "off" && /think|budget|level/i.test(message)) {
      const next: GeminiThinking = thinking === "tuned" ? "summaries" : "off";
      console.log(`[google] ${id}: thinking config (${thinking}) refused, retrying as ${next}: ${message}`);
      thinking = next;
      continue;
    }
    throw new ProviderError(`google ${res.status}: ${message}`, res.status);
  }
  if (!res.body) throw new ProviderError("google returned an empty stream", 502);

  let text = "";
  let reasoningText = "";
  let reasoningChunks = 0;
  let firstTokenAt: number | null = null;
  let firstReasoningAt: number | null = null;
  let finishReason = "unknown";
  let finishMessage = "";
  let blockReason = "";
  let usage: NonNullable<GeminiStreamChunk["usageMetadata"]> = {};

  for await (const ev of readSSEJson(res.body)) {
    const chunk = ev as GeminiStreamChunk;
    if (chunk.error) {
      throw new ProviderError(
        `google stream error: ${chunk.error.message ?? chunk.error.status ?? "unknown"}`,
        502
      );
    }
    if (chunk.usageMetadata) usage = chunk.usageMetadata;
    if (chunk.promptFeedback?.blockReason) blockReason = chunk.promptFeedback.blockReason;
    const cand = chunk.candidates?.[0];
    if (cand?.finishReason) finishReason = cand.finishReason;
    if (cand?.finishMessage) finishMessage = cand.finishMessage;

    for (const part of cand?.content?.parts ?? []) {
      // Parts can carry only a thoughtSignature, with no text.
      if (!part.text) continue;
      if (part.thought) {
        if (firstReasoningAt === null) {
          firstReasoningAt = Date.now() - t0;
          console.log(`[google] reasoning started after ${firstReasoningAt}ms`);
        }
        // Each summary section starts with a bold heading, often with no
        // separator from the one before; give each its own paragraph. (Only
        // after a finished sentence, so a bold word mid-sentence is left alone.)
        const delta =
          part.text.startsWith("**") && /[.!?]$/.test(reasoningText)
            ? `\n\n${part.text}`
            : part.text;
        reasoningText += delta;
        reasoningChunks++;
        input.onReasoning?.(delta, reasoningChunks);
      } else {
        if (firstTokenAt === null) {
          firstTokenAt = Date.now() - t0;
          console.log(
            `[google] first content token after ${firstTokenAt}ms` +
              (firstReasoningAt !== null ? ` (reasoned for ${firstTokenAt - firstReasoningAt}ms)` : "")
          );
        }
        text += part.text;
        input.onChunk?.(part.text);
      }
    }
  }

  console.log(
    `[google] stream ended after ${Date.now() - t0}ms, thinking=${thinking}, reasoning_chunks=${reasoningChunks}, chars=${text.length}, finish=${finishReason}`
  );

  if (!text) {
    const why = blockReason
      ? `prompt blocked: ${blockReason}`
      : `finish_reason=${finishReason}${finishMessage ? `: ${finishMessage}` : ""}`;
    throw new ProviderError(`google returned no message content (${why})`, 502);
  }

  const thoughts = usage.thoughtsTokenCount ?? 0;
  return {
    json: safeParse(text),
    stopReason: finishReason,
    usage: {
      input_tokens: usage.promptTokenCount ?? 0,
      // Thinking is billed as output, as OpenAI's output_tokens counts it.
      output_tokens: (usage.candidatesTokenCount ?? 0) + thoughts,
      cache_read_input_tokens: usage.cachedContentTokenCount ?? 0,
      reasoning_tokens: thoughts,
    },
  };
}

async function generateOpenAICompat(
  input: GenerateInput,
  provider: "xai" | "deepseek" | "openrouter" | "lmstudio",
  schemaSupport: boolean
): Promise<GenerateOutput> {
  const endpoint = ENDPOINTS[provider];
  let apiKey: string;
  if (endpoint.envKey === null) {
    apiKey = "lm-studio"; // local server, key is ignored but SDK requires non-empty
  } else {
    const k = process.env[endpoint.envKey];
    if (!k) throw new ProviderError(`${endpoint.envKey} is not set`, 401);
    apiKey = k;
  }

  const client = new OpenAI({
    apiKey,
    baseURL: endpoint.baseURL,
    // SDK default is 600_000ms — a slow reasoning model (e.g. Kimi via
    // OpenRouter) trips it and the request dies silently at 600s, well before
    // the route's maxDuration=800 ceiling. Raise it just under that ceiling so
    // the Vercel limit governs, not the SDK. Retries off: re-running an
    // 800s job on timeout is never what we want.
    timeout: 790_000,
    maxRetries: 0,
  });

  const t0 = Date.now();
  const stream = await client.chat.completions.create({
    model: input.model.id,
    messages: [
      { role: "system", content: input.systemPrompt },
      { role: "user", content: input.userPrompt },
    ],
    response_format: schemaSupport
      ? {
          type: "json_schema",
          json_schema: {
            name: "psalter_variants",
            schema: input.schema as Record<string, unknown>,
            strict: true,
          },
        }
      : { type: "json_object" },
    stream: true,
    // OpenAI-specific extension that DeepSeek and most local servers may not
    // honor — sending it can silently break streaming.
    ...(provider === "deepseek" || provider === "lmstudio"
      ? {}
      : { stream_options: { include_usage: true } }),
  }, { signal: input.signal });

  let text = "";
  let finishReason = "unknown";
  let usage = { input_tokens: 0, output_tokens: 0 };
  let firstTokenAt: number | null = null;
  let firstReasoningAt: number | null = null;
  let tokenChunks = 0;
  let reasoningChunks = 0;
  let chunkIndex = 0;

  for await (const chunk of stream) {
    chunkIndex++;
    const choice = chunk.choices[0];
    const delta = choice?.delta as
      | { content?: string; reasoning_content?: string; reasoning?: string }
      | undefined;
    // DeepSeek-direct emits `reasoning_content`; OpenRouter normalizes the same
    // tokens into `reasoning`. Treat them interchangeably: the text streams to
    // the Reasoning panel and the count drives the thinking indicator.
    const reasoning = delta?.reasoning_content ?? delta?.reasoning;

    if (chunkIndex === 1) {
      console.log(
        `[${provider}] first chunk after ${Date.now() - t0}ms, delta keys:`,
        delta ? Object.keys(delta) : "no delta"
      );
    }

    if (reasoning) {
      if (firstReasoningAt === null) {
        firstReasoningAt = Date.now() - t0;
        console.log(`[${provider}] reasoning started after ${firstReasoningAt}ms`);
      }
      reasoningChunks++;
      if (reasoningChunks % 100 === 0) {
        console.log(`[${provider}] ${reasoningChunks} reasoning chunks…`);
      }
      input.onReasoning?.(reasoning, reasoningChunks);
    }

    if (delta?.content) {
      if (firstTokenAt === null) {
        firstTokenAt = Date.now() - t0;
        console.log(
          `[${provider}] first content token after ${firstTokenAt}ms` +
            (firstReasoningAt !== null
              ? ` (reasoned for ${firstTokenAt - firstReasoningAt}ms)`
              : "")
        );
      }
      text += delta.content;
      tokenChunks++;
      input.onChunk?.(delta.content);
    }
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (chunk.usage) {
      usage = {
        input_tokens: chunk.usage.prompt_tokens ?? 0,
        output_tokens: chunk.usage.completion_tokens ?? 0,
      };
    }
  }

  console.log(
    `[${provider}] stream ended after ${Date.now() - t0}ms, content_chunks=${tokenChunks}, reasoning_chunks=${reasoningChunks}, chars=${text.length}, finish=${finishReason}`
  );

  if (!text) {
    throw new ProviderError(
      `${provider} returned no message content (finish_reason=${finishReason})`,
      502
    );
  }

  return {
    json: safeParse(text),
    stopReason: finishReason,
    usage,
  };
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError(`Model returned non-JSON output: ${text.slice(0, 200)}`, 502);
  }
}
