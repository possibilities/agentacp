import { RequestError } from "@agentclientprotocol/sdk";

export const errors = {
  invalid_request: ["Invalid command or arguments", "Read guide and use the advertised arguments."],
  owner_required: ["A Claude AgentRoles RUN identity is required", "Launch interactive Claude through AgentRoles; MCP and monitor inherit its UUID and harness."],
  unsafe_state: ["State or socket is not private and checkout-safe", "Choose an absolute private AGENTACP_STATE_DIR; do not replace foreign files or symlinks."],
  broker_unavailable: ["The private broker could not be reached", "Start agentacp serve, or inspect AgentStart supervision and stderr."],
  broker_busy: ["Another broker owns the singleton lock", "Connect to it; do not kill unrelated processes or remove a live lock."],
  startup_failed: ["The native harness could not initialize", "Inspect native installation/authentication and broker diagnostics; no prompt was admitted."],
  method_not_supported: ["The native harness does not support this method", "Inspect initialize capabilities and native session configOptions/modes."],
  native_error: ["The native ACP method returned an error", "Read nativeError, including its code and data; do not blindly retry a mutation."],
  unknown_outcome: ["A dispatched operation lost its response", "Inspect the exact session/worktree and retained run before retrying; nothing was rolled back."],
  not_found: ["The session, run, or permission is not owned by this invocation", "Use IDs returned to this exact AgentRoles RUN."],
  session_busy: ["The session has an active prompt or lifecycle operation", "Wait/read, respond to permissions, or cancel; cancellation is not yet completion."],
  session_disconnected: ["The native session is not loaded in the current process", "Inspect unknown outcomes, then explicitly session_load if advertised, or create a new session."],
  invalid_choice: ["The exact choice is not advertised", "Read native configOptions, modes, or pending permission options and use their exact IDs/values."],
  monitor_busy: ["This owner already has a connected monitor", "Keep one monitor per invocation; reconnect after the old transport closes."],
  capacity_exceeded: ["A bounded retention/admission limit was reached", "Connect the monitor to acknowledge events; use a new session when its retained run limit is reached."],
  internal_error: ["An unexpected internal operation failed", "Inspect stderr and report the failure without secrets."],
} as const;

export type ErrorCode = keyof typeof errors;
export type Failure = { code: ErrorCode; message: string; recovery: string; nativeError?: { code: number; message: string; data?: unknown } };
export type Envelope = { schema_version: 1; ok: boolean; error: Failure | null; data: unknown };
export class BridgeError extends Error {
  readonly failure: Failure;
  constructor(code: ErrorCode, message: string = errors[code][0], nativeError?: Failure["nativeError"]) {
    super(message);
    this.failure = { code, message, recovery: errors[code][1], ...(nativeError ? { nativeError } : {}) };
  }
}
export function fail(code: ErrorCode, message?: string): never { throw new BridgeError(code, message); }
export function failure(error: unknown): Failure {
  if (error instanceof BridgeError) return error.failure;
  if (error instanceof RequestError) return new BridgeError(error.code === -32601 ? "method_not_supported" : "native_error", error.message, {
    code: error.code, message: error.message, ...(error.data !== undefined ? { data: error.data } : {}),
  }).failure;
  return new BridgeError("internal_error", error instanceof Error ? error.message : "Internal failure").failure;
}
export function ok(data: unknown): Envelope { return { schema_version: 1, ok: true, error: null, data }; }
export function refused(error: unknown): Envelope { return { schema_version: 1, ok: false, error: failure(error), data: null }; }
export function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
