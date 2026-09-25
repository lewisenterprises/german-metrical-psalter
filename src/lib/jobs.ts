import { getRedis } from "./redis";
import {
  generateVariants,
  ProviderError,
  type ModelConfig,
} from "./providers";

export type JobStatus = "running" | "done" | "error" | "cancelled";

export interface JobState {
  id: string;
  status: JobStatus;
  model: string;
  provider: string;
  // Accumulated partial output so far (full snapshot, not a delta).
  text: string;
  // Reasoning-chunk count for the "thinking…" indicator.
  reasoning: number;
  // The visible reasoning text so far (the tail, capped at REASONING_TEXT_CAP
  // chars) and how many chars were dropped from its front to stay under the
  // cap. Optional: jobs written before 2026-09-25 lack them.
  reasoningText?: string;
  reasoningDropped?: number;
  createdAt: number;
  updatedAt: number;
  // Present once status === "done": { variants, meta }.
  result?: unknown;
  error?: string;
  errorStatus?: number;
}

const TTL_SECONDS = 3600;

// Every progress snapshot rewrites the whole JobState, and the live tail reads
// it back every 400ms, so a long reasoner must not grow it without bound. Keep
// the last REASONING_TEXT_CAP chars; trim only once it overshoots by
// REASONING_TEXT_SLACK, so the slice isn't redone on every delta.
export const REASONING_TEXT_CAP = 24_000;
const REASONING_TEXT_SLACK = 4_000;

// Append a reasoning delta to the capped tail. Pure, so it can be exercised
// offline.
export function appendReasoning(
  text: string,
  dropped: number,
  delta: string
): { text: string; dropped: number } {
  let next = text + delta;
  if (next.length <= REASONING_TEXT_CAP + REASONING_TEXT_SLACK) {
    return { text: next, dropped };
  }
  let cut = next.length - REASONING_TEXT_CAP;
  // Don't split a surrogate pair.
  const c = next.charCodeAt(cut);
  if (c >= 0xdc00 && c <= 0xdfff) cut++;
  next = next.slice(cut);
  return { text: next, dropped: dropped + cut };
}
const key = (id: string) => `psalter:job:${id}`;
// Stored in its own key so the worker's progress snapshots (which rebuild the
// JobState) never clobber it. The cancel endpoint reads it to cancel the run.
const runIdKey = (id: string) => `psalter:job:${id}:run`;

export async function readJob(id: string): Promise<JobState | null> {
  const redis = getRedis();
  if (!redis) return null;
  return (await redis.get<JobState>(key(id))) ?? null;
}

export async function writeJob(state: JobState): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  await redis.set(key(state.id), state, { ex: TTL_SECONDS });
}

export async function setRunId(id: string, runId: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  await redis.set(runIdKey(id), runId, { ex: TTL_SECONDS });
}

export async function getRunId(id: string): Promise<string | null> {
  const redis = getRedis();
  if (!redis) return null;
  return (await redis.get<string>(runIdKey(id))) ?? null;
}

// Flip a still-running job to cancelled (preserving any partial text). Won't
// clobber a job that already reached done/error. Lets the cancel endpoint
// update the UI immediately, without waiting on the worker's abort.
export async function markCancelled(id: string): Promise<void> {
  const job = await readJob(id);
  if (!job || job.status !== "running") return;
  await writeJob({ ...job, status: "cancelled", updatedAt: Date.now() });
}

interface RunParams {
  model: ModelConfig;
  systemPrompt: string;
  userPrompt: string;
  schema: object;
  createdAt: number;
}

// The decoupled worker. Runs the generation to completion regardless of any
// client connection, persisting throttled progress snapshots to Redis so the
// live SSE tail and the poll endpoint can read it. Cancellation is handled
// out-of-band by the cancel endpoint (it cancels the Trigger run, which stops
// this worker, and flips the status in Redis) — the worker has no cancel logic.
export async function runJob(id: string, params: RunParams): Promise<void> {
  const { model, systemPrompt, userPrompt, schema, createdAt } = params;
  let text = "";
  let reasoning = 0;
  let reasoningText = "";
  let reasoningDropped = 0;
  let finished = false;
  let flushing = false;
  // Set whenever text or reasoning changes, so the ticker skips writes while
  // the model is silent.
  let dirty = true;

  const snapshot = (status: JobStatus): JobState => ({
    id,
    status,
    model: model.id,
    provider: model.provider,
    text,
    reasoning,
    reasoningText,
    reasoningDropped,
    createdAt,
    updatedAt: Date.now(),
  });

  // Persist a progress snapshot at most every 500ms, when something changed, so
  // the live view stays current.
  const tick = setInterval(async () => {
    if (finished || flushing || !dirty) return;
    flushing = true;
    dirty = false;
    try {
      await writeJob(snapshot("running"));
    } catch {
      // Transient Redis hiccup — retry on the next tick.
      dirty = true;
    } finally {
      flushing = false;
    }
  }, 500);

  // Stop the ticker and wait for any in-flight snapshot to finish, so the
  // terminal write below is guaranteed to be the last one (no stale "running"
  // landing after "done"/"error").
  const finish = async () => {
    finished = true;
    clearInterval(tick);
    while (flushing) await new Promise((r) => setTimeout(r, 20));
  };

  try {
    const result = await generateVariants({
      model,
      systemPrompt,
      userPrompt,
      schema,
      onChunk: (delta) => {
        text += delta;
        dirty = true;
      },
      onReasoning: (delta, count) => {
        reasoning = count;
        ({ text: reasoningText, dropped: reasoningDropped } = appendReasoning(
          reasoningText,
          reasoningDropped,
          delta
        ));
        dirty = true;
      },
    });
    await finish();
    await writeJob({
      ...snapshot("done"),
      result: {
        ...(result.json as object),
        meta: {
          stop_reason: result.stopReason,
          usage: result.usage,
          provider: model.provider,
          elapsed_ms: Date.now() - createdAt,
        },
      },
    });
  } catch (err) {
    await finish();
    const message = err instanceof Error ? err.message : String(err);
    const errorStatus = err instanceof ProviderError ? err.status : 500;
    await writeJob({ ...snapshot("error"), error: message, errorStatus });
  }
}
