@AGENTS.md

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this app does

Generates singable German Common Metre (8.6.8.6, iambic) renderings of the Hebrew Psalms by routing the same prompt to a user-chosen LLM. The Hebrew source is bundled; the rendering is generated fresh on every request.

## Working from Slack

Alun and Emmanuel Dunbar both reach you through Claude in Slack, in a cloud
sandbox that has none of Alun's local context. They are the only people who work
on this, so there is no preview or review step. Run `npm ci` first, since the
sandbox starts without `node_modules`. When a change is ready:

1. `npm run lint` and `npm run build` must pass. There is no test runner, so
   the build is the gate.
2. Commit to `master` and push. That one push deploys everything: Vercel's
   GitHub integration deploys the web app, and Trigger.dev's GitHub integration
   deploys the generation task in `src/trigger/`. Nothing else is needed (no
   manual `npm run trigger:deploy`), and you hold no Vercel or Trigger.dev
   credentials. Vercel deploys Claude-authored commits like any other.
3. Confirm both deploys happened before you say a change is live. Check the
   pushed commit with `gh api repos/{owner}/{repo}/commits/<sha>/status` (the
   Vercel status) and `.../commits/<sha>/check-runs` (the Trigger.dev check run,
   named `Trigger.dev deployment (…:prod)`). Without `gh`, `curl` the same paths
   under `https://api.github.com/` — the repo is readable without a token.
   Both take a few minutes. If a deploy is missing or failed, say so and don't
   report the change as live.

**Why both matter.** The system and user prompts are built on the Vercel side
and passed into the task, so prompt *text* and UI changes are live once Vercel
finishes. Anything the task bundles — `src/trigger/`, `src/lib/jobs.ts`,
`src/lib/providers.ts`, `OUTPUT_SCHEMA` in `src/lib/prompt.ts` — is only live
once the Trigger.dev deploy finishes too.

**Money.** Every generation is a paid call to a model provider on Alun's keys.
The sandbox holds no provider keys, and it should stay that way. When you need
to see output, ask whoever asked for the change to generate it on the live site,
and tell them which psalm, model and settings to try.

## Commands

- `npm run dev` — dev server (Turbopack on port 3000)
- `npm run build` — production build
- `npm start` — serve production build
- `npm run lint` — ESLint
- `npm run build:psalms` — one-off script to refetch Hebrew Psalms from Sefaria and rewrite `data/psalms-he.json`. **The committed JSON is the authoritative source — do not re-run unless deliberately refreshing.** Strips HTML markup and Masoretic paragraph markers (`{פ}`/`{ס}`) but preserves full niqqud and ta'amim.

There is no test runner.

## Deployment (Vercel + Trigger.dev)

Two deploy targets, both fed by a push to `master` (see "Working from Slack"):

- **Vercel** serves the UI and the API routes. None of them runs a model: `/api/generate` only enqueues, and the longest-lived route is the live tail `/api/job/[id]/stream` at `maxDuration = 300` (the classic-serverless ceiling, so Fluid Compute is not required). The site lives at `https://german-metrical-psalter.vercel.app`. `metadataBase` in `src/app/layout.tsx` defaults there; override via `NEXT_PUBLIC_SITE_URL`.
- **Trigger.dev** (project `proj_jokoakevjzwxelcmplsb`, `trigger.config.ts`, tasks in `src/trigger/`, runtime `node-22`) runs the generation task `generate-psalm` off-Vercel with `maxDuration: 3600` and retries off, so long reasoning renders aren't bound by a serverless timeout. `npm run trigger:dev` runs the task locally; `npm run trigger:deploy` exists but isn't needed, since the GitHub integration deploys prod on every push to `master`.
- **Upstash Redis** is the only channel between them: the task writes job state there, and the Vercel routes read it.

## Architecture

**Single-page UI + API routes around a job store.** `src/app/page.tsx` renders `src/app/Psalter.tsx`, the client component handling all interaction.

```
src/app/Psalter.tsx            (UI: psalm grid, variants slider, provider chips, EN/DE toggle, job stream reader)
src/app/api/psalm/[n]          (GET: bundled Hebrew lookup)
src/app/api/models             (GET: discovered + curated models, per-model availability, LM Studio discovery)
src/app/api/generate           (POST: builds the prompts, seeds the job in Redis, triggers `generate-psalm`, returns 202 { jobId })
src/app/api/job/[id]           (GET: current job snapshot — the poll endpoint; `?reasoning=0` omits the reasoning text)
src/app/api/job/[id]/stream    (GET: SSE live tail of the job snapshot)
src/app/api/job/[id]/cancel    (POST: cancels the Trigger.dev run, marks the job cancelled)
src/trigger/generate.ts        (Trigger.dev task: calls `runJob` in src/lib/jobs.ts)
```

