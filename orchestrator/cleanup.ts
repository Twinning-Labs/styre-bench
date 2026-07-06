import { LinearClient } from "@linear/sdk";
import { Octokit } from "octokit";
import type { RunSeed } from "./run-task";

/**
 * Everything `cleanup` needs to tear down what a started instance created. `seed` is
 * `undefined` when the run never got past `run_controls`/never reached `seed` (the
 * fail-closed-drop path in `pipeline.ts`) — there is nothing to tear down in that case, and
 * `cleanup` is simply not called for it (see `pipeline.ts`'s `runInstance`, which only
 * enters the try/finally that calls `cleanup` once seeding has actually produced a `RunSeed`).
 * `benchGithubOrg` is carried alongside `seed` only for logging/diagnostics — the repo is
 * looked up by `seed.repoUrl`, not reconstructed from the org + instance id.
 */
export interface CleanupCtx {
  seed: RunSeed;
  /** True if the attempt this cleanup is closing out failed (threw, or finished
   *  `taxonomy:"infra"`) — governs the `retainOnFailure` branch below. */
  failed: boolean;
}

export interface CleanupConfig {
  /** If true, a FAILED attempt's throwaway repo/ticket are left in place (for post-mortem
   *  debugging) instead of deleted. A SUCCESSFUL attempt's repo/ticket are always deleted
   *  regardless of this flag — retention exists to help debug failures, not to accumulate
   *  every run's throwaway artifacts. Default false (delete unconditionally, matching the
   *  brief's "always runs" framing — retention is an opt-in debugging aid). */
  retainOnFailure?: boolean;
}

/**
 * Side-effecting steps, split out (same shape as `build-styre.ts`/`seed-github.ts`/
 * `run-task.ts`) so `cleanup`'s retain-on-failure branching can be unit-tested with stubs —
 * no network, no GitHub/Linear API calls. The default implementations do the real work.
 * There is deliberately no `deleteContainer`/`stopContainer` step: `run-task.ts`'s
 * `buildDockerArgs` always passes `--rm`, so the container is already gone by the time
 * `cleanup` runs — nothing to tear down there. There is likewise no separate
 * `deleteBranch` step: deleting the whole throwaway repo (`deleteGithubRepo`) removes every
 * branch in it, including whatever feature branch styre pushed.
 */
export interface CleanupDeps {
  deleteGithubRepo: (repoUrl: string) => Promise<void>;
  archiveLinearIssue: (ident: string) => Promise<void>;
}

function parseOwnerRepo(repoUrl: string): { owner: string; repo: string } {
  // Handles both the Octokit clone_url form (https://github.com/org/repo.git) and the
  // html_url form (https://github.com/org/repo) that seed-github.ts's createRepo can
  // return (see that file's `repoUrl ?? html_url` fallback).
  const match = repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?\/?$/);
  if (!match || !match[1] || !match[2]) {
    throw new Error(`cleanup: could not parse owner/repo from repoUrl "${repoUrl}"`);
  }
  return { owner: match[1], repo: match[2] };
}

const defaultDeps: CleanupDeps = {
  async deleteGithubRepo(repoUrl) {
    const token = process.env.BENCH_GH_TOKEN;
    if (!token) {
      throw new Error(
        "cleanup: BENCH_GH_TOKEN is not set — the same PAT scoped to benchGithubOrg " +
          "(seed-github.ts) is required to delete the throwaway repo it created.",
      );
    }
    const octokit = new Octokit({ auth: token });
    const { owner, repo } = parseOwnerRepo(repoUrl);
    await octokit.rest.repos.delete({ owner, repo });
  },

  async archiveLinearIssue(ident) {
    const apiKey = process.env.LINEAR_API_KEY;
    if (!apiKey) {
      throw new Error(
        "cleanup: LINEAR_API_KEY is not set — required to archive the throwaway ticket " +
          "seed-linear.ts created.",
      );
    }
    const client = new LinearClient({ apiKey });
    // ASSUMPTION (not exercised outside RUN_LIVE=1 — no live Linear call was made in this
    // session): Linear's `issue(id)` GraphQL query resolves EITHER the internal UUID or the
    // human-readable identifier ("ENG-123", what `seed-linear.ts`'s `seedLinear` returns as
    // `ident`) — documented Linear API behavior, not independently re-verified here. If this
    // turns out wrong at the live gate, swap for an `issueSearch`/filtered `issues()` lookup.
    const issue = await client.issue(ident);
    await issue.archive();
  },
};

export interface CleanupOpts {
  deps?: Partial<CleanupDeps>;
}

/**
 * Tears down everything a started instance attempt created: the throwaway GitHub repo
 * (`seed.repoUrl`) and the throwaway Linear ticket (`seed.ident`). Called from
 * `pipeline.ts`'s `runInstance` in a `finally` block around EVERY attempt (including
 * infra-retried ones) — see that file — so it always runs once seeding has produced a
 * `RunSeed`, whether the attempt subsequently succeeded, produced a scoreable-but-failing
 * record, or threw.
 *
 * Both deletions are attempted even if one throws (`Promise.allSettled`) — a Linear API
 * hiccup must not leave a throwaway GitHub repo behind, and vice versa. If either deletion
 * failed, `cleanup` re-throws an aggregate error (the caller's `runInstance` does NOT let a
 * cleanup failure crash the pipeline — see that file's try/finally wrapping).
 *
 * `cfg.retainOnFailure` (default false): when true AND `ctx.failed`, BOTH deletions are
 * skipped entirely (the repo/ticket are left in place for post-mortem debugging). A
 * successful attempt is always cleaned up regardless of this flag.
 */
export async function cleanup(
  ctx: CleanupCtx,
  cfg: CleanupConfig = {},
  opts: CleanupOpts = {},
): Promise<void> {
  const deps: CleanupDeps = { ...defaultDeps, ...opts.deps };

  if (ctx.failed && cfg.retainOnFailure) {
    return;
  }

  const results = await Promise.allSettled([
    deps.deleteGithubRepo(ctx.seed.repoUrl),
    deps.archiveLinearIssue(ctx.seed.ident),
  ]);

  const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failures.length > 0) {
    const messages = failures.map((f) =>
      f.reason instanceof Error ? f.reason.message : String(f.reason),
    );
    throw new Error(`cleanup: ${failures.length} teardown step(s) failed: ${messages.join("; ")}`);
  }
}
