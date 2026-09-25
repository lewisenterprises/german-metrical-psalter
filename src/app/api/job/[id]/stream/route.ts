import { readJob } from "@/lib/jobs";

export const runtime = "nodejs";
// The live tail caps at the classic-serverless ceiling (no Fluid Compute
// needed). If a render runs longer, this connection closes and the client
// transparently falls back to polling — the job itself is unaffected.
export const maxDuration = 300;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Live view: tails the job state from Redis (~400ms) and pushes snapshots when
// something changes. This connection is disposable — the job runs in its own
// background worker, so dropping/reconnecting here never affects generation.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: object) => {
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(obj)}\n\n`)
          );
        } catch {
          // Connection gone — the loop's next write will throw and we stop.
        }
      };
      const heartbeat = () => {
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          /* ignore */
        }
      };

      let lastLen = -1;
      let lastReasoning = -1;
      // Reasoning text is the bulk of a snapshot, so resend it only when it
      // grew: its length plus the chars trimmed off its front identify it.
      let lastReasoningMark = -1;
      let lastStatus = "";
      let lastSendAt = Date.now();

      try {
        while (true) {
          const job = await readJob(id);
          if (!job) {
            send({ status: "missing" });
            break;
          }
          const changed =
            job.text.length !== lastLen ||
            job.reasoning !== lastReasoning ||
            job.status !== lastStatus;
          if (changed) {
            lastLen = job.text.length;
            lastReasoning = job.reasoning;
            lastStatus = job.status;
            lastSendAt = Date.now();
            const reasoningText = job.reasoningText ?? "";
            const mark = (job.reasoningDropped ?? 0) + reasoningText.length;
            const reasoningChanged = mark !== lastReasoningMark;
            lastReasoningMark = mark;
            send({
              status: job.status,
              text: job.text,
              reasoning: job.reasoning,
              ...(reasoningChanged
                ? { reasoningText, reasoningDropped: job.reasoningDropped ?? 0 }
                : {}),
              createdAt: job.createdAt,
              result: job.result,
              error: job.error,
            });
          } else if (Date.now() - lastSendAt > 10_000) {
            lastSendAt = Date.now();
            heartbeat();
          }
          if (job.status !== "running") break;
          await sleep(400);
        }
      } finally {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