### Provider abstraction (`src/lib/providers.ts`)

The core. Seven providers behind three implementations, all reporting visible reasoning text through `onReasoning(delta, count)` alongside `onChunk(delta)` for content:

| Provider | Path | Notes |
|---|---|---|
| `anthropic` | `generateAnthropic` | Anthropic SDK (streaming), prompt caching on system, `output_config.format` json_schema, **summarized thinking** streamed as reasoning |
| `openai` | `generateOpenAIResponses` | OpenAI SDK, **Responses API**, json_schema strict, `store: false`, reasoning summaries streamed as reasoning |
| `google` / `xai` | `generateOpenAICompat` | OpenAI SDK Chat Completions with per-provider `baseURL`, json_schema strict |
| `deepseek` / `openrouter` / `lmstudio` | `generateOpenAICompat` | Same, **json_object** mode (no schema enforcement) |

Per-provider quirks already baked in — don't undo without good reason:

- **Anthropic thinking is on** (it was `disabled` until 2026-09-25). Models from 4.6 on get `thinking: { type: "adaptive", display: "summarized" }` plus `output_config.effort: "medium"` (`display` must be explicit: current models default to `"omitted"`, which streams empty thinking). Pre-4.6 models — `CLAUDE_BUDGET_THINKING`, e.g. `claude-haiku-4-5` — get `thinking: { type: "enabled", budget_tokens: 2048 }` and no effort. The choice is guessed from the id; if the API 400s on the thinking params before any output, it retries once with the other form. `max_tokens` is 32000 to leave room for thinking. Because thinking is no longer disabled, discovery no longer hides Fable, Mythos or Opus 5.5.
- **OpenAI runs on the Responses API**, not Chat Completions, because only Responses streams reasoning summaries. Reasoning models (`o*`, `gpt-5*`, minus `-chat`/`chatgpt-`) get `reasoning: { effort: "low", summary: "auto" }` (no effort on `-pro`); non-reasoning models like `gpt-4.1` get no `reasoning` param. If a 400 refuses summaries (unverified org) or the reasoning params, it steps down once each rather than failing. `-pro` models are still filtered out of discovery on cost grounds.
- **`stream_options.include_usage` is skipped for DeepSeek and LM Studio.** Their compat layers silently break streaming when they don't recognise it.
- **DeepSeek emits `delta.reasoning_content` during the thinking phase** (OpenRouter normalises it to `delta.reasoning`), then switches to `delta.content`. Both are treated as reasoning text, so the UI shows the thinking rather than looking frozen.
- **Google gets `reasoning_effort: "low"`** — Gemini 3.x otherwise thinks for 90s+ before its first token.
- **LM Studio uses a dummy `apiKey: "lm-studio"`** (the SDK requires non-empty) and discovers loaded models at runtime via `GET /v1/models`, filtering out embedding/whisper/TTS models that can't do chat completions.
- **Provider availability** is determined by env-key presence (see `ENV_KEYS` in `src/lib/discovery.ts`). LM Studio is "available" iff the local server responds.

### Models registry

Cloud models are discovered live by `src/lib/discovery.ts` (server-only; the Trigger.dev task gets a resolved `ModelConfig` in its payload and never imports it). For each provider whose env key is set, `listCloudModels()` queries its models endpoint in parallel (5s timeout each) — Anthropic `/v1/models`, OpenAI `/v1/models`, Google's native `v1beta/models`, xAI `/v1/language-models` (falling back to `/v1/models`), DeepSeek `/models` — and filters to text chat models this app can drive: no image/video/audio/TTS/transcription/realtime/embedding/moderation/search/computer-use/codex models, no dated snapshots whose undated alias is known, no OpenAI `-pro` (kept out on cost and latency) or legacy models without json_schema, no Claude models that report no structured-output support. Results are cached in module memory for an hour (five minutes after a failure).

