import { afterEach, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, existsSync, symlinkSync, readlinkSync, unlinkSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Primary owner: executable broker/MCP/monitor boundary. Fixtures provide ACP
// wire responses only; production owns admission, identity, persistence and ack.
const root = join(import.meta.dir, "..");
const main = join(root, "src/main.ts");
const fixture = join(import.meta.dir, "fixtures/native.ts");
const tempPath = process.env.AGENTACP_TEST_TMP ?? (process.env.TMPDIR ? join(process.env.TMPDIR, "opencode") : "/tmp");
mkdirSync(tempPath, { recursive: true, mode: 0o700 });
const tempBase = realpathSync(tempPath);
type HarnessTest = Awaited<ReturnType<typeof setup>>;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean, timeout = 6_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) { const value = await read(); if (ready(value)) return value; if (Date.now() >= deadline) throw new Error(`Observation deadline; last value: ${JSON.stringify(value)}`); await delay(20); }
}
async function stop(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  child.kill("SIGTERM");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([closed, new Promise<never>((_, reject) => { timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Owned test process required SIGKILL")); }, 6_000); })]); }
  finally { if (timer) clearTimeout(timer); }
}
async function setup(extra: Record<string, string> = {}) {
  const temp = mkdtempSync(join(tempBase, "acp-"));
  const state = join(temp, "s"), bin = join(temp, "bin"), cwd = join(temp, "task");
  mkdirSync(bin); mkdirSync(cwd); mkdirSync(join(temp, "code"));
  const receipts = join(temp, "receipts");
  writeFileSync(receipts, "");
  for (const harness of ["opencode", "devin"]) writeFileSync(join(bin, harness), `#!/bin/bash\nexport FAKE_HARNESS=${harness}\nexec "${process.execPath}" "${fixture}" "$@"\n`, { mode: 0o755 });
  writeFileSync(join(bin, "agentroles"), `#!/bin/bash\nprintf '%s\\n' "$@" > "${temp}/role-args"\n[[ "$2" == -- && "$3" == opencode && "$4" == acp ]] || exit 91\nexec opencode acp\n`, { mode: 0o755 });
  const env = { ...process.env, HOME: temp, PATH: `${bin}:${process.env.PATH}`, AGENTACP_STATE_DIR: state, AGENTACP_AUTOSTART: "0", FAKE_RECEIPTS: receipts, ...extra } as Record<string, string>;
  // Real credentials are never reached: fake PATH endpoints consume every launch.
  const children: ChildProcessWithoutNullStreams[] = [];
  const clients: Client[] = [];
  const launch = (args: string[], owner?: string) => {
    const child = spawn(process.execPath, [main, ...args], { cwd, env: { ...env, ...(owner ? { AGENTROLES_INVOCATION_ID: owner, AGENTROLES_HARNESS: "claude" } : {}) }, stdio: ["pipe", "pipe", "pipe"] });
    children.push(child); return child;
  };
  let broker = launch(["serve"]);
  let diagnostics = ""; broker.stderr.on("data", chunk => diagnostics += chunk.toString());
  const ready = async () => until(async () => {
    if (broker.exitCode !== null) throw new Error(`Broker startup exited: ${diagnostics}`);
    return new Promise<boolean>(resolve => {
      const socket = createConnection(join(state, "broker.sock"));
      socket.once("connect", () => { socket.destroy(); resolve(true); }); socket.once("error", () => { socket.destroy(); resolve(false); });
    });
  }, Boolean);
  await ready();
  const mcp = async (owner: string) => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [main, "mcp"], cwd, env: { ...env, AGENTROLES_INVOCATION_ID: owner, AGENTROLES_HARNESS: "claude" }, stderr: "pipe" });
    const client = new Client({ name: "real-test-client", version: "1" }); clients.push(client);
    await client.connect(transport); return client;
  };
  const monitor = (owner: string) => {
    const child = launch(["monitor"], owner);
    const events: any[] = [];
    const rl = createInterface({ input: child.stdout });
    rl.on("line", line => events.push(JSON.parse(line)));
    return { child, events };
  };
  const restart = async (crash = false) => {
    if (crash) { const closed = new Promise(resolve => broker.once("close", resolve)); broker.kill("SIGKILL"); await closed; }
    else await stop(broker);
    broker = launch(["serve"]); diagnostics = ""; broker.stderr.on("data", chunk => diagnostics += chunk.toString()); await ready();
  };
  cleanups.push(async () => {
    await Promise.all(clients.map(client => client.close()));
    for (const child of children.slice().reverse()) await stop(child);
    rmSync(temp, { recursive: true, force: true }); // Exact disposable test-owned tree only.
  });
  return { temp, state, cwd, env, receipts, mcp, monitor, launch, restart, broker, children };
}
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  return result.structuredContent as any;
}
async function success(client: Client, name: string, args: Record<string, unknown> = {}) {
  const envelope = await call(client, name, args); if (!envelope.ok) throw new Error(JSON.stringify(envelope.error)); return envelope.data;
}
const prompt = (client: Client, sessionId: string, text: string, harness = "opencode", requestId?: string) => success(client, `${harness}_session_prompt`, { sessionId, prompt: [{ type: "text", text }], ...(requestId ? { requestId } : {}) });
async function settled(client: Client, sessionId: string, runId: string, harness = "opencode") {
  return success(client, `${harness}_session_wait`, { sessionId, runId, timeoutMs: 5_000 });
}
function receipts(test: HarnessTest) { return readFileSync(test.receipts, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); }
async function rawSubscriber(state: string, owner: string | null, role = "monitor") {
  const socket = createConnection(join(state, "broker.sock"));
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  const pending = new Map<number, (value: any) => void>(); let id = 0;
  const rl = createInterface({ input: socket });
  rl.on("line", line => { const frame = JSON.parse(line); pending.get(frame.id)?.(frame.envelope); pending.delete(frame.id); });
  const request = (method: string, params: Record<string, unknown>) => new Promise<any>(resolve => { pending.set(++id, resolve); socket.write(JSON.stringify({ id, method, params }) + "\n"); });
  const hello = await request("hello", { version: 1, role, owner, harness: "claude" });
  if (!hello.ok) throw new Error(JSON.stringify(hello.error));
  return { request, hello: hello.data, close: () => socket.destroy() };
}

