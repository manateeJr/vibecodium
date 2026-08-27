# Vibecodium AFK host supervision — conceptual research note

**Ticket:** AFK host-supervision #8
**Validation date:** 2026-08-27
**Status:** source-backed baseline and open decisions; conceptual only

> **How to read this note.** **Fact** means behavior stated by a linked first-party source. **Recommendation** means a proposed Vibecodium design choice, not an existing implementation. **Caveat** marks a boundary, version-sensitive behavior, or an unresolved authority decision. A successful process restart, provider response, push response, or telemetry record is not an exactly-once guarantee for an external side effect.

## 1. Scope, assumptions, and primary sources

This note is for a **single-operator, self-hosted, always-on private host**. It deliberately does not prescribe a rollout, dependency, credential, production infrastructure, or deployment procedure.

The assumed architecture is:

- The host control plane owns workflows, typed/replayable workflow and session semantics, admission and policy, provider adapters, host-held provider secrets, push hints, and a durable ordered event/segment store.
- The store supports monotonic sequences, snapshots, cursor replay, and catch-up. Provider output and provider/notification delivery are observations, not canonical truth.
- The React Native (RN) app connects over a private overlay and pairs separately at the application layer. It keeps a cursor, reconnects, and catches up from the host.
- A push is an opaque attention hint. It is not state transfer, an acknowledgement, a cursor advance, or a delivery guarantee.
- There is one operator and no assumed public API. Current host OS, filesystem, runtime, provider SDK, database, concurrency, backup target, and deployed network are **unknown** until a later authority decision.

### Primary sources consulted

The links below are direct first-party documentation or first-party release/source pages. Rolling pages and observed versions are not treated as permanent contracts.

**Host lifecycle, isolation, and resources**

