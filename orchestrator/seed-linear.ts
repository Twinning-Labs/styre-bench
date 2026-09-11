import { LinearClient } from "@linear/sdk";
import { assertNoHeldOut } from "./firewall";
import type { Instance } from "./types";

export interface SeedLinearConfig {
  /** cfg.linearProjectId — the operator's dedicated throwaway "Benchmark" Linear project.
   *  BENCH_CONFIG defaults this to "" (see config/bench.config.ts); it MUST be set to a
   *  real project id before any live seeding run. */
  linearProjectId: string;
}

export interface SeedLinearResult {
  ident: string;
}

export interface CreateIssueInput {
  projectId: string;
  title: string;
  description: string;
  labelNames: string[];
}

/** Side-effecting step, split out (same shape as build-styre.ts/seed-github.ts) so
 *  `seedLinear`'s firewall-then-create ordering can be unit-tested with a stub — no
 *  network, no Linear SDK calls. The default implementation does the real work via
 *  `@linear/sdk`. */
export interface SeedLinearDeps {
  createIssue: (input: CreateIssueInput) => Promise<SeedLinearResult>;
}

const defaultDeps: SeedLinearDeps = {
  async createIssue({ projectId, title, description, labelNames }) {
    const apiKey = process.env.LINEAR_API_KEY;
    if (!apiKey) {
      throw new Error(
        "seedLinear: LINEAR_API_KEY is not set — a key for the dedicated throwaway " +
          "Linear workspace/project is required to seed bench tickets.",
      );
    }
    const client = new LinearClient({ apiKey });

    const project = await client.project(projectId);
    const teams = await project.teams();
    const team = teams.nodes[0];
    if (!team) {
      throw new Error(`seedLinear: Linear project "${projectId}" has no associated team`);
    }

    // first: 250 — an existing label past the SDK's default page size must still be found
    // (a false "not found" would create a duplicate label instead of reusing it).
    const existing = await team.labels({ first: 250 });
    const labelIds: string[] = [];
    for (const name of labelNames) {
      const found = existing.nodes.find((l) => l.name === name);
      if (found) {
        labelIds.push(found.id);
        continue;
      }
      const labelPayload = await client.createIssueLabel({ teamId: team.id, name });
      const created = await labelPayload.issueLabel;
      if (!created) {
        throw new Error(`seedLinear: failed to create the "${name}" label on team ${team.id}`);
      }
      labelIds.push(created.id);
    }

    const issuePayload = await client.createIssue({
      teamId: team.id,
      projectId,
      title,
      description,
      labelIds,
    });
    const issue = await issuePayload.issue;
    if (!issue) {
      throw new Error("seedLinear: createIssue returned no issue");
    }
    return { ident: issue.identifier };
  },
};

export interface SeedLinearOpts {
  /** Override any subset of the side-effecting steps (tests only). */
  deps?: Partial<SeedLinearDeps>;
}

function firstLine(text: string, maxLen: number): string {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > maxLen ? `${line.slice(0, maxLen)}…` : line;
}

/**
 * PURE. Builds the issue title from the first line of `problem_statement` ONLY.
 *
 * `inst.id` is deliberately ABSENT. It used to lead the title (`[bench] astropy__astropy-12907:
 * ...`), which handed the agent the exact public benchmark instance it was solving — the repo,
 * and the upstream issue/PR number that the gold fix landed under. That is a lookup key for a
 * model that memorised the issue, and it is measurably load-bearing: on
 * astropy__astropy-12907 the number 12907 appears NOWHERE in `problem_statement`, yet the agent
 * wrote "use the upstream issue/PR number 12907" and named its changelog fragment
 * `docs/changes/modeling/12907.bugfix.rst`. It could only have come from the identifier the
 * harness supplied.
 *
 * Host-side correlation is unaffected: the run's evidence dir is still named for the instance,
 * `TaskRecord.instance` still carries the id, and `persistSeedMapping` records the ticket ident
 * and throwaway repo URL beside the run's artifacts. Nothing the CONTAINER can read names the
 * instance. See `repoNameFor` for the same change to the other leak path.
 */
export function buildIssueTitle(inst: Instance): string {
  return `[bench] ${firstLine(inst.problem_statement, 120)}`;
}

/** The two halves of a seeded ticket: what the BENCH wrote, and that plus the corpus's own
 *  issue text. Separated so the firewall gate and the overlap measurement each get exactly
 *  the text they are about — see `buildIssueBody`. */
