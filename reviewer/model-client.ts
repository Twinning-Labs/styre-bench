import Anthropic from "@anthropic-ai/sdk";

/** Design/review model tier (CLAUDE.md: "design/review = Opus"). Both reviewer roles in
 *  this module are outside, independent reviewers — they judge styre's work, so they get
 *  the review-tier model regardless of which model styre itself used to produce the diff. */
export const REVIEW_MODEL = "claude-opus-4-8";

/**
 * Minimal model-call abstraction. `blindQuality`/`abReview` depend on this interface, not
 * on the Anthropic SDK directly — every unit test in this repo injects a mock `ModelClient`
 * (see `tests/reviewer.test.ts`), so PROMPT ASSEMBLY (pure, deterministic) is fully
 * unit-testable without a live model call. `getDefaultModelClient` below is the one real
 * implementation, and the only place that touches the network or requires
 * `ANTHROPIC_API_KEY`.
 */
export interface ModelClient {
  complete(prompt: string): Promise<string>;
}

let cached: ModelClient | undefined;

/**
 * Real Anthropic-backed `ModelClient`, constructed lazily on first use. Because it's lazy,
 * importing this module — or importing `blindQuality`/`abReview`, which import this module
 * — never constructs an `Anthropic` client or touches `ANTHROPIC_API_KEY`; only an actual
 * live call (never exercised in the unit suite, which always injects a mock) does.
 * `new Anthropic()` with no args resolves credentials from the environment
 * (`ANTHROPIC_API_KEY`, matching `.env.example`'s "used by ... the reviewer's model calls").
 */
export function getDefaultModelClient(): ModelClient {
  if (!cached) {
    cached = {
      async complete(prompt: string): Promise<string> {
        const client = new Anthropic();
        const response = await client.messages.create({
          model: REVIEW_MODEL,
          // 4096, not 1024: with adaptive thinking a thinking-heavy turn can otherwise
          // truncate mid-response, which then parses as unparsed/invalid and degrades
          // judgment metrics (overall-review Fix 4).
          max_tokens: 4096,
          thinking: { type: "adaptive" },
          messages: [{ role: "user", content: prompt }],
        });
        const textBlock = response.content.find(
          (block): block is Anthropic.TextBlock => block.type === "text",
        );
        return textBlock?.text ?? "";
      },
    };
  }
  return cached;
}
