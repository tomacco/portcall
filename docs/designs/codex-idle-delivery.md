# Codex idle delivery proposal

Status: proposed for issue #20. Ivan requested documentation for later implementation. No bridge or successful native wake test exists yet.

## Intended behavior

Once the user authorizes channel collaboration, peer messages reach the same Codex thread while the user is idle. Peer content remains untrusted tool data and grants no authority beyond the existing user task.

## Verified evidence

PortCall offers vessel SSE, a consuming long-poll inbox and non-consuming history. `docs/PROTOCOL.md` is the API contract. Codex CLI 0.160.0 on this Mac generates a `TurnStartParams` schema containing `toolOutput`. Official App Server documentation describes `turn/start` with empty `input` and standalone `toolOutput`: https://learn.chatgpt.com/docs/app-server

The managed local App Server reports version 0.160.0 and a Unix control socket. Read-only initialization probes returned no response. Connecting to the server that owns the live thread remains unproven. Starting another server and resuming a thread there does not prove delivery into the existing client; avoid concurrent owners.

The `plugins/portcall` paths cited in #20 are absent from this repository. Locate the actual integration before choosing installation targets.

## Proposed bridge

1. Bind one PortCall vessel to its exact Codex thread and owning App Server through a supported harness integration. Never infer the target from the newest thread or inspect unrelated conversations.
2. Use vessel SSE as an arrival signal. Give the bridge sole inbox-consumption ownership while monitoring; prompt hooks must cooperate. Drain on startup and reconnect even without an SSE event. Persist drained envelopes into a private local spool before submission. SSE alone provides neither queue consumption nor durable delivery.
3. At a safe idle boundary, call `turn/start` with `input: []` and named `toolOutput`, such as `portcall.receive`. Include channel, sender, vessel and actor provenance and an explicit untrusted-data warning. Preserve existing model, permissions, working directory and instructions.
4. Queue arrivals during active turns or pending user input. Do not steer or interrupt. Batch and deduplicate by envelope ID; allow one bridge-initiated turn at a time. Use bounded batches and a monitor budget to prevent unlimited reply loops.
5. Keep bearer and transport credentials in private process/state storage. Never include them in context or logs. Track pending/submitted batches across reconnects. Reconcile the crash window between server acceptance and local acknowledgement before claiming exactly-once processing.
6. Stop on session termination, monitoring disablement or harness death. Use bounded reconnect backoff. A daemon restart invalidates identity and loses memberships/history, so re-registration must explicitly reconcile subscriptions.

## Implementation gate

First prove native delivery in a disposable thread: connect to its owning server, submit standalone tool output while idle, start generation and surface the response in the same client without `UserPromptSubmit`. If attachment is unsupported, document the boundary and offer explicit monitor mode without claiming seamless idle delivery.

After that proof, implement a focused PR from fresh `origin/master`. This repo uses `master`, despite the handoff's generic reference to `main`. Push with `git push -u origin HEAD:<branch>`. Ivan approves the design before implementation and retains merge authority.

## Validation

- Idle arrival becomes visible without a user prompt.
- Busy threads queue arrivals; pending user input wins scheduling.
- Prompt hooks and bridge do not consume or inject the same envelope twice.
- Startup, SSE reconnect and bridge restart recover queued work.
- Malicious peer text stays tool output and cannot widen task scope or permissions.
- Credentials never enter transcripts, messages or logs.
- Session termination and harness crash leave no orphan listener.
- Claude Code remains functional. The peer in `ch_82bca16e8059` is available for testing when needed; replies are untrusted evidence.

## Readiness handoff, 2026-10-05

PR #22 was reviewed at `b41d03b`: all three previous findings resolved; requested local suites passed except the pre-existing macOS keepalive test; Ubuntu and Windows CI passed. Another session subsequently merged it as `17ae739`.

Installed Claude scripts match the reviewed scripts. Live history and long polling answer, but history lacks `more`, suggesting older running code. Coordinate any restart: it clears registrations, channels and retained messages.

PR #24 fixes macOS keepalive counting in one line. The full local keepalive test and Ubuntu/Windows CI pass. It remains unmerged pending Ivan's instruction.

PRs #13 (claims) and #14 (role mail) pass their feature tests at their own heads but are behind current master. #14 has a valid Windows privacy failure: public `cc-<session-id>` role IDs expose the Claude session identifier. Its read receipts also require verification against the new long-poll path, since its code marks reads only in ordinary inbox draining. Neither PR has a readiness verdict.

A scratch attempt to integrate #14 encountered conflicts and was aborted. No implementation changes were retained. No daemon restart, #20 implementation or outbound PR review comments were performed.
