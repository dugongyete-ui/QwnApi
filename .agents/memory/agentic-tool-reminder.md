---
name: Agentic tool reminder re-injection
description: Why and how the gateway appends a tool reminder at the END of the prompt for long agentic sessions to prevent "lazy" plain-text responses.
---

# Agentic Tool Reminder Re-injection

## The Rule
When `hasTools=true`, append a compact tool reminder at the **end** of `qwenMessageContent`, after `messagesToTextPrompt()` builds the full prompt string.

**Why:** The full tool definitions are injected at the start via `injectToolPrompt()`. In long agentic sessions (10+ turns, many tool calls), that system block gets diluted — the model's attention spreads across hundreds of tokens and it reverts to generating plain text instead of calling tools. Appending a short reminder at the very end keeps it close to where the model generates its next token.

**How to apply:** In `src/routes/v1.ts`, after building `_basePrompt`:
```typescript
const qwenMessageContent = hasTools
  ? _basePrompt +
    "\n\n---\n" +
    "TOOL REMINDER: You are in the middle of an ongoing task. " +
    "If you still need data or have not completed all required steps, " +
    "call a tool now using the JSON format: " +
    '{"tool_calls":[{"name":"TOOL_NAME","arguments":{...}}]}. ' +
    "Do NOT write a final analysis or conclusion until you have gathered all necessary data."
  : _basePrompt;
```

## Why NOT context trimming
The use case is a long-running autonomous agent that maintains full awareness of its work history. Trimming would cause the agent to "forget" previous steps. The reminder approach preserves full context while fixing the attention dilution problem.
