# pi-subagents-kill

`/subagents-kill` aborts running or queued subagents through the
`@gotgenes/pi-subagents` service API.

- `/subagents-kill` — pick one agent or "All active agents" from a selector,
  then confirm.
- `/subagents-kill all` — confirm once, abort every running/queued agent.
- `/subagents-kill <id|prefix>` — abort one; a unique id prefix works, an
  ambiguous one reopens the selector scoped to the matches.

Confirmations and the selector need an interactive session; without a UI the
command acts on `all` or a unique id immediately and otherwise prints usage.

ESC is not an on-demand abort under pi-subagents (`abortAllOnInterrupt` either
kills every subagent with the parent interrupt or none), so this command is the
"now kill them" half of the workflow: turn `abortAllOnInterrupt` off, use ESC to
release a waiting `get_subagent_result`, then `/subagents-kill` when you mean it.

## Install

Copy or symlink `extensions/subagents-kill.ts` into your Pi agent's
`extensions/` directory.

## Behavior

- Registers the command `subagents-kill`; listens to `session_start` and the
  `subagents:started|created|resuming` events.
- At factory load it captures the parent runtime's service adapter, before any
  child runtime exists, and refreshes it on `session_start`.
- Only `running` and `queued` agents are abortable; settled agents cannot be
  aborted.

## Dependencies / constraints

- Imports `@gotgenes/pi-subagents` — the plain specifier first, then an explicit
  resolution under `~/.pi/agent/npm/node_modules` — and expects
  `getSubagentsService()` returning `listAgents`/`abort`/`hasRunning`/
  `getRecord`. That surface is present in `@gotgenes/pi-subagents` 25.0.5; pin a
  compatible version.
- The parent-adapter selection is internal, not exported. It exists because a
  child session re-runs this factory in-process and overwrites the
  process-global service key with an adapter over the child's manager: the
  adapter captured before children exist is preferred, and candidates are
  disambiguated by ids this runtime spawned (from the parent event bus) or by
  `hasRunning()`.
- Appends one JSON diagnostic line per invocation to
  `PI_CODING_AGENT_DIR`/`subagents-kill.log` (default `~/.pi/agent`). That is
  local runtime state, and it records local agent ids and descriptions — do not
  publish a captured log.
- No credentials or personal settings in the source.
