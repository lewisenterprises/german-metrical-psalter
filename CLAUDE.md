@AGENTS.md

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this app does

Generates singable German Common Metre (8.6.8.6, iambic) renderings of the Hebrew Psalms by routing the same prompt to a user-chosen LLM. The Hebrew source is bundled; the rendering is generated fresh on every request.

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
src/app/api/models        (GET: registry + per-model availability + LM Studio discovery)
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
- **Provider availability** is determined by env-key presence (see `ENV_KEYS` in `/api/models/route.ts`). LM Studio is "available" iff the local server responds.

### Models registry

Static cloud models live in the `MODELS` array. LM Studio models are discovered dynamically by `discoverLMStudioModels()` and merged in by `/api/models`. The generate route falls back to LM Studio discovery if `findModel(id)` misses, so any loaded local model is callable without registry edits.

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

- **New provider:** add to `Provider` union, add `ENDPOINTS` entry, add to the `generateVariants` switch, add to `ENV_KEYS` in `/api/models`, add to `PROVIDER_LABEL` and `PROVIDER_ORDER` in `page.tsx`, add to `.env.local.example`.
- **New model on an existing provider:** add a `MODELS` entry. Sort within provider rows small-to-large — this is a deliberate convention.
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
