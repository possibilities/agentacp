import { z } from "zod";
import { errors, fail } from "./errors.ts";
import type { Harness } from "./native.ts";

export const guidance = "AgentACP controls full native OpenCode and Devin ACP harnesses, not a model router. Call the harness initialize, create a session with its exact absolute target cwd, then read native configOptions/modes before choosing values. session_prompt admits a run promptly; completion means the native prompt response settled, never an idle update. Its runId/eventId are stable dedup keys. Check delivery.monitorConnected: missing/disconnected monitors retain events, but do not deliver them to Claude until reconnect. Use bounded session_wait/session_read in noninteractive Claude (-p), where plugin monitors do not start. Agent-to-client permissions are never auto-approved; select only the exact advertised optionId after obtaining authority. Cancel requests cancellation and waits for native settlement. A disconnected/unknown run is not proof that native work rolled back. Session/permission access belongs only to the inherited Claude AgentRoles invocation UUID. Never retry a mutation with unknown outcome without inspecting retained state; requestId makes prompt admission retries safe.";
const id = z.string().min(1).max(512);
const session = { sessionId: id.describe("Exact native sessionId owned by this invocation") };
const specs = [
  { name: "initialize", description: "Initialize the private native ACP harness and return its actual capabilities and agentInfo.", mutates: true, schema: z.object({}).strict() },
  { name: "status", description: "Read native process state, owned sessions, pending permissions and completion delivery readiness without starting the native harness.", mutates: false, schema: z.object({}).strict() },
  { name: "session_new", description: "Create a native session at the exact absolute cwd; return native sessionId, configOptions and modes. No automatic worktree or arbitrary MCP executable injection.", mutates: true, schema: z.object({ cwd: z.string().min(1).max(4_096).describe("Exact absolute target directory; the user controls this path, including an owned worktree") }).strict() },
  { name: "session_load", description: "Load an already-owned retained session at its original exact cwd, only if the native harness advertises loadSession. Inspect prior unknown outcomes first.", mutates: true, schema: z.object({ ...session, cwd: z.string().min(1).max(4_096).describe("Must exactly match this session's original absolute cwd") }).strict() },
  { name: "session_prompt", description: "Uses native subscription quota. Admit an asynchronous native prompt and return runId immediately, before response completion; only one active run per session.", mutates: true, schema: z.object({ ...session,
    prompt: z.array(z.object({ type: z.string().min(1) }).passthrough()).min(1).max(64).describe("Native ACP ContentBlock[] (for text: [{type:'text',text:'...'}])"),
    requestId: z.string().uuid().optional().describe("Caller-generated idempotency UUID for safe admission retries; reuse only with the identical session/prompt"),
  }).strict() },
  { name: "session_set_config_option", description: "Set an exact native advertised configId/value and return native configOptions. Discover model and effort from these options, including boolean choices; no guessed catalogs.", mutates: true, schema: z.object({ ...session, configId: id, value: z.union([z.string().max(4_096), z.boolean()]).describe("Exact advertised select value or boolean toggle") }).strict() },
  { name: "session_set_mode", description: "Set an exact modeId from the native availableModes list.", mutates: true, schema: z.object({ ...session, modeId: id }).strict() },
  { name: "session_cancel", description: "Send native session/cancel notification and cancel pending permission requests; return cancelling, not a fabricated terminal completion.", mutates: true, schema: z.object(session).strict() },
  { name: "session_read", description: "Read bounded ordered native updates, current configOptions/modes, pending permissions and a run's aggregated finalText. Reports capture gaps/truncation explicitly.", mutates: false, schema: z.object({ ...session, runId: z.string().uuid().optional(), afterSeq: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(32).optional() }).strict() },
  { name: "session_wait", description: "Blocking, bounded observation fallback: wait up to timeoutMs for a run to settle; a wait deadline never cancels or fails the run.", mutates: false, blocking: true, schema: z.object({ ...session, runId: z.string().uuid(), timeoutMs: z.number().int().min(0).max(30_000).optional() }).strict() },
  { name: "session_request_permission_response", description: "Respond to this exact pending native permission with an advertised optionId, or null to cancel. Requires caller authority; never implicit approval.", mutates: true, schema: z.object({ ...session, permissionId: z.string().uuid(), optionId: z.string().min(1).max(512).nullable() }).strict() },
];
export const toolDefinitions = specs.flatMap(spec => (["opencode", "devin"] as Harness[]).map(harness => ({ ...spec, harness, toolName: `${harness}_${spec.name}` })));
export function tool(name: string) {
  const found = toolDefinitions.find(spec => spec.toolName === name);
  if (!found) fail("invalid_request", `Unknown harness tool: ${name}`);
  return found;
}
export function parseTool(name: string, input: unknown): Record<string, unknown> {
  const spec = tool(name);
  const result = spec.schema.safeParse(input);
  if (!result.success) fail("invalid_request", result.error.issues.map(issue => `${issue.path.join(".") || "arguments"}: ${issue.message}`).join("; "));
  if (Buffer.byteLength(JSON.stringify(result.data)) > 262_144) fail("invalid_request", "Tool input exceeds 256 KiB");
  return result.data;
}
export function inputSchema(spec: typeof toolDefinitions[number]): Record<string, unknown> {
  const { $schema: _, ...schema } = z.toJSONSchema(spec.schema, { io: "input" });
  return schema;
}
function argumentsOf(spec: typeof toolDefinitions[number]) {
  const schema = inputSchema(spec) as { properties: Record<string, { type?: string; description?: string; minimum?: number; maximum?: number }>; required?: string[] };
  return Object.entries(schema.properties).map(([name, property]) => {
    const json = !["string", "integer", "number", "boolean"].includes(property.type ?? "");
    return { name: `--${name}`, type: json ? "string" : property.type, description: `${property.description ?? name}${json ? "; JSON value on the CLI; native shape in MCP" : ""}`,
      ...(schema.required?.includes(name) ? { required: true } : {}), ...(json ? { format: "json" } : {}),
      ...(name === "cwd" ? { format: "path", direction: "in" } : {}),
      ...(property.minimum !== undefined ? { minimum: property.minimum } : {}), ...(property.maximum !== undefined ? { maximum: property.maximum } : {}),
    };
  });
}
export function guide() {
  return {
    contract_version: 1,
    meta: { name: "agentacp", version: "0.1.0", purpose: "Control native OpenCode and Devin ACP harnesses with durable owner-scoped asynchronous completions.", audience: "agent" },
    guidance,
    concepts: {
      output_contract: { envelope: { schema_version: "integer", ok: "boolean", error: "{code,message,recovery,nativeError?} | null", data: "native payload or broker receipt | null" }, exit_codes: { "0": "success", "1": "domain failure", "2": "usage fault" } },
      error_codes: Object.entries(errors).map(([code, [meaning, recovery]]) => ({ code, meaning, recovery })),
      agent_defaults: ["Owners are inherited AGENTROLES_INVOCATION_ID + AGENTROLES_HARNESS=claude; never tool arguments/cwd.", "Read native configOptions after new/load/each selection; choice availability may change.", "Keep stable runId/eventId dedup keys; monitor delivery acknowledges stdout, not human reading."],
      retention: { ...limitsForGuide },
    },
    global_arguments: [{ name: "--json", type: "boolean", description: "JSON envelope (the default for finite commands)", role: "output-format" }],
    commands: [
      { name: "guide", summary: "Read the fleet agent contract", audience: "agent", mutates: false, arguments: [] },
      ...(["opencode", "devin"] as Harness[]).map(harness => ({ name: harness, summary: `Control the native ${harness} ACP harness`, audience: "agent", subcommands: toolDefinitions.filter(spec => spec.harness === harness).map(spec => ({
        name: spec.name, summary: spec.description, audience: "agent", mutates: spec.mutates, arguments: argumentsOf(spec),
        ...(spec.blocking ? { blocking: true } : {}), x_input_schema: inputSchema(spec),
      })) })),
      { name: "serve", summary: "Own the private singleton broker in the foreground", audience: "operator", mutates: true, blocking: true, arguments: [] },
      { name: "mcp", summary: "Serve MCP stdio for an inherited Claude owner", audience: "internal", mutates: true, blocking: true, arguments: [] },
      { name: "monitor", summary: "Emit durable owner event lines for a Claude plugin Monitor", audience: "internal", mutates: true, blocking: true, arguments: [] },
    ],
  };
}
const limitsForGuide = { eventBatch: 16, updatePage: 32, finalTextChars: 65_536, nativeFrameBytes: 1_048_576, toolInputBytes: 262_144 };
export function help(): string {
  const contract = guide();
  return [contract.meta.purpose, "", "Usage: agentacp <command> [--camelCase value] [--json]", ...contract.commands.map(command => `${command.name.padEnd(12)} ${command.summary}`), "", contract.guidance].join("\n");
}
export function mcpInstructions(): string {
  const contract = guide();
  return [contract.guidance, `Output: ${JSON.stringify(contract.concepts.output_contract)}`,
    "Errors:", ...contract.concepts.error_codes.map(error => `${error.code}: ${error.meaning}. ${error.recovery}`),
    "Defaults:", ...contract.concepts.agent_defaults].join("\n");
}
export function cliInput(name: string, args: string[]): Record<string, unknown> {
  const spec = tool(name);
  const schema = inputSchema(spec) as { properties: Record<string, { type?: string }> };
  const input: Record<string, unknown> = {};
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--json") continue;
    const key = flag.slice(2);
    if (!flag.startsWith("--") || !(key in schema.properties) || key in input) fail("invalid_request", `Unknown or repeated argument ${flag}`);
    const value = args[++index];
    if (value === undefined) fail("invalid_request", `Missing value for ${flag}`);
    const type = schema.properties[key].type;
    if (type === "string") input[key] = value;
    else {
      try { input[key] = JSON.parse(value); } catch { fail("invalid_request", `${flag} requires JSON (${type ?? "native value"})`); }
    }
  }
  return parseTool(name, input);
}
