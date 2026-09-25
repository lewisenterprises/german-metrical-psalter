import { MODELS, type ModelConfig, type Provider } from "./providers";

// Live model discovery: asks each cloud provider which models its key can use,
// filters to text chat models that can do this job, and merges the result with
// the curated MODELS entries. Server-only — the API routes use it; the
// Trigger.dev task never imports it (it receives a resolved ModelConfig in its
// payload), so the task bundle doesn't carry it.

type CloudProvider = Exclude<Provider, "lmstudio">;
// OpenRouter is deliberately not discovered: it lists hundreds of models, and
// its curated tiers were chosen for speed (see the comment in MODELS).
type Discoverable = Exclude<CloudProvider, "openrouter">;

export const ENV_KEYS: Record<CloudProvider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_API_KEY",
  xai: "XAI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

const CLOUD_PROVIDERS = Object.keys(ENV_KEYS) as CloudProvider[];

const TIMEOUT_MS = 5_000;
const TTL_MS = 60 * 60 * 1000;
// A failed query is retried sooner, so a transient outage doesn't pin the
// curated fallback for the whole hour.
const FAILURE_TTL_MS = 5 * 60 * 1000;

// One model as a provider lists it, after the relevance filter.
export interface Listed {
  id: string;
  label?: string;
  created?: number;
  aliases?: string[];
}

export type AvailableModel = ModelConfig & { available: boolean };

// ---- Per-provider filters (pure, so they can be checked offline) ----------

export interface AnthropicModel {
  id: string;
  display_name?: string;
  capabilities?: { structured_outputs?: { supported?: boolean } };
}

export function filterAnthropic(data: AnthropicModel[]): Listed[] {
  return data
    .filter(
      (m) =>
        m.id.startsWith("claude-") &&
        // Generation sends output_config.format (json_schema); models that
        // report no structured-output support would 400.
        m.capabilities?.structured_outputs?.supported !== false &&
        // Generation also sends thinking: disabled, which these reject with a
        // 400 (their thinking is always on).
        !/^claude-(fable|mythos)-|^claude-opus-5-5\b/.test(m.id)
    )
    .map((m) => ({
      id: m.id,
      label: m.display_name?.replace(/^Claude\s+/, "") || undefined,
    }));
}

export interface OpenAIStyleModel {
  id: string;
  created?: number;
}

export function filterOpenAI(data: OpenAIStyleModel[]): Listed[] {
  return data
    .filter(
      (m) =>
        /^(gpt-|o\d|chatgpt-)/.test(m.id) &&
        !/image|audio|realtime|live|tts|transcribe|diarize|whisper|dall-e|embedding|moderation|search|computer-use|instruct|babbage|davinci|codex|deep-research|sora|oss/.test(
          m.id
        ) &&
        // -pro models are Responses-API only; generation uses Chat Completions.
        !/-pro\b/.test(m.id) &&
        // Legacy models without json_schema structured outputs.
        !/^gpt-3\.5|^gpt-4(-|$)|^chatgpt-4o|^o1-(mini|preview)/.test(m.id)
    )
    .map((m) => ({ id: m.id, created: m.created }));
}

export interface GoogleModel {
  name: string;
  displayName?: string;
  supportedGenerationMethods?: string[];
}