- [systemd.service](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html), [systemd.unit](https://www.freedesktop.org/software/systemd/man/latest/systemd.unit.html), [systemd.kill](https://www.freedesktop.org/software/systemd/man/latest/systemd.kill.html), and [sd_notify](https://www.freedesktop.org/software/systemd/man/latest/sd_notify.html)
- [systemd.exec](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html), [systemd.resource-control](https://www.freedesktop.org/software/systemd/man/latest/systemd.resource-control.html), [user@.service](https://www.freedesktop.org/software/systemd/man/latest/user@.service.html), and [loginctl](https://www.freedesktop.org/software/systemd/man/latest/loginctl.html)
- [systemd journal fields](https://www.freedesktop.org/software/systemd/man/latest/systemd.journal-fields.html), [journald.conf](https://www.freedesktop.org/software/systemd/man/latest/journald.conf.html), [coredump.conf](https://www.freedesktop.org/software/systemd/man/latest/coredump.conf.html), and [systemd-analyze](https://www.freedesktop.org/software/systemd/man/latest/systemd-analyze.html)

**Process/container alternatives**

- Podman [Quadlet](https://docs.podman.io/en/latest/markdown/podman-systemd.unit.5.html) and [auto-update](https://docs.podman.io/en/latest/markdown/podman-auto-update.1.html)
- Docker [Compose startup order](https://docs.docker.com/compose/how-tos/startup-order/) and [Compose services](https://docs.docker.com/reference/compose-file/services/)
- Supervisor [configuration](https://supervisord.org/configuration.html) and [running/control server](https://supervisord.org/running.html)

**Private connectivity and front doors**

- Tailscale [access control](https://tailscale.com/docs/features/access-control), [auth keys](https://tailscale.com/docs/features/access-control/auth-keys), [device approval](https://tailscale.com/docs/features/access-control/device-management/device-approval), [encryption](https://tailscale.com/docs/concepts/tailscale-encryption), [coordination outage](https://tailscale.com/docs/reference/coordination-server-down), [Serve](https://tailscale.com/docs/reference/tailscale-cli/serve), and [connection types](https://tailscale.com/docs/reference/connection-types)
- Headscale [registration](https://headscale.net/stable/ref/registration/), [OIDC](https://headscale.net/stable/ref/oidc/), [policy](https://headscale.net/stable/ref/policy/), [requirements](https://headscale.net/stable/setup/requirements/), and [reverse proxy integration](https://headscale.net/stable/ref/integration/reverse-proxy/)
- WireGuard [conceptual overview](https://www.wireguard.com/#conceptual-overview), [quick start](https://www.wireguard.com/quickstart/), and [wg(8)](https://git.zx2c4.com/wireguard-tools/about/src/man/wg.8)
- Caddy [automatic HTTPS](https://caddyserver.com/docs/automatic-https) and [reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)
- Cloudflare [Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/), [service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/), [Mesh](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-mesh/), and OpenBSD [ssh reverse forwarding](https://man.openbsd.org/ssh#R)

**Push**

- Apple [token-based APNs connection](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns), [sending requests](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns), [device registration](https://developer.apple.com/documentation/usernotifications/registering-your-app-with-apns), [remote-notification generation](https://developer.apple.com/documentation/usernotifications/generating-a-remote-notification), [responses](https://developer.apple.com/documentation/usernotifications/handling-notification-responses-from-apns), and [permission](https://developer.apple.com/documentation/usernotifications/asking-permission-to-use-notifications)
- Firebase [FCM HTTP v1](https://firebase.google.com/docs/cloud-messaging/send/v1-api), [token management](https://firebase.google.com/docs/cloud-messaging/manage-tokens), [message types](https://firebase.google.com/docs/cloud-messaging/customize-messages/set-message-type), [message lifespan](https://firebase.google.com/docs/cloud-messaging/customize-messages/setting-message-lifespan.md.txt), [error codes](https://firebase.google.com/docs/cloud-messaging/error-codes.md.txt), and [delivery understanding](https://firebase.google.com/docs/cloud-messaging/understand-delivery.md.txt)

**Observability and provider limits**

- OpenTelemetry [specification v1.60.0 release](https://github.com/open-telemetry/opentelemetry-specification/releases/tag/v1.60.0), [Collector v0.159.0 release](https://github.com/open-telemetry/opentelemetry-collector/releases/tag/v0.159.0), [exporter queues/retry](https://raw.githubusercontent.com/open-telemetry/opentelemetry-collector/v0.159.0/exporter/exporterhelper/README.md), [memory limiter](https://raw.githubusercontent.com/open-telemetry/opentelemetry-collector/v0.159.0/processor/memorylimiterprocessor/README.md), [batch processor](https://raw.githubusercontent.com/open-telemetry/opentelemetry-collector/v0.159.0/processor/batchprocessor/README.md), and [security configuration](https://opentelemetry.io/docs/security/config-best-practices/)
- Anthropic [rate limits and spend limits](https://platform.claude.com/docs/en/api/rate-limits) and [errors](https://platform.claude.com/docs/en/api/errors)
- OpenAI [rate limits](https://developers.openai.com/api/docs/guides/rate-limits) and [spend limits](https://developers.openai.com/api/docs/guides/spend-limits)

### Version and source caveats

The systemd `latest` pages fetched for this note identify systemd **261.2**. The Headscale stable site identifies **0.29.3**. The cited OpenTelemetry release pages identify specification **v1.60.0** and Collector **v0.159.0**. Tailscale, Apple, Firebase, Anthropic, OpenAI, and Cloudflare pages are rolling documentation. Re-check selected versions, account limits, platform behavior, and provider contracts when implementation authority is granted. Numeric quotas and prices are intentionally not used as architecture constants.

## 2. Evidence matrix

| Area | Source-backed facts | Implication for Vibecodium |
| --- | --- | --- |
| **Host supervision** | **Fact:** systemd distinguishes process setup from application readiness. `Type=exec` waits until `execve()` succeeds; `Type=notify` lets service code announce `READY=1`; `WatchdogSec=` uses recurring `WATCHDOG=1` notifications. The service page recommends `Restart=on-failure` for long-running services, and start-rate limiting bounds restart storms. `Requires=`/`Wants=` express dependency strength, not ordering; `After=`/`Before=` order jobs, and `BindsTo=` with `After=` can react to a dependency disappearing. ([systemd.service](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html), [systemd.unit](https://www.freedesktop.org/software/systemd/man/latest/systemd.unit.html), [sd_notify](https://www.freedesktop.org/software/systemd/man/latest/sd_notify.html)) | **Recommendation:** one host lifecycle owner should supervise the control plane. Readiness should be announced only after store/schema recovery and the private listener are usable; liveness should describe a responsive control loop, not mere process existence. Provider/push degradation should be represented separately. **Caveat:** `Type=notify` requires application support and does not prove provider success. |
| **Termination, credentials, and resources** | **Fact:** systemd's documented default `KillMode=control-group` tracks the service process group; stop handling can send the configured termination signal and then force termination after `TimeoutStopSec=`. cgroup controls include `MemoryHigh=` (throttling/reclaim), `MemoryMax=` (last-resort ceiling), `TasksMax=`, CPU, and I/O controls. `LoadCredential=` and `LoadCredentialEncrypted=` expose scoped read-only credential files through a credentials directory. ([systemd.kill](https://www.freedesktop.org/software/systemd/man/latest/systemd.kill.html), [systemd.resource-control](https://www.freedesktop.org/software/systemd/man/latest/systemd.resource-control.html), [systemd.exec](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html)) | **Recommendation:** run the control plane under a dedicated unprivileged account, keep provider workers in separate units/slices when their failure or resource profile warrants it, and use `MemoryHigh=` before `MemoryMax=`. Keep provider credentials host-side and scoped. **Caveat:** effective cgroup, namespace, credential, and filesystem isolation depends on the host kernel and manager context. |
| **Private connectivity and pairing** | **Fact:** Tailscale access defaults to deny unless policy grants/ACLs permit traffic; device approval can block a device before approval. Tailscale attempts direct encrypted paths and can use DERP relays. Existing devices cache keys/rules and can continue during a coordination outage until device-key expiry, while enrollment, refresh, policy updates, and revocation require coordination. `tailscale serve` shares a local service within the tailnet and its documented proxy target is `127.0.0.1`; background mode changes persistence across restart/reboot. ([Tailscale access](https://tailscale.com/docs/features/access-control), [device approval](https://tailscale.com/docs/features/access-control/device-management/device-approval), [encryption](https://tailscale.com/docs/concepts/tailscale-encryption), [coordination outage](https://tailscale.com/docs/reference/coordination-server-down), [Serve](https://tailscale.com/docs/reference/tailscale-cli/serve)) | **Recommendation:** use a narrow private overlay path to a localhost-bound API/WS, while keeping RN application pairing and revocation separate from tailnet membership and device approval. **Caveat:** cached overlay connectivity is not indefinite availability and does not provide instant revocation during coordination loss. TLS or overlay membership is not app authorization. |
| **Upgrade, restart, and drain** | **Fact:** systemd manages stop/start transitions and can terminate a process tree at the stop deadline. Quadlet generates regular systemd units; Podman documents health/notify behavior and auto-update rollback on failed restart/readiness. Compose has dependency conditions and healthchecks, but its restart policy is a container policy. Supervisor documents startup windows, retries/backoff, autorestart, stop waits, priorities, and log rotation, while its optional network control server is unauthenticated/unencrypted by default. ([systemd.service](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html), [systemd.kill](https://www.freedesktop.org/software/systemd/man/latest/systemd.kill.html), [Quadlet](https://docs.podman.io/en/latest/markdown/podman-systemd.unit.5.html), [Podman auto-update](https://docs.podman.io/en/latest/markdown/podman-auto-update.1.html), [Compose startup](https://docs.docker.com/compose/how-tos/startup-order/), [Supervisor](https://supervisord.org/configuration.html)) | **Recommendation:** planned restart begins with drain: withdraw readiness, stop admission, checkpoint/reconcile active work, flush bounded telemetry, close the store, then allow the supervisor deadline. Code/configuration and schema compatibility need an explicit release/rollback policy. **Caveat:** a supervisor restart cannot establish whether a remote provider side effect committed; uncertain attempts need reconciliation before retry. |
| **Push notifications** | **Fact:** APNs token-based requests use provider credentials and ES256 JWTs; Apple says device tokens can change and should be registered/forwarded by the app. APNs describes itself as best effort: it can reorder, store, collapse/select, throttle, delay, or expire notifications, and `apns-id` correlates a request rather than proving device delivery. APNs payloads are bounded (4 KB for ordinary remote notifications). FCM HTTP v1 requires trusted server credentials; FCM documents token freshness, TTL/collapse behavior, invalid-token cleanup, and that a returned message ID means acceptance for delivery rather than device delivery. ([APNs token](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns), [APNs send](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns), [APNs register](https://developer.apple.com/documentation/usernotifications/registering-your-app-with-apns), [FCM HTTP v1](https://firebase.google.com/docs/cloud-messaging/send/v1-api), [FCM lifespan](https://firebase.google.com/docs/cloud-messaging/customize-messages/setting-message-lifespan.md.txt)) | **Recommendation:** append canonical state first, then enqueue a deduplicated push intent carrying only an opaque event/stream/schema/latest-cursor hint. Persist attempt/result/error/provider IDs. RN authenticates and catches up from its cursor on foreground, resume, reconnect, and push tap. **Caveat:** notification permission/settings, token registration, and visible delivery are independent; missing, duplicate, reordered, collapsed, or expired pushes must be harmless. |
| **Observability** | **Fact:** journald supplies unit, invocation, boot, and application fields, but rate limits and storage policy can drop or expire logs. OTel exporter helpers provide bounded queues, retry, timeout, and optional persistent storage; enqueue overflow or storage failure can reject/drop telemetry. Persistent queues can resume exports after collector restart, but they remain telemetry buffers. OTel security guidance covers authentication, encryption, least privilege, and narrow listener exposure. ([journal fields](https://www.freedesktop.org/software/systemd/man/latest/systemd.journal-fields.html), [journald.conf](https://www.freedesktop.org/software/systemd/man/latest/journald.conf.html), [OTel exporter helper](https://raw.githubusercontent.com/open-telemetry/opentelemetry-collector/v0.159.0/exporter/exporterhelper/README.md), [OTel security](https://opentelemetry.io/docs/security/config-best-practices/)) | **Recommendation:** make the durable event store authoritative and telemetry intentionally lossy. Emit structured event/message, correlation, run/stream/sequence, attempt, provider/request, schema/config, and trace identifiers. Redact prompts, outputs, keys, tokens, and secret values from normal logs, metrics labels, and crash artifacts. |
| **Resource and cost controls** | **Fact:** systemd exposes cgroup CPU, memory, tasks, and I/O controls. Anthropic documents organization/model request and token limits, `429` rate-limit responses with `retry-after`, and spend-cap responses that may intentionally lack retry guidance. OpenAI documents organization/project/model limits and distinguishes transient rate limits from billing/quota errors. Provider limits are maximum allowed usage, not guaranteed capacity. ([systemd resource control](https://www.freedesktop.org/software/systemd/man/latest/systemd.resource-control.html), [Anthropic limits](https://platform.claude.com/docs/en/api/rate-limits), [Anthropic errors](https://platform.claude.com/docs/en/api/errors), [OpenAI limits](https://developers.openai.com/api/docs/guides/rate-limits), [OpenAI spend](https://developers.openai.com/api/docs/guides/spend-limits)) | **Recommendation:** reserve local per-run and global budgets before admission: active runs, provider concurrency, turns, estimated input/output, wall time, bytes, and estimated spend. Settle actual usage and record unknown-cost states when usage is unavailable. Retry only classified transient failures with bounded jitter and provider retry hints. **Caveat:** provider quotas and spend controls are mutable safety nets, not a substitute for local admission. |

## 3. Recommended single-operator baseline

This is a design recommendation for later authority, not an instruction to deploy it now.

### 3.1 Conceptual process topology

```text
systemd system manager (boot/lifecycle, cgroups, journald)
├── vibecodium-control.service (dedicated unprivileged account)
│   ├── private API/WS listener (localhost-bound)
│   ├── workflow/session state machines, policy, admission
│   ├── ordered event/segment store, snapshots, cursors, replay
│   ├── provider-adapter supervisor and push-intent dispatcher
│   └── bounded telemetry emission
├── provider worker units/slices (adapter/run budget classes)
└── optional local OTel Collector (telemetry only)

private overlay ──> private front door/Serve ──> API/WS
RN ── app pairing + authenticated cursor catch-up ──> API/WS
host push adapter ── opaque hint ──> APNs / FCM ──> RN attention UI
provider workers ── outbound provider APIs (host-held credentials)
```

**Recommendation:** only the control plane may admit a workflow, append canonical events, advance a stream sequence, issue cursors, or create push intents. Provider workers return typed observations and side-effect results through a narrow adapter contract. They must not become a second store or source of truth.

A provider adapter may eventually be a child process, template unit, transient unit, or container behind a systemd unit. That packaging choice is subordinate to the control-plane boundary, resource budget, and uncertainty/reconciliation semantics.

### 3.2 Readiness, liveness, watchdog, and drain

- **Readiness:** announce ready only after opening the durable store, validating/covering the active schema, recovering required indexes/snapshots, replaying enough state for safe admission, and binding the private API/WS listener. Store recovery failure means not-ready and no new admission. Provider, push, or telemetry outages are normally degraded states if the host can still serve history and reconcile work.
- **Liveness:** answer whether the control loop and health path remain responsive. Do not define it as a provider ping or a PID check. Keep health responses small and free of output, prompts, and secrets.
- **Watchdog:** where application support exists, use `sd_notify` with `READY=1` only after readiness and `WATCHDOG=1` from the control loop. `STOPPING=1`, `STATUS=`, and bounded `EXTEND_TIMEOUT_USEC=` are lifecycle signals. A watchdog only observes the configured process/control loop; it does not validate an external side effect. ([sd_notify](https://www.freedesktop.org/software/systemd/man/latest/sd_notify.html))
- **Drain:** first withdraw readiness and stop new admissions. Mark active workflows draining. Each provider attempt must become checkpointed, typed-terminal, or explicitly `unknown/reconcile-required`. Flush only bounded telemetry, close provider sessions according to adapter contracts, commit final local state, and close the store. A forced deadline remains possible, so every step must be repeatable after recovery.

### 3.3 Restart, backoff, and rate limits

Use one lifecycle owner: the host supervisor. A reasonable baseline is `Restart=on-failure`, an intentional restart delay/backoff, and start-rate limits. systemd 261.2 documents `RestartSec=` and, on versions that support them, `RestartSteps=`/`RestartMaxDelaySec=`; `StartLimitIntervalSec=`/`StartLimitBurst=` bound start storms. Do not treat observed defaults as architecture constants; recovery time, provider cooldown, and disk pressure determine the authority values. ([systemd.service](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html), [systemd.unit](https://www.freedesktop.org/software/systemd/man/latest/systemd.unit.html))

Provider retry is a separate loop. Classify configuration/authentication, invalid request, rate limit, overload, transport, cancellation, and unknown-stream outcomes. Honor `Retry-After` where present, add bounded jitter, and cap attempts and wall time. If a remote outcome is unknown, reconcile using provider request IDs, supported idempotency keys, or an application uncertainty state before retrying.

**Caveat:** a clean restart may duplicate a remote action, lose an in-flight stream, or leave a remote action committed while the process died before appending its result. The event store and reconciliation protocol, not `Restart=`, provide side-effect safety.

### 3.4 Event-store safety and replay

Define the store contract before choosing SQLite, files, or another engine. It should include:

1. A monotonic per-stream sequence and stable event/message identifier.
2. Append-only or versioned records with correlation ID and schema/config version.
3. Durable checkpoint/snapshot boundaries that can be replayed after interruption.
4. Snapshot-plus-tail and bounded cursor catch-up APIs.
5. Idempotent append and intent handling so retried requests cannot create accidental duplicate canonical events.
6. Typed `pending`, `running`, `completed`, `failed`, `cancelled`, `draining`, and `unknown/reconcile-required` states.
7. Retention and compaction that preserve offline RN catch-up and operator-audit requirements.
8. Integrity, backup/restore, and recovery checks owned by a later authority decision.

Append canonical state before asking a push gateway to send. In the eventual storage design, an event and its push intent may share a local transaction; if they cannot, the architecture must explicitly recover or tolerate the gap. A push response never advances the canonical cursor. Snapshot, compaction, retention, backup, and schema compatibility details remain open.

Release code and configuration in an order that lets the previous reader recover durable state. Prefer additive schema evolution before readers depend on new fields, and retain a tested rollback artifact. Exact migration mechanics are intentionally out of scope.

### 3.5 Provider isolation and budgets

Each provider worker receives a typed request and returns a typed observation containing provider/model/request identifiers, usage when supplied, finish/error class, timestamps, and reconciliation metadata. It cannot write arbitrary host files, read unrelated credentials, or mutate canonical state outside the control-plane boundary.

Use separate units or slices when provider memory, process count, CPU, or I/O can harm the control plane. `MemoryHigh=` is the pressure/backpressure boundary and `MemoryMax=` a last line of defense; `TasksMax=` limits runaway process creation. A worker hitting a local limit should pause/fail its run with an observable reason rather than take down the control plane.

Before admission, reserve a conservative local budget for active runs, provider concurrency, turns, input/output tokens where known, output bytes, wall time, and estimated spend. Settle actual usage after provider completion. If the provider cannot report usage, retain a conservative reservation or record an explicit unknown-cost state. Provider account limits remain external constraints.

### 3.6 Push and cursor relationship

Use a provider-neutral push adapter behind the control plane:

1. Append the canonical event and advance the stream sequence.
2. Enqueue a deduplicated push intent keyed by event/stream, target app/device, schema version, and notification channel.
3. Send a minimal opaque payload containing a non-secret stream/event identifier and latest cursor or catch-up marker. Never include prompts, model output, provider keys, access tokens, or PII.
4. Persist provider response, attempt, error, expiry, and correlation identifiers.
5. On RN foreground, resume, reconnect, or push tap, authenticate to the host and catch up from the RN cursor. Ignore stale hints and tolerate duplicates/reordering.

Register or refresh APNs and FCM identities on startup and relevant callbacks; support multiple operator devices. Revoke a target on unpair/logout or permanent invalid-token responses. Permission/settings state is a client display concern, not evidence that a token is valid or a workflow event was delivered.

Direct APNs plus FCM, or FCM-mediated delivery for both platforms, are implementation choices behind the same contract. APNs/FCM acceptance, message IDs, expiry, and collapse are transport observations; none can advance canonical state.

### 3.7 Private access and app pairing

The baseline recommendation is a managed Tailscale tailnet with narrow grants from explicitly paired operator devices to a localhost-bound API/WS. Prefer a direct LAN path when available and retain the overlay’s encrypted relay path as fallback. Do not expose this control plane with a public Funnel-style front door.

The app-level pairing record binds operator/account, app-device identity, and host identity to a revocable capability. QR/code exchange is only a bootstrap ceremony; the resulting credential must be scoped, rotated/revoked, auditable, and unusable for another host. Check overlay membership, device approval, app pairing, operator authorization, and workflow policy separately.

Tailscale auth-key revocation does not by itself deauthorize nodes already enrolled; node deletion/unauthorization and app-pair revocation are separate operations. `tailscale serve` can provide private HTTPS reachability, but TLS and overlay membership are not the app authorization model. ([Tailscale auth keys](https://tailscale.com/docs/features/access-control/auth-keys), [device approval](https://tailscale.com/docs/features/access-control/device-management/device-approval), [Serve](https://tailscale.com/docs/reference/tailscale-cli/serve))

## 4. Host/RN/provider split and invariants

| Component | Owns | Must not own |
| --- | --- | --- |
| **Host control plane** | Workflow/session state machines; admission/policy; durable ordered events/segments; snapshots/cursors/replay; provider adapter contracts; push intents; pairing records; host-side secrets; correlation/audit metadata | Provider-specific truth, RN cache as canonical state, or APNs/FCM delivery guarantees |
| **systemd/cgroups and host OS** | Process lifecycle, boot/start ordering, stop deadline, process-tree termination, watchdog action, journald identity, and resource ceilings | Workflow semantics, provider idempotency, event ordering, or a decision that a remote side effect happened |
| **Provider adapters/workers** | Native provider protocol/session handling, request/response translation, provider IDs, usage/error mapping, bounded retry, and reconciliation hooks | Arbitrary store mutation, unrelated credentials, or provider stream/notification as canonical truth |
| **RN client** | App pairing; authenticated API/WS connection; local cursor; reconnect/catch-up; snapshots; user actions; attention UI | Long-lived provider secrets, canonical sequencing, or assumptions about push delivery/order |
| **Push gateway** | Transport-specific token registration, send, response handling, retry classification, and invalid-token cleanup | Workflow state, durable sequencing, or sensitive payload content |
| **Private overlay/front door** | Encrypted reachability and network-level admission | App identity, operator authorization, workflow policy, or canonical storage |

### Security and operational invariants

1. **Canonical truth:** every user-visible workflow transition is represented by a durable host event. Provider output, push response, journal entry, telemetry, and RN cache are projections or evidence.
2. **Ordered replay:** each stream has a monotonic sequence/cursor. RN recovers from a cursor or snapshot plus tail without notification history.
3. **Explicit uncertainty:** timeout, process death, or lost stream produces `unknown/reconcile-required`, not an automatic failure-and-retry that can duplicate a remote action.
4. **Bounded admission:** when capacity, disk, provider, or local budgets are exhausted, reject or defer new work with a durable reason; never silently drop accepted canonical events.
5. **One lifecycle owner:** systemd owns host process lifecycle; provider/application retry loops are bounded and do not compete with another supervisor over the same restart decision.
6. **Honest readiness:** store recovery and private listener availability are prerequisites. Provider, push, and telemetry degradation are visible states, not falsely green readiness.
7. **Repeatable drain:** planned stop blocks new work, checkpoints/reconciles active work, then closes state. Forced termination remains recoverable.
8. **Least privilege:** dedicated host account, scoped worker credentials, narrow overlay grants, app-level pairing, and host-held secrets. Never assume logs, metrics, push payloads, or coredumps are secret-safe.
9. **Non-authoritative telemetry:** sampling, rate limiting, queue overflow, collector outage, and retention can lose observations; missing telemetry never changes workflow truth.
10. **Opaque push hint:** push IDs and correlation IDs support diagnosis only. RN catches up over an authenticated host connection.
11. **Layered policy:** overlay membership, device approval, app pairing, operator authorization, and per-workflow admission have separate checks and revoke paths.
12. **Local cost guard:** host admission budgets and provider usage/error metadata remain meaningful even when provider quotas or spend caps change.

## 5. Honest alternatives and tradeoffs

### systemd system service versus systemd user service

- **System service (baseline):** PID 1 owns the unit independently of login/logout and can apply system-level cgroup, namespace, credential, state-directory, dependency, journald, and hardening controls while running the process as a dedicated `User=`. This fits an always-on host.
- **User service:** `systemd --user` manages a per-user unit hierarchy. `loginctl enable-linger` can start the user manager at boot and keep it after logout, so a personal host can run long-lived services without an interactive session. It is not the same boundary as PID 1; filesystem hardening, resource delegation, boot ordering, credential paths, and recovery behavior need separate verification.
- **Tradeoff:** user units can reduce system-administration privilege and be convenient for one operator, but lingering is not a security or durability guarantee. Choose them only if the authority owner accepts and tests the weaker/system-dependent boundaries. ([user@.service](https://www.freedesktop.org/software/systemd/man/latest/user@.service.html), [loginctl](https://www.freedesktop.org/software/systemd/man/latest/loginctl.html), [systemd.exec](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html))

### Quadlet, Compose, and Supervisor

- **Podman Quadlet:** source files become regular systemd units, retaining systemd dependency and cgroup integration. Podman documents notification/readiness and auto-update rollback behavior. Rootless operation adds user paths, lingering, image, storage, and runtime lifecycle concerns. Quadlet is packaging, not a replacement for the control-plane contract. ([Quadlet](https://docs.podman.io/en/latest/markdown/podman-systemd.unit.5.html), [auto-update](https://docs.podman.io/en/latest/markdown/podman-auto-update.1.html))
- **Docker Compose:** dependencies can wait for `service_healthy` when a healthcheck exists; `service_started` means the container is running, not that the application is ready. Compose restart policies operate at the container layer, so a host lifecycle owner is still needed. Avoid two supervisors repeatedly restarting the same control process. ([startup order](https://docs.docker.com/compose/how-tos/startup-order/), [services](https://docs.docker.com/reference/compose-file/services/))
- **Supervisor:** provides process groups, start-success windows, retries/backoff, autorestart, stop waits, priorities, and rotating logs. It does not supply systemd's cgroup/dependency/readiness protocol as a first-class host contract. Its optional inet control server is unauthenticated/unencrypted by default and must never be public; it is not Vibecodium app pairing. It may fit a narrowly scoped legacy bundle, but adds a second lifecycle vocabulary if systemd already owns the host. ([Supervisor configuration](https://supervisord.org/configuration.html), [Supervisor running](https://supervisord.org/running.html))

### Tailscale, Headscale, WireGuard, Caddy, and cloud tunnels

- **Managed Tailscale (baseline):** supplies identity-aware coordination, grants/ACLs, device approval, encrypted direct/DERP paths, and private Serve. It depends on the managed coordination plane for enrollment, policy updates, key refresh, and revocation. Existing cached paths during an outage are not indefinite operation or immediate-revocation guarantees.
- **Headscale:** is a deliberate self-hosted coordination alternative, not an offline or maintenance-free Tailscale substitute. Its documentation adds a public HTTPS/control endpoint and operator-owned OIDC/bootstrap, DERP, policy, backup, upgrade, and outage duties. Its policy docs distinguish no loaded policy (allow-all behavior) from an explicitly empty grants list (deny-all); a policy file's existence alone is not proof of safe policy. ([requirements](https://headscale.net/stable/setup/requirements/), [registration](https://headscale.net/stable/ref/registration/), [policy](https://headscale.net/stable/ref/policy/))
- **Raw WireGuard:** provides an encrypted tunnel and cryptokey routing. Official documentation leaves key distribution/configuration out of scope; peers exchange them out of band. `AllowedIPs` participates in routing and receive-side access checks, while `PersistentKeepalive` can preserve NAT mappings. It is a low-dependency option for a technically capable operator, but leaves pairing UX, inventory, revocation, policy distribution, and recovery to Vibecodium/operations. ([overview](https://www.wireguard.com/#conceptual-overview), [quick start](https://www.wireguard.com/quickstart/), [wg(8)](https://git.zx2c4.com/wireguard-tools/about/src/man/wg.8))
- **Caddy:** can provide TLS termination and reverse proxying, but TLS is not app pairing or operator authorization. Public automatic HTTPS has DNS/ACME/port/storage prerequisites; local HTTPS requires clients to trust the local CA. It is a front-door option, not a replacement for private overlay policy. ([automatic HTTPS](https://caddyserver.com/docs/automatic-https), [reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy))
- **Cloudflare Tunnel/Mesh and SSH reverse forwarding:** can solve remote reachability or identity integration, but introduce cloud/control-plane or bastion dependence. Tunnel is outbound-only to Cloudflare; Mesh is cloud-routed. They are explicit later alternatives, not LAN/offline fallbacks and not invisible transport substitutions. ([Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/), [Cloudflare Mesh](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-mesh/), [SSH `-R`](https://man.openbsd.org/ssh#R))

### Journald versus a local OTel Collector

A host-only baseline can use structured application logs plus journald fields and bounded local retention. A local OTel Collector can add batching, retry, sampling, redaction, and an exporter boundary, but queue overflow, storage failure, collector restart, or downstream outage can lose or delay observations. Keep it off the canonical event path, bind receivers narrowly, protect credentials, and size its memory/queues inside the host budget. ([journald.conf](https://www.freedesktop.org/software/systemd/man/latest/journald.conf.html), [OTel exporter helper](https://raw.githubusercontent.com/open-telemetry/opentelemetry-collector/v0.159.0/exporter/exporterhelper/README.md), [OTel memory limiter](https://raw.githubusercontent.com/open-telemetry/opentelemetry-collector/v0.159.0/processor/memorylimiterprocessor/README.md), [OTel security](https://opentelemetry.io/docs/security/config-best-practices/))

## 6. Open decisions for later authority

These are intentionally left for the operator, GitHub/workspace authority, two-plane prototype, and final architecture tickets.

### Operator and authority model

- What is the authoritative operator/account identity, and how does a paired RN device prove it without a reusable host-wide secret?
- What bootstrap artifact is displayed/transferred, how long is it valid, where are device keys stored, and what revokes a device, operator, host, or all pairings?
- What is the break-glass/recovery path when the phone, overlay coordination plane, host disk, or host OS is unavailable?

### GitHub/workspace contract

- Which repository/package owns the host control plane, RN client, provider adapters, push gateway, deployment definition, and architecture record?
- Which event/schema/version identifiers are workspace-wide, and how are issue/PR/trace/run IDs correlated without sensitive or high-cardinality metric labels?
- Which artifact records ratified invariants, and which tickets are allowed to change them?

### Two-plane prototype

- Where exactly is the control-plane/provider-worker boundary, and is isolation by process, unit, container, or another mechanism?
- What is the smallest API/WS protocol for snapshot, cursor catch-up, live events, backpressure, drain, reconnect, and unknown-outcome reconciliation?
- How are local admission budgets reserved/settled, and what happens when provider, push, overlay coordination, disk, or telemetry is unavailable?
- Which failure drills are required: abrupt kill during append; kill after provider acceptance; store recovery; cursor gap; duplicate/collapsed push; token rotation; overlay outage; and cgroup pressure?

### Final architecture tickets

- Durable event/segment store, schema evolution, snapshots/compaction, backup/restore, retention, and integrity checks.
- Typed workflow/session state machine, provider adapter contract, request idempotency, streaming uncertainty, and reconciliation.
- Native host lifecycle, readiness/watchdog/drain semantics, restart backoff/rate limits, and resource slices.
- Pairing/policy/revocation, private overlay choice, localhost/front-door binding, and operator recovery.
- Provider-neutral push registration/intent contract, APNs/FCM response handling, and RN cursor catch-up.
- Structured observability, redaction, coredump/journal retention, optional OTel boundary, and cost/rate dashboards.
- Compatibility-tested release/upgrade/rollback and a verification matrix for host restarts, network outages, provider outages, and notification loss.

### Unknowns that must not be silently filled in

- Host hardware, filesystem durability, power/thermal behavior, OS/systemd version, cgroup mode, backup target, expected concurrency, and recovery objectives are unspecified.
- Provider account tiers, model availability, request/stream limits, pricing, token accounting, key expiry, SDK retry behavior, and outage behavior are vendor/account/version dependent.
- APNs/FCM presentation, permission, background-execution, token, collapse, and expiry behavior varies with OS/app configuration; a push cannot be a transport-level promise.
- No cited source establishes arbitrary provider actions as exactly once across process death. The architecture must expose uncertainty and reconcile it.
- OTel Collector queues, journald retention, and coredumps can be incomplete or sensitive; they cannot replace the durable event store.