Discovered models are listed **newest first** within each provider: by creation date where the API gives one (Anthropic `created_at`, OpenAI and xAI `created`, DeepSeek `created` if present; a dated snapshot lends its date to the alias it folds into), and otherwise — Google's API has no dates — by the version in the id, highest first (`gemini-3.8` > `3.7` > `3.1` > `2.5`), then pro/flash/flash-lite, GA before preview. Dated models sort ahead of undated ones in the same provider. The order depends only on which models are listed, never on the API's response order.

`MODELS` in `providers.ts` is the curated overrides and fallback list. A curated entry the provider still lists keeps its label; other discovered models are labelled from the API (`display_name`/`displayName`, provider prefix stripped) or humanised from the id. A curated entry that a successful query doesn't list is dropped. If a provider's query fails or nothing survives the filter, or its key is missing, the picker shows its curated entries in their curated (small-to-large) order. **OpenRouter is not discovered** — it lists hundreds of models, and its curated small/flash tiers are a deliberate choice (see the comment in `MODELS`).

LM Studio models are discovered by `discoverLMStudioModels()` and merged in by `/api/models`. The generate route resolves an id via `findModel` (curated), then the discovered list (cached), then LM Studio, so any listed or loaded model is callable without registry edits. The UI falls back to `DEFAULT_MODEL`, else the first available model, when a saved choice is no longer in the list.

### Job flow (`src/lib/jobs.ts`, `/api/generate`, `/api/job/[id]*`)

Generation is a decoupled job, not a request-scoped stream:

1. **`POST /api/generate`** validates the body, resolves the model, builds the system and user prompts (so prompt text is a Vercel-side change), writes a `running` `JobState` to Redis under `psalter:job:<id>` (TTL 1h), triggers `generate-psalm` with `{ id, model, systemPrompt, userPrompt, createdAt }`, stores the Trigger run id under `psalter:job:<id>:run`, and returns `202 { jobId }`. It returns 503 if Upstash isn't configured.
2. **The task** calls `runJob`, which runs `generateVariants` and rewrites the whole `JobState` at most every 500ms when something changed: `text` (content so far), `reasoning` (reasoning-delta count), `reasoningText` (the visible reasoning, tail-capped at `REASONING_TEXT_CAP` = 24,000 chars, trimmed only once it overshoots by 4,000) and `reasoningDropped` (chars cut from its front). The terminal write is `done` with `result: { variants, meta: { stop_reason, usage, provider, elapsed_ms } }`, or `error` with `error`/`errorStatus`. `runJob` never throws, so the task always completes.
3. **`GET /api/job/[id]/stream`** tails Redis every 400ms and sends `data: <json>\n\n` snapshots when `text` length, `reasoning` or `status` changes — `{ status, text, reasoning, reasoningText?, reasoningDropped?, createdAt, result, error }`, with `reasoningText` resent only when it grew — plus a `: ping` comment after 10s of silence. It closes on a terminal status (`done`/`error`/`cancelled`, or `missing` if the job is gone) or at 300s.
4. **The client** (`consumeJob` in `Psalter.tsx`) reads the stream first and falls back to polling `GET /api/job/[id]` every 1.5s if it drops. The job id and its reference are kept in `sessionStorage`, so a reload resumes the job. The metre sweep follows its dozen jobs by polling `?reasoning=0` every 2s instead.
5. **Cancel** posts to `/api/job/[id]/cancel`, which cancels the Trigger run and then flips the job to `cancelled`.

While generating, the status line reads "Thinking… N reasoning chunks" until content arrives, then "Receiving… N chars". Two disclosures sit under it (single jobs only, not sweeps, and only while generating): **"Show reasoning"** (DE "Überlegungen anzeigen") with the reasoning text, auto-scrolled while the reader is at the bottom and prefixed "… N earlier characters not shown" once the cap trims it; and **"Show raw stream"** with the content so far. Structured variants render on `done`.

### Prompt (`src/lib/prompt.ts`)

The system prompt is the heart of output quality. It encodes:
- CM rules (8/6/8/6 iambic, ABAB/ABCB rhyme)
- A **fidelity rule** that ranks above rhyme — explicitly forbids inventing content for rhyme convenience (the historical failure mode flagged by user feedback). Includes a `✗ AVOID` / `✓ BETTER` worked example with bad-vs-good Psalm 23 quatrains.
- A modern-German-over-archaisms rule with concrete word-pair examples (`Wiese > Aue`, `geht > wandelt`).
- A per-line self-check the model is told to run before returning.

