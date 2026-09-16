import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { $ } from "bun";
import { assertNoHeldOutPaths } from "./firewall";
import { createOwnedRepo, createSeedClient, deleteOwnedRepo } from "./seed-repo";
import type { OwnedRepo, SeedEvent } from "./seed-repo";
import type { Instance } from "./types";

export interface SeedGithubConfig {
  /** cfg.benchGithubOrg — the throwaway org every seeded repo is created under. */
  benchGithubOrg: string;
}

export interface SnapshotFile {
  path: string;
  content: string;
}

export interface SeedGithubResult {
  repoUrl: string;
  defaultBranch: string;
  ownedRepo?: OwnedRepo;
}

/**
 * Side-effecting steps, split out (same shape as `build-styre.ts`'s `BuildStyreDeps`) so
 * `seedGithub`'s firewall/strip/push-ordering logic can be unit-tested with stubs — no
 * network, no git, no GitHub API. The default implementations do the real work: a shallow
 * clone of the upstream instance repo at `base_commit` (read-only source), a GitHub repo
 * create via Octokit, and a git push of the (post-firewall, post-strip) snapshot.
 */
export interface SeedGithubDeps {
  /** Clones `repo` and checks out `baseCommit`, returning both its file listing (fed to
   *  `assertNoHeldOutPaths` and the `stripClaude` decision) and the live clone dir `repoDir`
   *  that `pushBaseRef` pushes from. `seedGithub` owns cleanup of `repoDir` on every path;
   *  `fetchSnapshot` cleans up after itself only on its own internal failure (clone/fetch/
   *  checkout), since in that case `repoDir` is never handed back to the caller. */
  fetchSnapshot: (
    repo: string,
    baseCommit: string,
  ) => Promise<{ files: SnapshotFile[]; repoDir: string }>;
  createRepo: (
    org: string,
    name: string,
    emit?: (event: SeedEvent) => Promise<void>,
  ) => Promise<SeedGithubResult>;
  /** Publish the REAL `baseCommit` (its ancestry included, nothing after it) as `branch` on
   *  `repoUrl`. styre's fix branch — rooted at the same content-addressed `baseCommit` in the
   *  container clone — then shares it as the PR merge-base, so the PR opens and `git diff
   *  baseCommit..head` is unaffected. Pushing only the `baseCommit`-rooted ref keeps every commit
   *  after it (incl. the gold fix) unreachable in the throwaway repo. `stripClaude` layers ONE
   *  commit removing `.claude/` on top (defense-in-depth) — never rewrites `baseCommit`. */
  pushBaseRef: (
    repoDir: string,
    baseCommit: string,
    repoUrl: string,
    branch: string,
    opts: { stripClaude: boolean },
  ) => Promise<void>;
  /** Best-effort teardown of a repo that was created but never fully seeded (a push failure
   *  after createRepo). cleanup() only runs for attempts that produced a complete RunSeed, so
   *  a mid-seed failure here is seedGithub's own responsibility to clean up — otherwise every
   *  failed push leaks an orphan throwaway repo (observed: 14 accumulated in the first smoke). */
  deleteRepo: (org: string, name: string, ownedRepo?: OwnedRepo) => Promise<void>;
}

/** Guards every default dep that pushes/writes to the throwaway org — a scoped
 *  `BENCH_GH_TOKEN` PAT is required; never fall back to an ambient credential (blast-radius). */
function requireBenchToken(action: string): string {
  const token = process.env.BENCH_GH_TOKEN;
  if (!token) {
    throw new Error(
      `seedGithub: BENCH_GH_TOKEN is not set — required to ${action}. It is a PAT scoped ONLY to benchGithubOrg; refusing to fall back to any ambient credential.`,
    );
  }
  return token;
}

