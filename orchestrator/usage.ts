/**
 * Recovers REAL cost and token usage from the `claude` transcript (ENG-390).
 *
 * WHY THIS EXISTS: `run-task.ts`'s wrapper deliberately prints only the terminal `result`
 * event's `.result` field as plain text, so styre's `extractSidecar` sees a real fenced block
 * (a JSON envelope escapes the fence's newlines and never matches). The documented side effect
 * is that styre's `parseClaudeJson` receives plain text and reports `cost_usd`/`tokens_*` as
 * null — for EVERY dispatch. The bench then had nothing measured to report and fell back to a
 * fixed per-attempt estimate, which understated the 2026-09-08 astropy run by ~24x ($0.50
 * reported vs $11.84 actual) and made the run budget unable to fire.
 *
 * The wrapper also TEES the full stream-json to `transcript.jsonl`, so the usage was never
 * lost — only bypassed. This module reads it back. It covers the whole container session,
 * `styre setup`'s own agent calls included, which is why no separate setup estimate is needed
 * once a transcript is available.
 *
 * `null` means UNKNOWN and must never be coerced to `0` by a caller: "we did not measure this"
 * and "this was free" are different claims, and conflating them is what disabled the budget.
 */
export interface TranscriptUsage {
  /** Summed `total_cost_usd` over `result` events; null when none carried a cost. */
  costUsd: number | null;
  /** Summed `usage.input_tokens`; null when no result event reported one. */
  tokensIn: number | null;
  /** Summed `usage.output_tokens`; null when no result event reported one. */
  tokensOut: number | null;
  /** Count of `type:"result"` events seen. 0 means the container produced no agent turn. */
  resultEvents: number;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * PURE. Sums cost and token usage across every `type:"result"` event in a stream-json
 * transcript. Lines that aren't valid JSON (stray container output interleaved into the tee)
 * are skipped rather than throwing — a malformed line must not destroy the whole measurement.
 *
 * Each total stays `null` until at least one event actually reports that field, so a transcript
 * of uncosted events yields `costUsd: null` (unknown) rather than `0` (free).
 */
export function sumTranscriptUsage(text: string): TranscriptUsage {
  let costUsd: number | null = null;
  let tokensIn: number | null = null;
  let tokensOut: number | null = null;
  let resultEvents = 0;

  for (const raw of text.split("\n")) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const obj = parsed as Record<string, unknown>;
    if (obj.type !== "result") continue;
    resultEvents += 1;

    const cost = num(obj.total_cost_usd);
    if (cost !== null) costUsd = (costUsd ?? 0) + cost;

    const usage = (obj.usage ?? {}) as Record<string, unknown>;
    const tin = num(usage.input_tokens);
    if (tin !== null) tokensIn = (tokensIn ?? 0) + tin;
    const tout = num(usage.output_tokens);
    if (tout !== null) tokensOut = (tokensOut ?? 0) + tout;
  }

  return { costUsd, tokensIn, tokensOut, resultEvents };
}
