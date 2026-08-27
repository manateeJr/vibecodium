# Vibecodium provider capability matrix

> Research note for [issue #2](https://github.com/manateeJr/vibecodium/issues/2). Documentation only; this does not define an implementation or promise cross-provider parity.

## 1. Scope, date, and evidence

**Scope.** Compare host-side integration surfaces for Claude Code/Agent SDK, Oh My Pi (OMP), and Codex CLI. The target is a provider-neutral adapter for Vibecodium's host-owned orchestration, immutable workflows, typed JSON Schema boundaries, explicit retries/failures/checkpoints, named execution runs, and separate workflow/session consoles. Raw terminal output is evidence, never the core contract.

**Research date.** 2026-08-27.

**Observed versions.**

| Surface | Observed version and confidence |
| --- | --- |
| Claude Agent SDK | npm `@anthropic-ai/claude-agent-sdk` `0.3.247`; its first-party registry metadata declares bundled Claude Code `2.1.247`. This is package metadata, not a local binary probe: [npm metadata](https://registry.npmjs.org/@anthropic-ai%2Fclaude-agent-sdk/latest). |
| OMP | Local `/home/stefanandonov/.local/bin/omp --version` reported `omp/17.3.5`. The `omp://` documents cited below are the installed documentation snapshot; upstream source is [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi). |
| Codex CLI | Local `/home/stefanandonov/.local/bin/codex --version` reported `codex-cli 0.146.0`. The `exec` claims are checked against the matching [rust-v0.146.0 source](https://github.com/openai/codex/tree/rust-v0.146.0/codex-rs); app-server claims are checked against the current [first-party app-server documentation](https://learn.chatgpt.com/docs/app-server.md) and [protocol-v2 source](https://github.com/openai/codex/tree/main/codex-rs/app-server-protocol/src/protocol/v2). These are intentionally treated as potentially skewed. |

**Primary sources used.**

- Claude: [CLI reference](https://code.claude.com/docs/en/cli-reference.md), [headless/non-interactive mode](https://code.claude.com/docs/en/headless.md), [TypeScript Agent SDK reference](https://code.claude.com/docs/en/agent-sdk/typescript.md), [sessions](https://code.claude.com/docs/en/agent-sdk/sessions.md), [user input and approvals](https://code.claude.com/docs/en/agent-sdk/user-input.md), [file checkpointing](https://code.claude.com/docs/en/agent-sdk/file-checkpointing.md), [artifacts](https://code.claude.com/docs/en/artifacts.md), [errors](https://code.claude.com/docs/en/errors.md), and the [dated package metadata](https://registry.npmjs.org/@anthropic-ai%2Fclaude-agent-sdk/latest).
- OMP: installed [RPC reference](omp://rpc.md), [SDK reference](omp://sdk.md), [session storage model](omp://session.md), [blob/artifact architecture](omp://blob-artifact-architecture.md), [skills](omp://skills.md), [settings](omp://settings.md), [approval modes](omp://approval-mode.md), and [shell/PTY/process primitives](omp://natives-shell-pty-process.md); first-party implementations [rpc-mode.ts](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/modes/rpc/rpc-mode.ts) and [sdk.ts](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/sdk.ts).
- Codex: [non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode.md), [app-server](https://learn.chatgpt.com/docs/app-server.md), [approvals and security](https://learn.chatgpt.com/docs/agent-approvals-security.md), [config basics](https://learn.chatgpt.com/docs/config-file/config-basic.md), [skills and plugins](https://learn.chatgpt.com/docs/skills-and-plugins.md), matching [exec CLI source](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/exec/src/cli.rs), [exec event types](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/exec/src/exec_events.rs), [shared CLI options](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/utils/cli/src/shared_options.rs), and current [app-server protocol-v2 source](https://github.com/openai/codex/tree/main/codex-rs/app-server-protocol/src/protocol/v2).

## 2. Side-by-side capability matrix

The matrix records what the cited surface exposes, not what every installation or account enables. “Yes” means a documented path exists; it does not mean identical semantics across providers.

| Capability | Claude Code / Agent SDK | OMP | Codex CLI |
| --- | --- | --- | --- |
| **Invocation and lifecycle** | `claude -p` is non-interactive and exits after the task; the TypeScript `query()` API returns an async message generator. [Headless](https://code.claude.com/docs/en/headless.md), [SDK](https://code.claude.com/docs/en/agent-sdk/typescript.md) | `omp -p/--print` is non-interactive; `--mode text\|json\|rpc\|rpc-ui` selects output/control surfaces. RPC starts with a `ready` frame; the in-process `createAgentSession()` SDK is the alternative. [RPC `Startup`](omp://rpc.md#Startup), [SDK](omp://sdk.md#Entry-points) | `codex exec` is the bounded non-interactive command. Its default is progress on stderr and final agent text on stdout; `--json` changes stdout to JSONL. App-server is a separate long-lived rich-client surface. [Non-interactive](https://learn.chatgpt.com/docs/non-interactive-mode.md), [app-server](https://learn.chatgpt.com/docs/app-server.md) |
| **Machine-readable streaming and events** | `--output-format stream-json` emits NDJSON; `--verbose --include-partial-messages` is required for token-level partial events. The stream includes initialization, assistant/user/tool events, and a terminal `result`; SDK `SDKMessage` and partial assistant messages are typed. [Headless streaming](https://code.claude.com/docs/en/headless.md#stream-responses), [SDK message types](https://code.claude.com/docs/en/agent-sdk/typescript.md#sdkmessage) | RPC stdout is framed NDJSON containing `ready`, correlated responses, session events, extension/host requests, and `message_update` deltas. `agent_end` is not necessarily final when `isTerminal: false`; SDK subscribers receive `AgentSessionEvent`. [RPC framing](omp://rpc.md#Transport-and-Framing), [RPC events](omp://rpc.md#Event-Stream-Schema), [SDK events](omp://sdk.md#Event-subscription-model) | `codex exec --json` emits `thread.started`, `turn.started/completed/failed`, `item.*`, and `error` JSONL events. App-server uses bidirectional JSON-RPC-like notifications such as `turn/*`, `item/*`, deltas, diffs, usage, and errors. [Non-interactive JSONL](https://learn.chatgpt.com/docs/non-interactive-mode.md#make-output-machine-readable), [tagged event enum](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/exec/src/exec_events.rs), [app-server lifecycle](https://learn.chatgpt.com/docs/app-server.md#lifecycle-overview) |
| **Session identity and resume** | Session IDs are UUIDs. `continue` chooses the most recent conversation; `resume` chooses a specific ID; `fork` creates a new conversation history. Sessions persist conversation history, not filesystem state, by default in local JSONL; `SessionStore` is the documented route for shared storage. [Sessions](https://code.claude.com/docs/en/agent-sdk/sessions.md), [storage](https://code.claude.com/docs/en/agent-sdk/session-storage.md) | OMP distinguishes its local session ID/file from provider-session IDs and prompt-cache keys. Installed RPC docs describe `--resume`, `--continue`, `branch`, `new_session`, `switch_session`, and `provider-session-id`; default files are under `~/.omp/agent/sessions/<encoded-cwd>`. File-backed SDK sessions can resume/fork; in-memory sessions cannot file-resume. [RPC session commands](omp://rpc.md#Command-Schema), [session layout/tree](omp://session.md#On-Disk-Layout), [SDK persistence](omp://sdk.md#Session-manager-behavior-persistent-vs-in-memory) | `codex exec resume --last` or `codex exec resume <SESSION_ID>` continues a recorded exec session. App-server separates a thread ID from `thread.sessionId`; `thread/start`, `thread/resume`, and `thread/fork` are explicit. [Exec resume](https://learn.chatgpt.com/docs/non-interactive-mode.md#resume-a-non-interactive-session), [app-server thread identity](https://learn.chatgpt.com/docs/app-server.md#threadstart-threadresume-and-threadfork) |
| **Human input, stdin, and control** | CLI accepts a prompt argument or piped stdin (piped input is capped at 10 MB). SDK streaming input accepts an `AsyncIterable<SDKUserMessage>` and supports queued messages; `canUseTool` surfaces tool approvals and `AskUserQuestion` requests. [Headless stdin](https://code.claude.com/docs/en/headless.md#pipe-data-through-claude), [SDK `query`](https://code.claude.com/docs/en/agent-sdk/typescript.md#query), [user input](https://code.claude.com/docs/en/agent-sdk/user-input.md) | RPC accepts `prompt`, `steer`, and `follow_up`, with explicit steering/follow-up/interrupt queue modes. Extension UI, host-tool, and host-URI request/response frames provide typed host interaction. SDK exposes `prompt`, `sendUserMessage`, `steer`, and `followUp`. PTY `write` is a separate primitive, not an implicit RPC stdin channel. [RPC commands](omp://rpc.md#Command-Schema), [host sub-protocols](omp://rpc.md#Host-Tool-Sub-Protocol), [PTY API](omp://natives-shell-pty-process.md#PTY-subsystem), [SDK prompt lifecycle](omp://sdk.md#Prompt-lifecycle) | Exec takes an argument and/or stdin as initial prompt/context; it is intentionally bounded rather than a live turn-control protocol. App-server `turn/steer` appends input to an active turn; approval and user-input requests are server-initiated JSON-RPC requests. Experimental process/command APIs expose stdin writes and PTY resize. [Exec input](https://learn.chatgpt.com/docs/non-interactive-mode.md#when-to-use-codex-exec), [app-server steering](https://learn.chatgpt.com/docs/app-server.md#turnsteer), [app-server process control](https://learn.chatgpt.com/docs/app-server.md#process-control) |
| **Cancellation and interruption** | SDK `AbortController`, streaming-only `query.interrupt()`, and `close()` are documented. CLI SIGINT ends the turn; SIGTERM exits 143, records no result for the unfinished turn, and leaves it resumable. [SDK controls](https://code.claude.com/docs/en/agent-sdk/typescript.md#query-object), [SIGTERM behavior](https://code.claude.com/docs/en/headless.md#stop-a-run-with-sigterm) | RPC `abort`, `abort_and_prompt`, and `abort_bash`; SDK `abort()`; EOF rejects pending extension/host requests and disposes the process. Native PTY has `kill()` and structured `cancelled`/`timedOut` results. [RPC commands/EOF](omp://rpc.md#Startup), [SDK lifecycle](omp://sdk.md#AgentSession-lifecycle-and-disposal), [PTY cancellation](omp://natives-shell-pty-process.md#Cancellation-and-timeout-semantics) | Ctrl-C interrupts the CLI process; failed/interrupted exec turns are non-success. App-server `turn/interrupt` ends a turn with `status: interrupted`; `command/exec/terminate` and experimental `process/kill` control child processes. [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode.md), [app-server controls](https://learn.chatgpt.com/docs/app-server.md#core-primitives) |
| **Permissions and sandbox** | Permission modes include default, `acceptEdits`, and `bypassPermissions`; allowed/denied tools and a `canUseTool` callback govern tool approvals. Claude's documented controls are not a claim of an OS-level sandbox equivalent to Codex. [CLI flags](https://code.claude.com/docs/en/cli-reference.md#cli-flags), [permission callback](https://code.claude.com/docs/en/agent-sdk/user-input.md#handle-tool-approval-requests) | Installed OMP approval modes are `always-ask`, `write`, and `yolo`, with per-tool policy and safety overrides. Shell/PTY access is a separate native capability with its own cancellation and process-group behavior. [Approval modes](omp://approval-mode.md#Modes), [shell/PTY](omp://natives-shell-pty-process.md#Shell-subsystem) | `read-only`, `workspace-write`, and `danger-full-access` sandbox modes combine with approval policies; local defaults have network access off. `--sandbox` and `--ask-for-approval`/`--yolo` are explicit controls. [Approvals and security](https://learn.chatgpt.com/docs/agent-approvals-security.md#sandbox-and-approvals), [exec guidance](https://learn.chatgpt.com/docs/non-interactive-mode.md#permissions-and-safety), [tagged flags](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/utils/cli/src/shared_options.rs) |
| **Model, mode, skills, and context** | CLI/SDK expose model, effort, max turns, client-side max budget, settings, working/additional directories, tools, MCP, and skills. `system/init` reports model, tools, MCP, skills/plugins, and capabilities when supported. [Headless options](https://code.claude.com/docs/en/headless.md#auto-approve-tools), [SDK options](https://code.claude.com/docs/en/agent-sdk/typescript.md#options), [init metadata](https://code.claude.com/docs/en/headless.md#read-session-metadata) | RPC has `set_model`, `set_thinking_level`, queue/compaction controls, and state inspection. Skills are discovered from configured roots and injected as prompt capability; `--skills`/`--no-skills` and explicit include/ignore settings exist. [RPC model/thinking](omp://rpc.md#Command-Schema), [skills](omp://skills.md#Source-toggles-and-filtering), [settings/models](omp://settings.md#Models) | CLI supports model, profile, sandbox, approval, `--cd`, `--add-dir`, config overrides, and reasoning effort. App-server `turn/start` can override model, effort, personality, cwd, sandbox, and output schema. Skills are reusable instruction packs invoked with `$name` and can be sent as `skill` input items. [Config](https://learn.chatgpt.com/docs/config-file/config-basic.md), [app-server turn](https://learn.chatgpt.com/docs/app-server.md#start-a-turn), [skills](https://learn.chatgpt.com/docs/skills-and-plugins.md) |
| **Artifacts, files, and diffs** | File checkpointing tracks Write/Edit/NotebookEdit changes and can rewind them; Bash edits and subagent edits are explicitly not tracked. Artifacts publish a self-contained HTML/Markdown page to a private/shareable claude.ai URL, subject to account/plan/version limits; this is not a generic workspace diff contract. [Checkpointing](https://code.claude.com/docs/en/agent-sdk/file-checkpointing.md), [artifact limits](https://code.claude.com/docs/en/artifacts.md#what-an-artifact-is-not) | Session-local `artifact://` files preserve spilled tool output and `agent://` files preserve subagent output; content-addressed `blob:sha256:` refs externalize large images. The session model persists messages/state, while workspace edits remain provider tool effects. [Blob/artifact architecture](omp://blob-artifact-architecture.md#Why-two-storage-systems-exist), [session persistence](omp://session.md#Persistence-Guarantees-and-Failure-Model) | Tagged exec events expose `file_change` items with path/kind/status; app-server exposes `fileChange` items with change diffs and `turn/diff/updated`. `command/exec` can return/stream command output, while process output is experimental. [Exec file item](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/exec/src/exec_events.rs), [app-server filesystem/diff](https://learn.chatgpt.com/docs/app-server.md#filesystem), [app-server items](https://learn.chatgpt.com/docs/app-server.md#items) |
| **Usage and cost** | JSON/result and SDK result messages expose usage, estimated cost, `total_cost_usd`, and per-model usage. Claude documents these as client-side estimates; streaming-input results are cumulative across turns for `modelUsage`. [Cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking), [result fields](https://code.claude.com/docs/en/agent-sdk/typescript.md#sdkresultmessage), [headless JSON](https://code.claude.com/docs/en/headless.md#get-structured-output) | RPC state can expose context usage and throughput; session stats/export and SDK message usage exist, and advisor usage is separate from primary usage. The installed contract does not make a portable USD-cost shape a provider guarantee. [RPC state](omp://rpc.md#get_state-payload), [session stats](omp://rpc.md#Command-Schema), [advisor usage](omp://advisor-watchdog.md#Cost-and-context-behavior) | Exec `turn.completed` includes token usage fields (input, cached input, cache write when present, output, reasoning output). App-server has `thread/tokenUsage/updated` and turn usage fields; accounting details remain runtime/provider-specific. [Tagged usage type](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/exec/src/exec_events.rs), [app-server notifications](https://learn.chatgpt.com/docs/app-server.md#warning-events) |
| **Errors and terminal outcomes** | A result can carry `is_error`, subtype, errors, duration, usage, and session ID. Process/connection failures can throw or produce no result; callers must treat a missing terminal result as a transport/process failure, not success. [Sessions and no-result caveat](https://code.claude.com/docs/en/agent-sdk/sessions.md#capture-the-session-id), [errors](https://code.claude.com/docs/en/errors.md) | RPC failures are `{success:false,error,code?}`; malformed JSON is a recoverable parse failure; pending requests are rejected on EOF. Session events include extension errors; shell/PTY results distinguish exit, timeout, cancellation, and failures. [RPC response/error model](omp://rpc.md#Response-Schema), [recoverability](omp://rpc.md#Error-Model-and-Recoverability), [PTY failures](omp://natives-shell-pty-process.md#Failure-behavior) | Exec has `turn.failed` and stream-level `error` events plus non-zero process status. App-server responses use JSON-RPC error objects; failed turns carry typed error details and known classes such as context, usage, HTTP, stream, sandbox, and internal failures. [Tagged errors](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/exec/src/exec_events.rs), [app-server errors](https://learn.chatgpt.com/docs/app-server.md#errors) |
| **Version and experimental caveats** | SDK releases track the bundled Claude Code version; capability arrays are open-set and should be feature-detected rather than version-compared. Features such as interrupt receipts and some fields are explicitly version-gated. [SDK installation/versioning](https://code.claude.com/docs/en/agent-sdk/typescript.md#installation), [capabilities](https://code.claude.com/docs/en/agent-sdk/typescript.md#sdksystemmessage) | `omp://` references describe installed OMP `17.3.5`, not a universal upstream stability promise. RPC advertises protocol versions and frame limits; v2 negotiation/chunking and local helper behavior must be probed/handled. SDK and RPC are different integration choices; PTY is separate. [RPC negotiation](omp://rpc.md#Transport-and-Framing), [SDK boundary](omp://sdk.md#If-you-need-cross-languageprocess-isolation-use-rpc-mode-instead) | Local exec is `0.146.0`, while current app-server docs/protocol source can move independently. App-server WebSocket, `process/*`, and some methods/fields are explicitly experimental; generated schemas are specific to the runtime that produced them. [App-server transports](https://learn.chatgpt.com/docs/app-server.md#protocol), [experimental opt-in](https://learn.chatgpt.com/docs/app-server.md#experimental-api-opt-in), [generated schemas](https://learn.chatgpt.com/docs/app-server.md#message-schema) |

## 3. Normalized `ExecutionProvider` contract

This is a proposed Vibecodium boundary. It deliberately describes capability negotiation and typed events rather than pretending that the provider protocols are isomorphic.

### 3.1 Provider and execution lifecycle

```ts
type ExecutionProvider = {
  descriptor(): Promise<ProviderDescriptor>;
  start(request: StartExecution): Promise<ExecutionHandle>;
  resume(request: ResumeExecution): Promise<ExecutionHandle>;
};

type ExecutionHandle = {
  ref: ProviderSessionRef;
  events: AsyncIterable<ExecutionEvent>;
  send(input: ExecutionInput): Promise<void>;
  control(control: ExecutionControl): Promise<void>;
  cancel(reason?: CancelReason): Promise<void>;
  close(): Promise<void>;
};
```

1. **Preflight.** Validate the `ExecutionProfile`, workspace policy, output schema, and required capabilities before starting a provider process/session. Security-sensitive fields (sandbox, approval, workspace roots, network) fail closed when unsupported.
2. **Start/resume.** Allocate a Vibecodium `executionRunId`, retain the provider's native identity in `ProviderSessionRef`, and emit exactly one normalized `run.started` event once the provider handshake succeeds. `resume` must say whether it resumed, forked, or started fresh; never infer identity from text.
3. **Stream.** Normalize provider frames into an append-only, sequence-numbered event stream. Preserve provider-native payloads only as optional diagnostics, never as the required UI/workflow contract.
4. **Terminal.** Emit exactly one terminal `run.completed`, `run.failed`, `run.cancelled`, or `run.transport_lost` outcome. `transport_lost` is not provider success and must include whether a resume recipe/ref is available. A provider that acknowledges a prompt before work completes (as OMP RPC does) must not be treated as complete until its terminal lifecycle event.
5. **Close.** `close()` is idempotent and drains/terminates owned transports and child processes. Persist the last known ref and terminal state before releasing the handle.

### 3.2 Event envelope and event vocabulary

Every event should carry:

```ts
type ExecutionEvent = {
  schemaVersion: 1;
  provider: string;
  providerVersion?: string;
  executionRunId: string;
  providerSessionRef: ProviderSessionRef;
  sequence: number;
  occurredAt: string;
  type:
    | "run.started" | "run.progress" | "run.completed"
    | "run.failed" | "run.cancelled" | "run.transport_lost"
    | "text.delta" | "reasoning.delta"
    | "tool.started" | "tool.progress" | "tool.completed"
    | "approval.requested" | "input.requested"
    | "file.change" | "diff.updated"
    | "artifact.created" | "usage.updated" | "warning" | "error";
  payload: unknown;
};
```

Adapters should map only events the provider actually exposes. For example, Codex app-server has explicit file/diff and approval notifications, while Claude checkpointing is a rewind facility rather than a diff stream. Unknown provider event kinds can be retained in a diagnostic side channel, but must not break the normalized stream.

### 3.3 Input and control

`ExecutionInput` should distinguish `user_message` (text, images, structured attachments), `steer`, `follow_up`, `approval_response`, `stdin`, `resize`, and provider-host callbacks. `ExecutionControl` should distinguish `interrupt`, `cancel`, `set_model`, `set_reasoning`, `set_queue_policy`, and `compact`.

- `steer`, `follow_up`, approval responses, stdin, and resize are capability-gated. A provider that lacks one must return `unsupported_capability`, not silently append the value to a prompt.
- Approval requests are first-class events with stable request IDs, action details, deadline, and allowed decisions. A denial is a typed policy outcome, not a transport error.
- `stdin` means a real provider/process input channel. Initial prompt piping does not satisfy live stdin/control.
- The host owns retry policy and idempotency keys. Adapters must not replay a non-idempotent control without an explicit provider acknowledgment.

### 3.4 `ProviderSessionRef` and resume recipe

```ts
type ProviderSessionRef = {
  provider: string;
  providerVersion?: string;
  nativeSessionId?: string;
  nativeThreadId?: string;
  nativeTurnId?: string;
  localSessionId?: string;
  sessionFile?: string;
  cwd?: string;
  workspaceFingerprint?: string;
  profileFingerprint?: string;
  resumeRecipe: {
    kind: "claude-cli" | "claude-sdk" | "omp" | "codex-exec" | "codex-app-server";
    argsOrMethod: string[];
    envKeys?: string[];
    humanSummary: string;
  };
};
```

Keep local and provider IDs separate. Examples of recipes are `claude --resume <id>`, `omp --resume <id>`, `codex exec resume <id>`, or an app-server `thread/resume` request. Recipes must never include API keys or bearer tokens. A ref records the workspace/profile assumptions required for safe resume; a resume that cannot prove those assumptions must fail or require an explicit operator decision.

### 3.5 Cancellation, artifacts, workspace results, and failures

- Cancellation is best-effort and idempotent. Record request time, provider acknowledgment (if any), and final classification: interrupted, cancelled-before-start, timeout, or transport loss.
- `ArtifactRef` is provider-neutral metadata (`kind`, `uri/path`, media type, size/hash, retention, sensitivity), not a promise that every provider supplies a hosted URL. OMP `artifact://`, Claude claude.ai artifacts, and Codex local files remain provider-specific refs.
- `WorkspaceChange` is `{path, kind, patch?, baseHash?, resultHash?}`. `patch` is optional because not every surface emits it. A checkpoint/rewind operation is not itself a diff.
- Typed failure categories should include `invalid_request`, `unsupported_capability`, `auth`, `policy_denied`, `model_unavailable`, `rate_limited`, `context_exceeded`, `tool_failed`, `workspace_failed`, `timeout`, `cancelled`, `transport`, `protocol`, and `internal`, with provider code/status/detail attached when available.

### 3.6 Capability negotiation and versioning

`ProviderDescriptor` should advertise provider name/version, adapter version, wire/protocol version, supported event/input/control kinds, persistence/resume, approvals, sandbox/network model, PTY, artifacts, file/diff, usage, skills, output schema, and limits. Negotiate before `start` and record the result in `run.started`.

The adapter must reject a required unsupported field with a structured error naming the field, capability, provider version, and safe alternatives. Optional degradation is allowed only when the request explicitly opts into it and the adapter emits a `warning`/`capability_degraded` event. Never silently stuff unsupported fields into a system prompt, ignore a sandbox request, downgrade approval, or pretend a CLI final string is a streamed event.

## 4. `ExecutionProfile` proposal

A profile is declarative policy, not a bag of provider CLI flags. Provider-specific extras should be namespaced and validated by the adapter.

```ts
type ExecutionProfile = {
  provider: "claude-code" | "omp" | "codex";
  model?: string;
  mode?: "sdk" | "rpc" | "exec-json" | "app-server" | "interactive";
  reasoning?: { level?: string; maxTokens?: number };
  thinking?: { level?: string; budgetTokens?: number; visible?: boolean };
  skills?: {
    bundleId?: string;
    names: string[];
    source?: "project" | "user" | "managed" | "inline";
    required?: boolean;
  };
  context?: {
    cwd: string;
    additionalDirs?: string[];
    rules?: string[];
    mcp?: string[];
    promptAdditions?: string[];
  };
  budget?: {
    maxTurns?: number;
    maxTokens?: number;
    maxCostUsd?: number;
  };
  latency?: {
    deadlineMs?: number;
    firstEventDeadlineMs?: number;
    idleTimeoutMs?: number;
  };
  sandbox?: {
    kind: "none" | "read-only" | "workspace-write" | "isolated" | "danger-full-access";
    writableRoots?: string[];
    network?: "off" | "restricted" | "on";
  };
  approval?: {
    mode: "manual" | "on-request" | "accept-edits" | "auto" | "yolo";
    toolRules?: Record<string, "allow" | "deny" | "prompt">;
    reviewer?: "user" | "provider" | "auto";
  };
  autonomy?: "manual" | "bounded" | "delegating" | "unattended";
  workspace?: {
    root: string;
    isolation?: "shared" | "worktree" | "container";
    persistSession?: boolean;
  };
  outputSchema?: object;
  featureFlags?: Record<string, boolean | string | number>;
  unsupportedFieldPolicy?: "reject" | "explicit-degrade";
};
```

### OMP Advisor modes and skill bundles

OMP's `/full` and `/budget` labels must be represented as **orchestration policy metadata**, not passed as if they were universal provider model modes:

```yaml
orchestration:
  advisorMode: full       # or budget
  skillBundle: vibecodium-advisor
```

For this installed harness, `/full` selects the local `orchestrator` agent definition with `anthropic/claude-opus-5` ([`/home/stefanandonov/.omp/agent/agents/orchestrator.md`, frontmatter lines 1-14]); `/budget` selects `orchestrator-budget` with `openai-codex/gpt-5.6-luna:max` and forbids Opus-pinned workers ([`/home/stefanandonov/.omp/agent/agents/orchestrator-budget.md`, frontmatter lines 1-14 and budget rule]). These are local harness routing decisions, not an OMP RPC protocol guarantee. The profile should therefore retain `advisorMode`, selected model/worker policy, and skill bundle provenance so another operator can reproduce or explicitly reject it.

For OMP-native skills, `skills.names` maps to discovered skill names and `--skills`/`--no-skills` or SDK/session settings. For Claude, names map to SDK `skills` or project/user skill discovery. For Codex, names map to `$skill` text plus a `skill` input item and `skills/list`. A bundle should record exact names and source/version, not just a free-form prompt.

### Unsupported-field behavior

1. `unsupportedFieldPolicy: reject` is the default for security, identity, workspace, approval, sandbox, persistence, output-schema, and cancellation semantics. Fail preflight with `unsupported_field` and do not start the provider.
2. `explicit-degrade` is opt-in for presentation-only fields (for example, hiding reasoning when the provider cannot expose reasoning). Emit the omitted field and a degradation event in the run log.
3. Never silently ignore a selected model, budget, sandbox, approval mode, skill, workspace root, or output schema. If an adapter must choose a fallback model/provider, require an explicit fallback chain and emit `model_fallback_applied` with the reason.
4. Provider-specific fields belong under `extensions.<provider>` and are rejected by other adapters. This keeps the normalized profile stable while allowing OMP queue modes, Claude setting overrides, or Codex collaboration/app-server options.

## 5. Honest parity gaps and open questions

- **Streaming is not equivalent.** Claude SDK and OMP RPC/SDK offer persistent streams/control. Codex `exec --json` is a bounded JSONL job; Codex app-server is richer but has explicitly experimental/version-sensitive portions. A common event envelope must preserve “unsupported” and “transport lost” states.
- **Input semantics differ.** Claude approvals are SDK callbacks, OMP can emit extension/host requests, and Codex app-server uses server-initiated JSON-RPC requests. There is no safe universal assumption that `steer`, approval, or stdin exists.
- **Session semantics differ.** Claude sessions are conversation history; OMP has local session files plus provider IDs; Codex distinguishes exec sessions and app-server threads/session roots. Cross-machine resume requires provider-specific storage/credentials and is not portable by ID alone.
- **Security boundaries differ.** Codex documents OS-enforced sandbox modes and network policy. OMP approval/yolo and native shell/PTY controls are not the same thing. Claude permission modes should not be marketed as an equivalent OS sandbox. Vibecodium must enforce its own workspace and secret boundary before invoking any adapter.
- **File results differ.** Codex app-server has explicit file-change/diff events; Claude checkpointing tracks only selected tool edits and its hosted artifacts are not a generic diff; OMP artifacts primarily preserve output/subagent content. Workspace snapshots/diffs therefore remain optional normalized data.
- **Usage differs.** Claude cost is a client-side estimate; Codex exposes token usage; OMP exposes state/stats and provider-native usage but does not establish one portable cost shape. Billing/cost fields must be optional and provenance-tagged.
- **PTY/process control differs.** OMP exposes native PTY separately. Codex app-server process/command controls include experimental surfaces. The Claude sources checked here do not define a provider-neutral PTY contract for the Agent SDK.
- **Version skew is material.** This note combines Claude SDK metadata `0.3.247`, OMP `17.3.5`, Codex exec `0.146.0`, and moving Codex app-server documentation/source. Adapters must pin binaries, negotiate capabilities, and capture exact versions in every run.

Open questions to resolve before implementation:

1. Which OMP protocol version and client library will Vibecodium pin, and will the host support the advertised v2 chunking path as well as v1 fallback?
2. Does Vibecodium require cross-host Claude resume, and if so, what `SessionStore` implementation and encryption/retention policy will host it?
3. Which Codex app-server release is approved for production, and which methods may be used only behind an experimental feature flag? Generate and pin schemas from that exact binary.
4. Does the workflow engine require provider-native file diffs, or is a host-side workspace diff/checkpoint sufficient when a provider exposes only file operations?
5. What is the operator policy when a requested profile asks for a stronger sandbox/approval/autonomy mode than a provider can enforce? The safe default is reject, not downgrade.
6. Which artifacts may leave the host? Claude claude.ai artifacts, OMP local artifact URLs, and Codex local files have different retention and sharing boundaries; a host-owned artifact store may be required.

## 6. Recommended adapter architecture

### Shared host layer

Implement one host-owned `ExecutionProvider` façade and a per-provider adapter. The host should own credentials, process supervision, workspace isolation, event persistence, retry/idempotency, and conversion to React Native console events. Store normalized events plus `ProviderSessionRef`; optionally retain raw frames in a bounded, access-controlled diagnostic store. Keep WorkflowControl (durable state machine) separate from linked SessionConsole (provider transcript/control).

### Claude adapter

- **Preferred persistent path:** TypeScript Agent SDK `query()` with streaming input. Use its typed async generator, `canUseTool`, `AbortController`, `interrupt`, `setPermissionMode`, `setModel`, `applyFlagSettings`, and `streamInput` where the negotiated SDK/CLI capabilities support them. [SDK controls](https://code.claude.com/docs/en/agent-sdk/typescript.md#query-object), [user input](https://code.claude.com/docs/en/agent-sdk/user-input.md).
- **Simple/fallback path:** spawn `claude -p --output-format stream-json` for bounded jobs or when the host cannot embed the SDK. Require `--verbose --include-partial-messages` only when partial events are needed; capture the terminal `result` and process exit separately. [Headless mode](https://code.claude.com/docs/en/headless.md#stream-responses).
- Persist `session_id` and a `--resume`/SDK recipe. Treat filesystem checkpointing as an optional rewind feature, not a generic diff feed. Treat claude.ai artifacts as provider-hosted presentation artifacts with their own policy, not Vibecodium workspace results.

### OMP adapter

- **Preferred same-process path:** use the installed `@oh-my-pi/pi-coding-agent` SDK when Vibecodium's host is Bun and trusts the provider process. It provides direct subscription, prompt/steer/follow-up/abort, tool wiring, and explicit session manager choice. [OMP SDK](omp://sdk.md).
- **Preferred isolated/cross-language path:** use `omp --mode rpc`; consume the `ready` handshake, negotiate protocol v2 when advertised, enforce frame/reassembly limits, correlate every response by ID, and wait for `agent_end` with `isTerminal !== false` before declaring completion. [OMP RPC](omp://rpc.md#Transport-and-Framing), [completion semantics](omp://rpc.md#Immediate-ack-vs-completion).
- Use `--mode json` or print mode only for simple bounded output where bidirectional control is unnecessary. Keep PTY as a separately negotiated capability; do not infer PTY from RPC or no-PTY flags. Map OMP local session IDs, provider-session IDs, blobs, artifacts, and skill bundles into separate fields.
- Treat `/full` and `/budget` as Vibecodium host orchestration metadata when this local advisor routing is desired; do not claim that another OMP installation has the same models or agent definitions.

### Codex adapter

- **Rich console path:** use `codex app-server` for bidirectional threads/turns, steering, approvals, file changes/diffs, usage, and (where explicitly enabled) command/PTY/process control. Perform `initialize`/`initialized`, pin the exact binary, advertise `experimentalApi` only when approved, and generate schemas from that binary. [App-server lifecycle](https://learn.chatgpt.com/docs/app-server.md#lifecycle-overview), [experimental API](https://learn.chatgpt.com/docs/app-server.md#experimental-api-opt-in).
- **Bounded job path:** use `codex exec --json` for one-shot or resumable jobs, CI-style workflows, and structured final output. Consume JSONL events, stderr, exit code, and `--output-schema`; use `codex exec resume` with the recorded session ID when needed. Do not parse the default human stdout as a protocol. [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode.md).
- Do not present `exec --json` and app-server as equivalent: only the latter supplies the documented bidirectional approval/steering and rich file/diff protocol, while its experimental portions require explicit version/feature gating.

This architecture lets Vibecodium expose one typed, capability-negotiated surface while remaining honest about provider-specific control, persistence, security, artifacts, and version behavior.
