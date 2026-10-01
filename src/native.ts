import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { homedir } from "node:os";
import { join } from "node:path";
import { client, ndJsonStream, PROTOCOL_VERSION, type ClientConnection, type InitializeResponse, type RequestPermissionRequest, type RequestPermissionResponse, type SessionNotification } from "@agentclientprotocol/sdk";
import { BridgeError, failure } from "./errors.ts";
import { nativeEnv } from "./environment.ts";

export type Harness = "opencode" | "devin";
export type NativeHandlers = {
  update: (params: SessionNotification) => void;
  permission: (params: RequestPermissionRequest, signal: AbortSignal) => Promise<RequestPermissionResponse>;
  disconnected: () => void;
};

/** One private owned process group. Native subscription authentication stays native. */
export class NativeProcess {
  private child: ChildProcessWithoutNullStreams;
  private connection: ClientConnection;
  private exited = false;
  private exit: Promise<void>;
  private closing?: Promise<void>;
  initialization?: InitializeResponse;
  get connected(): boolean { return !this.connection.signal.aborted && !this.exited; }
  get pid(): number | null { return this.exited ? null : this.child.pid ?? null; }

  constructor(readonly harness: Harness, handlers: NativeHandlers) {
    const command = harness === "opencode" ? "agentroles" : "devin";
    const args = harness === "opencode" ? [join(homedir(), ".local/share/agentstart/resources/roles/default"), "--", "opencode", "acp"] : ["acp"];
    this.child = spawn(command, args, { cwd: join(homedir(), "code"), env: nativeEnv(harness), detached: true, stdio: ["pipe", "pipe", "pipe"] });
    // Drain, but never log native stderr (it can contain prompt bodies or secrets).
    this.child.stderr.resume();
    this.connection = client({ name: "agentacp" })
      .onNotification("session/update", ({ params }) => handlers.update(params))
      .onRequest("session/request_permission", ({ params, signal }) => handlers.permission(params, signal))
      .connect(ndJsonStream(Writable.toWeb(this.child.stdin) as WritableStream<Uint8Array>, Readable.toWeb(this.child.stdout) as unknown as ReadableStream<Uint8Array>, { maxMessageBytes: 1_048_576 }));
    this.exit = new Promise(resolve => {
      this.child.once("error", () => { this.connection.close(new BridgeError("startup_failed", `${harness} executable failed to start`)); });
      this.child.once("close", () => { this.exited = true; this.connection.close(new BridgeError("unknown_outcome", `${harness} process exited`)); resolve(); });
    });
    this.connection.signal.addEventListener("abort", () => { handlers.disconnected(); void this.close(); }, { once: true });
  }

  async initialize(): Promise<InitializeResponse> {
    try {
      const result = await this.request("initialize", {
        protocolVersion: PROTOCOL_VERSION, clientInfo: { name: "agentacp", version: "0.1.0" },
        clientCapabilities: { session: { configOptions: { boolean: {} } } },
      }, 15_000);
      if (!result || (result as InitializeResponse).protocolVersion !== PROTOCOL_VERSION) throw new Error("ACP v1 negotiation failed");
      this.initialization = result as InitializeResponse;
      return this.initialization;
    } catch (error) {
      await this.close();
      throw new BridgeError("startup_failed", `${this.harness} ACP initialization failed: ${failure(error).message}`, failure(error).nativeError);
    }
  }

  async request(method: string, params: object, timeoutMs = 30_000): Promise<unknown> {
    if (!this.connected) throw new BridgeError("session_disconnected");
    const response = this.connection.agent.request(method, params);
    if (!timeoutMs) return response; // Prompts have no artificial task timeout.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([response, new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new BridgeError("unknown_outcome", `${method} response deadline elapsed; outcome is unknown`);
          this.connection.close(error); // Fence all sessions and settle all outstanding prompts honestly.
          reject(error);
        }, timeoutMs);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }

  async cancel(sessionId: string): Promise<void> {
    if (!this.connected) throw new BridgeError("session_disconnected");
    await this.connection.agent.notify("session/cancel", { sessionId });
  }
  close(): Promise<void> {
    return this.closing ??= Promise.resolve().then(() => this.stop());
  }
  private async stop(): Promise<void> {
    this.connection.close(new BridgeError("unknown_outcome", "Owned ACP transport closed"));
    this.child.stdin.end();
    const wait = async (ms: number) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { return await Promise.race([this.exit.then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), ms); })]); }
      finally { if (timer) clearTimeout(timer); }
    };
    const signal = (value: NodeJS.Signals) => {
      if (!this.exited && this.child.pid) {
        try { process.kill(-this.child.pid, value); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      }
    };
    if (await wait(500)) return;
    signal("SIGTERM");
    if (await wait(2_000)) return;
    signal("SIGKILL");
    if (!await wait(2_000)) throw new BridgeError("internal_error", "Owned ACP process did not exit after SIGKILL");
  }
}
