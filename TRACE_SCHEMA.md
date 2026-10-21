# Structured trace extension, version 1

`viewer.py build --structured records.jsonl` imports optional newline-delimited JSON alongside `debug_trace.txt`. These are explicit instrumentation records, not data automatically inferred from free-text logs. Test fixtures exercise this extension; the real hello dataset currently has no structured sidecar.

All records require `tick` (decimal string, unsigned 64-bit) and `component` (stable component path). Preserve ticks as strings in JSON clients. File order determines same-tick ordering within each source; structured records follow free-text records at equal ticks. This is deterministic display ordering, not a guaranteed causal order between independently produced streams. For causally interleaved replay, emit all relevant actions in a single ordered structured stream and use an empty text trace.

## State deltas

```json
{"tick":"1000","component":"system.cpu.decode","kind":"state","fields":{"status":"Blocked","skid_occupancy":8}}
{"tick":"1500","component":"system.cpu.decode","kind":"state","fields":{"skid_occupancy":0}}
```

Fields are carried forward until another explicit update. Absence of a field update means unchanged only under the producer's contract of recording every change. Before the first value it is unknown. Use `null` to explicitly invalidate a known value. Emit an initial state snapshot for every field for which complete replay is claimed.

## Port actions

```json
{"tick":"2000","component":"system.cpu.icache.mem_side","kind":"port","source":"system.cpu.icache.mem_side","target":"system.membus.cpu_side_ports[1]","action":"sendTimingReq.accepted","transaction":"packet-42"}
```

The viewer highlights an edge only when both source and target match a configured connection. A response should record its actual direction; action and transaction identifier remain visible in the payload. This is an instant, not a busy interval. A transaction ID must survive packet replacement/cloning or expose parent-child IDs to support reliable end-to-end correlation. The first implementation displays supplied IDs but does not infer transaction lifetimes.

## Events

```json
{"tick":"2000","component":"system.cpu.tickEvent","kind":"event","event_key":"queue0:event23:generation1","action":"scheduled","target":"2500","message":"schedule CPU tick"}
{"tick":"2500","component":"system.cpu.tickEvent","kind":"event","event_key":"queue0:event23:generation1","action":"executed","target":"2500","message":"execute CPU tick"}
```

Actions: `scheduled`, `rescheduled`, `descheduled`, `executed`. Scheduling requires a non-past target. An event remains observed-pending until execution, cancellation, or replacement by rescheduling. If its target passes with no termination record, the UI marks a negative remaining time rather than silently inventing execution. The default text adapter keys events by logged owner + instance identifier. Durable generation and queue identifiers are preferable for long or parallel traces.

## Capture work needed for complete system replay

- Central event queue hooks: creation/generation, schedule, reschedule, cancel, service begin/end, queue ID and priority, and event owner identity.
- Port protocol hooks: request/response/snoop/retry calls, send acceptance, both endpoint IDs, transaction identity, and payload metadata.
- Model-specific hooks: initial values and transitions for relevant queues, stages, capacities, drain state, clock/power state, and resource allocations.
- Ordering: an explicit ordered sequence within each event queue, plus cross-queue dependencies for parallel simulation. Host wall-clock callback durations must be recorded separately from simulation ticks.
- Capture boundaries: initial pending-event and model-state snapshots; explicit loss/truncation markers. Avoid claiming complete replay when records are dropped.

The viewer cannot manufacture this information from ordinary debug output. These hooks are not installed by the current implementation.

## Native Classic Cache adapter

The text importer also recognizes exact `CacheResponsePort::setBlocked`, `clearBlocked`, and `processSendRetry` messages from local `src/mem/cache/base.cc` (lines 152–186). It maps the C++ `.cpu_side_port` name to the configured `.cpu_side` only for configured `Cache`/`NoncoherentCache` objects with that port. Blocking/accepting messages update `accepts_new_requests`; retry messages produce an observed reverse-direction `sendRetryReq` action using the configured peer. Initial state stays unknown until the first such observation. These are source-verified message semantics, not a generic heuristic for arbitrary components. The prebuilt binary/source provenance limit still applies.
