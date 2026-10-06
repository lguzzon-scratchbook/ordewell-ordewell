# 0023 — Messages reach a running task between tool calls

**Status:** proposed — changes [ADR-0018](0018-structured-runner-transport.md) M1

A message sent to a structured task waits in Ordewell's queue until the
runner's turn ends (ADR-0018, M1). That rule was written for a conversation of
short turns. A task is not one: it is usually a single long turn, from the
prompt to `task_complete`. So "delivered when the turn ends" means "delivered
when the task is over" — a correction sent five minutes into a ten-minute task
reaches the runner after the work it was meant to change, and a message sent
to stop a wrong approach arrives once the wrong approach is finished.

Claude Code and Codex do better in their own TUIs: a message typed while the
agent works is shown to the model after the current command or edit, inside
the same turn. The structured transport speaks the same protocols, so it can
do the same. The supervisor (#28) needs it too: a message it sends to a
running task is only useful if the task reads it while it still matters.

## Decision

**A message sent to a running structured task is handed to the runner at once
and reaches the model at the runner's next step boundary — after the tool call
in flight, within the same turn. Where a runner cannot take a message
mid-turn, or refuses one, the message waits for the turn to end, as before.
*Force send* interrupts the running tool call and delivers its message
straight away.**

## Key properties

### Delivery

- **A per-adapter optional capability (D1).** A task-mode adapter may offer
  *deliver into the running turn*. It is feature-detected, like the rest of
  ADR-0018's structured capability (S2); an adapter without it keeps the
  turn-end queue, and nothing upstream changes for it.
- **Handed over at once, delivered at the boundary (D2).** A message sent
  while a turn runs is passed to the runner immediately; the runner shows it
  to the model after the tool call in flight completes. Ordewell does not wait
  for the boundary itself — no runner exposes "between tool calls" as a moment
  a client can act in, and each one already queues and injects on its own
  (see *Per runner*).
- **The runner's acknowledgement is the delivery (D3).** A message is
  *delivered* when the runner reports that the model has it — not when the
  write, POST or request succeeded. Each runner has its own evidence (below).
  Until then the message is *handed over*: still in the queue, no longer
  removable (no runner can recall it), and owed a delivery.
- **Fallback to the turn-end queue (D4).** A message goes to the turn-end
  queue when the adapter lacks the capability, when the runner refuses it
  (Codex: no active turn, or a different one), or when the turn ends with the
  message handed over but never acknowledged — it is then sent as the next
  turn's message, so nothing handed over is lost. Turn-end delivery keeps
  ADR-0018's W1 rule: the task stays `in_progress` with no flicker.
- **A turn that ends with a message owed does not wait for input (D5).** If a
  turn ends without the marker while a handed-over message is unacknowledged,
  the runner is about to work on it (or Ordewell is about to send it), so the
  task does not become `awaiting_user` (W1) for that turn end.

### The queue view and the task log

- **A message leaves the queue when the runner has it (Q1).** The queue lists
  messages not yet delivered: *queued* ones (removable, waiting for a turn to
  end on a runner without the capability) and *handed over* ones (not
  removable). Delivery removes the entry.
- **Delivery is a task-log event (Q2).** A `message_delivered` event carries
  the message id and where it landed: `mid_turn` (into the running turn) or
  `turn_end` (as the message that opened a turn). The log shows the message
  at the point the model read it, not where it was typed, and replays the
  same way on reload (ADR-0018, P1). A forced message is marked as such.

### Force send

- **Interrupt the tool call, then deliver (F1).** Force send soft-interrupts
  the running turn — which stops the tool call in flight — and sends the
  forced message as the turn that replaces it. The runners' interrupts are the
  ones ADR-0018 M1 already uses: Claude's `control_request` interrupt, Codex's
  `turn/interrupt`, OpenCode's abort, with kill-and-resume as the fallback.
- **The forced message goes first; the rest keep their order (F2).** Messages
  still in Ordewell's queue follow the forced one in the order they were sent.
  Messages already handed over to the runner are where the runners differ:
  Claude Code and OpenCode keep them in the conversation and the model reads
  them in the same turn as the forced message, ahead of it (they were sent
  first); Codex discards a steered message it had not consumed, so Ordewell
  re-sends it after the forced one (D4). Ordewell cannot reorder a runner's
  own queue, and does not try.
- **No waiting for input in between (F3).** The interrupted turn does not make
  the task `awaiting_user`: a forced message follows, and the task stays
  `in_progress` through the switch. A plain interrupt, with no message, still
  ends in "waiting for input" (M1).
- **What an interrupt does to the running command differs (F4).** Claude Code
  and OpenCode kill it. Codex aborts the turn but leaves the command running
  to its end, and reports it later, in the next turn. On Codex, force send
  therefore stops the agent waiting on the command, not the command itself,
  and the adapter drops that late report as belonging to a finished turn.

### Per runner

| runner | mid-turn delivery | delivered when | force send |
|---|---|---|---|
| **Claude Code** (stream-json) | a `user` message written to stdin; native | the CLI echoes it (`isReplay: true`) under `--replay-user-messages`, after the tool result | `control_request` interrupt, then the message as the next `user` line |
| **Codex** (app-server) | `turn/steer` with `expectedTurnId` and `clientUserMessageId`; native | a `userMessage` item whose `clientId` is that id | `turn/interrupt`, wait for `turn/completed: interrupted`, then `turn/start` |
| **OpenCode 1.x** (serve) | `prompt_async` while the session is busy; native | an assistant message whose `parentID` is that user message or a later one | `POST /session/:id/abort`, then `prompt_async` |
| **OpenCode 2.x** | not verified — no 2.x binary on the probe host | — | turn-end queue until verified |

- **Claude Code.** The CLI queues a `user` line that arrives mid-turn and
  attaches it to the next tool result as "The user sent a new message while
  you were working" (its transcript records it as `queued_command`, removed
  with reason `absorbed_mid_turn`). If the model ends the turn without
  another tool call, the CLI runs the message as a turn of its own after
  `result` — delivery `turn_end`, and the adapter attributes that turn to the
  message instead of treating it as background work (ADR-0018, B1). The task
  spawn adds `--replay-user-messages`; the echo of a message is the only
  signal that tells the two cases apart. Its first prompt is echoed too, and
  is not a delivery.
