# AgentACP usage

Requires Bun, AgentRoles, OpenCode V2, and optionally the native Devin CLI via
AgentStart's shim. Authentication/subscriptions remain with the native harness;
this project never reads/copies credentials or changes accounts.

## Install and service

```sh
bun install --frozen-lockfile
bun run check
./scripts/install.sh
agentacp guide --json
agentacp serve
```

The installer links `~/.local/bin/agentacp` into this checkout and records its
SHA. It refuses foreign links/non-links. `--uninstall` removes only this
checkout's link. Disposable installers can set `AGENTACP_INSTALL_BIN_DIR` and
`AGENTACP_INSTALL_STATE_DIR`. It does not register launchd; AgentStart owns
registration and supervision. Do not remove a deployed checkout while linked.

MCP/monitor/finite CLI commands connect to the same broker; if absent they can
start its safe singleton. Set `AGENTACP_AUTOSTART=0` to require supervision.
State defaults to `~/.local/state/agentacp`. An absolute private
`AGENTACP_STATE_DIR` overrides it (socket path must be at most 100 bytes).
The directory must be owned by the current UID, mode 0700, not a symlink;
socket/files are private. Diagnostics go to stderr / `broker.log`, not stdout.
SIGINT/SIGTERM shut down only owned harness processes. No live app restarts.

Native processes start in `~/code`. Every native session/new/load receives the
exact absolute target cwd. The user supplies worktrees; AgentACP never creates
or resets one. Tools cannot supply executables, credentials, or arbitrary
session MCP servers. Role injection comes from the public native CLI contracts:

- `agentroles ~/.local/share/agentstart/resources/roles/default -- opencode acp`
- PATH `devin acp`, with `AGENTSTART_DEVIN_ACP_ROLE=1`

## Claude integration

AgentRoles must assign each Claude RUN a fresh `AGENTROLES_INVOCATION_ID` UUID
and `AGENTROLES_HARNESS=claude`. `agentacp mcp` and `agentacp monitor` require
these inherited values. Never manufacture an owner using a tool argument/cwd.
Nested native harness processes do not inherit their parent's owner identity.

The Default Role supplies an MCP server named `agentacp` running
`${HOME}/.local/bin/agentacp mcp`, and its `monitors.json` includes:

```json
[
  {
    "name": "agentacp-completions",
    "command": "\"${HOME}/.local/bin/agentacp\" monitor",
    "description": "OpenCode and Devin ACP completions",
    "when": "always"
  }
]
```

AgentRoles generates the Claude plugin. Plugin monitors run in **interactive
Claude only**, not `claude -p`. A native `-p` run cannot prove monitor startup.
Check `delivery.monitorConnected` in status/read/admission. A missing monitor
is explicitly `waiting_for_monitor`: events remain queued, not delivered.

Each monitor stdout line is one native Monitor notification, represented as
JSON with `type`, `eventId`, `runId`, `harness`, `sessionId` and terminal state
or `permissionId`. No heartbeat/readiness lines are emitted. A reconnect
replays events not durably acknowledged after stdout writing. Deduplicate by
eventId/runId. Acknowledgement means stdout write, not human reading; the
native Monitor API cannot provide end-consumer acknowledgements.

## Harness tools and CLI

Every harness MCP tool starts with `opencode_` or `devin_`. `guide` returns the
fleet contract. CLI equivalents are `agentacp opencode session_new ...` etc.
Finite commands always return `{schema_version,ok,error,data}`. Native results
stay in `data`; classified native failures retain `error.nativeError` with its
numeric code/message/data. MCP also returns this envelope as standalone JSON
text and `structuredContent`. ACP params keep their camelCase.

1. `opencode_initialize` / `devin_initialize`: native capabilities/agentInfo.
2. `*_session_new {cwd}`: native sessionId, configOptions, modes.
3. Read those **actual** choices. `*_session_set_config_option
   {sessionId,configId,value}` accepts select values or boolean toggles. Setting
   a model can change available effort/config choices; use the returned options.
   `*_session_set_mode` accepts only advertised modeId values.
