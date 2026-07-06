import { extractStrippedDiff } from "../orchestrator/collect";
import type { ModelClient } from "./model-client";
import { getDefaultModelClient } from "./model-client";

export type AbPreference = "A(styre)" | "B(human)" | "tie" | "invalid";

export interface AbReviewResult {
  preference: AbPreference;
  notes: string;
}

export interface AbReviewOpts {
  /** Injected for tests (mock ModelClient). Defaults to the real Anthropic-backed client. */
  client?: ModelClient;
}

/** Which real candidate (styre's diff vs the accepted human fix) sits at position "A"
 *  (first) vs "B" (second) in the assembled prompt. */
export interface AbOrder {
  first: "styre" | "human";
  second: "styre" | "human";
}

/**
 * Small stable string hash (djb2). Deterministic, no crypto needed -- used only to derive
 * A/B position parity per instance, never for anything security-sensitive.
 */
function djb2Hash(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 33 + str.charCodeAt(i)) | 0; // |0 keeps it a 32-bit signed int
  }
  return hash;
}

/**
 * PURE. Deterministic (instanceId, runSeed) -> candidate-position mapping: parity of
 * `hash(instanceId) ^ runSeed` picks the order. Keyed off a PER-INSTANCE identifier (not
 * the run-global seed alone) so that a fixed `runSeed` does not pin styre to the same
 * position for every instance in a run -- if it did, the judge's positional bias (not
 * styre-vs-human quality) would dominate the aggregate A/B-preference metric, which is
 * exactly the artifact this blind A/B design exists to kill. Reproducible across runs of
 * the same (instanceId, runSeed) pair, and carries no information about which candidate is
 * "really" styre's (that's exactly the label-neutrality property
 * `buildAbPrompt`/`mapChoiceToPreference` rely on).
 */
export function chooseOrder(instanceId: string, runSeed: number): AbOrder {
  const combined = djb2Hash(instanceId) ^ Math.trunc(runSeed);
  const styreFirst = Math.abs(combined) % 2 === 1;
  return styreFirst ? { first: "styre", second: "human" } : { first: "human", second: "styre" };
}

/**
 * PURE. Assembles the role-B ("blind A/B") review prompt: styre's diff and the accepted
 * `fixPatch` are presented as unlabeled **candidate A / candidate B**, with the order
 * chosen by `(instanceId, runSeed)` (via `chooseOrder`) -- reproducible, and label-neutral
 * (the prompt text itself never says which candidate is which). `docs/plans/` is stripped
 * from styre's diff first (`extractStrippedDiff`, reused from `orchestrator/collect.ts`) --
 * styre always commits its own plan doc alongside the code change, and that must never read
 * as scope creep relative to a human fix that carries no such doc.
 *
 * LABEL-NEUTRALITY IS LOAD-BEARING: this prompt must never contain "accepted", "human",
 * "gold", "reference", or "styre" (case-insensitive) -- see `tests/reviewer.test.ts`.
 */
export function buildAbPrompt(
  issue: string,
  styreDiff: string,
  fixPatch: string,
  instanceId: string,
  runSeed: number,
): string {
  const order = chooseOrder(instanceId, runSeed);
  const strippedStyreDiff = extractStrippedDiff(styreDiff);
  const diffFor = (who: "styre" | "human"): string =>
    who === "styre" ? strippedStyreDiff : fixPatch;

  return [
    "You are comparing two independent code changes that both attempt to address the same",
    "issue below. You are told nothing about where either change came from -- judge each",
    "purely on its own merits.",
    "",
    "## Issue",
    issue,
    "",
    "## Candidate A",
    diffFor(order.first),
    "",
    "## Candidate B",
    diffFor(order.second),
    "",
    "Which candidate better addresses the issue: A, B, or is it a tie? Consider",
    "correctness, completeness, and whether the change stays in scope.",
    "",
    // NOTE: the JSON key is "choice", not "preference" -- "preference" contains the
    // substring "reference", which would trip the label-neutrality invariant this prompt
    // must uphold (never "accepted"/"human"/"gold"/"reference"/"styre", see
    // tests/reviewer.test.ts). `parseAbChoice` below reads this same "choice" key; the
    // public result type still calls the field `preference` -- that's the API surface,
    // not prompt content.
    'Respond as JSON: {"choice": "A" | "B" | "tie", "notes": "<one or two sentences ' +
      'explaining your choice>"}',
  ].join("\n");
}

