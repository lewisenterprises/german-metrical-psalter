import { readJob } from "@/lib/jobs";

export const runtime = "nodejs";

// Poll endpoint: returns the current job snapshot. Reconnect-safe — the client
// falls back to this if the live SSE drops, and resumes from it after a reload.
// `?reasoning=0` leaves out the reasoning text (up to ~28k chars), for callers
// that only wait on the result, like the metre sweep's dozen pollers.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const job = await readJob(id);
  if (!job) {
    return Response.json({ error: "job not found" }, { status: 404 });
  }
  if (new URL(req.url).searchParams.get("reasoning") === "0") {
    const { reasoningText: _omit, ...rest } = job;
    void _omit;
    return Response.json(rest);
  }
  return Response.json(job);
}
