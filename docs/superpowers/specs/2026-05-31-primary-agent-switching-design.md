# Primary Agent Role Switching Design

## Summary

Allow switching the main agent's role (system prompt + tool set) within a single TUI session, preserving conversation history. Default role is `build` (full tools), with a built-in `plan` role (read-only tools). Users can define additional roles via `.md` files.

## Core Concept

**PrimaryAgentDefinition** defines a main agent role:

- `name`: role identifier (e.g. `build`, `plan`)
- `description`: short description shown in picker
- `systemPrompt`: replaces the default system prompt
- `includedTools`: tool whitelist (empty = all tools)
- `excludedTools`: tool blacklist (applied when `includedTools` is empty)
- `model`: optional default model override
- `thinking`: optional default thinking level override
- `scope`: `"builtin" | "user" | "project"`
- `sourcePath`: file path for user/project definitions

**Tool filtering logic**:

1. If `includedTools` has values → only enable those tools
2. Otherwise → enable all registered tools, minus `excludedTools`
3. `build`: no restrictions (both lists empty)
4. `plan`: `excludedTools: ["bash", "edit", "write"]` (read-only: read, grep, find, ls, subagent)

**Switching behavior**:

- Preserve conversation history
- Replace system prompt
- Update active tool set
- Optionally update model and thinking level
- Emit `primary_agent_changed` event

## Types

New file: `packages/coding-agent/src/core/primary-agents/types.ts`

```typescript
import type { ThinkingLevel } from "@schovest/pi-agent-core";

export type PrimaryAgentDefinitionScope = "builtin" | "user" | "project";

export interface PrimaryAgentDefinition {
  name: string;
  description: string;
  systemPrompt: string;
  scope: PrimaryAgentDefinitionScope;
  sourcePath?: string;
  includedTools?: string[];
  excludedTools?: string[];
  model?: string;
  thinking?: ThinkingLevel;
}
```

## Discovery

New file: `packages/coding-agent/src/core/primary-agents/discovery.ts`

**Built-in definitions**:

```typescript
const BUILT_IN_PRIMARY_AGENTS: PrimaryAgentDefinition[] = [
  {
    name: "build",
    description: "Default agent with full tools for implementation and execution.",
    systemPrompt: "",  // empty = use default system prompt from buildSystemPrompt()
    scope: "builtin",
  },
  {
    name: "plan",
    description: "Planning agent with read-only tools for analysis and design.",
    systemPrompt:
      "You are a planning agent. Analyze requirements, explore the codebase, and produce concise implementation plans. Do not modify files or execute commands. Focus on understanding, designing, and proposing solutions.",
    scope: "builtin",
    excludedTools: ["bash", "edit", "write"],
  },
];
```

**Discovery sources** (same merge pattern as subagents):

1. Built-in (hardcoded array)
2. User: `{agentDir}/primary-agents/*.md`
3. Project: nearest ancestor `{cwd}/.pi/primary-agents/*.md`

Later sources override earlier ones by name.

**.md file format** (frontmatter + body):

```markdown
---
description: Plan and analyze without making changes
excludedTools: [bash, edit, write]
model: claude-sonnet-4-6
thinking: high
---
You are a planning agent. Analyze, design, and propose solutions without modifying files...
```

Body becomes `systemPrompt`. Frontmatter fields: `description`, `includedTools`, `excludedTools`, `model`, `thinking`.

## AgentSession Integration

**New state** in `AgentSession`:

```typescript
private _currentPrimaryAgent: string = "build";
```

**New method** `switchPrimaryAgent(name: string)`:

1. Discover all primary agent definitions via `discoverPrimaryAgents()`
2. Find target definition by name; throw if not found
3. Compute new active tool set:
   - `includedTools` has values → `setActiveToolsByName(includedTools)`
   - Otherwise → all registered tools minus `excludedTools` → `setActiveToolsByName()`
4. Rebuild system prompt with `primaryAgentPrompt` from definition
5. Optionally update model and thinking level if definition specifies them
6. Update `_currentPrimaryAgent`
7. Emit `primary_agent_changed` event

**System prompt injection**:

Add `primaryAgentPrompt?: string` to `BuildSystemPromptOptions`. When non-empty, prepend it to the system prompt (before tool descriptions and other sections). When empty (i.e. `build` role), use the default system prompt unchanged.

**New event** in `AgentSessionEvent`:

```typescript
| { type: "primary_agent_changed"; name: string; previousName: string }
```

**Public accessors**:

```typescript
get currentPrimaryAgent(): string  // returns _currentPrimaryAgent
async listPrimaryAgents(): Promise<PrimaryAgentDefinition[]>
```

## `/agent` Slash Command

**Command**: `/agent [name]`

- No argument: show interactive picker listing all available `PrimaryAgentDefinition`s
- With argument (e.g. `/agent build`, `/agent plan`): switch directly

**Interactive picker** (TUI component):

- List all available roles, mark current role
- Each item shows: role name, description, source (builtin/user/project)
- Keyboard: `j/k` navigate, `Enter` confirm, `Esc` cancel
- On confirm: call `session.switchPrimaryAgent(selectedName)`

**Status bar**:

Display current primary agent name in TUI status bar (alongside model name), so users can see which role is active at a glance.

## File Structure

**New files**:

```
packages/coding-agent/src/core/primary-agents/
  types.ts          -- PrimaryAgentDefinition types
  discovery.ts      -- discover built-in + user + project definitions
  index.ts          -- barrel export
```

**Modified files**:

| File | Change |
|------|--------|
| `agent-session.ts` | Add `_currentPrimaryAgent` state, `switchPrimaryAgent()`, `listPrimaryAgents()`, `currentPrimaryAgent` getter, `primary_agent_changed` event |
| `system-prompt.ts` | Add `primaryAgentPrompt` to `BuildSystemPromptOptions`, inject into prompt |
| `slash-commands.ts` | Register `/agent` command |
| `agents-panel.ts` | Show primary agent roles and current role |
| TUI status bar component | Display current role name |

## Constraints

- Switching is only allowed when agent is idle (not streaming)
- `build` role cannot be removed or overridden to have no system prompt fallback
- Tool filtering respects `_allowedToolNames` from `AgentSessionConfig` (session-level allowlist takes precedence over role definitions)
- Subagent tool is available in all roles unless explicitly excluded
