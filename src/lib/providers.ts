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

export const MODELS: ModelConfig[] = [
  { id: "claude-haiku-4-5", label: "Haiku 4.5", provider: "anthropic" },
  { id: "claude-sonnet-5", label: "Sonnet 5", provider: "anthropic" },
  { id: "claude-opus-4-8", label: "Opus 4.8", provider: "anthropic" },
  { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", provider: "openai" },
  { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", provider: "openai" },
  { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", provider: "openai" },
  { id: "gemini-3.1-flash-lite", label: "3.1 Flash Lite", provider: "google" },
  { id: "gemini-3.5-flash", label: "3.5 Flash", provider: "google" },
  { id: "gemini-3.1-pro-preview", label: "3.1 Pro (Preview)", provider: "google" },
  { id: "grok-4.5", label: "Grok 4.5", provider: "xai" },
  { id: "deepseek-v4-flash", label: "V4 Flash", provider: "deepseek" },
  { id: "deepseek-v4-pro", label: "V4 Pro", provider: "deepseek" },
  { id: "meta-llama/llama-4-maverick", label: "Llama 4 Maverick", provider: "openrouter" },
  { id: "qwen/qwen3.7-plus", label: "Qwen 3.7 Plus", provider: "openrouter" },
  { id: "moonshotai/kimi-k2.6", label: "Kimi K2.6", provider: "openrouter" },
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

const ENDPOINTS: Record<Exclude<Provider, "anthropic">, ProviderEndpoint> = {
  openai: { envKey: "OPENAI_API_KEY" },
  google: {
    envKey: "GOOGLE_API_KEY",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
  },
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
  onReasoning?: (chunkCount: number) => void;
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
    case "xai":
    case "google":
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

async function generateAnthropic(input: GenerateInput): Promise<GenerateOutput> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new ProviderError("ANTHROPIC_API_KEY is not set", 401);

  const client = new Anthropic({ apiKey });
  const stream = client.messages.stream({
    model: input.model.id,
    max_tokens: 16000,
    thinking: { type: "disabled" },
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
    },
  }, { signal: input.signal });

  if (input.onChunk) {
    stream.on("text", (delta) => input.onChunk?.(delta));
  }

  const final = await stream.finalMessage();
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

async function generateOpenAICompat(
  input: GenerateInput,
  provider: "openai" | "google" | "xai" | "deepseek" | "openrouter" | "lmstudio",
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
    // Gemini 3.x defaults to a generous dynamic thinking budget, so a "Flash"
    // model can sit silent for 90s+ before its first token. Google's compat
    // endpoint maps reasoning_effort to the thinking budget — cap it low.
    ...(provider === "google" ? { reasoning_effort: "low" as const } : {}),
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
    // tokens into `reasoning`. Treat them interchangeably so the thinking
    // indicator works for both.
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
      input.onReasoning?.(reasoningChunks);
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
