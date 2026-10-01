import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { fail, type Failure } from "./errors.ts";
import type { Harness } from "./native.ts";

export type Session = {
  harness: Harness; sessionId: string; owner: string; cwd: string; connected: number;
  metadata: string; activeRunId: string | null; seq: number; dropped: number;
};
export type Run = {
  runId: string; harness: Harness; sessionId: string; owner: string; requestId: string | null; digest: string;
  state: "running" | "cancelling" | "completed" | "cancelled" | "failed" | "unknown";
  createdAt: number; settledAt: number | null; result: string | null; error: string | null;
  finalText: string; textTruncated: number;
};
export type Event = { seq: number; eventId: string; owner: string; kind: "completion" | "permission"; harness: Harness; sessionId: string; runId: string; payload: string; createdAt: number };
const terminal = new Set(["completed", "cancelled", "failed", "unknown"]);
export function isTerminal(run: Run): boolean { return terminal.has(run.state); }
export const limits = { owners: 1024, sessionsPerOwner: 256, runsPerSession: 256, eventsPerOwner: 4096, updatesPerSession: 512, updateBytes: 16_384, textChars: 65_536 };

/** The broker is the sole writer. Transactions tie run terminal state to its completion event. */
export class Ledger {
  private db: Database;
  constructor(dir: string) {
    const path = join(dir, "ledger.sqlite");
    this.db = new Database(path, { create: true, strict: true });
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
      INSERT INTO schema_version SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM schema_version);
      CREATE TABLE IF NOT EXISTS owners (owner TEXT PRIMARY KEY, ack INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS sessions (harness TEXT NOT NULL, sessionId TEXT NOT NULL, owner TEXT NOT NULL REFERENCES owners(owner), cwd TEXT NOT NULL,
        connected INTEGER NOT NULL, metadata TEXT NOT NULL, activeRunId TEXT, seq INTEGER NOT NULL DEFAULT 0, dropped INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(harness,sessionId));
      CREATE TABLE IF NOT EXISTS runs (runId TEXT PRIMARY KEY, harness TEXT NOT NULL, sessionId TEXT NOT NULL, owner TEXT NOT NULL,
        requestId TEXT, digest TEXT NOT NULL, state TEXT NOT NULL, createdAt INTEGER NOT NULL, settledAt INTEGER, result TEXT, error TEXT,
        finalText TEXT NOT NULL DEFAULT '', textTruncated INTEGER NOT NULL DEFAULT 0, FOREIGN KEY(harness,sessionId) REFERENCES sessions(harness,sessionId));
      CREATE UNIQUE INDEX IF NOT EXISTS run_request ON runs(owner,harness,requestId) WHERE requestId IS NOT NULL;
      CREATE TABLE IF NOT EXISTS updates (harness TEXT NOT NULL, sessionId TEXT NOT NULL, seq INTEGER NOT NULL, runId TEXT,
        value TEXT NOT NULL, createdAt INTEGER NOT NULL, PRIMARY KEY(harness,sessionId,seq));
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, eventId TEXT UNIQUE NOT NULL, owner TEXT NOT NULL REFERENCES owners(owner),
        kind TEXT NOT NULL, harness TEXT NOT NULL, sessionId TEXT NOT NULL, runId TEXT NOT NULL, payload TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS owner_events ON events(owner,seq);
    `);
    if ((this.db.query("SELECT version FROM schema_version").get() as { version: number }).version !== 1) fail("unsafe_state", "Unsupported broker ledger version");
  }
  close(): void { this.db.close(); }
  owner(owner: string): void {
    if (this.db.query("SELECT owner FROM owners WHERE owner=?").get(owner)) return;
    if (this.count("SELECT count(*) AS n FROM owners") >= limits.owners) fail("capacity_exceeded", "Broker owner limit reached; operator must archive inactive state offline");
    this.db.query("INSERT INTO owners(owner) VALUES(?)").run(owner);
  }
  private count(sql: string, ...values: Array<string | number>): number { return (this.db.query(sql).get(...values) as { n: number }).n; }
  owned(owner: string, harness: Harness, sessionId: string): Session {
    const value = this.db.query("SELECT * FROM sessions WHERE owner=? AND harness=? AND sessionId=?").get(owner, harness, sessionId) as Session | null;
    if (!value) fail("not_found");
    return value;
  }
  session(harness: Harness, sessionId: string): Session | null { return this.db.query("SELECT * FROM sessions WHERE harness=? AND sessionId=?").get(harness, sessionId) as Session | null; }
  sessions(owner: string, harness: Harness): Session[] { return this.db.query("SELECT * FROM sessions WHERE owner=? AND harness=? ORDER BY rowid").all(owner, harness) as Session[]; }
  checkSessionCapacity(owner: string): void {
    if (this.count("SELECT count(*) AS n FROM sessions WHERE owner=?", owner) >= limits.sessionsPerOwner) fail("capacity_exceeded", "Owner session limit reached");
  }
  bind(owner: string, harness: Harness, sessionId: string, cwd: string, metadata: unknown): void {
    const existing = this.session(harness, sessionId);
    if (existing) fail("unknown_outcome", "Native session/new returned an already-bound session ID; runtime must be inspected");
    this.db.query("INSERT INTO sessions(harness,sessionId,owner,cwd,connected,metadata) VALUES(?,?,?,?,1,?)").run(harness, sessionId, owner, cwd, JSON.stringify(metadata));
  }
  metadata(harness: Harness, sessionId: string, response: Record<string, unknown>): void {
    const session = this.session(harness, sessionId);
    if (!session) return;
    const previous = JSON.parse(session.metadata);
    for (const key of ["configOptions", "modes", "models", "_meta"]) if (key in response) previous[key] = response[key];
    this.db.query("UPDATE sessions SET metadata=? WHERE harness=? AND sessionId=?").run(JSON.stringify(previous), harness, sessionId);
  }
  loaded(harness: Harness, sessionId: string): void { this.db.query("UPDATE sessions SET connected=1 WHERE harness=? AND sessionId=?").run(harness, sessionId); }
  dropUpdates(harness: Harness, sessionId: string, count: number): void { this.db.query("UPDATE sessions SET dropped=dropped+? WHERE harness=? AND sessionId=?").run(count, harness, sessionId); }
  disconnect(harness?: Harness): void {
    if (harness) this.db.query("UPDATE sessions SET connected=0 WHERE harness=?").run(harness);
    else this.db.exec("UPDATE sessions SET connected=0");
  }
  run(owner: string, harness: Harness, sessionId: string, runId: string): Run {
    const value = this.db.query("SELECT * FROM runs WHERE owner=? AND harness=? AND sessionId=? AND runId=?").get(owner, harness, sessionId, runId) as Run | null;
    if (!value) fail("not_found");
    return value;
  }
  findRequest(owner: string, harness: Harness, requestId: string): Run | null {
    return this.db.query("SELECT * FROM runs WHERE owner=? AND harness=? AND requestId=?").get(owner, harness, requestId) as Run | null;
  }
  latest(session: Session): Run | null {
    return this.db.query("SELECT * FROM runs WHERE harness=? AND sessionId=? ORDER BY rowid DESC LIMIT 1").get(session.harness, session.sessionId) as Run | null;
  }
  active(harness?: Harness): Run[] {
    return this.db.query(`SELECT * FROM runs WHERE state IN ('running','cancelling')${harness ? " AND harness=?" : ""}`).all(...(harness ? [harness] : [])) as Run[];
  }
  checkEvents(owner: string): void {
    // Leave room for one terminal record for every admitted active run and pending permission.
    if (this.pendingCount(owner) + this.count("SELECT count(*) AS n FROM runs WHERE owner=? AND state IN ('running','cancelling')", owner) >= limits.eventsPerOwner - 64) fail("capacity_exceeded", "Unacknowledged owner events reached admission limit; connect its monitor");
  }
  admit(session: Session, digest: string, requestId: string | null): Run {
    this.checkEvents(session.owner);
    if (this.count("SELECT count(*) AS n FROM runs WHERE harness=? AND sessionId=?", session.harness, session.sessionId) >= limits.runsPerSession) fail("capacity_exceeded", "Retained run limit reached for this session; create a new session");
    const runId = randomUUID();
    this.db.transaction(() => {
      this.db.query("INSERT INTO runs(runId,harness,sessionId,owner,requestId,digest,state,createdAt) VALUES(?,?,?,?,?,?,'running',?)").run(runId, session.harness, session.sessionId, session.owner, requestId, digest, Date.now());
      this.db.query("UPDATE sessions SET activeRunId=? WHERE harness=? AND sessionId=?").run(runId, session.harness, session.sessionId);
    })();
    return this.run(session.owner, session.harness, session.sessionId, runId);
  }
  cancelling(run: Run): void { this.db.query("UPDATE runs SET state='cancelling' WHERE runId=? AND state='running'").run(run.runId); }
  private insertEvent(run: Run, kind: Event["kind"], payload: unknown): void {
    this.db.query("INSERT INTO events(eventId,owner,kind,harness,sessionId,runId,payload,createdAt) VALUES(?,?,?,?,?,?,?,?)").run(randomUUID(), run.owner, kind, run.harness, run.sessionId, run.runId, JSON.stringify(payload), Date.now());
  }
  attention(run: Run, permissionId: string): void { this.insertEvent(run, "permission", { permissionId }); }
  settle(run: Run, state: Run["state"], result: unknown = null, error: Failure | null = null): boolean {
    return this.db.transaction(() => {
      const changed = this.db.query("UPDATE runs SET state=?, settledAt=?, result=?, error=? WHERE runId=? AND state IN ('running','cancelling')").run(state, Date.now(), JSON.stringify(result), error ? JSON.stringify(error) : null, run.runId);
      if (!changed.changes) return false;
      this.db.query("UPDATE sessions SET activeRunId=NULL WHERE harness=? AND sessionId=? AND activeRunId=?").run(run.harness, run.sessionId, run.runId);
      this.insertEvent(run, "completion", { state, ...(result !== null ? { stopReason: (result as { stopReason?: string }).stopReason ?? null } : {}), ...(error ? { error: { code: error.code, message: error.message.slice(0, 2_000) } } : {}) });
      return true;
    })();
  }
  update(session: Session, value: unknown, text?: string): void {
    this.db.transaction(() => {
      const seq = session.seq + 1;
      const encoded = JSON.stringify(value);
      const bounded = Buffer.byteLength(encoded) <= limits.updateBytes ? encoded : JSON.stringify({ truncated: true, preview: encoded.slice(0, 4_000) });
      this.db.query("INSERT INTO updates(harness,sessionId,seq,runId,value,createdAt) VALUES(?,?,?,?,?,?)").run(session.harness, session.sessionId, seq, session.activeRunId, bounded, Date.now());
      const removed = this.db.query("DELETE FROM updates WHERE harness=? AND sessionId=? AND seq<=?").run(session.harness, session.sessionId, seq - limits.updatesPerSession).changes;
      this.db.query("UPDATE sessions SET seq=?, dropped=dropped+? WHERE harness=? AND sessionId=?").run(seq, removed + Number(bounded !== encoded), session.harness, session.sessionId);
      if (text && session.activeRunId) {
        this.db.query("UPDATE runs SET textTruncated=CASE WHEN length(finalText)+? > ? THEN 1 ELSE textTruncated END, finalText=substr(finalText || ?,1,?) WHERE runId=?").run(text.length, limits.textChars, text, limits.textChars, session.activeRunId);
      }
    })();
  }
  updates(session: Session, afterSeq: number, limit: number, runId?: string): unknown {
    const rows = this.db.query(`SELECT seq,runId,value,createdAt FROM updates WHERE harness=? AND sessionId=? AND seq>?${runId ? " AND runId=?" : ""} ORDER BY seq LIMIT ?`).all(session.harness, session.sessionId, afterSeq, ...(runId ? [runId] : []), limit) as Array<{ seq: number; runId: string | null; value: string; createdAt: number }>;
    const oldest = this.db.query("SELECT min(seq) AS seq FROM updates WHERE harness=? AND sessionId=?").get(session.harness, session.sessionId) as { seq: number | null };
    return { updates: rows.map(row => ({ ...row, value: JSON.parse(row.value) })), nextSeq: rows.at(-1)?.seq ?? afterSeq,
      latestSeq: session.seq, oldestSeq: oldest.seq, gap: oldest.seq !== null && afterSeq < oldest.seq - 1, dropped: session.dropped };
  }
  ackCursor(owner: string): number { return (this.db.query("SELECT ack FROM owners WHERE owner=?").get(owner) as { ack: number }).ack; }
  pendingCount(owner: string): number { return this.count("SELECT count(*) AS n FROM events WHERE owner=? AND seq>(SELECT ack FROM owners WHERE owner=?)", owner, owner); }
  events(owner: string): Event[] { return this.db.query("SELECT * FROM events WHERE owner=? AND seq>(SELECT ack FROM owners WHERE owner=?) ORDER BY seq LIMIT 16").all(owner, owner) as Event[]; }
  ack(owner: string, seq: number, eventId: string): void {
    if (!this.db.query("SELECT seq FROM events WHERE owner=? AND seq=? AND eventId=?").get(owner, seq, eventId)) fail("not_found");
    this.db.transaction(() => {
      this.db.query("UPDATE owners SET ack=max(ack,?) WHERE owner=?").run(seq, owner);
      // Retain a bounded acknowledged history; never delete an unacknowledged event.
      this.db.query("DELETE FROM events WHERE owner=? AND seq<=? AND seq NOT IN (SELECT seq FROM events WHERE owner=? ORDER BY seq DESC LIMIT 512)").run(owner, seq, owner);
    })();
  }
}

export function runView(run: Run): unknown {
  return { runId: run.runId, sessionId: run.sessionId, state: run.state, createdAt: run.createdAt, settledAt: run.settledAt,
    result: run.result ? JSON.parse(run.result) : null, error: run.error ? JSON.parse(run.error) : null,
    finalText: run.finalText, textTruncated: Boolean(run.textTruncated) };
}
