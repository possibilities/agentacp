// A fake native ACP endpoint, reached only through disposable PATH wrappers.
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const harness = process.env.FAKE_HARNESS!;
function receipt(value: unknown) { appendFileSync(process.env.FAKE_RECEIPTS!, JSON.stringify({ harness, ...value as object }) + "\n"); }
receipt({ kind: "start", pid: process.pid, cwd: process.cwd(), args: process.argv.slice(2), owner: process.env.AGENTROLES_INVOCATION_ID ?? null, ownerHarness: process.env.AGENTROLES_HARNESS ?? null, devinRole: process.env.AGENTSTART_DEVIN_ACP_ROLE ?? null });
const send = (value: unknown) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value as object }) + "\n");
const result = (id: unknown, value: unknown) => send({ id, result: value });
const error = (id: unknown, code: number, message: string, data?: unknown) => send({ id, error: { code, message, data } });
const sessions = new Map<string, { model: string; effort: string; boolean: boolean }>();
const prompts = new Map<string, number>();
const permissionPrompts = new Map<number, { sessionId: string; promptId: number }>();
let request = 10_000;
function options(sessionId: string) {
  const session = sessions.get(sessionId)!;
  return [
    { id: "native-model", name: "Model", category: "model", type: "select", currentValue: session.model, options: [{ group: "native", name: "Native", options: [{ value: "model-a", name: "A" }, { value: "model-b", name: "B" }] }] },
    { id: "native-effort", name: "Effort", category: "thought_level", type: "select", currentValue: session.effort, options: (session.model === "model-a" ? ["low", "medium"] : ["high"]).map(value => ({ value, name: value })) },
    { id: "native-toggle", name: "Toggle", type: "boolean", currentValue: session.boolean },
  ];
}
const modes = { currentModeId: "normal", availableModes: [{ id: "normal", name: "Normal" }, { id: "plan", name: "Plan" }] };
function update(sessionId: string, update: unknown) { send({ method: "session/update", params: { sessionId, update } }); }
function finish(sessionId: string, stopReason = "end_turn", text?: string) {
  const id = prompts.get(sessionId);
  if (id === undefined) return;
  prompts.delete(sessionId);
  if (text) update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
  result(id, { stopReason });
}
const rl = createInterface({ input: process.stdin });
rl.on("line", line => {
  const frame = JSON.parse(line);
  const p = frame.params ?? {};
  if (!frame.method) {
    receipt({ kind: "client_response", response: frame });
    const pending = permissionPrompts.get(frame.id);
    if (pending) { receipt({ kind: "permission_response", response: frame.result }); permissionPrompts.delete(frame.id); finish(pending.sessionId, frame.result.outcome.outcome === "cancelled" ? "cancelled" : frame.result.outcome.optionId === "allow" ? "end_turn" : "refusal", "permission resolved"); }
    return;
  }
  receipt({ kind: "request", method: frame.method, params: p });
  if (frame.method === "initialize") {
    if (process.env.FAKE_START_FAIL === "1") { process.exit(7); }
    result(frame.id, { protocolVersion: 1, agentInfo: { name: `fake-${harness}`, version: "native-version" }, agentCapabilities: { loadSession: process.env.FAKE_NO_LOAD !== "1", promptCapabilities: {} }, authMethods: [] });
  } else if (frame.method === "session/new" || frame.method === "session/load") {
    const sessionId = p.sessionId ?? randomUUID();
    sessions.set(sessionId, { model: "model-a", effort: "medium", boolean: false });
    update(sessionId, { sessionUpdate: "available_commands_update", availableCommands: [{ name: "native-command", description: "Offered before session/new response" }] });
    result(frame.id, { ...(frame.method === "session/new" ? { sessionId } : {}), configOptions: options(sessionId), modes });
  } else if (frame.method === "session/set_config_option") {
    const session = sessions.get(p.sessionId)!;
    if (p.configId === "native-model") { session.model = p.value; session.effort = p.value === "model-b" ? "high" : "medium"; }
    if (p.configId === "native-effort") session.effort = p.value;
    if (p.configId === "native-toggle") session.boolean = p.value;
    result(frame.id, { configOptions: options(p.sessionId) });
  } else if (frame.method === "session/set_mode") {
    if (harness === "devin") error(frame.id, -32601, "Mode method unavailable", { native: "details" });
    else result(frame.id, {});
  } else if (frame.method === "session/prompt") {
    const text = p.prompt[0].text;
    prompts.set(p.sessionId, frame.id);
    if (text === "hold") return;
    if (text === "crash") { setTimeout(() => process.exit(23), 100); return; }
    if (text === "failure") { prompts.delete(p.sessionId); error(frame.id, -32001, "native failed turn", { reason: "test-provider-error" }); return; }
    if (text === "permission") {
      const id = request++;
      permissionPrompts.set(id, { sessionId: p.sessionId, promptId: frame.id });
      send({ id, method: "session/request_permission", params: { sessionId: p.sessionId,
        toolCall: { toolCallId: "native-tool", title: "Execute command", kind: "execute", status: "pending" },
        options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }, { optionId: "deny", name: "Reject once", kind: "reject_once" }] } });
      return;
    }
    if (text === "unknown-client-method") { send({ id: request++, method: "terminal/create", params: { sessionId: p.sessionId, command: "not-actually-executed" } }); }
    if (text === "large") {
      for (let i = 0; i < 520; i++) update(p.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x".repeat(200) } });
      update(p.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "z".repeat(20_000) } });
    }
    setTimeout(() => finish(p.sessionId, "end_turn", `answer:${text}`), 100);
  } else if (frame.method === "session/cancel") finish(p.sessionId, "cancelled", "cancel acknowledged");
  else error(frame.id, -32601, "Unknown method");
});
if (process.env.FAKE_STUBBORN === "1") {
  // Exercise owned process-group escalation/reaping, without a real harness.
  setInterval(() => {}, 1_000);
  process.on("SIGTERM", () => {});
} else {
  rl.once("close", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
}
