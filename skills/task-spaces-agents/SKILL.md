---
name: task-spaces-agents
description: Select, launch, message, resume, or supervise agents on local and remote Herdr hosts.
---

# Coordinate through Herdr

Read `hc --skill` on the destination host. Use `hc` for all agent launches, messages and session
management. Use `herdr-app` for the presentation layer. Verify the exact host, terminal, native
conversation, task, Space and checkout before acting.

Reuse the same task and working Space for helpers. Give each helper a fresh tab and a short title
that describes the work. A task may own multiple existing worktrees. Coordinate writers and check
the host's `herdr-task inventory --repo MAIN` before assigning a free worktree. Create a physical
worktree only when requested. A quiet session or branch name alone does not release an assignment.

Use the configured CLI and model defaults unless the user asks for something different. If the
optional wrapper is available, use `herdr-agent TOOL`. Otherwise use the installed agent command
as argv to `hc run`. For example, a same-host launch from a manager uses:

```sh
hc run --bg --json --keep --no-parent --outlive-parent --cwd "$folder" \
  --label "herdr.space=$space" --label "herdr.tab=$fresh_tab" \
  --label "session.title=$title" --label "orchestration.task=$task" \
  --label "orchestration.parent=$manager_address" \
  --label "orchestration.parent-session=$manager_native_session" -- codex
```

Use verified values and omit an unavailable optional native ID. Logical manager labels link the
worker in the sidebar. They do not grant message access. On another host, use `hc run --on HOST`
from the actual live launcher and omit both parent flags if its worker needs a return grant.
Verify the exact reachable parent address. If access is denied, let the authorized manager pull
results through `hc read` or use the actual launcher as a relay.

Deliver the brief through `hc send` after readiness and supervise with `hc get`, `hc read`, and
bounded `hc wait`. A brief states the deliverable, files and checkout, handoff destination,
validation, and any approvals. Verify the artifact before calling work done. Preserve existing
human gates for publish, merge, deployment, and task/worktree cleanup. After an uncertain reply,
reconcile the saved address or operation ID before attempting another launch.
