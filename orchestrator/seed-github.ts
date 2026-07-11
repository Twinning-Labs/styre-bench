import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { $ } from "bun";
import { Octokit } from "octokit";
import { assertNoHeldOutPaths } from "./firewall";
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
  createRepo: (org: string, name: string) => Promise<SeedGithubResult>;
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
  deleteRepo: (org: string, name: string) => Promise<void>;
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

  async createRepo(org, name) {
    const token = process.env.BENCH_GH_TOKEN;
    if (!token) {
      throw new Error(
        "seedGithub: BENCH_GH_TOKEN is not set — a GitHub PAT scoped ONLY to " +
          "benchGithubOrg is required to create/push throwaway repos (blast-radius, see " +
          "task-5 brief). Refusing to fall back to any other credential.",
      );
    }
    const octokit = new Octokit({ auth: token });
    const res = await octokit.rest.repos.createInOrg({
      org,
      name,
      private: true,
      auto_init: false,
      description: "styre-bench throwaway seed repo — safe to delete",
    });
    const repoUrl = res.data.clone_url ?? res.data.html_url;
    if (!repoUrl) {
      throw new Error(`seedGithub: createInOrg for ${org}/${name} returned no clone/html URL`);
    }
    // Disable GitHub Actions on the throwaway repo. The seed snapshot carries the upstream
    // repo's `.github/workflows/*` verbatim (BENCH_GH_TOKEN has the Workflows permission, so
    // the push is allowed), but we do NOT want those workflows to actually RUN: the benchmark
    // scores via the oracle harness, not the repo's own CI, and a throwaway repo firing
    // push/PR/release workflows would burn Actions minutes and could trigger deploy side
    // effects. Best-effort: a disable hiccup must not fail the whole seed (log and continue).
    try {
      await octokit.rest.actions.setGithubActionsPermissionsRepository({
        owner: org,
        repo: name,
        enabled: false,
      });
    } catch (err) {
      console.error(
        `[seed] WARNING: could not disable Actions on ${org}/${name} — its workflows may run: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return { repoUrl, defaultBranch: res.data.default_branch ?? "main" };
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

  async deleteRepo(org, name) {
    const token = process.env.BENCH_GH_TOKEN;
    if (!token) return; // best-effort: no token -> nothing we can (or should) do
    try {
      await new Octokit({ auth: token }).rest.repos.delete({ owner: org, repo: name });
    } catch {
      // best-effort teardown of a half-seeded repo — never mask the original push error
    }
  },
};

export interface SeedGithubOpts {
  /** Override any subset of the side-effecting steps (tests only — production always uses
   *  the real git/Octokit implementations). */
  deps?: Partial<SeedGithubDeps>;
}

/**
 * Exported so it's unit-testable (see tests/seed.test.ts). Appends a short random hex
 * suffix so an infra-retry / re-run / concurrent attempt for the SAME instance never
 * re-seeds the same repo name — a deterministic name collides on GitHub's "name already
 * exists" and both masks the real post-seed error and fails the retry. `cleanup` deletes by
 * the returned `repoUrl`, so the random suffix costs nothing at cleanup time.
 */
export function repoNameFor(inst: Instance): string {
  const slug = inst.id
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const suffix = crypto.randomUUID().slice(0, 8);
  return `bench-${slug || "instance"}-${suffix}`;
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

  const { files, repoDir } = await deps.fetchSnapshot(inst.repo, inst.base_commit);
  try {
    assertNoHeldOutPaths(
      files.map((f) => f.path),
      inst,
    );
    const stripClaude = files.some((f) => f.path === ".claude" || f.path.startsWith(".claude/"));

    const name = repoNameFor(inst);
    const { repoUrl, defaultBranch } = await deps.createRepo(cfg.benchGithubOrg, name);
    try {
      await deps.pushBaseRef(repoDir, inst.base_commit, repoUrl, defaultBranch, { stripClaude });
    } catch (err) {
      // The repo exists but the push failed — tear it down so a push failure never leaves an
      // orphan throwaway repo behind (see deleteRepo's rationale). Then re-throw the ORIGINAL
      // push error unchanged so the pipeline still classifies the attempt as an infra failure.
      await deps.deleteRepo(cfg.benchGithubOrg, name);
      throw err;
    }

    return { repoUrl, defaultBranch };
  } finally {
    // seedGithub owns the clone's lifetime once fetchSnapshot hands it back successfully.
    await rm(repoDir, { recursive: true, force: true });
  }
}