test("real MCP admission precedes completion; late monitors replay only their invocation and reconnect without losing the race", async () => {
  const t = await setup();
  const a = randomUUID(), b = randomUUID();
  const ca = await t.mcp(a), cb = await t.mcp(b);
  const tools = await ca.listTools();
  expect(tools.tools.filter(tool => tool.name !== "guide").every(tool => /^(opencode|devin)_/.test(tool.name))).toBe(true);
  const sa = await success(ca, "opencode_session_new", { cwd: t.cwd }), sb = await success(cb, "opencode_session_new", { cwd: t.cwd });
  expect(sa.sessionId).not.toBe(sb.sessionId);
  const key = randomUUID();
  const admitted = await prompt(ca, sa.sessionId, "hold", "opencode", key);
  expect(admitted.delivery.readiness).toBe("waiting_for_monitor");
  expect((await success(ca, "opencode_session_wait", { sessionId: sa.sessionId, runId: admitted.runId, timeoutMs: 0 })).state).toBe("running");
  expect((await prompt(ca, sa.sessionId, "hold", "opencode", key)).runId).toBe(admitted.runId);
  expect((await call(ca, "opencode_session_prompt", { sessionId: sa.sessionId, prompt: [{ type: "text", text: "different" }], requestId: key })).error.code).toBe("invalid_request");
  expect((await call(cb, "opencode_session_cancel", { sessionId: sa.sessionId })).error.code).toBe("not_found");
  expect((await call(cb, "opencode_session_read", { sessionId: sa.sessionId })).error.code).toBe("not_found");
  expect((await call(cb, "opencode_session_load", { sessionId: sa.sessionId, cwd: t.cwd })).error.code).toBe("not_found");
  expect((await call(ca, "opencode_session_prompt", { sessionId: sa.sessionId, prompt: [{ type: "text", text: "second" }] })).error.code).toBe("session_busy");
  expect((await success(ca, "opencode_session_cancel", { sessionId: sa.sessionId })).state).toBe("cancelling");
  expect((await settled(ca, sa.sessionId, admitted.runId)).state).toBe("cancelled");
  const ra = await prompt(ca, sa.sessionId, "a"), rb = await prompt(cb, sb.sessionId, "b");
  await settled(ca, sa.sessionId, ra.runId); await settled(cb, sb.sessionId, rb.runId);
  const ma = t.monitor(a);
  await until(async () => ma.events, value => value.length >= 2);
  expect(ma.events.map(event => event.runId)).toEqual([admitted.runId, ra.runId]);
  expect(ma.events.every(event => event.sessionId === sa.sessionId && event.type === "agentacp_completion")).toBe(true);
  await until(() => success(ca, "opencode_status"), value => value.delivery.pendingEventCount === 0);
  expect((await success(cb, "opencode_status")).delivery.pendingEventCount).toBe(1);
  await stop(ma.child);
  await until(() => success(ca, "opencode_status"), value => !value.delivery.monitorConnected);
  const reconnected = await prompt(ca, sa.sessionId, "reconnect"); await settled(ca, sa.sessionId, reconnected.runId);
  const next = t.monitor(a), mb = t.monitor(b);
  await until(async () => next.events, value => value.length === 1); await until(async () => mb.events, value => value.length === 1);
  expect(next.events[0].runId).toBe(reconnected.runId); expect(mb.events[0].runId).toBe(rb.runId);
  expect(next.events[0].eventId).not.toBe(ma.events[1].eventId);
  expect((await success(ca, "opencode_session_read", { sessionId: sa.sessionId, runId: ra.runId })).run.finalText).toBe("answer:a");
  // The actual public launch contracts and stripped inherited identity were exercised.
  const start = receipts(t).find(row => row.kind === "start");
  expect(start.owner).toBeNull(); expect(start.ownerHarness).toBeNull(); expect(start.cwd).toBe(join(t.temp, "code"));
  expect(readFileSync(join(t.temp, "role-args"), "utf8").trim().split("\n")).toEqual([join(t.temp, ".local/share/agentstart/resources/roles/default"), "--", "opencode", "acp"]);
  expect(statSync(t.state).mode & 0o777).toBe(0o700); expect(statSync(join(t.state, "broker.sock")).mode & 0o777).toBe(0o600);
}, 20_000);

