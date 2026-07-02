import type { ModelClient } from "./model-client";
import { getDefaultModelClient } from "./model-client";

export interface BlindQualityResult {
  verdict: string;
  notes: string;
}

export interface BlindQualityOpts {
  /** Injected for tests (mock ModelClient). Defaults to the real Anthropic-backed client. */
  client?: ModelClient;
}

/**
 * PURE. Assembles the role-A ("blind quality") review prompt: the agent sees ONLY the
 * issue text and styre's diff — never the oracle verdict, never `fix_patch` (that value
 * isn't even a parameter here, so it structurally cannot leak into this prompt). Judges:
 * does the diff address the issue, is there test-gaming, is there obvious scope creep.
 * This is the load-bearing, unit-testable half of `blindQuality` — the model CALL is a
 * separate, mockable step (see `ModelClient`).
 */
export function buildBlindQualityPrompt(issue: string, styreDiff: string): string {
  return [
    "You are reviewing a single code change against the issue it claims to address.",
    "You are given only the issue and the diff -- nothing else.",
    "",
    "## Issue",
    issue,
    "",
    "## Diff",
    styreDiff,
    "",
    "Judge three things: (1) does the diff actually address the issue; (2) is there any",
    "sign of test-gaming (e.g. a test written to trivially pass rather than verify the",
    "fix); (3) is there obvious scope creep beyond what the issue calls for.",
    "",
    'Respond as JSON: {"verdict": "<a short label, e.g. addresses-issue | partial | ' +
      'does-not-address | test-gaming-suspected>", "notes": "<one or two sentences of ' +
      'explanation>"}',
  ].join("\n");
}

/**
 * PURE. Parses the model's raw response text into a `BlindQualityResult`. The prompt asks
 * for strict JSON, but a model response is untrusted free text — a non-JSON reply (or JSON
 * missing the expected shape) falls back to `verdict: "unparsed"` with the raw text as
 * `notes`, rather than throwing (a malformed review is a signal to flag downstream, not a
 * crash).
 */
function parseBlindQualityResponse(raw: string): BlindQualityResult {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      if (typeof obj.verdict === "string") {
        return {
          verdict: obj.verdict,
          notes: typeof obj.notes === "string" ? obj.notes : "",
        };
      }
    }
  } catch {
    // not JSON -- fall through to the raw-text fallback below
  }
  return { verdict: "unparsed", notes: raw.trim() };
}

/**
 * Role A ("blind quality") review: sees ONLY the issue + styre's diff, never the oracle
 * verdict or `fix_patch`. Split as the brief requires -- PROMPT ASSEMBLY
 * (`buildBlindQualityPrompt`, pure, unit-tested) is separate from the model CALL
 * (`opts.client`, mockable/gated; defaults to the real Anthropic client).
 */
export async function blindQuality(
  issue: string,
  styreDiff: string,
  opts: BlindQualityOpts = {},
): Promise<BlindQualityResult> {
  const client = opts.client ?? getDefaultModelClient();
  const prompt = buildBlindQualityPrompt(issue, styreDiff);
  const raw = await client.complete(prompt);
  return parseBlindQualityResponse(raw);
}