If output quality regresses, the prompt is the lever — schema and provider plumbing are stable.

### i18n (`src/lib/i18n.ts`)

EN/DE strings as a `STRINGS` object. Function-valued entries take parameters (verse counts, elapsed seconds). Choice persists in `localStorage` under `psalter.lang`. Hebrew block is always Hebrew; model labels and provider names are always English (proper nouns).

### Icon and OG image

Both are rendered via `next/og` `ImageResponse` at request time:
- `src/app/icon.tsx` — 64×64 PNG, served at `/icon`, used as favicon
- `src/app/opengraph-image.tsx` — 1200×630 PNG, served at `/opengraph-image`

Both fetch `Noto Serif Hebrew` from `cdn.jsdelivr.net/fontsource/fonts/noto-serif-hebrew@latest/hebrew-500-normal.ttf` at render time. The font is a **static** TTF — Satori cannot consume variable fonts, so do not switch the URL to the Google Fonts variable file.

## Environment variables

```
ANTHROPIC_API_KEY     # Anthropic
OPENAI_API_KEY        # OpenAI
GOOGLE_API_KEY        # Gemini (AI Studio key)
XAI_API_KEY           # Grok
DEEPSEEK_API_KEY      # DeepSeek
OPENROUTER_API_KEY    # open-source models via OpenRouter
LMSTUDIO_BASE_URL     # optional, defaults to http://localhost:1234/v1
NEXT_PUBLIC_SITE_URL  # optional, defaults to https://german-metrical-psalter.vercel.app
UPSTASH_REDIS_REST_URL    # job store — required on Vercel and Trigger.dev
UPSTASH_REDIS_REST_TOKEN
TRIGGER_SECRET_KEY    # on Vercel, so /api/generate and cancel can reach Trigger.dev
```

Provider keys are needed in both places: Vercel uses them for discovery and availability, and the Trigger.dev task makes the actual calls. Missing keys are not an error — corresponding chips are marked `available: false` and rendered greyed-out with a tooltip explaining the missing key.

## When adding a provider or model

- **New provider:** add to `Provider` union, add `ENDPOINTS` entry, add to the `generateVariants` switch, add to `ENV_KEYS` in `src/lib/discovery.ts` plus a `LISTERS` entry and filter (or leave it undiscovered, like OpenRouter), add to `PROVIDER_LABEL` and `PROVIDER_ORDER` in `Psalter.tsx`, add to `.env.local.example`.
- **New model on an existing provider:** nothing to do if discovery picks it up; it appears in date order, newest first. Add a `MODELS` entry only to fix its label, to keep it visible as a fallback, or for OpenRouter. Sort `MODELS` within provider rows small-to-large — this convention now governs only the curated fallback lists and OpenRouter. If discovery shows junk or hides a usable model, adjust that provider's filter in `discovery.ts`.
- **Verify new model IDs against the provider's live `/v1/models` endpoint** before relying on vendor-doc IDs — they frequently disagree with what's actually served (e.g. Google's `gemini-3.1-pro` doesn't exist as a plain ID; only `gemini-3.1-pro-preview` does).


<!-- TRIGGER.DEV basic START -->
# Trigger.dev Basic Tasks (v4)

**MUST use `@trigger.dev/sdk`, NEVER `client.defineJob`**

## Basic Task

```ts
import { task } from "@trigger.dev/sdk";

export const processData = task({
  id: "process-data",
  retry: {
    maxAttempts: 10,
    factor: 1.8,
    minTimeoutInMs: 500,
    maxTimeoutInMs: 30_000,
    randomize: false,
  },
  run: async (payload: { userId: string; data: any[] }) => {
    // Task logic - runs for long time, no timeouts
    console.log(`Processing ${payload.data.length} items for user ${payload.userId}`);
    return { processed: payload.data.length };
  },
});
```

## Schema Task (with validation)

```ts
import { schemaTask } from "@trigger.dev/sdk";
import { z } from "zod";

export const validatedTask = schemaTask({
  id: "validated-task",
  schema: z.object({
    name: z.string(),
    age: z.number(),
    email: z.string().email(),
  }),
  run: async (payload) => {
    // Payload is automatically validated and typed
    return { message: `Hello ${payload.name}, age ${payload.age}` };
  },
});
```

## Triggering Tasks

### From Backend Code