test("native choices, boolean config, exact cwd and errors survive MCP; permissions require exact owned advertised options", async () => {
  const t = await setup(); const owner = randomUUID();
  const ca = await t.mcp(owner), other = await t.mcp(randomUUID());
  const init = await success(ca, "devin_initialize"); expect(init.agentInfo.name).toBe("fake-devin");
  const session = await success(ca, "devin_session_new", { cwd: t.cwd });
  const sid = session.sessionId;
  expect(session.configOptions.find((option: any) => option.category === "model").id).toBe("native-model");
  expect((await call(ca, "devin_session_set_config_option", { sessionId: sid, configId: "native-model", value: "guessed-model" })).error.code).toBe("invalid_choice");
  const selected = await success(ca, "devin_session_set_config_option", { sessionId: sid, configId: "native-model", value: "model-b" });
  expect(selected.configOptions.find((o: any) => o.id === "native-effort").options).toEqual([{ value: "high", name: "high" }]);
  expect((await call(ca, "devin_session_set_config_option", { sessionId: sid, configId: "native-effort", value: "medium" })).error.code).toBe("invalid_choice");
  const boolean = await success(ca, "devin_session_set_config_option", { sessionId: sid, configId: "native-toggle", value: true });
  expect(boolean.configOptions.find((o: any) => o.id === "native-toggle").currentValue).toBe(true);
  const mode = await call(ca, "devin_session_set_mode", { sessionId: sid, modeId: "plan" });
  expect(mode.error.code).toBe("method_not_supported"); expect(mode.error.nativeError).toEqual({ code: -32601, message: "Mode method unavailable", data: { native: "details" } });
  expect((await call(ca, "devin_session_load", { sessionId: sid, cwd: join(t.temp, "code") })).error.code).toBe("invalid_request");
  const run = await prompt(ca, sid, "permission", "devin");
  const view = await until(() => success(ca, "devin_session_read", { sessionId: sid }), value => value.pendingPermissions.length === 1);
  const permissionId = view.pendingPermissions[0].permissionId;
  expect((await success(ca, "devin_session_wait", { sessionId: sid, runId: run.runId, timeoutMs: 20 })).state).toBe("running");
  expect(receipts(t).filter(row => row.kind === "permission_response")).toHaveLength(0);
  expect((await call(other, "devin_session_request_permission_response", { sessionId: sid, permissionId, optionId: "allow" })).error.code).toBe("not_found");
  expect((await call(ca, "devin_session_request_permission_response", { sessionId: sid, permissionId, optionId: "invented" })).error.code).toBe("invalid_choice");
  const monitor = t.monitor(owner); await until(async () => monitor.events, events => events.some(event => event.type === "agentacp_permission"));
  await success(ca, "devin_session_request_permission_response", { sessionId: sid, permissionId, optionId: "allow" });
  expect((await settled(ca, sid, run.runId, "devin")).state).toBe("completed");
  const cancelled = await prompt(ca, sid, "permission", "devin");
  await until(() => success(ca, "devin_session_read", { sessionId: sid }), value => value.pendingPermissions.length === 1);
  await success(ca, "devin_session_cancel", { sessionId: sid });
  expect((await settled(ca, sid, cancelled.runId, "devin")).state).toBe("cancelled");
  const failed = await prompt(ca, sid, "failure", "devin"); const terminal = await settled(ca, sid, failed.runId, "devin");
  expect(terminal.state).toBe("failed"); expect(terminal.error.nativeError).toEqual({ code: -32001, message: "native failed turn", data: { reason: "test-provider-error" } });
  await until(async () => monitor.events, events => events.some(event => event.runId === failed.runId));
  expect(monitor.events.find(event => event.runId === failed.runId).state).toBe("failed");
  const initialize = receipts(t).find(row => row.method === "initialize");
  expect(initialize.params.clientCapabilities).toEqual({ session: { configOptions: { boolean: {} } } });
  expect(receipts(t).find(row => row.kind === "start").devinRole).toBe("1");
  expect(receipts(t).find(row => row.method === "session/new").params).toEqual({ cwd: t.cwd, mcpServers: [] });
  const unknown = await prompt(ca, sid, "unknown-client-method", "devin"); await settled(ca, sid, unknown.runId, "devin");
  expect(receipts(t).find(row => row.kind === "client_response" && row.response.error?.code === -32601).response.error.code).toBe(-32601);
}, 20_000);