/**
 * PURE. Parses the model's raw response into a bare "A" | "B" | "tie" | "invalid" choice --
 * untrusted free text, so this does NOT require the requested JSON shape. Tries JSON first
 * (`{"choice": "A"}`); falling back to scanning the free text for "candidate a" / "candidate
 * b" / a standalone "tie" (so a reply like "I prefer candidate A because ..." still parses).
 *
 * "invalid" is a DISTINCT outcome from "tie" -- returned for empty responses, JSON-parse
 * failure with no recognizable free-text signal, or free text that mentions BOTH candidates
 * (ambiguous -- e.g. "Candidate A is worse than Candidate B" mentions "candidate a" first
 * but is clearly NOT a preference for A; guessing the earliest mention would silently invert
 * the verdict). A genuine tie (the model explicitly says so, with no unresolved A-vs-B
 * ambiguity) still returns "tie". Collapsing "invalid" into "tie" would corrupt the
 * (already provisional) A/B-preference metric by treating "the judge said nothing
 * meaningful" the same as "the judge deliberately called it even."
 */
function parseAbChoice(raw: string): "A" | "B" | "tie" | "invalid" {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && "choice" in parsed) {
      const pref = String((parsed as Record<string, unknown>).choice)
        .trim()
        .toLowerCase();
      if (pref === "a") return "A";
      if (pref === "b") return "B";
      if (pref === "tie") return "tie";
    }
  } catch {
    // not JSON -- fall through to the free-text scan below
  }

  const lower = raw.toLowerCase();
  const hasA = lower.includes("candidate a");
  const hasB = lower.includes("candidate b");
  const hasTie = /\btie\b/.test(lower);

  if (hasA && hasB) return "invalid"; // both candidates mentioned -- no reliable signal of intent
  if (hasA) return "A";
  if (hasB) return "B";
  if (hasTie) return "tie";
  return "invalid"; // no signal at all -- empty/refusal/unparseable response
}

/**
 * PURE. Maps the agent's positional A/B/tie/invalid choice back to styre/human identity via
 * `order` -- the SAME literal model choice (e.g. "A") maps to a DIFFERENT identity
 * depending on the order, because `order` itself flips with `(instanceId, runSeed)`. This is
 * what makes the label-neutral presentation reversible without ever telling the model which
 * is which. "invalid" passes through unchanged -- there is no position to resolve it against.
 */
export function mapChoiceToPreference(
  choice: "A" | "B" | "tie" | "invalid",
  order: AbOrder,
): AbPreference {
  if (choice === "tie") return "tie";
  if (choice === "invalid") return "invalid";
  const winner = choice === "A" ? order.first : order.second;
  return winner === "styre" ? "A(styre)" : "B(human)";
}

/**
 * Role B ("blind A/B gold comparison") review: presents styre's diff and the accepted
 * `fixPatch` as unlabeled candidate A/B ((instanceId, runSeed)-ordered, label-neutral -- see
 * `buildAbPrompt`), asks which better addresses the issue, and maps the answer back to
 * styre/human. `instanceId` is REQUIRED (not optional) -- keying the order off a per-instance
 * identifier (XORed with the run-global `runSeed`) is what stops a fixed run seed from
 * pinning styre to the same A/B position for every instance in a run (see `chooseOrder`).
 * Split as the brief requires -- PROMPT ASSEMBLY (`buildAbPrompt` + `chooseOrder` +
 * `mapChoiceToPreference`, pure, unit-tested) is separate from the model CALL
 * (`opts.client`, mockable/gated; defaults to the real Anthropic client). Firewall: this is
 * one of only two places in the whole rig that ever sees `fix_patch` (the other is the
 * scorer), strictly post-hoc.
 */
export async function abReview(
  issue: string,
  styreDiff: string,
  fixPatch: string,
  instanceId: string,
  runSeed: number,
  opts: AbReviewOpts = {},
): Promise<AbReviewResult> {
  const client = opts.client ?? getDefaultModelClient();
  const order = chooseOrder(instanceId, runSeed);
  const prompt = buildAbPrompt(issue, styreDiff, fixPatch, instanceId, runSeed);
  const raw = await client.complete(prompt);
  const choice = parseAbChoice(raw);
  const preference = mapChoiceToPreference(choice, order);
  return { preference, notes: raw.trim() };
}
