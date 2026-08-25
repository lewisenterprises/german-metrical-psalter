import { NextRequest } from "next/server";
import { tasks } from "@trigger.dev/sdk/v3";
import { getPsalm } from "@/lib/psalms";
import {
  buildSystemPrompt,
  buildUserPrompt,
  clampStyle,
  TRIAL_CONTEXT_VERSES,
} from "@/lib/prompt";
import { findMeter } from "@/lib/meters";
import { findModel, MODELS, discoverLMStudioModels } from "@/lib/providers";
import { getRedis } from "@/lib/redis";
import { DEFAULT_MODEL } from "@/lib/prefs";
import { writeJob, setRunId } from "@/lib/jobs";
import type { generatePsalm } from "@/trigger/generate";

export const runtime = "nodejs";
// This route only enqueues now — the generation runs on Trigger.dev — so it no
// longer needs an extended duration (or Fluid Compute).

function json(status: number, body: object): Response {
  return Response.json(body, { status });
}

// Starts a decoupled generation job and returns its id immediately. The actual
// generation runs in `after()` — independent of this (or any) client connection
// — and writes progress to Redis. The client streams/polls the job by id.
export async function POST(req: NextRequest) {
  let body: {
    psalm?: number;
    variants?: number;
    model?: string;
    systemPrompt?: string;
    meter?: string;
    style?: number;
    verseStart?: number;
    verseEnd?: number;
    trial?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  if (!getRedis()) {
    return json(503, {
      error:
        "Job store not configured — set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.",
    });
  }

  const psalm = Number(body.psalm);
  const variants = Number(body.variants ?? 3);
  const modelId = body.model ?? DEFAULT_MODEL;
  const meter = findMeter(body.meter);
  // Metre trial: render two complete stanzas rather than a verse range, so the
  // metre is never judged on a half-finished stanza. It replaces the range's end
  // with a fixed window of raw material (the start is still honoured).
  const trial = body.trial === true;
  // The literal↔poetic dial. The client bakes it into the system prompt it
  // sends, so here it's mainly for logging and for the (rare) fallback when no
  // system prompt is supplied.
  const style = clampStyle(Number(body.style));
  const systemPrompt =
    typeof body.systemPrompt === "string" && body.systemPrompt.trim()
      ? body.systemPrompt
      : buildSystemPrompt(meter, style);

  if (!Number.isInteger(psalm) || psalm < 1 || psalm > 150) {
    return json(400, { error: "psalm must be an integer between 1 and 150" });
  }
  if (!Number.isInteger(variants) || variants < 1 || variants > 5) {
    return json(400, { error: "variants must be an integer between 1 and 5" });
  }

  let model = findModel(modelId);
  if (!model) {
    const local = await discoverLMStudioModels();
    model = local.find((m) => m.id === modelId);
  }
  if (!model) {
    return json(400, {
      error: `unknown model "${modelId}". Known: ${MODELS.map((m) => m.id).join(", ")}`,
    });
  }

  const hebrew = getPsalm(psalm);
  if (!hebrew) {
    return json(404, { error: `Psalm ${psalm} not found` });
  }

  // Optional verse range. Clamp to the psalm's bounds; an invalid/empty range
  // falls back to the whole psalm.
  const startVerse =
    Number.isInteger(body.verseStart) &&
    (body.verseStart as number) >= 1 &&
    (body.verseStart as number) <= hebrew.length
      ? (body.verseStart as number)
      : 1;
  const requestedEnd =
    Number.isInteger(body.verseEnd) &&
    (body.verseEnd as number) >= startVerse &&
    (body.verseEnd as number) <= hebrew.length
      ? (body.verseEnd as number)
      : hebrew.length;
  // In trial mode the model decides where to stop, so any requested end is
  // replaced by a fixed window of opening verses — enough raw material that even
  // a six-line strophe can't run out of text before its two stanzas are full.
  const endVerse = trial
    ? Math.min(hebrew.length, startVerse + TRIAL_CONTEXT_VERSES - 1)
    : requestedEnd;
  const verses = hebrew.slice(startVerse - 1, endVerse);

  const id = crypto.randomUUID();
  const createdAt = Date.now();

  // Client IP + geo from Vercel's forwarding headers (x-forwarded-for is a
  // comma-separated list; the client is the first entry). Logged as one JSON
  // line so the Better Stack log drain can parse and filter it.
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    null;
  const decode = (v: string | null) => {
    if (!v) return null;
    try {
      return decodeURIComponent(v);
    } catch {
      return v;
    }
  };
  console.log(
    JSON.stringify({
      event: "generation",
      job: id,
      psalm,
      verseStart: startVerse,
      verseEnd: endVerse,
      verseCount: hebrew.length,
      variants,
      meter: meter.id,
      style,
      trial,
      model: model.id,
      provider: model.provider,
      ip,
      country: req.headers.get("x-vercel-ip-country") || null,
      city: decode(req.headers.get("x-vercel-ip-city")),
    })
  );

  // Seed the job so the client can start polling/streaming immediately, then
  // hand the work to Trigger.dev (runs off-Vercel, no timeout).
  await writeJob({
    id,
    status: "running",
    model: model.id,
    provider: model.provider,
    text: "",
    reasoning: 0,
    createdAt,
    updatedAt: createdAt,
  });

  try {
    const handle = await tasks.trigger<typeof generatePsalm>("generate-psalm", {
      id,
      model,
      systemPrompt,
      userPrompt: buildUserPrompt(
        psalm,
        verses,
        variants,
        meter,
        startVerse,
        trial
      ),
      createdAt,
    });
    // Remember the Trigger run id so cancel can stop the run on its infra.
    await setRunId(id, handle.id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[generate] failed to enqueue job=${id}`, err);
    await writeJob({
      id,
      status: "error",
      model: model.id,
      provider: model.provider,
      text: "",
      reasoning: 0,
      createdAt,
      updatedAt: Date.now(),
      error: `Could not enqueue generation: ${message}`,
    });
    return json(502, { error: "Could not enqueue generation job" });
  }

  return json(202, { jobId: id });
}
