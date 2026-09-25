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
   deploys the generation task in `src/trigger/`. Nothing else is needed, and
   you hold no Vercel or Trigger.dev credentials.
3. Confirm both deploys happened before you say a change is live. Check the
   pushed commit with `gh api repos/{owner}/{repo}/commits/<sha>/status` and
   `.../commits/<sha>/check-runs`. Vercel can refuse a deploy because of who
   authored the commit, and your commits come from Claude's GitHub App, not
   from Alun. If a deploy is missing or failed, say so and don't report the
   change as live.

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

## Deployment constraint (Vercel)

`src/app/api/generate/route.ts` declares `maxDuration = 800`. This requires **Fluid Compute** enabled on the Vercel project — otherwise deploy fails. Classic serverless on Pro caps at 300s; Fluid Compute extends to 800s. The site lives at `https://german-metrical-psalter.vercel.app`. `metadataBase` in `src/app/layout.tsx` defaults there; override via `NEXT_PUBLIC_SITE_URL`.

## Architecture

**Single-page UI + three API routes.** `src/app/page.tsx` is a client component handling all interaction. The three routes are independent and stateless.

```
src/app/page.tsx          (UI: psalm grid, variants slider, provider chips, EN/DE toggle, SSE reader)
src/app/api/psalm/[n]     (GET: bundled Hebrew lookup)
src/app/api/models        (GET: discovered + curated models, per-model availability, LM Studio discovery)
src/app/api/generate      (POST: SSE stream of generation events)
```

### Provider abstraction (`src/lib/providers.ts`)

The core. Seven providers behind two implementations:

| Provider | Path | Notes |
|---|---|---|
| `anthropic` | `generateAnthropic` | Anthropic SDK, prompt caching on system, json_schema strict, thinking **disabled** |
| `openai` / `google` / `xai` | `generateOpenAICompat` | OpenAI SDK with per-provider `baseURL`, json_schema strict |
| `deepseek` / `openrouter` / `lmstudio` | `generateOpenAICompat` | Same SDK, **json_object** mode (no schema enforcement) |

Per-provider quirks already baked in — don't undo without good reason:

- **Anthropic adaptive thinking is disabled** (`thinking: { type: "disabled" }`). Earlier testing showed it hung the route. The user explicitly asked for the toggle to be removed; do not re-add it without asking.
- **`stream_options.include_usage` is skipped for DeepSeek and LM Studio.** Their compat layers silently break streaming when they don't recognise it.
- **DeepSeek emits `delta.reasoning_content` during the thinking phase**, then switches to `delta.content`. The streaming loop counts both and emits `thinking` events to the client during reasoning so the UI doesn't look frozen.
- **LM Studio uses a dummy `apiKey: "lm-studio"`** (the SDK requires non-empty) and discovers loaded models at runtime via `GET /v1/models`, filtering out embedding/whisper/TTS models that can't do chat completions.
- **Provider availability** is determined by env-key presence (see `ENV_KEYS` in `src/lib/discovery.ts`). LM Studio is "available" iff the local server responds.

### Models registry

Cloud models are discovered live by `src/lib/discovery.ts` (server-only; the Trigger.dev task gets a resolved `ModelConfig` in its payload and never imports it). For each provider whose env key is set, `listCloudModels()` queries its models endpoint in parallel (5s timeout each) — Anthropic `/v1/models`, OpenAI `/v1/models`, Google's native `v1beta/models`, xAI `/v1/language-models` (falling back to `/v1/models`), DeepSeek `/models` — and filters to text chat models this app can drive: no image/video/audio/TTS/transcription/realtime/embedding/moderation/search/computer-use/codex models, no dated snapshots whose undated alias is known, no OpenAI `-pro` (Responses-API only) or legacy models without json_schema, no Claude models that report no structured-output support or can't take `thinking: disabled`. Results are cached in module memory for an hour (five minutes after a failure).

Discovered models are listed **newest first** within each provider: by creation date where the API gives one (Anthropic `created_at`, OpenAI and xAI `created`, DeepSeek `created` if present; a dated snapshot lends its date to the alias it folds into), and otherwise — Google's API has no dates — by the version in the id, highest first (`gemini-3.8` > `3.7` > `3.1` > `2.5`), then pro/flash/flash-lite, GA before preview. Dated models sort ahead of undated ones in the same provider. The order depends only on which models are listed, never on the API's response order.

`MODELS` in `providers.ts` is the curated overrides and fallback list. A curated entry the provider still lists keeps its label; other discovered models are labelled from the API (`display_name`/`displayName`, provider prefix stripped) or humanised from the id. A curated entry that a successful query doesn't list is dropped. If a provider's query fails or nothing survives the filter, or its key is missing, the picker shows its curated entries in their curated (small-to-large) order. **OpenRouter is not discovered** — it lists hundreds of models, and its curated small/flash tiers are a deliberate choice (see the comment in `MODELS`).

LM Studio models are discovered by `discoverLMStudioModels()` and merged in by `/api/models`. The generate route resolves an id via `findModel` (curated), then the discovered list (cached), then LM Studio, so any listed or loaded model is callable without registry edits. The UI falls back to `DEFAULT_MODEL`, else the first available model, when a saved choice is no longer in the list.

### SSE protocol (`/api/generate`)

The route returns `text/event-stream`. Each event is `data: <json>\n\n`. Event types:

- `start` — `{ model, provider }`
- `chunk` — `{ delta: string }` — content tokens as they arrive
- `thinking` — `{ count }` — reasoning chunk count (throttled every 10), only for models that emit `reasoning_content`
- `heartbeat` — every 10s, keeps the connection alive while a reasoning model is silent
- `done` — final payload: `{ variants, meta: { stop_reason, usage, provider, elapsed_ms } }`
- `error` — `{ message, status? }`

The client reader in `page.tsx` accumulates `chunk.delta` into `streamingText` (shown in a "raw stream" disclosure while generating), tracks `thinking.count` for the live "Thinking… N reasoning chunks" message, and renders structured variants on `done`.

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
```

Missing keys are not an error — corresponding chips are marked `available: false` and rendered greyed-out with a tooltip explaining the missing key.

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
