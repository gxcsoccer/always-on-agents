#!/usr/bin/env node
// Reports from inside the container to the Worker: `report <kind> <message...>`.
// brain.internal is not a real host; the Worker intercepts it. Exits non-zero if the report was rejected.
const [kind = "progress", ...rest] = process.argv.slice(2);

try {
  const response = await fetch(`http://brain.internal/callback/${encodeURIComponent(kind)}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-task-id": process.env.TASK_ID ?? "",
      "x-task-token": process.env.TASK_PASS ?? "",
    },
    // REPORT_BODY lets a script send structured fields instead of a message.
    body: process.env.REPORT_BODY ?? JSON.stringify({ message: rest.join(" "), sent_at: Date.now() }),
    signal: AbortSignal.timeout(20_000),
  });
  console.log(response.status, (await response.text()).trim());
  process.exit(response.ok ? 0 : 1);
} catch (error) {
  console.log("ERR", error?.cause?.code ?? error?.message ?? String(error));
  process.exit(1);
}
