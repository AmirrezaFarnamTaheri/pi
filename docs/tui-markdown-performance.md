# Streamed Markdown render reuse

The interactive assistant renderer now reuses cached Markdown layout for earlier
unchanged text blocks while streaming *when no extension Markdown transformers
are registered*. It still refreshes changed trailing blocks and after the
streaming state changes. Theme invalidation and changes to the visible thinking
blocks continue to use their existing APIs.

**Compatibility:** Extension Markdown transformers are arbitrary callbacks that
may depend on mutable state. For messages using extensions, the renderer still
calls `setText()` on every reused block to preserve the old transform behavior.
The optimization never skips those callback invocations.

The Vitest regression in `assistant-message.test.ts` checks that the
unchanged block does not reset its cache, that the changed block does, that
end-of-stream invalidation still happens, and that extension transformers are
reevaluated even when source text is identical.

To compare work against the original release, use the same Node version,
hardware, terminal width and benchmark fixture on both commits:

```bash
npm ci --ignore-scripts
npm run hydrate:model-data
npm run build:offline
node scripts/bench-tui-streaming.mjs --updates 50
```

The benchmark calls the compiled production assistant renderer (12 measured
samples, three warmups), records median/p95 total render time, and exercises a
long stable Markdown block alongside a growing streamed tail. Do not claim
speedup without repeatable measurements from both versions on identical hardware.
This is not yet full incremental virtualization: other TUI children may still
render during whole-screen refresh.
