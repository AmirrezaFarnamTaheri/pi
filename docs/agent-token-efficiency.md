# Optional historical tool-result context budget

Default agent behavior is **unchanged**. Applications may opt into shortening *older successful single-text* tool results before each provider call using the existing `transformContext` hook:

```ts
import { compactHistoricalToolResults } from "@earendil-works/pi-agent-core";

const previous = agent.transformContext;
agent.transformContext = async (messages, signal) => {
  const transformed = previous ? await previous(messages, signal) : messages;
  return compactHistoricalToolResults(transformed, {
    maxCharsPerToolResult: 2048,
    keepRecentResults: 2,
  }).messages;
};
```

The helper does not mutate the original transcript, does not change tool-call IDs or role/order, never abbreviates an error, always preserves the most recent two tool-result messages, and skips image-bearing and multi-block results. It retains the beginning and end of older single-text output and inserts an explicit abbreviation marker suggesting re-reading the full output when required.

The API reports `savedChars` in UTF-16 characters, not actual provider tokens or dollars. Tokenization and billing depend on the selected model/provider. The policy is deliberately opt-in, because omitting tool output may force additional reads or harm correctness. Measure prompt cost and externally graded coding-task success against an identical full-context baseline before enabling it in an agent application.

Potential follow-up experiments, each independently tested: preserve structured task-critical paths and stack traces, use provider-specific tokenizer counts, deduplicate identical outputs, stabilize prompt prefixes, and implement versioned context-projection reuse. None is enabled by this PR.
