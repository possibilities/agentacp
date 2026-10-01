import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { BrokerClient } from "./service.ts";
import { guide, inputSchema, mcpInstructions, parseTool, toolDefinitions } from "./tools.ts";
import { BridgeError, ok, refused, type Envelope } from "./errors.ts";

function result(envelope: Envelope) {
  return {
    isError: !envelope.ok,
    structuredContent: envelope,
    content: [
      ...(!envelope.ok && envelope.error ? [{ type: "text" as const, text: `${envelope.error.code}\n${envelope.error.message}\n${envelope.error.recovery}` }] : []),
      { type: "text" as const, text: JSON.stringify(envelope) },
    ],
  };
}
export async function mcp(owner: string, signal: AbortSignal): Promise<void> {
  let client: BrokerClient | undefined;
  let connecting: Promise<BrokerClient> | undefined;
  const connection = () => {
    if (client?.connected) return Promise.resolve(client);
    return connecting ??= BrokerClient.connect("mcp", owner).then(value => {
      if (signal.aborted) { value.close(); throw new BridgeError("broker_unavailable", "MCP is closing"); }
      return client = value;
    }).finally(() => { connecting = undefined; });
  };
  const server = new Server({ name: "agentacp", version: "0.1.0" }, { capabilities: { tools: {} }, instructions: mcpInstructions() });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [
    { name: "guide", description: "Read AgentACP's fleet contract and shared guidance", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
    ...toolDefinitions.map(spec => ({ name: spec.toolName, description: spec.description, inputSchema: { ...inputSchema(spec), type: "object" as const }, annotations: { readOnlyHint: !spec.mutates, openWorldHint: !["status", "session_read", "session_wait", "session_request_permission_response"].includes(spec.name) } })),
  ] }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      if (request.params.name === "guide") {
        if (Object.keys(request.params.arguments ?? {}).length) return result(refused(new BridgeError("invalid_request", "guide takes no arguments")));
        return result(ok(guide()));
      }
      const args = parseTool(request.params.name, request.params.arguments ?? {});
      return result(ok(await (await connection()).call(request.params.name, args)));
    } catch (error) { return result(refused(error)); }
  });
  const transport = new StdioServerTransport();
  let finish!: () => void;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  const stop = () => { client?.close(); void server.close().finally(finish); };
  server.onclose = finish;
  signal.addEventListener("abort", stop, { once: true });
  process.stdin.once("end", stop);
  process.stdin.once("close", stop);
  try { await server.connect(transport); if (signal.aborted) stop(); await finished; }
  finally { signal.removeEventListener("abort", stop); process.stdin.removeListener("end", stop); process.stdin.removeListener("close", stop); client?.close(); }
}