export const defaultDeps: SeedGithubDeps = {
  async fetchSnapshot(repo, baseCommit) {
    const repoDir = await mkdtemp(path.join(tmpdir(), "styre-bench-seed-src-"));
    try {
      await $`git clone --quiet https://github.com/${repo}.git ${repoDir}`.quiet();
      // Fetch first so a base_commit not reachable from the default branch tip (e.g. a
      // shallow default clone) is still checkoutable; ignore failure and let checkout be
      // the real check (mirrors build-styre.ts's checkout dep).
      await $`git -C ${repoDir} fetch --quiet origin ${baseCommit}`.quiet().nothrow();
      await $`git -C ${repoDir} checkout --quiet ${baseCommit}`.quiet();
      const lsOut = await $`git -C ${repoDir} ls-files`.quiet().text();
      const paths = lsOut
        .split("\n")
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
      const files: SnapshotFile[] = [];
      for (const p of paths) {
        const content = await readFile(path.join(repoDir, p), "utf8").catch(() => "");
        files.push({ path: p, content });
      }
      return { files, repoDir };
    } catch (err) {
      // Clone/fetch/checkout failed before we could hand `repoDir` to the caller — clean it up
      // here (the caller's finally only covers the success path), then rethrow unchanged.
      await rm(repoDir, { recursive: true, force: true });
      throw err;
    }
  },

  async createRepo(org, name, emit) {
    return createOwnedRepo(
      createSeedClient(requireBenchToken("create a throwaway repo")),
      org,
      name,
      emit,
    );
  },

  async pushBaseRef(repoDir, baseCommit, repoUrl, branch, opts) {
    // Local branch AT base_commit: the pushed ref is rooted here, so its ancestors travel and every
    // commit AFTER base_commit stays unreachable in the throwaway repo (leak firewall).
    await $`git -C ${repoDir} checkout -q -B ${branch} ${baseCommit}`.quiet();
    if (opts.stripClaude) {
      // Remove .claude/ at the TIP with one commit on top of base_commit — base_commit stays the
      // shared ancestor. `--ignore-unmatch` + nothrow keep it a no-op when there is no .claude/.
      await $`git -C ${repoDir} rm -r -q --ignore-unmatch .claude`.quiet().nothrow();
      await $`git -C ${repoDir} -c user.email=bench@styre.dev -c user.name=styre-bench commit -q -m "seed: strip .claude/"`
        .quiet()
        .nothrow(); // nothrow: nothing staged (no .claude present) → no commit; tip stays base_commit
    }
    // file:// remotes (tests) carry no credential; a real https remote gets the scoped token.
    const pushUrl = /^https:\/\//.test(repoUrl)
      ? repoUrl.replace(
          /^https:\/\//,
          `https://x-access-token:${requireBenchToken("push the base_commit ref")}@`,
        )
      : repoUrl;
    await $`git -C ${repoDir} push -q ${pushUrl} ${branch}:${branch}`
      .env({ ...process.env, GIT_TERMINAL_PROMPT: "0" })
      .quiet();
  },

  async deleteRepo(org, name, ownedRepo) {
    if (!ownedRepo || ownedRepo.org !== org || ownedRepo.name !== name) {
      throw new Error(`seedGithub: refusing rollback without ownership for ${org}/${name}`);
    }
    await deleteOwnedRepo(createSeedClient(requireBenchToken("roll back a seed")), ownedRepo);
  },
};

export interface SeedGithubOpts {
  /** Override any subset of the side-effecting steps (tests only — production always uses
   *  the real git/Octokit implementations). */
  deps?: Partial<SeedGithubDeps>;
  emit?: (event: SeedEvent) => Promise<void>;
}

/**
 * Exported so it's unit-testable (see tests/seed.test.ts). Appends a short random hex
 * suffix so an infra-retry / re-run / concurrent attempt for the SAME instance never
 * re-seeds the same repo name — a deterministic name collides on GitHub's "name already
 * exists" and both masks the real post-seed error and fails the retry. `cleanup` deletes by
 * the returned `repoUrl`, so the random suffix costs nothing at cleanup time.
 */
