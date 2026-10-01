import { BrokerClient } from "./service.ts";
import { BridgeError, record } from "./errors.ts";

/** Claude Monitor makes each stdout line one notification; no heartbeat/status lines. */
export async function monitor(owner: string, signal: AbortSignal): Promise<void> {
  let client: BrokerClient | undefined;
  const stop = () => client?.close();
  signal.addEventListener("abort", stop, { once: true });
  try {
    while (!signal.aborted) {
      try {
        client = await BrokerClient.connect("monitor", owner);
        if (signal.aborted) break;
        while (!signal.aborted) {
          const batch = await client.request("next", {});
          if (!record(batch) || !Array.isArray(batch.events)) throw new BridgeError("internal_error", "Invalid event batch");
          for (const event of batch.events) {
            if (signal.aborted) break;
            const payload = event.payload;
            const notification = {
              type: event.kind === "completion" ? "agentacp_completion" : "agentacp_permission",
              eventId: event.eventId, runId: event.runId, harness: event.harness, sessionId: event.sessionId,
              ...(event.kind === "completion" ? { state: payload.state, stopReason: payload.stopReason ?? null,
                ...(payload.error ? { error: { code: payload.error.code, message: String(payload.error.message).slice(0, 2_000) } } : {}),
                message: "Native ACP prompt response settled. Read the owned session/run for its result; deduplicate by eventId/runId." }
                : { permissionId: payload.permissionId, message: "Native ACP permission requires attention. Read pendingPermissions and obtain authority before selecting an exact optionId." }),
            };
            // Write callback is the strongest available Monitor acknowledgement boundary.
            // A crash before durable ack replays; writing a line is not proof Claude/human read it.
            await new Promise<void>((resolve, reject) => process.stdout.write(JSON.stringify(notification) + "\n", error => error ? reject(error) : resolve()));
            await client.request("ack", { seq: event.seq, eventId: event.eventId });
          }
        }
      } catch (error) {
        if (signal.aborted) break;
        if ((error as NodeJS.ErrnoException).code === "EPIPE") break;
        if (error instanceof BridgeError && ["monitor_busy", "owner_required", "unsafe_state", "capacity_exceeded"].includes(error.failure.code)) throw error;
        console.error("agentacp monitor disconnected; events remain durable; reconnecting");
        await new Promise<void>(resolve => {
          const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
          const timer = setTimeout(done, 500); signal.addEventListener("abort", done, { once: true });
        });
      } finally { client?.close(); client = undefined; }
    }
  } finally { signal.removeEventListener("abort", stop); client?.close(); }
}
