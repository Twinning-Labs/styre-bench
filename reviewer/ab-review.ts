import { extractStrippedDiff } from "../orchestrator/collect";
import type { ModelClient } from "./model-client";
import { getDefaultModelClient } from "./model-client";

export type AbPreference = "A(styre)" | "B(human)" | "tie";

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
 * PURE. Deterministic seed -> candidate-position mapping: odd seeds put styre at "A"
 * (first), even seeds put styre at "B" (second). A function of `seed` ONLY -- never of
 * diff content -- so it's reproducible across runs of the same seed and carries no
 * information about which candidate is "really" styre's (that's exactly the
 * label-neutrality property `buildAbPrompt`/`mapChoiceToPreference` rely on).
 */
export function chooseOrder(seed: number): AbOrder {
  const styreFirst = Math.abs(Math.trunc(seed)) % 2 === 1;
  return styreFirst ? { first: "styre", second: "human" } : { first: "human", second: "styre" };
}

/**
 * PURE. Assembles the role-B ("blind A/B") review prompt: styre's diff and the accepted
 * `fixPatch` are presented as unlabeled **candidate A / candidate B**, with the order
 * chosen by `seed` (via `chooseOrder`) -- reproducible, and label-neutral (the prompt text
 * itself never says which candidate is which). `docs/plans/` is stripped from styre's diff
 * first (`extractStrippedDiff`, reused from `orchestrator/collect.ts`) -- styre always
 * commits its own plan doc alongside the code change, and that must never read as scope
 * creep relative to a human fix that carries no such doc.
 *
 * LABEL-NEUTRALITY IS LOAD-BEARING: this prompt must never contain "accepted", "human",
 * "gold", "reference", or "styre" (case-insensitive) -- see `tests/reviewer.test.ts`.
 */
export function buildAbPrompt(
  issue: string,
  styreDiff: string,
  fixPatch: string,
  seed: number,
): string {
  const order = chooseOrder(seed);
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
 * PURE. Parses the model's raw response into a bare "A" | "B" | "tie" choice -- untrusted
 * free text, so this does NOT require the requested JSON shape. Tries JSON first
 * (`{"preference": "A"}`); falling back to scanning for the earliest of "candidate a",
 * "candidate b", or a standalone "tie" in the text (so a reply like "I prefer candidate A
 * because ..." still parses). Ambiguous/unparseable text defaults to "tie" -- absent a
 * clear signal, treating it as a decisive A or B would fabricate a preference.
 */
function parseAbChoice(raw: string): "A" | "B" | "tie" {
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
  const candidates: Array<{ label: "A" | "B" | "tie"; idx: number }> = (
    [
      { label: "A", idx: lower.indexOf("candidate a") },
      { label: "B", idx: lower.indexOf("candidate b") },
      { label: "tie", idx: lower.search(/\btie\b/) },
    ] as const
  ).filter((c) => c.idx !== -1);

  candidates.sort((x, y) => x.idx - y.idx);
  const winner = candidates[0];
  return winner ? winner.label : "tie";
}

/**
 * PURE. Maps the agent's positional A/B/tie choice back to styre/human identity via
 * `order` -- the SAME literal model choice (e.g. "A") maps to a DIFFERENT identity
 * depending on `seed`, because `order` itself flips with the seed. This is what makes the
 * label-neutral presentation reversible without ever telling the model which is which.
 */
export function mapChoiceToPreference(choice: "A" | "B" | "tie", order: AbOrder): AbPreference {
  if (choice === "tie") return "tie";
  const winner = choice === "A" ? order.first : order.second;
  return winner === "styre" ? "A(styre)" : "B(human)";
}

/**
 * Role B ("blind A/B gold comparison") review: presents styre's diff and the accepted
 * `fixPatch` as unlabeled candidate A/B (seed-ordered, label-neutral -- see
 * `buildAbPrompt`), asks which better addresses the issue, and maps the answer back to
 * styre/human. Split as the brief requires -- PROMPT ASSEMBLY (`buildAbPrompt` +
 * `chooseOrder` + `mapChoiceToPreference`, pure, unit-tested) is separate from the model
 * CALL (`opts.client`, mockable/gated; defaults to the real Anthropic client). Firewall:
 * this is one of only two places in the whole rig that ever sees `fix_patch` (the other is
 * the scorer), strictly post-hoc.
 */
export async function abReview(
  issue: string,
  styreDiff: string,
  fixPatch: string,
  seed: number,
  opts: AbReviewOpts = {},
): Promise<AbReviewResult> {
  const client = opts.client ?? getDefaultModelClient();
  const order = chooseOrder(seed);
  const prompt = buildAbPrompt(issue, styreDiff, fixPatch, seed);
  const raw = await client.complete(prompt);
  const choice = parseAbChoice(raw);
  const preference = mapChoiceToPreference(choice, order);
  return { preference, notes: raw.trim() };
}