export interface BuiltIssueBody {
  body: string;
  benchAuthored: string;
}

/**
 * PURE. Builds the Linear issue description as What/Why/Scope(IN/OUT)/Acceptance criteria
 * (mirrors the repo's own Linear ticket convention) from ONLY `inst.problem_statement`.
 * `fix_patch`/`test_patch` are never referenced here.
 *
 * Returns the two halves separately (ENG-411). `benchAuthored` is every line the BENCH wrote;
 * `body` is that plus the corpus's verbatim issue text. `seedLinear` hard-gates the former
 * with `assertNoHeldOut` — that check exists to catch a bench bug ("did we compose the patch
 * into a ticket?") and stays fail-closed — and MEASURES the latter with
 * `measureTicketOverlap`, because a real GitHub issue that happens to contain the accepted
 * fix is not a bench bug and cannot be fixed by refusing to run it.
 *
 * NO `## Refs` SECTION. It carried `hints_text` and nothing else; see `corpus.ts` for why
 * that field is no longer read at all.
 *
 * ACCEPTANCE CRITERIA — exactly ONE `- [ ]` item, by design (styre main #67, verify
 * M1–M6). styre derives one AC per GFM `- [ ]` line and, at design time, `checks:dispatch`
 * must author a RED-first *scoped* behavioral test for each AC or it throws → escalates.
 * Only "the bug no longer reproduces" maps to such a test (and to the oracle's fail_to_pass).
 * The former "existing tests still pass" / "a regression test is added" items were meta-
 * criteria with no RED-first behavioral test — they risked a no-valid-check escalate with no
 * gate value. Non-regression ("existing tests still pass") is already carried by styre's
 * advisory whole-suite sweep (M4, non-gating) surfaced to the merging human (M6), and is
 * stated as Scope-IN guidance below; a regression test is what `checks:dispatch` authors
 * anyway. So the gate is the single behavioral criterion; the rest is guidance, not a gate.
 */
export function buildIssueBody(inst: Instance): BuiltIssueBody {
  // Everything the BENCH writes. Kept as its own array so the firewall can be pointed at it
  // exactly, with no string surgery to separate it from the corpus text below.
  const benchAuthored = [
    "## Why",
    "A bug reported against the seeded repo at its pre-fix commit; styre should design, " +
      "implement, and verify a fix end to end.",
    "",
    "## Scope",
    "**IN:** fix the behavior described above so the repo's existing test suite (plus any " +
      "styre-authored regression test) passes.",
    "**OUT:** unrelated refactors, dependency upgrades, or changes outside the affected " +
      "behavior.",
    "",
    "## Acceptance criteria",
    "- [ ] The reported bug no longer reproduces",
  ];
  return {
    body: ["## What", inst.problem_statement.trim(), "", ...benchAuthored].join("\n"),
    benchAuthored: benchAuthored.join("\n"),
  };
}

/**
 * Creates a Linear issue in `cfg.linearProjectId` from `inst.problem_statement`, labeled `Bug`.
 *
 * FIREWALL: `assertNoHeldOut` runs over the BENCH-AUTHORED half of the description BEFORE
 * `deps.createIssue` is ever called — nothing the bench writes may contain a line from
 * `inst.fix_patch`/`inst.test_patch`. It no longer covers the corpus's verbatim
 * `problem_statement`: that text is a public GitHub issue written before any fix existed, so
 * an overlap there is a property of the instance, not a leak by the bench. ENG-411 replaced
 * that block (30.8% of SWE-bench Verified) with `measureTicketOverlap`, recorded per record
 * and reported as a clean-subset resolve rate alongside the headline.
 */
export async function seedLinear(
  inst: Instance,
  cfg: SeedLinearConfig,
  opts: SeedLinearOpts = {},
): Promise<SeedLinearResult> {
  const deps: SeedLinearDeps = { ...defaultDeps, ...opts.deps };

  const title = buildIssueTitle(inst);
  const { body: description, benchAuthored } = buildIssueBody(inst);
  // ENG-411: the GATE covers what the bench wrote — a held-out line here is a bench bug and
  // must stop the seed. The corpus's own `problem_statement` is measured instead, by
  // `measureTicketOverlap` in the pipeline, and never blocks: see that function's doc.
  assertNoHeldOut(benchAuthored, inst);

  return deps.createIssue({
    projectId: cfg.linearProjectId,
    title,
    description,
    labelNames: ["Bug"],
  });
}
