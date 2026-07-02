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

/** PURE. Builds the issue title from `inst.id` + the first line of `problem_statement`. */
export function buildIssueTitle(inst: Instance): string {
  return `[bench] ${inst.id}: ${firstLine(inst.problem_statement, 100)}`;
}

/**
 * PURE. Builds the Linear issue description as What/Why/Scope(IN/OUT)/Acceptance
 * criteria/Refs (mirrors the repo's own Linear ticket convention) from ONLY
 * `inst.problem_statement` (+ `inst.hints`). Contains ONLY issue text — `fix_patch`/
 * `test_patch` are never referenced here. The caller (`seedLinear`) additionally runs
 * `assertNoHeldOut` over the result as a defense-in-depth firewall check before it is
 * ever sent to Linear.
 */
export function buildIssueBody(inst: Instance): string {
  const hints = inst.hints?.trim();
  return [
    "## What",
    inst.problem_statement.trim(),
    "",
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
    "- [ ] Existing tests still pass",
    "- [ ] A regression test covering this bug is added",
    "",
    "## Refs",
    hints && hints.length > 0 ? hints : "(none)",
  ].join("\n");
}

/**
 * Creates a Linear issue in `cfg.linearProjectId` from `inst.problem_statement`(+`hints`),
 * labeled `Bug`.
 *
 * FIREWALL: `assertNoHeldOut` runs over the built description BEFORE `deps.createIssue` is
 * ever called — the description must contain ONLY issue text, never a line from
 * `inst.fix_patch`/`inst.test_patch` (this also catches the edge case where
 * `problem_statement` itself happens to quote held-out content verbatim).
 */
export async function seedLinear(
  inst: Instance,
  cfg: SeedLinearConfig,
  opts: SeedLinearOpts = {},
): Promise<SeedLinearResult> {
  const deps: SeedLinearDeps = { ...defaultDeps, ...opts.deps };

  const title = buildIssueTitle(inst);
  const description = buildIssueBody(inst);
  assertNoHeldOut(description, inst);

  return deps.createIssue({
    projectId: cfg.linearProjectId,
    title,
    description,
    labelNames: ["Bug"],
  });
}