- **Codex.** `turn/steer` answers `{turnId}` at once; that is acceptance, not
  delivery. The `userMessage` item appears after the item in flight completes.
  A steer before the turn id is known is refused (the request needs a string
  `expectedTurnId`); the adapter holds the message until `turn/started` or the
  `turn/start` response names the turn, as it does for interrupts. A steer
  after the turn ended is refused with `no active turn to steer`, and a wrong
  id with `expected active turn id …` — both fall back to the turn-end queue.
  The existing deny-note steer (ADR-0018, Codex approvals) is the same call.
- **OpenCode 1.x.** A `prompt_async` while busy returns 204 and stores the user
  message at once (`message.updated`, role `user`) — storage, not delivery.
  The session's loop reads it at its next step, including when the step in
  flight was the model's final text: the loop runs one more step instead of
  going idle. So the busy period simply continues, and the turn ends at the
  next idle as today.

### The supervisor

- **#28 sends through the same seam (S1).** A supervisor message is a task
  message with a different sender: it is handed over, acknowledged, logged
  and, when the runner cannot take it mid-turn, queued exactly like a
  person's. #28 described supervisor messages as delivered "at the next turn
  boundary through `IAgentSession.send`"; this decision makes that boundary
  the runner's next step rather than the end of the task, and #28 needs no
  delivery path of its own. Force send is available to the supervisor only
  under the same grant that lets it steer.

## Evidence

Observed on 2026-10-06 on the development host, with throwaway scripts
speaking each runner's protocol directly (deleted afterwards). Each probe
started a turn whose first step was `sleep 20 && echo step1done`, followed by
two more commands, and sent a message about four seconds into the sleep.

- **Claude Code 2.1.291**, `haiku` (`claude-haiku-4-5-20251001`). The message
  reached the model right after the sleep's tool result, in the same turn
  (one `result`, `num_turns` 4); the summary carried the requested word. With
  `--replay-user-messages` the message was echoed with `isReplay: true`
  between the tool result and the next tool call. A message sent during a
  text-only reply ran as a second turn after the first `result`, echoed after
  it. Interrupt: the sleep's tool result became "The user doesn't want to
  proceed…", `result` was `error_during_execution`, and a message written
  just after started a new turn. A message handed over before the interrupt
  ran in that new turn together with the forced one, ahead of it; the
  interrupt's `control_response` reported `still_queued: []` even so, so that
  field is not a reliable account of the CLI's queue.
