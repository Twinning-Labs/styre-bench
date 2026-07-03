import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { $ } from "bun";
import { Octokit } from "octokit";
import { assertNoHeldOutPaths, stripClaudeDir } from "./firewall";
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
  fetchSnapshot: (repo: string, baseCommit: string) => Promise<SnapshotFile[]>;
  createRepo: (org: string, name: string) => Promise<SeedGithubResult>;
  pushSnapshot: (files: SnapshotFile[], repoUrl: string, branch: string) => Promise<void>;
  /** Best-effort teardown of a repo that was created but never fully seeded (a push failure
   *  after createRepo). cleanup() only runs for attempts that produced a complete RunSeed, so
   *  a mid-seed failure here is seedGithub's own responsibility to clean up — otherwise every
   *  failed push leaks an orphan throwaway repo (observed: 14 accumulated in the first smoke). */
  deleteRepo: (org: string, name: string) => Promise<void>;
}

const defaultDeps: SeedGithubDeps = {
  async fetchSnapshot(repo, baseCommit) {
    const scratch = await mkdtemp(path.join(tmpdir(), "styre-bench-seed-src-"));
    try {
      await $`git clone --quiet https://github.com/${repo}.git ${scratch}`.quiet();
      // Fetch first so a base_commit not reachable from the default branch tip (e.g. a
      // shallow default clone) is still checkoutable; ignore failure and let checkout be
      // the real check (mirrors build-styre.ts's checkout dep).
      await $`git -C ${scratch} fetch --quiet origin ${baseCommit}`.quiet().nothrow();
      await $`git -C ${scratch} checkout --quiet ${baseCommit}`.quiet();
      const lsOut = await $`git -C ${scratch} ls-files`.quiet().text();
      const paths = lsOut
        .split("\n")
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
      const files: SnapshotFile[] = [];
      for (const p of paths) {
        const content = await readFile(path.join(scratch, p), "utf8").catch(() => "");
        files.push({ path: p, content });
      }
      return files;
    } finally {
      await rm(scratch, { recursive: true, force: true });
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

  async pushSnapshot(files, repoUrl, branch) {
    const token = process.env.BENCH_GH_TOKEN;
    if (!token) {
      throw new Error(
        "seedGithub: BENCH_GH_TOKEN is not set — required to push the seed snapshot to the " +
          "throwaway repo. Refusing to fall back to an ambient git credential helper: that " +
          "would authenticate as a personal identity (violating the throwaway-org blast-radius " +
          "isolation) and would fail headless/CI where no keychain exists.",
      );
    }
    // Embed the scoped token in the push URL so the push authenticates as BENCH_GH_TOKEN
    // (scoped ONLY to benchGithubOrg), NEVER via whatever the local git credential helper
    // happens to hold. GIT_TERMINAL_PROMPT=0 makes a bad/absent credential fail fast instead
    // of blocking on an interactive username prompt.
    const authedUrl = repoUrl.replace(/^https:\/\//, `https://x-access-token:${token}@`);
    const scratch = await mkdtemp(path.join(tmpdir(), "styre-bench-seed-push-"));
    try {
      await $`git -C ${scratch} init --quiet -b ${branch}`.quiet();
      for (const f of files) {
        const dest = path.join(scratch, f.path);
        await mkdir(path.dirname(dest), { recursive: true });
        await writeFile(dest, f.content);
      }
      await $`git -C ${scratch} add -A`.quiet();
      await $`git -C ${scratch} -c user.email=bench@styre.dev -c user.name=styre-bench commit --quiet -m "seed: base_commit snapshot"`
        .quiet()
        .nothrow(); // nothrow: an empty snapshot (e.g. a unit test with zero files) has nothing to commit
      await $`git -C ${scratch} push --quiet ${authedUrl} HEAD:${branch}`
        .env({ ...process.env, GIT_TERMINAL_PROMPT: "0" })
        .quiet();
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
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
 * Creates a throwaway repo under `cfg.benchGithubOrg` and pushes the `inst.base_commit`
 * snapshot of `inst.repo` as its default branch.
 *
 * FIREWALL (load-bearing, in this exact order):
 * 1. Fetch the snapshot at `base_commit`.
 * 2. `assertNoHeldOutPaths` — throws (never pushes) if any path touched by `test_patch`/
 *    `fix_patch` is present in that snapshot. Checked BEFORE the repo is even created, so a
 *    firewall violation never results in a throwaway repo existing with tainted content.
 * 3. `stripClaudeDir` — unconditionally removes any `.claude/` path (esp.
 *    `.claude/settings.json`) so a real repo's own Claude config can't re-enable
 *    WebFetch/WebSearch and silently break the web-off cohort.
 * 4. Only then: create the repo (Octokit, `BENCH_GH_TOKEN` scoped to `benchGithubOrg`) and
 *    push the cleaned snapshot.
 */
export async function seedGithub(
  inst: Instance,
  cfg: SeedGithubConfig,
  opts: SeedGithubOpts = {},
): Promise<SeedGithubResult> {
  const deps: SeedGithubDeps = { ...defaultDeps, ...opts.deps };

  const snapshot = await deps.fetchSnapshot(inst.repo, inst.base_commit);
  assertNoHeldOutPaths(
    snapshot.map((f) => f.path),
    inst,
  );
  const cleaned = stripClaudeDir(snapshot);

  const name = repoNameFor(inst);
  const { repoUrl, defaultBranch } = await deps.createRepo(cfg.benchGithubOrg, name);
  try {
    await deps.pushSnapshot(cleaned, repoUrl, defaultBranch);
  } catch (err) {
    // The repo exists but the push failed — tear it down so a push failure never leaves an
    // orphan throwaway repo behind (see deleteRepo's rationale). Then re-throw the ORIGINAL
    // push error unchanged so the pipeline still classifies the attempt as an infra failure.
    await deps.deleteRepo(cfg.benchGithubOrg, name);
    throw err;
  }

  return { repoUrl, defaultBranch };
}