4. `*_session_prompt {sessionId,prompt:[{type:"text",text:"..."}],requestId?}`
   returns a durable admission/runId promptly, before native response completion.
   It uses native subscription quota. Only one active prompt per session.
5. Monitor completion arrives when that prompt response settles; use
   `*_session_read {sessionId,runId,afterSeq?,limit?}` for bounded native updates,
   pendingPermissions, current metadata, aggregated finalText and truncation.
   `*_session_wait {sessionId,runId,timeoutMs?}` is a bounded fallback (0–30000 ms,
   default 10000), particularly for noninteractive Claude. Its timeout only
   stops observing; it never cancels/fails native work.

CLI example (inside an inherited Claude owner environment):

```sh
agentacp opencode initialize
agentacp opencode session_new --cwd /absolute/owned/worktree
agentacp opencode session_prompt --sessionId '<native-id>' \
  --prompt '[{"type":"text","text":"Your authorized task"}]' \
  --requestId '<fresh-uuid>'
agentacp opencode session_read --sessionId '<native-id>' --runId '<run-id>'
agentacp opencode session_wait --sessionId '<native-id>' --runId '<run-id>' --timeoutMs 30000
```

Complex/union params use JSON on the CLI. For instance `--value '"exact-model"'`
or `--value false`, and `--optionId '"allow-once"'` or `--optionId null`.
Native content blocks are passed through; unsupported modalities return native
errors rather than guessed provider behavior.

## Permissions, cancellation and recovery

Native `session/request_permission` stays pending. Monitor attention gives its
permissionId; read pendingPermissions for native toolCall/options. After
obtaining the appropriate authority, call
`*_session_request_permission_response {sessionId,permissionId,optionId}` with
the **exact advertised** optionId; null cancels. Cross-owner IDs cannot read or
respond. Unknown client methods return method-not-supported. Client fs/terminal
capabilities are absent; this does not disable native harness-owned tools.

`*_session_cancel {sessionId}` sends ACP's cancellation notification, cancels
pending permission requests, and returns `cancelling`. Continue reading updates.
Only native response settlement proves a cancelled/completed/failed result.
Transport loss or broker restart generates a terminal `unknown` event; it is
not proof native side effects stopped or rolled back. All active runs settle
even when the monitor is disconnected.

Sessions are retained but fenced disconnected on restart. `*_session_load
{sessionId,cwd}` accepts only already-owned sessions and their original exact
cwd, only when native `loadSession` is advertised. Inspect any unknown outcome
before loading or submitting more work. No arbitrary native-session takeover.

Use a caller-generated requestId for prompt idempotency. Repeating identical
input returns the same run; changing input under that ID is refused. A lost
request response can be an unknown outcome: inspect status/read before retrying
other mutations. There is no automatic retry of session/config mutations.

## Bounds and verification

- 1 MiB native frames, 2 MiB broker output frames (oversized reads return an
  explicit capacity error); 256 KiB tool inputs; 64 prompt blocks.
- 512 ordered updates/session, each at most 16 KiB (oversized values retain a
  marked preview); 65536 characters aggregated text/run; thoughts not retained.
- 32 updates/read page, 16 events/monitor batch; history gaps/dropped counts and
  text truncation are explicit. FinalText aggregates only agent text chunks.
- At most eight pending permissions/run and 16 KiB/request; requests exceeding
  those bounds are cancelled, never approved. Attention notifications carry
  IDs, not arbitrary tool content; status lists counts and read exposes details.
- 1024 owners, 256 sessions/owner, 256 retained runs/session. Inactive ledgers
  may need operator offline archiving. No automatic destructive garbage collection.
- 4096 unacknowledged event budget/owner, with reservation for active terminal
  records; admission pauses near the limit. Unacknowledged events are not pruned.
  Acknowledged history retains at most the newest 512 events/owner.

`bun run check` uses actual CLI/MCP/monitor processes against disposable PATH
harnesses and private state. It sends no real model prompts and uses no native
credentials. Protocol/lifecycle tests do not claim interactive Claude plugin
startup or real provider behavior; those require separately authorized
integration validation. Read the [architecture decision](adr/0001-private-acp-broker.md).
