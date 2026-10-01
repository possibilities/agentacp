import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { lstatSync, mkdirSync } from "node:fs";
import { fail } from "./errors.ts";

export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function ownerFromEnv(env = process.env): string {
  if (env.AGENTROLES_HARNESS !== "claude" || !uuid.test(env.AGENTROLES_INVOCATION_ID ?? "")) fail("owner_required");
  return env.AGENTROLES_INVOCATION_ID!.toLowerCase();
}
export function stateDir(env = process.env): string {
  const dir = env.AGENTACP_STATE_DIR ?? join(homedir(), ".local/state/agentacp");
  if (!isAbsolute(dir) || Buffer.byteLength(join(dir, "broker.sock")) > 100) fail("unsafe_state", "State directory must be absolute with a Unix socket path no longer than 100 bytes");
  return dir;
}
export function privatePath(path: string, kind: "directory" | "file" | "socket", missing = false): void {
  let stat;
  try { stat = lstatSync(path); } catch (e) { if (missing && (e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
  if (stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0
    || !(kind === "directory" ? stat.isDirectory() : kind === "socket" ? stat.isSocket() : stat.isFile())) fail("unsafe_state", `Refusing non-private ${kind}: ${path}`);
}
export function prepareState(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  privatePath(dir, "directory");
  for (const name of ["ledger.sqlite", "ledger.sqlite-wal", "ledger.sqlite-shm", "broker.log"]) privatePath(join(dir, name), "file", true);
  privatePath(join(dir, "broker.sock"), "socket", true);
}
export function nativeEnv(harness: "opencode" | "devin", env = process.env): NodeJS.ProcessEnv {
  const result = { ...env };
  delete result.AGENTROLES_INVOCATION_ID;
  delete result.AGENTROLES_HARNESS;
  delete result.CLAUDECODE;
  if (harness === "devin") result.AGENTSTART_DEVIN_ACP_ROLE = "1";
  return result;
}
