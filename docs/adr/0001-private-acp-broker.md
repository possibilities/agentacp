# 0001 — Private broker owns native ACP and completion history

Status: accepted for the first-party implementation, 2026-10-01.

## Context

MCP calls must return prompt admission before native work completes. Claude
plugin monitors start independently, can disconnect, and do not start in
noninteractive `claude -p`. A subprocess per MCP connection loses work when
the host reconnects. Working directories do not identify conversations.

## Decision

One broker per private state directory owns at most one OpenCode and one Devin
ACP stdio process. MCP and monitor are clients of a 0600 Unix socket in a 0700
directory. A PID/token lock serializes startup; stale recovery never signals
a PID found in a file. Native processes run in private owned process groups.
AgentStart owns long-lived supervision; the CLI can also start the singleton
on demand. No second launchd installer or public HTTP endpoint is introduced.

AgentRoles supplies one UUID per RUN and the harness identity. MCP and monitor
require inherited `AGENTROLES_HARNESS=claude` and that UUID. The socket handshake
binds it once; tool arguments cannot choose an owner. All session, run and
permission lookups include the owner. Native launches strip the parent's owner
identity, and AgentRoles assigns OpenCode its own invocation. This isolates
honest same-user subscribers, not malicious processes with the same UID and
filesystem access. Other Unix users cannot connect/read private state.

SQLite transactions couple terminal run state and completion event creation.
Admission is durable before native dispatch. Prompt requests have no task
timeout. Response settle (including failure/cancellation), transport loss and
broker restart produce terminal events; idle/session updates never do.
Transport loss is an **unknown outcome**, not proof native side effects stopped.
Cancellation remains `cancelling` until a native response or transport loss.

A monitor receives ordered owner events, writes one JSON notification line,
then acknowledges its exact event ID/sequence. The broker persists the cursor.
Unacknowledged events are never pruned. Reconnect replays them, including the
first-call-before-monitor race. At-least-once stdout delivery can duplicate
an event if the process dies between write and ack; stable run/event IDs support
deduplication. Neither stdout write nor ack proves Claude/human consumed it.
Only one monitor may hold an owner's subscription at a time. No heartbeats go
to stdout. Delivery readiness and backlog are explicit in tool results.

Native ACP SDK schemas and methods preserve capabilities/configOptions and
native errors. No model/effort catalog is synthesized. Permission requests are
held pending, surfaced as attention events, and answered only with an exact
advertised option ID or cancellation. Unknown client methods are refused;
filesystem/terminal capabilities are not advertised. Native harness tools may
still operate through their own permission behavior.

## Consequences

- A broker/MCP crash does not silently discard completions. Broker restart
  fences retained sessions and settles outstanding prompts as unknown; explicit
  native load (only when advertised) or a new session is required.
- User-selected exact absolute `cwd` passes unchanged to session/new/load.
  No worktrees are created, no credentials copied, and no arbitrary executable
  or MCP-server injection is accepted through tools.
- Capture is bounded and reports gaps/truncation. Unacknowledged event pressure
  refuses new prompts rather than deleting notifications. Owner/session/run
  limits eventually require operator offline archiving of inactive state.
- Native permissions belong to the exact current run/transport; they are not
  resumable after disconnect. Attention history may outlive the pending request.
- OpenCode uses `agentroles <default-role> -- opencode acp`. Devin uses PATH
  `devin acp` with `AGENTSTART_DEVIN_ACP_ROLE=1`; AgentStart owns its session-cwd
  snapshot lifecycle. No sibling implementation is imported.

## References

- `@agentclientprotocol/sdk` 1.5.1, stable ACP v1 types/transport.
- Fleet agent contract: AgentStart `config/agent-contract/README.md` and `MCP.md`.
- [Claude plugin manifest](https://code.claude.com/docs/en/plugins/manifest-reference.md#monitors).
- [Claude Monitor](https://code.claude.com/docs/en/tools-reference.md#monitor-tool).