export function repoNameFor(_inst: Instance): string {
  // OPAQUE ON PURPOSE — the instance id must not appear here.
  //
  // This name becomes the throwaway repo's URL, which the entrypoint sets as `origin` inside
  // the container. The old name embedded the instance slug, so it read
  //     styre-bench-scratch/bench-astropy__astropy-12907-e2bddaff.git
  // and any `git remote -v` told the agent exactly which public benchmark instance it was
  // solving, including the upstream issue/PR number the gold fix landed under. That is the same
  // leak `buildIssueTitle` carried, through a second path, so fixing only the ticket title would
  // have been cosmetic.
  //
  // Correlation stays host-side: the evidence dir is named for the instance, `TaskRecord`
  // carries it, and `persistSeedMapping` writes {instance, repo_url, ident} beside the run's
  // artifacts — so an orphaned throwaway repo is still traceable to its run.
  return `bench-${crypto.randomUUID().replace(/-/g, "")}`;
}

/**
 * Creates a throwaway repo under `cfg.benchGithubOrg` and pushes the REAL `inst.base_commit`
 * ref (its ancestry included, nothing after it) as its default branch — see `pushBaseRef`'s
 * doc-comment for why this must be real shared history, not a fresh-init snapshot commit
 * (styre's fix branch needs a common ancestor with `main` for its PR to open).
 *
 * FIREWALL (load-bearing, in this exact order):
 * 1. Fetch the snapshot at `base_commit` (`fetchSnapshot` also keeps the live clone dir,
 *    which is what actually gets pushed).
 * 2. `assertNoHeldOutPaths` — throws (never pushes) if any path touched by `test_patch`/
 *    `fix_patch` is present in that snapshot. Checked BEFORE the repo is even created, so a
 *    firewall violation never results in a throwaway repo existing with tainted content.
 * 3. Only then: create the repo (Octokit, `BENCH_GH_TOKEN` scoped to `benchGithubOrg`) and
 *    `pushBaseRef` the `base_commit`-rooted ref. `stripClaude` (computed from whether the
 *    snapshot has any `.claude/` path) layers ONE on-top commit removing `.claude/` — defense-
 *    in-depth so a real repo's own Claude config can't re-enable WebFetch/WebSearch and
 *    silently break the web-off cohort — without rewriting `base_commit` itself.
 *
 * Note: pushing full ancestry (a real clone, one ref) is heavier per instance than the old
 * fresh-init single snapshot commit. That's expected — it's inherent to publishing a real
 * shared ancestor rather than a synthetic one.
 */
export async function seedGithub(
  inst: Instance,
  cfg: SeedGithubConfig,
  opts: SeedGithubOpts = {},
): Promise<SeedGithubResult> {
  const deps: SeedGithubDeps = { ...defaultDeps, ...opts.deps };
  const emit = async (event: SeedEvent): Promise<void> => {
    try {
      await opts.emit?.(event);
    } catch {
      console.error("[seed] could not record GitHub seed event");
    }
  };

  const { files, repoDir } = await deps.fetchSnapshot(inst.repo, inst.base_commit);
  try {
    assertNoHeldOutPaths(
      files.map((f) => f.path),
      inst,
    );
    const stripClaude = files.some((f) => f.path === ".claude" || f.path.startsWith(".claude/"));

    const name = repoNameFor(inst);
    const result = await deps.createRepo(cfg.benchGithubOrg, name, emit);
    const { repoUrl, defaultBranch } = result;
    try {
      await deps.pushBaseRef(repoDir, inst.base_commit, repoUrl, defaultBranch, { stripClaude });
    } catch (err) {
      // The repo exists but the push failed — tear it down so a push failure never leaves an
      // orphan throwaway repo behind (see deleteRepo's rationale). Then re-throw the ORIGINAL
      // push error unchanged so the pipeline still classifies the attempt as an infra failure.
      try {
        await deps.deleteRepo(cfg.benchGithubOrg, name, result.ownedRepo);
        await emit({ phase: "rolled-back", org: cfg.benchGithubOrg, name });
      } catch {
        console.error(
          `[seed] rollback failed for ${cfg.benchGithubOrg}/${name}; inspect seed-events.ndjson`,
        );
        await emit({ phase: "rollback-failed", org: cfg.benchGithubOrg, name });
      }
      throw err;
    }

    return result;
  } finally {
    // seedGithub owns the clone's lifetime once fetchSnapshot hands it back successfully.
    await rm(repoDir, { recursive: true, force: true });
  }
}