```ts
import { tasks } from "@trigger.dev/sdk";
import type { processData } from "./trigger/tasks";

// Single trigger
const handle = await tasks.trigger<typeof processData>("process-data", {
  userId: "123",
  data: [{ id: 1 }, { id: 2 }],
});

// Batch trigger (up to 1,000 items, 3MB per payload)
const batchHandle = await tasks.batchTrigger<typeof processData>("process-data", [
  { payload: { userId: "123", data: [{ id: 1 }] } },
  { payload: { userId: "456", data: [{ id: 2 }] } },
]);
```

### Debounced Triggering

Consolidate multiple triggers into a single execution:

```ts
// Multiple rapid triggers with same key = single execution
await myTask.trigger(
  { userId: "123" },
  {
    debounce: {
      key: "user-123-update",  // Unique key for debounce group
      delay: "5s",              // Wait before executing
    },
  }
);

// Trailing mode: use payload from LAST trigger
await myTask.trigger(
  { data: "latest-value" },
  {
    debounce: {
      key: "trailing-example",
      delay: "10s",
      mode: "trailing",  // Default is "leading" (first payload)
    },
  }
);
```

**Debounce modes:**
- `leading` (default): Uses payload from first trigger, subsequent triggers only reschedule
- `trailing`: Uses payload from most recent trigger

### From Inside Tasks (with Result handling)

```ts
export const parentTask = task({
  id: "parent-task",
  run: async (payload) => {
    // Trigger and continue
    const handle = await childTask.trigger({ data: "value" });

    // Trigger and wait - returns Result object, NOT task output
    const result = await childTask.triggerAndWait({ data: "value" });
    if (result.ok) {
      console.log("Task output:", result.output); // Actual task return value
    } else {
      console.error("Task failed:", result.error);
    }

    // Quick unwrap (throws on error)
    const output = await childTask.triggerAndWait({ data: "value" }).unwrap();

    // Batch trigger and wait
    const results = await childTask.batchTriggerAndWait([
      { payload: { data: "item1" } },
      { payload: { data: "item2" } },
    ]);

    for (const run of results) {
      if (run.ok) {
        console.log("Success:", run.output);
      } else {
        console.log("Failed:", run.error);
      }
    }
  },
});

export const childTask = task({
  id: "child-task",
  run: async (payload: { data: string }) => {
    return { processed: payload.data };
  },
});
```

> Never wrap triggerAndWait or batchTriggerAndWait calls in a Promise.all or Promise.allSettled as this is not supported in Trigger.dev tasks.

## Waits

```ts
import { task, wait } from "@trigger.dev/sdk";

export const taskWithWaits = task({
  id: "task-with-waits",
  run: async (payload) => {
    console.log("Starting task");

    // Wait for specific duration
    await wait.for({ seconds: 30 });
    await wait.for({ minutes: 5 });
    await wait.for({ hours: 1 });
    await wait.for({ days: 1 });

    // Wait until specific date
    await wait.until({ date: new Date("2024-12-25") });

    // Wait for token (from external system)
    await wait.forToken({
      token: "user-approval-token",
      timeoutInSeconds: 3600, // 1 hour timeout
    });

    console.log("All waits completed");
    return { status: "completed" };
  },
});
```

> Never wrap wait calls in a Promise.all or Promise.allSettled as this is not supported in Trigger.dev tasks.

## Key Points

- **Result vs Output**: `triggerAndWait()` returns a `Result` object with `ok`, `output`, `error` properties - NOT the direct task output
- **Type safety**: Use `import type` for task references when triggering from backend
- **Waits > 5 seconds**: Automatically checkpointed, don't count toward compute usage
- **Debounce + idempotency**: Idempotency keys take precedence over debounce settings

## NEVER Use (v2 deprecated)

```ts
// BREAKS APPLICATION
client.defineJob({
  id: "job-id",
  run: async (payload, io) => {
    /* ... */
  },
});
```

Use SDK (`@trigger.dev/sdk`), check `result.ok` before accessing `result.output`

<!-- TRIGGER.DEV basic END -->

<!-- TRIGGER.DEV SKILLS START -->
## Trigger.dev agent skills

This project has Trigger.dev agent skills installed in `.claude/skills/`. Before writing or changing Trigger.dev code (background tasks, scheduled tasks, realtime, or chat.agent AI agents), load the most relevant skill: `trigger-getting-started`.
<!-- TRIGGER.DEV SKILLS END -->