test("native transport loss and broker shutdown settle pending runs durably; restart fences sessions and preserves monitor replay", async () => {
  const t = await setup(); const owner = randomUUID(), other = randomUUID(); const client = await t.mcp(owner), second = await t.mcp(other);
  const sa = await success(client, "opencode_session_new", { cwd: t.cwd }), sb = await success(second, "opencode_session_new", { cwd: t.cwd });
  const pending = await prompt(second, sb.sessionId, "hold"), crash = await prompt(client, sa.sessionId, "crash");
  expect((await settled(client, sa.sessionId, crash.runId)).state).toBe("unknown");
  expect((await settled(second, sb.sessionId, pending.runId)).state).toBe("unknown");
  expect((await call(client, "opencode_session_prompt", { sessionId: sa.sessionId, prompt: [{ type: "text", text: "again" }] })).error.code).toBe("session_disconnected");
  await success(client, "opencode_session_load", { sessionId: sa.sessionId, cwd: t.cwd });
  const shutdown = await prompt(client, sa.sessionId, "hold");
  await t.restart();
  // MCP connection to the old broker is not silently reused/retried; a fresh
  // client reads durable state in the new process.
  const reconnected = await t.mcp(owner);
  expect((await success(reconnected, "opencode_session_read", { sessionId: sa.sessionId, runId: shutdown.runId })).run.state).toBe("unknown");
  const monitor = t.monitor(owner); await until(async () => monitor.events, events => events.length === 2);
  expect(monitor.events.map(event => event.runId)).toEqual([crash.runId, shutdown.runId]);
  expect(monitor.events.every(event => event.state === "unknown")).toBe(true);
  const fresh = await success(reconnected, "opencode_session_load", { sessionId: sa.sessionId, cwd: t.cwd }); expect(fresh.configOptions.length).toBeGreaterThan(0);
  const final = await prompt(reconnected, sa.sessionId, "after-restart"); expect((await settled(reconnected, sa.sessionId, final.runId)).finalText).toBe("answer:after-restart");
}, 20_000);

