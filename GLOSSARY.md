# Vocabulary

- **Harness**: a full native OpenCode or Devin process speaking ACP over stdio.
- **Broker**: the private local service that exclusively owns harness processes.
- **Owner**: one Claude AgentRoles RUN's `AGENTROLES_INVOCATION_ID` UUID.
- **Session**: a native ACP session bound to its harness, exact cwd, and owner.
- **Run**: one admitted `session/prompt`; terminal only when its response settles or transport is lost.
- **Event**: a durable, owner-scoped attention/completion record with stable ID and sequence.
- **Monitor**: the Claude plugin process that emits event notification lines and acknowledges stdout writes.
- **Unknown outcome**: transport/process loss after dispatch; not proof native work stopped or rolled back.

_Avoid_: worker/model router (this is mechanism only), idle = complete, delivery = human read, cwd = identity, cancel = cancelled.
