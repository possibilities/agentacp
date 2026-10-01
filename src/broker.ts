import { createHash, randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { RequestPermissionRequest, RequestPermissionResponse, SessionNotification } from "@agentclientprotocol/sdk";
import { BridgeError, fail, failure, record } from "./errors.ts";
import { isTerminal, Ledger, runView, type Run, type Session } from "./ledger.ts";
import { NativeProcess, type Harness } from "./native.ts";
import { parseTool, tool } from "./tools.ts";

type Permission = { permissionId: string; run: Run; params: RequestPermissionRequest; resolve: (value: RequestPermissionResponse) => void };

export class Broker {
  readonly ledger: Ledger;
  private processes = new Map<Harness, NativeProcess>();
  private starting = new Map<Harness, Promise<NativeProcess>>();
  private permissions = new Map<string, Permission>();
  private lifecycle = new Set<string>();
  private creation = new Map<Harness, Promise<void>>();
  private earlyUpdates = new Map<Harness, { updates: SessionNotification[]; dropped: number }>();
  private monitors = new Set<string>();
  private listeners = new Set<() => void>();
  private closing = false;
  constructor(dir: string) {
    this.ledger = new Ledger(dir);
    // Broker crash recovery is durable, without inventing resumed native work.
    this.ledger.disconnect();
    for (const run of this.ledger.active()) this.ledger.settle(run, "unknown", null, new BridgeError("unknown_outcome", "Broker restarted while prompt response was outstanding").failure);
  }
  private changed(): void { for (const listener of this.listeners) listener(); }
  private key(harness: Harness, sessionId: string): string { return `${harness}:${sessionId}`; }
  connectOwner(owner: string): void { this.ledger.owner(owner); }
  connectMonitor(owner: string): void { if (this.monitors.has(owner)) fail("monitor_busy"); this.monitors.add(owner); }
  disconnectMonitor(owner: string): void { this.monitors.delete(owner); this.changed(); }
  delivery(owner: string) {
    return { monitorConnected: this.monitors.has(owner), readiness: this.monitors.has(owner) ? "connected" : "waiting_for_monitor", pendingEventCount: this.ledger.pendingCount(owner), ackCursor: this.ledger.ackCursor(owner), semantics: "at_least_once_stdout_write_not_human_read" };
  }
  private async runtime(harness: Harness): Promise<NativeProcess> {
    if (this.closing) fail("broker_unavailable", "Broker is shutting down");
    const current = this.processes.get(harness);
    if (current?.connected && current.initialization) return current;
    const pending = this.starting.get(harness);
    if (pending) return pending;
    const task = (async () => {
      if (current) await current.close();
      if (this.closing) fail("broker_unavailable", "Broker is shutting down");
      let process: NativeProcess;
      process = new NativeProcess(harness, {
        update: params => this.update(harness, params),
        permission: (params, signal) => this.permission(harness, params, signal),
        disconnected: () => { if (this.processes.get(harness) === process) this.disconnected(harness); },
      });
      this.processes.set(harness, process);
      await process.initialize();
      return process;
    })();
    this.starting.set(harness, task);
    try { return await task; } finally { this.starting.delete(harness); }
  }
  private disconnected(harness: Harness): void {
    this.ledger.disconnect(harness);
    for (const permission of this.permissions.values()) if (permission.run.harness === harness) this.resolvePermission(permission, null);
    for (const run of this.ledger.active(harness)) this.ledger.settle(run, "unknown", null, new BridgeError("unknown_outcome", `${harness} ACP transport closed before prompt response settled`).failure);
    this.changed();
  }
  private update(harness: Harness, params: SessionNotification): void {
    const session = this.ledger.session(harness, params.sessionId);
    if (!session) {
      const early = this.earlyUpdates.get(harness);
      if (early) {
        if (early.updates.length < 64 && Buffer.byteLength(JSON.stringify(params)) < 16_384) early.updates.push(params);
        else early.dropped++;
      }
      return;
    }
    if ((!session.connected && !this.lifecycle.has(this.key(harness, session.sessionId))) || params.update.sessionUpdate === "agent_thought_chunk") return;
    const update = params.update;
    this.ledger.update(session, params, update.sessionUpdate === "agent_message_chunk" && update.content.type === "text" ? update.content.text : undefined);
    if (update.sessionUpdate === "config_option_update") this.ledger.metadata(harness, session.sessionId, { configOptions: update.configOptions });
    if (update.sessionUpdate === "current_mode_update") {
      const metadata = JSON.parse(session.metadata);
      this.ledger.metadata(harness, session.sessionId, { modes: { ...(metadata.modes ?? {}), currentModeId: update.currentModeId } });
    }
  }
  private permission(harness: Harness, params: RequestPermissionRequest, signal: AbortSignal): Promise<RequestPermissionResponse> {
    const session = this.ledger.session(harness, params.sessionId);
    if (!session?.connected || !session.activeRunId || signal.aborted) return Promise.resolve({ outcome: { outcome: "cancelled" } });
    const run = this.ledger.run(session.owner, harness, session.sessionId, session.activeRunId);
    if (run.state !== "running" || [...this.permissions.values()].filter(p => p.run.runId === run.runId).length >= 8 || !params.options.length || params.options.length > 32 || Buffer.byteLength(JSON.stringify(params)) > 16_384) return Promise.resolve({ outcome: { outcome: "cancelled" } });
    try { this.ledger.checkEvents(session.owner); } catch { return Promise.resolve({ outcome: { outcome: "cancelled" } }); }
    return new Promise(resolve => {
      const permission = { permissionId: randomUUID(), run, params, resolve };
      this.permissions.set(permission.permissionId, permission);
      signal.addEventListener("abort", () => this.resolvePermission(permission, null), { once: true });
      this.ledger.attention(run, permission.permissionId);
      this.changed();
    });
  }
  private resolvePermission(permission: Permission, optionId: string | null): void {
    if (!this.permissions.delete(permission.permissionId)) return;
    permission.resolve({ outcome: optionId === null ? { outcome: "cancelled" } : { outcome: "selected", optionId } });
  }
  private pending(session: Session): unknown[] {
    return [...this.permissions.values()].filter(permission => permission.run.harness === session.harness && permission.run.sessionId === session.sessionId && permission.run.owner === session.owner).map(permission => ({ permissionId: permission.permissionId, runId: permission.run.runId, ...permission.params }));
  }
  private idle(session: Session): void {
    if (session.activeRunId || this.lifecycle.has(this.key(session.harness, session.sessionId))) fail("session_busy");
  }
  private connected(session: Session): NativeProcess {
    const runtime = this.processes.get(session.harness);
    if (!session.connected || !runtime?.connected || !runtime.initialization) fail("session_disconnected");
    return runtime;
  }
  private cwd(input: unknown): string {
    if (typeof input !== "string" || !isAbsolute(input)) fail("invalid_request", "ACP cwd must be an exact absolute directory path");
    try { if (!statSync(input).isDirectory()) fail("invalid_request", "ACP cwd is not a directory"); } catch (error) { if (error instanceof BridgeError) throw error; fail("invalid_request", "ACP cwd does not exist or is unreadable"); }
    return input;
  }
  async call(owner: string, name: string, raw: unknown): Promise<unknown> {
    if (this.closing) fail("broker_unavailable", "Broker is shutting down");
    const input = parseTool(name, raw);
    const { harness, name: action } = tool(name);
    if (action === "initialize") return (await this.runtime(harness)).initialization;
    if (action === "status") {
      const runtime = this.processes.get(harness);
      return { harness, connected: Boolean(runtime?.connected && runtime.initialization), pid: runtime?.pid ?? null, initialize: runtime?.initialization ?? null,
        delivery: this.delivery(owner), sessions: this.ledger.sessions(owner, harness).map(session => ({ sessionId: session.sessionId, cwd: session.cwd, connected: Boolean(session.connected), activeRunId: session.activeRunId, pendingPermissionCount: this.pending(session).length })) };
    }
    if (action === "session_new") return this.newSession(owner, harness, this.cwd(input.cwd));
    const session = this.ledger.owned(owner, harness, input.sessionId as string);
    if (action === "session_read") {
      const run = input.runId ? this.ledger.run(owner, harness, session.sessionId, input.runId as string) : this.ledger.latest(session);
      return { sessionId: session.sessionId, cwd: session.cwd, connected: Boolean(session.connected), ...JSON.parse(session.metadata),
        activeRunId: session.activeRunId, run: run ? runView(run) : null, pendingPermissions: this.pending(session),
        history: this.ledger.updates(session, input.afterSeq as number ?? 0, input.limit as number ?? 16, input.runId as string | undefined), delivery: this.delivery(owner) };
    }
    if (action === "session_wait") {
      const runId = input.runId as string;
      await this.waitFor(() => isTerminal(this.ledger.run(owner, harness, session.sessionId, runId)), input.timeoutMs as number ?? 10_000);
      const run = this.ledger.run(owner, harness, session.sessionId, runId);
      return { ...runView(run) as object, timedOut: !isTerminal(run), delivery: this.delivery(owner) };
    }
    if (action === "session_load") {
      this.idle(session);
      if (this.cwd(input.cwd) !== session.cwd) fail("invalid_request", "session/load must use the exact original cwd");
      const key = this.key(harness, session.sessionId);
      this.lifecycle.add(key);
      try {
        const runtime = await this.runtime(harness);
        if (!runtime.initialization?.agentCapabilities?.loadSession) fail("method_not_supported", "Native loadSession is not advertised");
        const result = await runtime.request("session/load", { sessionId: session.sessionId, cwd: session.cwd, mcpServers: [] });
        if (!runtime.connected) fail("unknown_outcome", "Native transport disconnected while loading session");
        if (record(result)) this.ledger.metadata(harness, session.sessionId, result);
        this.ledger.loaded(harness, session.sessionId);
        return result;
      } finally { this.lifecycle.delete(key); }
    }
    if (action === "session_prompt") {
      const digest = createHash("sha256").update(JSON.stringify({ sessionId: session.sessionId, prompt: input.prompt })).digest("hex");
      if (input.requestId) {
        const prior = this.ledger.findRequest(owner, harness, input.requestId as string);
        if (prior) {
          if (prior.digest !== digest || prior.sessionId !== session.sessionId) fail("invalid_request", "requestId was reused for different prompt input");
          return { ...runView(prior) as object, duplicate: true, delivery: this.delivery(owner) };
        }
      }
      const runtime = this.connected(session);
      this.idle(session);
      const run = this.ledger.admit(session, digest, input.requestId as string ?? null);
      void runtime.request("session/prompt", { sessionId: session.sessionId, prompt: input.prompt }, 0).then(result => {
        const stopReason = record(result) ? result.stopReason : undefined;
        const state = stopReason === "cancelled" ? "cancelled" : record(result) && result.failed === true ? "failed" : typeof stopReason === "string" ? "completed" : "unknown";
        this.settle(run, state, result, state === "unknown" ? new BridgeError("unknown_outcome", "Native prompt returned no stopReason").failure : null);
      }).catch(error => this.settle(run, runtime.connected ? "failed" : "unknown", null, runtime.connected ? failure(error) : new BridgeError("unknown_outcome", "Native prompt transport closed").failure));
      return { runId: run.runId, sessionId: session.sessionId, state: "running", duplicate: false, delivery: this.delivery(owner) };
    }
    const runtime = this.connected(session);
    if (action === "session_cancel") {
      if (!session.activeRunId) return { sessionId: session.sessionId, state: "idle", delivery: this.delivery(owner) };
      const run = this.ledger.run(owner, harness, session.sessionId, session.activeRunId);
      this.ledger.cancelling(run);
      for (const permission of this.permissions.values()) if (permission.run.runId === run.runId) this.resolvePermission(permission, null);
      await runtime.cancel(session.sessionId);
      return { sessionId: session.sessionId, runId: run.runId, state: "cancelling" };
    }
    if (action === "session_request_permission_response") {
      const permission = this.permissions.get(input.permissionId as string);
      if (!permission || permission.run.owner !== owner || permission.run.harness !== harness || permission.run.sessionId !== session.sessionId || permission.run.runId !== session.activeRunId) fail("not_found");
      const optionId = input.optionId as string | null;
      if (optionId !== null && !permission.params.options.some(option => option.optionId === optionId)) fail("invalid_choice");
      this.resolvePermission(permission, optionId);
      return { sessionId: session.sessionId, permissionId: permission.permissionId, outcome: optionId === null ? { outcome: "cancelled" } : { outcome: "selected", optionId } };
    }
    this.idle(session);
    const metadata = JSON.parse(session.metadata);
    if (action === "session_set_config_option") {
      const option = Array.isArray(metadata.configOptions) ? metadata.configOptions.find((item: unknown) => record(item) && item.id === input.configId) : undefined;
      const choices = (items: unknown): unknown[] => Array.isArray(items) ? items.flatMap(item => record(item) && "value" in item ? [item.value] : record(item) ? choices(item.options) : []) : [];
      if (!option || (option.type === "boolean" ? typeof input.value !== "boolean" : !choices(option.options).includes(input.value))) fail("invalid_choice");
    } else if (action === "session_set_mode") {
      if (!Array.isArray(metadata.modes?.availableModes) || !metadata.modes.availableModes.some((mode: unknown) => record(mode) && mode.id === input.modeId)) fail("invalid_choice");
    } else fail("invalid_request");
    const key = this.key(harness, session.sessionId);
    this.lifecycle.add(key);
    try {
      const result = await runtime.request(action === "session_set_mode" ? "session/set_mode" : "session/set_config_option", input);
      if (record(result)) this.ledger.metadata(harness, session.sessionId, result);
      if (action === "session_set_mode") this.ledger.metadata(harness, session.sessionId, { modes: { ...metadata.modes, currentModeId: input.modeId } });
      return result;
    } finally { this.lifecycle.delete(key); }
  }
  private async newSession(owner: string, harness: Harness, cwd: string): Promise<unknown> {
    this.ledger.checkSessionCapacity(owner);
    // Serialize only session/new, so pre-response updates can bind to the exact returned ID.
    const previous = this.creation.get(harness) ?? Promise.resolve();
    let release!: () => void;
    const finished = new Promise<void>(resolve => { release = resolve; });
    this.creation.set(harness, finished);
    await previous;
    try {
      this.ledger.checkSessionCapacity(owner);
      const runtime = await this.runtime(harness);
      this.earlyUpdates.set(harness, { updates: [], dropped: 0 });
      const result = await runtime.request("session/new", { cwd, mcpServers: [] });
      if (!runtime.connected) fail("unknown_outcome", "Native transport disconnected while creating session");
      if (!record(result) || typeof result.sessionId !== "string" || !result.sessionId.length) fail("unknown_outcome", "Native session/new returned no sessionId");
      if (this.ledger.session(harness, result.sessionId)) { await runtime.close(); fail("unknown_outcome", "Native session/new returned an already-bound ID; transport fenced"); }
      this.ledger.bind(owner, harness, result.sessionId, cwd, result);
      const early = this.earlyUpdates.get(harness)!;
      for (const params of early.updates) if (params.sessionId === result.sessionId) this.update(harness, params);
      if (early.dropped) this.ledger.dropUpdates(harness, result.sessionId, early.dropped);
      return result;
    } finally { this.earlyUpdates.delete(harness); release(); if (this.creation.get(harness) === finished) this.creation.delete(harness); }
  }
  private settle(run: Run, state: Run["state"], result: unknown, error: ReturnType<typeof failure> | null): void {
    for (const permission of this.permissions.values()) if (permission.run.runId === run.runId) this.resolvePermission(permission, null);
    if (this.ledger.settle(run, state, result, error)) this.changed();
  }
  waitFor(ready: () => boolean, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (ready() || !timeoutMs || signal?.aborted) return Promise.resolve();
    return new Promise(resolve => {
      const done = () => { clearTimeout(timer); this.listeners.delete(check); signal?.removeEventListener("abort", done); resolve(); };
      const check = () => { if (ready() || this.closing) done(); };
      const timer = setTimeout(done, timeoutMs);
      this.listeners.add(check);
      signal?.addEventListener("abort", done, { once: true });
      check();
    });
  }
  async nextEvents(owner: string, signal: AbortSignal) {
    await this.waitFor(() => this.ledger.pendingCount(owner) > 0, 25_000, signal);
    return this.ledger.events(owner).map(event => ({ ...event, payload: JSON.parse(event.payload) }));
  }
  async close(): Promise<void> {
    this.closing = true;
    this.changed();
    await Promise.allSettled([...this.processes.values()].map(runtime => runtime.close()));
    await Promise.allSettled([...this.starting.values(), ...this.creation.values()]);
    for (const run of this.ledger.active()) this.ledger.settle(run, "unknown", null, new BridgeError("unknown_outcome", "Broker shut down before native response").failure);
    this.ledger.close();
  }
}