export function filterGoogle(models: GoogleModel[]): Listed[] {
  return models
    .map((m) => ({ ...m, id: m.name.replace(/^models\//, "") }))
    .filter(
      (m) =>
        m.id.startsWith("gemini-") &&
        (m.supportedGenerationMethods ?? []).includes("generateContent") &&
        // -latest ids are moving aliases of models listed in their own right;
        // -exp ids are short-lived experiments.
        !/image|imagen|veo|tts|audio|live|transcribe|embedding|aqa|robotics|computer-use|customtools|learnlm|gemma|nano-banana|native|deep-research|-exp|-latest$/.test(
          m.id
        )
    )
    .map((m) => ({
      id: m.id,
      label: m.displayName
        ? m.displayName
            .replace(/^Gemini\s+/, "")
            .replace("Flash-Lite", "Flash Lite")
            .replace(/\s+Preview$/, " (Preview)")
        : undefined,
    }));
}

export interface XAILanguageModel {
  id: string;
  created?: number;
  aliases?: string[];
  output_modalities?: string[];
}

const XAI_EXCLUDE = /image|imagine|video|tts|audio|realtime|voice|embed|code|multi-agent/;

export function filterXAI(models: XAILanguageModel[]): Listed[] {
  return models
    .filter(
      (m) =>
        m.id.startsWith("grok-") &&
        // Aliases too: one may become the id shown (see mergeProvider).
        ![m.id, ...(m.aliases ?? [])].some((a) => XAI_EXCLUDE.test(a)) &&
        (m.output_modalities ?? ["text"]).includes("text") &&
        !(m.output_modalities ?? []).some((o) => o !== "text")
    )
    .map((m) => ({ id: m.id, created: m.created, aliases: m.aliases }));
}

// For xAI's plain /v1/models, which carries no modalities: names only.
export function filterXAIByName(data: OpenAIStyleModel[]): Listed[] {
  return data
    .filter((m) => m.id.startsWith("grok-") && !XAI_EXCLUDE.test(m.id))
    .map((m) => ({ id: m.id, created: m.created }));
}

export function filterDeepSeek(data: OpenAIStyleModel[]): Listed[] {
  return data
    .filter((m) => m.id.startsWith("deepseek-") && !/embed/.test(m.id))
    .map((m) => ({ id: m.id }));
}

// ---- Merge ----------------------------------------------------------------

// Ids a dated/versioned snapshot is a copy of. A snapshot is dropped when one
// of these is also known (listed, or a curated entry).
function snapshotBases(provider: Discoverable, id: string): string[] {
  const bases: string[] = [];
  const strip = (re: RegExp) => {
    const b = id.replace(re, "");
    if (b !== id) bases.push(b);
  };
  switch (provider) {
    case "anthropic":
      strip(/-\d{8}$/); // claude-haiku-4-5-20251001
      break;
    case "openai":
      strip(/-\d{4}-\d{2}-\d{2}$/); // gpt-4.1-2025-04-14
      strip(/-\d{4}$/); // older -0613 style
      break;
    case "xai":
      strip(/-\d{4}$/); // grok-4-0709
      break;
    case "google": {
      strip(/-\d{3}$/); // gemini-2.0-flash-001
      // gemini-2.5-flash-preview-09-2025 → gemini-2.5-flash-preview / -flash
      const undated = id.replace(/-\d{2}-\d{2,4}$/, "");
      if (undated !== id) bases.push(undated, undated.replace(/-preview$/, ""));
      break;
    }
    case "deepseek":
      break;
  }
  return bases;
}

// Curated entries the provider still lists keep their label and position (the
// small-to-large convention); newly discovered models follow them. Curated
// entries the provider no longer lists are dropped.
export function mergeProvider(provider: Discoverable, listed: Listed[]): ModelConfig[] {
  const curated = MODELS.filter((m) => m.provider === provider);
  const curatedIds = new Set(curated.map((m) => m.id));

  // xAI lists aliases per model: prefer a curated one, else a clean alias
  // ("grok-4" over "grok-4-0709"), else the id itself.
  const entries = listed.map((l) => ({
    ...l,
    id:
      l.aliases?.find((a) => curatedIds.has(a)) ??
      l.aliases?.find((a) => !/-latest$|-\d{4}$/.test(a)) ??
      l.id,
  }));

  const known = new Set([...entries.map((e) => e.id), ...curatedIds]);
  const present = new Set<string>();
  const extras: Listed[] = [];
  for (const e of entries) {
    const base = snapshotBases(provider, e.id).find((b) => known.has(b));
    if (base) {
      present.add(base);
      continue;
    }
    if (present.has(e.id)) continue;
    present.add(e.id);
    if (!curatedIds.has(e.id)) extras.push(e);
  }

  // Newest first where the API gives creation times; otherwise API order.
  if (extras.every((e) => typeof e.created === "number")) {
    extras.sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
  }

  return [
    ...curated.filter((m) => present.has(m.id)),
    ...extras.map((e) => ({
      id: e.id,
      label: e.label ?? humanise(provider, e.id),
      provider,
    })),
  ];
}

// Labels for id-only listings, matching the curated style: the provider name
// is left off where the group heading already says it ("V4 Pro", "3.7 Flash").
export function humanise(provider: Discoverable, id: string): string {
  const words = (s: string) =>
    s
      .split("-")
      .filter(Boolean)
      .map((w) =>
        /^(\d|o\d)/.test(w)
          ? w
          : /^v\d/i.test(w)
          ? w.toUpperCase()
          : w[0].toUpperCase() + w.slice(1)
      );
  switch (provider) {
    case "openai": {
      const m = id.match(/^gpt-([^-]+)(?:-(.*))?$/);
      return m
        ? ["GPT-" + m[1], ...words(m[2] ?? "")].join(" ")
        : words(id).join(" ");
    }
    case "google":
      return words(id.replace(/^gemini-/, ""))
        .join(" ")
        .replace(/\s+Preview$/, " (Preview)");
    case "deepseek":
      return words(id.replace(/^deepseek-/, "")).join(" ");
    case "anthropic":
      // claude-opus-4-5-20251101 → "Opus 4.5 20251101" (display_name is the
      // norm; this is only a fallback).
      return words(id.replace(/^claude-/, ""))
        .join(" ")
        .replace(/(\d) (?=\d{1,2}\b)/g, "$1.");
    case "xai":
      return words(id).join(" ");
  }
}

// ---- Fetching and cache ---------------------------------------------------

async function getJSON<T>(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal
): Promise<T> {
  // no-store: the module cache below governs, and Next's data cache would key
  // on the request (including credentials).
  const r = await fetch(url, { headers, signal, cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${new URL(url).pathname}`);
  return (await r.json()) as T;
}

// raw/pages feed the non-secret diagnostics in /api/models.
interface ListResult {
  listed: Listed[];
  raw: number;
  pages: number;
}
type Lister = (key: string, signal: AbortSignal) => Promise<ListResult>;

const LISTERS: Record<Discoverable, Lister> = {
  async anthropic(key, signal) {
    const all: AnthropicModel[] = [];
    let after: string | undefined;
    let pages = 0;
    for (; pages < 10; ) {
      pages++;
      const url = new URL("https://api.anthropic.com/v1/models");
      url.searchParams.set("limit", "1000");
      if (after) url.searchParams.set("after_id", after);
      const body = await getJSON<{
        data?: AnthropicModel[];
        has_more?: boolean;
        last_id?: string | null;
      }>(url.toString(), { "x-api-key": key, "anthropic-version": "2023-06-01" }, signal);
      all.push(...(body.data ?? []));
      if (!body.has_more || !body.last_id) break;
      after = body.last_id;
    }
    return { listed: filterAnthropic(all), raw: all.length, pages };
  },

  async openai(key, signal) {
    // /v1/models has been a single page, but follow cursor pagination if the
    // response ever carries it.
    const all: OpenAIStyleModel[] = [];
    let after: string | undefined;
    let pages = 0;
    for (; pages < 10; ) {
      pages++;
      const url = new URL("https://api.openai.com/v1/models");
      if (after) url.searchParams.set("after", after);
      const body = await getJSON<{
        data?: OpenAIStyleModel[];
        has_more?: boolean;
        last_id?: string | null;
      }>(url.toString(), { Authorization: `Bearer ${key}` }, signal);
      const data = body.data ?? [];
      all.push(...data);
      const last = body.last_id ?? data.at(-1)?.id;
      if (!body.has_more || !last) break;
      after = last;
    }
    return { listed: filterOpenAI(all), raw: all.length, pages };
  },

  async google(key, signal) {
    // Native endpoint (it reports supportedGenerationMethods); the key goes in
    // a header rather than ?key= so it stays out of URLs.
    const all: GoogleModel[] = [];
    let token: string | undefined;
    let pages = 0;
    for (; pages < 10; ) {
      pages++;
      const url = new URL("https://generativelanguage.googleapis.com/v1beta/models");
      url.searchParams.set("pageSize", "1000");
      if (token) url.searchParams.set("pageToken", token);
      const body = await getJSON<{ models?: GoogleModel[]; nextPageToken?: string }>(
        url.toString(),
        { "x-goog-api-key": key },
        signal
      );
      all.push(...(body.models ?? []));
      if (!body.nextPageToken) break;
      token = body.nextPageToken;
    }
    return { listed: filterGoogle(all), raw: all.length, pages };
  },

  async xai(key, signal) {
    const headers = { Authorization: `Bearer ${key}` };
    try {
      const body = await getJSON<{ models?: XAILanguageModel[] }>(
        "https://api.x.ai/v1/language-models",
        headers,
        signal
      );
      const all = body.models ?? [];
      return { listed: filterXAI(all), raw: all.length, pages: 1 };
    } catch (err) {
      if (signal.aborted) throw err;
      const body = await getJSON<{ data?: OpenAIStyleModel[] }>(
        "https://api.x.ai/v1/models",
        headers,
        signal
      );
      const all = body.data ?? [];
      return { listed: filterXAIByName(all), raw: all.length, pages: 1 };
    }
  },

  async deepseek(key, signal) {
    const body = await getJSON<{ data?: OpenAIStyleModel[] }>(
      "https://api.deepseek.com/models",
      { Authorization: `Bearer ${key}` },
      signal
    );
    const all = body.data ?? [];
    return { listed: filterDeepSeek(all), raw: all.length, pages: 1 };
  },
};

const curatedFor = (p: CloudProvider) => MODELS.filter((m) => m.provider === p);

export interface Diagnostics {
  fetchedAt: string;
  raw?: number;
  pages?: number;
  kept?: number;
  merged?: number;
  fallback?: string;
}

interface CacheEntry {
  at: number;
  ttl: number;
  models: Promise<ModelConfig[]>;
  diag?: Diagnostics;
}
// Module memory: lives as long as the server instance. Holding the promise
// also dedupes concurrent requests while a query is in flight.
const cache = new Map<Discoverable, CacheEntry>();

function discover(p: Discoverable, key: string): Promise<ModelConfig[]> {
  const hit = cache.get(p);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.models;
  const entry: CacheEntry = { at: Date.now(), ttl: TTL_MS, models: Promise.resolve([]) };
  entry.models = LISTERS[p](key, AbortSignal.timeout(TIMEOUT_MS))
    .then(({ listed, raw, pages }) => {
      const fetchedAt = new Date().toISOString();
      entry.diag = { fetchedAt, raw, pages, kept: listed.length };
      if (listed.length === 0) throw new Error("no relevant models after filtering");
      const merged = mergeProvider(p, listed);
      entry.diag.merged = merged.length;
      return merged;
    })
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[discovery] ${p}: ${message} — using curated list`);
      entry.diag = {
        ...(entry.diag ?? { fetchedAt: new Date().toISOString() }),
        fallback: message,
      };
      entry.ttl = FAILURE_TTL_MS;
      return curatedFor(p);
    });
  cache.set(p, entry);
  return entry.models;
}

// Every cloud model for the picker. Providers without a key show their curated
// entries as unavailable; OpenRouter always shows its curated list.
export async function listCloudModels(): Promise<AvailableModel[]> {
  const groups = await Promise.all(
    CLOUD_PROVIDERS.map(async (p) => {
      const key = process.env[ENV_KEYS[p]];
      if (!key) return curatedFor(p).map((m) => ({ ...m, available: false }));
      const models = p === "openrouter" ? curatedFor(p) : await discover(p, key);
      return models.map((m) => ({ ...m, available: true }));
    })
  );
  return groups.flat();
}

// Per-provider counts from this instance's cache (no ids or keys), for
// checking the filters against what the APIs actually return.
export function discoveryDiagnostics(): Partial<Record<Discoverable, Diagnostics>> {
  const out: Partial<Record<Discoverable, Diagnostics>> = {};
  for (const [p, entry] of cache) if (entry.diag) out[p] = entry.diag;
  return out;
}
