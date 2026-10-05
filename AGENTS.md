# AgentACP

Read `GLOSSARY.md`, `docs/usage.md`, and `docs/adr/0001-private-acp-broker.md`.
Work in an owned task worktree, never in the canonical checkout or on main.

- Bun/TypeScript; `bun install --frozen-lockfile`, `bun run check`, `git diff --check`.
- Keep MCP/monitor stdout protocol-only. Diagnostics go to stderr.
- Preserve ACP camelCase, native capabilities, config choices, and errors.
- Owners come only from AgentRoles invocation environment, never cwd/tool input.
- Never auto-approve permission requests, copy credentials, or advertise unimplemented client capabilities.
- Tests use fake PATH harnesses and disposable private state. No live model prompts.
- AgentStart owns registration/supervision; this checkout owns only its CLI installer.
