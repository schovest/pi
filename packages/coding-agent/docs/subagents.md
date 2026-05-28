# Subagents

Pi includes an in-memory `subagent` tool for focused delegation inside the current process. It does not spawn child processes and child sessions are not persisted for resume.

The `subagent` tool injects the currently discovered agent names into the tool schema and system prompt. Running subagents are shown in the footer as `agents:N`; open `/running-agents` to inspect each subagent's events, tools, output, errors, model, thinking level, and usage.

## Built-in agents

- `scout` - read-only exploration.
- `planner` - implementation planning.
- `reviewer` - code and plan review.
- `worker` - focused implementation work.

## Custom agents

Create Markdown files in:

- User scope: `~/.pi/agent/agents/*.md`
- Project scope: nearest `.pi/agents/*.md`

Project agents are loaded only when a run sets `agentScope` to `project` or `both`. Override order is built-in, then user, then project.

```markdown
---
description: Reviews a focused patch
model: anthropic/claude-sonnet-4-5
thinking: high
tools: [read, grep, find, ls]
---

Review for regressions, missing tests, and behavior changes. Lead with findings.
```

`model` and `thinking` can also be set per task; task values override agent frontmatter. Thinking is clamped to the target model's supported levels.

## Tool input

Single task:

```json
{
  "agent": "reviewer",
  "task": "Review the current change set",
  "thinking": "high"
}
```

Parallel tasks:

```json
{
  "tasks": [
    { "agent": "scout", "task": "Find settings-related files", "tools": ["read", "grep", "find"] },
    { "agent": "reviewer", "task": "Review tests for coverage gaps", "tools": ["read", "grep"] }
  ]
}
```

Chains run sequentially and replace `{previous}` with the prior step's output:

```json
{
  "chain": [
    { "agent": "scout", "task": "Summarize the auth flow" },
    { "agent": "planner", "task": "Plan a safe refactor from this context: {previous}" }
  ]
}
```

Parallel runs accept at most 8 tasks and execute with concurrency 4. Result order matches input order.

## SDK

```typescript
const { session } = await createAgentSession();

const result = await session.runSubagents({
  agent: "planner",
  task: "Plan the smallest implementation for subagent discovery",
  thinking: "medium",
});
```

Disable the built-in tool while keeping the SDK methods:

```typescript
await createAgentSession({ enableSubagents: false });
```