test("capture bounds and pre-session updates are observable; invalid owners never start MCP/monitor or choose another owner", async () => {
  const t = await setup(); const client = await t.mcp(randomUUID());
  const session = await success(client, "opencode_session_new", { cwd: t.cwd });
  const first = await success(client, "opencode_session_read", { sessionId: session.sessionId });
  expect(first.history.updates[0].value.update.availableCommands[0].name).toBe("native-command");
  const large = await prompt(client, session.sessionId, "large"); await settled(client, session.sessionId, large.runId);
  const capture = await success(client, "opencode_session_read", { sessionId: session.sessionId, runId: large.runId, limit: 32 });
  expect(capture.run.textTruncated).toBe(true); expect(capture.run.finalText.length).toBe(65_536);
  expect(capture.history.gap).toBe(true); expect(capture.history.dropped).toBeGreaterThan(0); expect(capture.history.updates.length).toBe(32);
  expect((await call(client, "opencode_status", { owner: randomUUID() })).error.code).toBe("invalid_request");
  for (const command of ["mcp", "monitor"]) {
    const child = spawn(process.execPath, [main, command], { cwd: t.cwd, env: { ...t.env, AGENTROLES_INVOCATION_ID: randomUUID(), AGENTROLES_HARNESS: "opencode" }, stdio: ["pipe", "pipe", "pipe"] }); t.children.push(child);
    let stdout = "", stderr = ""; child.stdout.on("data", chunk => stdout += chunk); child.stderr.on("data", chunk => stderr += chunk);
    await new Promise(resolve => child.once("close", resolve)); expect(child.exitCode).toBe(1); expect(stdout).toBe(""); expect(stderr).toContain("owner_required");
  }
}, 20_000);

test("startup failure is distinct from unsupported load; MCP ends on SIGTERM and stdin close without keeping clients alive", async () => {
  const t = await setup({ FAKE_START_FAIL: "1" }); const client = await t.mcp(randomUUID());
  expect((await call(client, "opencode_initialize")).error.code).toBe("startup_failed");
  const child = t.launch(["mcp"], randomUUID()); let output = ""; child.stdout.on("data", chunk => output += chunk);
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "lifecycle-test", version: "1" } } }) + "\n");
  await until(async () => output, value => value.includes('"id":1'));
  await stop(child); expect(child.signalCode).not.toBe("SIGKILL"); expect(JSON.parse(output).result.serverInfo.name).toBe("agentacp");
  const eof = t.launch(["mcp"], randomUUID()); eof.stdin.end();
  await until(async () => eof.exitCode, value => value !== null); expect(eof.exitCode).toBe(0);
  expect(existsSync(join(t.state, "ledger.sqlite"))).toBe(true);
  const noLoad = await setup({ FAKE_NO_LOAD: "1" }); const c = await noLoad.mcp(randomUUID());
  const session = await success(c, "opencode_session_new", { cwd: noLoad.cwd });
  expect((await call(c, "opencode_session_load", { sessionId: session.sessionId, cwd: noLoad.cwd })).error.code).toBe("method_not_supported");
}, 15_000);

test("unacknowledged events replay with stable IDs; abrupt broker crash creates an owner-specific completion on recovery", async () => {
  const t = await setup(); const owner = randomUUID(); const client = await t.mcp(owner);
  const session = await success(client, "opencode_session_new", { cwd: t.cwd });
  const first = await prompt(client, session.sessionId, "unacked"); await settled(client, session.sessionId, first.runId);
  const subscriber = await rawSubscriber(t.state, owner);
  const batch = await subscriber.request("next", {}); expect(batch.ok).toBe(true);
  const event = batch.data.events[0];
  // An event delivered to a subscriber is not acknowledged merely by delivery.
  subscriber.close();
  await until(() => success(client, "opencode_status"), value => !value.delivery.monitorConnected);
  const monitor = t.monitor(owner); await until(async () => monitor.events, events => events.length === 1);
  expect(monitor.events[0].eventId).toBe(event.eventId); expect(monitor.events[0].runId).toBe(first.runId);
  await until(() => success(client, "opencode_status"), value => value.delivery.pendingEventCount === 0);
  const key = randomUUID(); const active = await prompt(client, session.sessionId, "hold", "opencode", key);
  await t.restart(true);
  // This same MCP process can reconnect for a future read, never retrying the
  // original request automatically. Monitor also reconnects without heartbeat.
  const view = await success(client, "opencode_session_read", { sessionId: session.sessionId, runId: active.runId });
  expect(view.run.state).toBe("unknown"); expect(view.connected).toBe(false);
  const duplicate = await prompt(client, session.sessionId, "hold", "opencode", key);
  expect(duplicate.runId).toBe(active.runId); expect(duplicate.duplicate).toBe(true); expect(duplicate.state).toBe("unknown");
  await until(async () => monitor.events, events => events.length === 2);
  expect(monitor.events[1].runId).toBe(active.runId); expect(monitor.events[1].state).toBe("unknown");
}, 20_000);

