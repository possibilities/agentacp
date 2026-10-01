import { createServer, createConnection, type Socket } from "node:net";
import { spawn } from "node:child_process";
import { closeSync, constants, lstatSync, mkdirSync, openSync, readFileSync, rmdirSync, unlinkSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Broker } from "./broker.ts";
import { BridgeError, fail, ok, record, refused, type Envelope } from "./errors.ts";
import { prepareState, privatePath, stateDir, uuid } from "./environment.ts";

const maxFrameBytes = 2_097_152;
type Role = "mcp" | "cli" | "monitor" | "probe";
type WireRequest = { id: number; method: string; params: Record<string, unknown> };
type Hello = { role: Role; owner: string | null };

function lines(socket: Socket, onLine: (line: string) => void): void {
  let buffer = Buffer.alloc(0);
  socket.on("data", chunk => {
    buffer = Buffer.concat([buffer, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
    for (;;) {
      const end = buffer.indexOf(10);
      if (end < 0) break;
      if (end > maxFrameBytes) { socket.destroy(); return; }
      const line = buffer.subarray(0, end).toString("utf8");
      buffer = buffer.subarray(end + 1);
      try { onLine(line); } catch { socket.destroy(); return; }
    }
    if (buffer.length > maxFrameBytes) socket.destroy();
  });
}
function send(socket: Socket, value: unknown): void {
  if (socket.destroyed) return;
  const line = JSON.stringify(value) + "\n";
  if (Buffer.byteLength(line) > maxFrameBytes) {
    // Preserve an honest classified refusal instead of disguising an output cap
    // as lost transport. Native run/results remain in the private ledger.
    if (record(value) && typeof value.id === "number" && "envelope" in value) socket.write(JSON.stringify({ id: value.id, envelope: refused(new BridgeError("capacity_exceeded", "Broker output exceeds 2 MiB; reduce the read page size")) }) + "\n");
    else socket.destroy();
    return;
  }
  if (socket.writableLength > 2 * maxFrameBytes) { socket.destroy(); return; }
  socket.write(line);
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== "ESRCH"; }
}
function lock(dir: string): () => void {
  const path = join(dir, "broker.lock");
  const metadata = join(path, "owner.json");
  const token = randomUUID();
  try { mkdirSync(path, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    privatePath(path, "directory");
    privatePath(metadata, "file", true);
    let owner;
    try { owner = JSON.parse(readFileSync(metadata, "utf8")); } catch { fail("broker_busy", "Broker lock has no valid PID record; inspect it offline rather than guessing ownership"); }
    if (!record(owner) || !Number.isInteger(owner.pid) || (owner.pid as number) <= 0 || typeof owner.token !== "string" || alive(owner.pid as number)) fail("broker_busy");
    // Recover only a proven dead lock, never kill a PID from metadata.
    unlinkSync(metadata); rmdirSync(path); mkdirSync(path, { mode: 0o700 });
  }
  writeFileSync(metadata, JSON.stringify({ pid: process.pid, token }), { mode: 0o600, flag: "wx" });
  return () => {
    try {
      const current = JSON.parse(readFileSync(metadata, "utf8"));
      if (current.token === token) { unlinkSync(metadata); rmdirSync(path); }
    } catch { /* Never remove a lock no longer owned by this instance. */ }
  };
}

export async function serve(signal: AbortSignal): Promise<void> {
  const dir = stateDir();
  prepareState(dir);
  const unlock = lock(dir);
  const socketPath = join(dir, "broker.sock");
  let broker: Broker | undefined;
  const sockets = new Set<Socket>();
  let listening = false;
  const server = createServer(socket => {
    sockets.add(socket);
    let hello: Hello | undefined;
    let inFlight = 0;
    let monitorWaiting = false;
    const delivered = new Map<number, string>();
    const controller = new AbortController();
    socket.on("error", () => {});
    socket.once("close", () => {
      sockets.delete(socket); controller.abort();
      if (hello?.role === "monitor" && hello.owner) broker?.disconnectMonitor(hello.owner);
    });
    lines(socket, line => {
      const value: unknown = JSON.parse(line);
      if (!record(value) || !Number.isInteger(value.id) || typeof value.method !== "string" || !record(value.params)) throw new Error("Invalid broker frame");
      const request = value as WireRequest;
      if (++inFlight > 32) { socket.destroy(); return; }
      void (async () => {
        if (!hello) {
          if (request.method !== "hello" || request.params.version !== 1 || !["mcp", "cli", "monitor", "probe"].includes(request.params.role as string)) fail("invalid_request", "Broker hello required");
          const role = request.params.role as Role;
          const owner = role === "probe" ? null : request.params.owner;
          if (role !== "probe" && (typeof owner !== "string" || !uuid.test(owner) || request.params.harness !== "claude")) fail("owner_required");
          const identity = typeof owner === "string" ? owner.toLowerCase() : null;
          if (identity) broker!.connectOwner(identity);
          if (role === "monitor") broker!.connectMonitor(identity!);
          hello = { role, owner: identity };
          return { version: 1, pid: process.pid, ...(identity ? { delivery: broker!.delivery(identity) } : {}) };
        }
        if (request.method === "ping") return { version: 1 };
        if (hello.role === "probe") fail("owner_required");
        if (request.method === "call" && hello.role !== "monitor") return broker!.call(hello.owner!, request.params.name as string, request.params.arguments);
        if (request.method === "next" && hello.role === "monitor") {
          if (monitorWaiting) fail("invalid_request", "Only one monitor next request may wait at once");
          monitorWaiting = true;
          try {
            const events = await broker!.nextEvents(hello.owner!, controller.signal);
            for (const event of events) delivered.set(event.seq, event.eventId);
            return { events };
          } finally { monitorWaiting = false; }
        }
        if (request.method === "ack" && hello.role === "monitor") {
          const seq = request.params.seq as number, eventId = request.params.eventId as string;
          const first = broker!.ledger.events(hello.owner!)[0];
          if (delivered.get(seq) !== eventId || first?.seq !== seq) fail("invalid_request", "Acknowledgement must be the next delivered owner event");
          broker!.ledger.ack(hello.owner!, seq, eventId); delivered.delete(seq);
          return { ackCursor: seq };
        }
        fail("invalid_request", "Unknown or unauthorized broker method");
      })().then(data => send(socket, { id: request.id, envelope: ok(data) }), error => send(socket, { id: request.id, envelope: refused(error) })).finally(() => { inFlight--; });
    });
  });
  try {
    // A lock alone is not permission to unlink a responsive socket.
    if (lstatExists(socketPath)) {
      try { const probe = await BrokerClient.connect("probe", null, false); probe.close(); fail("broker_busy", "A broker already answers this socket"); }
      catch (error) { if (error instanceof BridgeError && error.failure.code === "broker_busy") throw error; if (!connectFailure(error)) throw error; }
      privatePath(socketPath, "socket"); unlinkSync(socketPath);
    }
    broker = new Broker(dir);
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, () => { server.removeListener("error", reject); resolve(); }); });
    chmodSync(socketPath, 0o600); listening = true;
    console.error("agentacp broker ready (private Unix socket)");
    await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
  } finally {
    for (const socket of sockets) socket.destroy();
    if (listening) await new Promise<void>(resolve => server.close(() => resolve()));
    await broker?.close();
    if (listening) { privatePath(socketPath, "socket", true); if (lstatExists(socketPath)) unlinkSync(socketPath); }
    unlock();
  }
}
function lstatExists(path: string): boolean { try { lstatSync(path); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; } }
function connectFailure(error: unknown): boolean {
  return ["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException)?.code ?? "");
}

export class BrokerClient {
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void; timer: ReturnType<typeof setTimeout> }>();
  private constructor(private socket: Socket) {
    socket.on("error", () => {});
    socket.once("close", () => {
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new BridgeError("unknown_outcome", "Broker transport closed; inspect retained state before retrying mutations")); }
      this.pending.clear();
    });
    lines(socket, line => {
      const value = JSON.parse(line);
      if (!record(value) || typeof value.id !== "number" || !record(value.envelope)) throw new Error("Invalid broker response");
      const pending = this.pending.get(value.id);
      if (!pending) return;
      this.pending.delete(value.id); clearTimeout(pending.timer);
      const envelope = value.envelope as unknown as Envelope;
      if (envelope.ok) pending.resolve(envelope.data);
      else if (envelope.error) pending.reject(new BridgeError(envelope.error.code, envelope.error.message, envelope.error.nativeError));
      else pending.reject(new BridgeError("internal_error", "Broker returned an invalid error envelope"));
    });
  }
  get connected(): boolean { return !this.socket.destroyed; }
  static async connect(role: Role, owner: string | null, autoStart = process.env.AGENTACP_AUTOSTART !== "0"): Promise<BrokerClient> {
    const dir = stateDir(); prepareState(dir);
    const attempt = async () => {
      privatePath(join(dir, "broker.sock"), "socket", true);
      const socket = createConnection(join(dir, "broker.sock"));
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { socket.destroy(); reject(new BridgeError("broker_unavailable", "Broker socket connect deadline elapsed")); }, 2_000);
        socket.once("connect", () => { clearTimeout(timer); resolve(); });
        socket.once("error", error => { clearTimeout(timer); socket.destroy(); reject(error); });
      });
      const client = new BrokerClient(socket);
      try { await client.request("hello", { version: 1, role, owner, harness: "claude" }); return client; }
      catch (error) { client.close(); throw error; }
    };
    try { return await attempt(); }
    catch (error) {
      if (!connectFailure(error)) throw error;
      if (!autoStart) {
        if (role === "probe") throw error; // Singleton stale-socket recovery needs the exact connect errno.
        throw new BridgeError("broker_unavailable", "Broker is absent and AGENTACP_AUTOSTART=0; start agentacp serve or inspect supervision");
      }
      const log = openSync(join(dir, "broker.log"), constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try {
        const env = { ...process.env };
        delete env.AGENTROLES_INVOCATION_ID; delete env.AGENTROLES_HARNESS;
        const child = spawn(process.execPath, [join(import.meta.dir, "main.ts"), "serve"], { cwd: import.meta.dir, env, detached: true, stdio: ["ignore", log, log] });
        child.on("error", () => {}); child.unref();
      } finally { closeSync(log); }
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 100));
        try { return await attempt(); } catch (next) { if (!connectFailure(next)) throw next; }
      }
      fail("broker_unavailable", "Singleton startup did not become ready within eight seconds; inspect broker.log");
    }
  }
  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.socket.destroyed) return Promise.reject(new BridgeError("broker_unavailable"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new BridgeError("unknown_outcome", "Broker response deadline elapsed; inspect state rather than retrying a mutation")); this.socket.destroy();
      }, 40_000);
      this.pending.set(id, { resolve, reject, timer });
      send(this.socket, { id, method, params });
    });
  }
  call(name: string, args: Record<string, unknown>): Promise<unknown> { return this.request("call", { name, arguments: args }); }
  close(): void { this.socket.destroy(); }
}