- **Codex 0.160.0**, `gpt-5.6-luna`, `danger-full-access` (the sandbox cannot
  start on this host). `turn/steer` returned `{turnId}` immediately; the
  `userMessage` item, carrying `clientId` = the `clientUserMessageId` sent,
  appeared when the sleep completed, before the next command. Refusals:
  `expectedTurnId: null` → `Invalid request: invalid type: null, expected a
  string`; omitted → `missing field expectedTurnId`; after `turn/completed` →
  `no active turn to steer`; a wrong id → `expected active turn id
  \`not-the-turn\` but found \`<id>\``. `turn/interrupt` completed the turn as
  `interrupted` at once and the command's output became "aborted by user",
  but the command itself ran on (a `sleep 15 && touch` file appeared on time)
  and its `item/completed` arrived during the next turn. A steer accepted and
  not yet consumed when the turn was interrupted never reached the model and
  is absent from the rollout.
- **OpenCode 1.18.34**, `opencode-go/deepseek-v4.1-flash`, variant `low`,
  agent `build`. `prompt_async` while busy returned 204 and the user message
  was stored immediately; the next step after the sleep finished was the
  first assistant message with that message as its `parentID`, and the
  session stayed busy until one idle at the end. A message posted during a
  text-only final step produced one more step, still without an idle between.
  Abort killed the command (the `touch` never ran; the output read "User
  aborted the command"), raised `MessageAbortedError` and went idle; a
  `prompt_async` after it opened a new loop. A message stored before the abort
  stayed in the history, so the next loop read it ahead of the forced one;
  the new loop's assistant messages are parented on the forced message.

Not verified here: OpenCode 2.x (not installed — its `/api/session/:id/prompt`
while active is the expected path); Codex in a sandboxed mode; whether a Codex
steer accepted during the turn's final reply can be dropped without an
interrupt (D4 covers it either way).

## Considered options

- **Keep turn-end delivery only.** Simple, and correct for a conversation of
  short turns, but a task is one long turn, so a message would reach the
  runner when the task is already over. Rejected; it stays as the fallback.
- **Keystroke injection into the runner's TUI.** Rejected in #28, for the
  reasons ADR-0018 left the terminal transport: keystrokes cannot be promised
  to land between turns, and #11 and #13 were bugs in exactly this path. The
  terminal transport keeps turn-end-only, human-only messaging.
- **Hook-based injection.** A Claude Code `PostToolUse` hook returning
  `additionalContext`, injected per task with `--settings`, pulling the
  attempt's pending messages from the Ordewell MCP server with the task
  token; an OpenCode plugin on its `tool.execute.after` hook through
  `OPENCODE_CONFIG_CONTENT`. It works without the runner's cooperation, but
  each runner already injects mid-turn messages natively — the same path its
  own TUI uses — and a hook would be a second, per-runner delivery channel
  with its own failure modes (a hook that does not load, a message delivered
  twice), executable code added to a task's configuration, and nothing at all
  for Codex. Rejected while native delivery exists; it is the route to
  revisit if a runner drops it.
- **Ordewell waits for the boundary and sends the message then.** No runner
  reports "between tool calls" as a moment a client can act in before the
  next model call starts; by the time a tool result is seen, the next request
  is already on its way. Handing the message over at once and letting the
  runner inject it is what makes the boundary reachable.
- **Treat the write or POST as delivery.** Every runner accepts the message
  long before the model sees it, and Codex can still discard an accepted
  steer. The queue would claim a delivery that may not have happened.
- **Force send as interrupt plus a normal send.** The interrupted turn would
  become "waiting for input" for a moment, and the forced message would queue
  behind anything already waiting. F2 and F3 exist to avoid both.

## Consequences

- The structured capability's `sendMessage` changes meaning: "handed over now,
  delivered at the next step" on a capable adapter, "queued until the turn
  ends" otherwise. `queued()` reports both states; `removeQueued` refuses a
  handed-over message.
- The Claude task spawn adds `--replay-user-messages`, and the adapter learns
  to read echoes as deliveries and to attribute a turn the CLI starts for a
  queued message to that message.
- The Codex adapter steers task messages with a `clientUserMessageId` and
  re-sends any it never saw acknowledged.
- ADR-0018 carries a *Pending* line naming this ADR until M1 is rewritten.

## History

- 2026-10-06 — proposed, with the per-runner probe above (Claude Code 2.1.291, Codex 0.160.0, OpenCode 1.18.34).