test("checkout installer refuses foreign targets/state and provides a usable CLI link without installing a service", async () => {
  const t = await setup(); const bin = join(t.temp, "install-bin"), state = join(t.temp, "install-state"); mkdirSync(bin);
  const target = join(bin, "agentacp"), foreign = join(t.temp, "foreign"); writeFileSync(foreign, "human file"); symlinkSync(foreign, target);
  const installer = (arg: string) => Bun.spawnSync(["/bin/bash", join(root, "scripts/install.sh"), arg], { cwd: root, env: { ...process.env, AGENTACP_INSTALL_BIN_DIR: bin, AGENTACP_INSTALL_STATE_DIR: state }, stdout: "pipe", stderr: "pipe" });
  expect(installer("--install").exitCode).toBe(1); expect(readlinkSync(target)).toBe(foreign);
  expect(installer("--uninstall").exitCode).toBe(1); expect(readFileSync(foreign, "utf8")).toBe("human file");
  unlinkSync(target);
  expect(installer("--install").exitCode).toBe(0); expect(readlinkSync(target)).toBe(main);
  const guide = Bun.spawnSync([target, "guide", "--json"], { env: t.env, stdout: "pipe", stderr: "pipe" });
  expect(guide.exitCode).toBe(0); expect(JSON.parse(guide.stdout.toString()).data.contract_version).toBe(1);
  const protectedDir = join(t.temp, "protected"); mkdirSync(protectedDir); writeFileSync(join(protectedDir, "deployed-sha"), "keep");
  rmSync(state, { recursive: true }); symlinkSync(protectedDir, state);
  expect(installer("--uninstall").exitCode).toBe(1); expect(readlinkSync(target)).toBe(main); expect(readFileSync(join(protectedDir, "deployed-sha"), "utf8")).toBe("keep");
  unlinkSync(state); expect(installer("--uninstall").exitCode).toBe(0); expect(existsSync(target)).toBe(false);
}, 15_000);

test("concurrent on-demand clients converge on one safe singleton without starting native harnesses", async () => {
  const t = await setup({ AGENTACP_AUTOSTART: "1" });
  await stop(t.broker);
  const clients = await Promise.all([t.mcp(randomUUID()), t.mcp(randomUUID())]);
  const statuses = await Promise.all(clients.map(client => success(client, "opencode_status")));
  expect(statuses.every(status => !status.connected && status.pid === null)).toBe(true);
  const probe = await rawSubscriber(t.state, null, "probe");
  const pid = probe.hello.pid; probe.close();
  // This exact process is proven owned by our disposable state through the
  // private handshake and singleton record; never infer ownership from a PID alone.
  expect(JSON.parse(readFileSync(join(t.state, "broker.lock/owner.json"), "utf8")).pid).toBe(pid);
  cleanups.push(async () => {
    try { process.kill(pid, "SIGTERM"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    await until(async () => { try { process.kill(pid, 0); return false; } catch { return true; } }, Boolean);
  });
  expect(receipts(t)).toHaveLength(0);
  expect(readFileSync(join(t.state, "broker.log"), "utf8").match(/broker ready/g)).toHaveLength(1);
}, 20_000);

test("broker shutdown escalates only its owned stubborn ACP process group and reaps it", async () => {
  const t = await setup({ FAKE_STUBBORN: "1" }); const client = await t.mcp(randomUUID());
  const session = await success(client, "opencode_session_new", { cwd: t.cwd });
  await prompt(client, session.sessionId, "hold");
  const pid = (await success(client, "opencode_status")).pid;
  expect(receipts(t).find(row => row.kind === "start").pid).toBe(pid);
  await stop(t.broker);
  expect(() => process.kill(pid, 0)).toThrow();
}, 15_000);
