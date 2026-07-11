# Seed the throwaway repo from the real base_commit (shared-history PR) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **v2 — folds an independent plan review (verdict: SOUND-WITH-FIXES).** Changes from v1: (a) `fetchSnapshot` now cleans up its own temp dir on internal failure; (b) removed a broken placeholder import from the test block; (c) **dropped the `.claude/` strip entirely** — the review proved it protects nothing (the agent runs in `/testbed` and never reads the throwaway repo; web-off is enforced by `applyWebOffPatch` + the wrapper's `--disallowedTools`), so `main = base_commit` verbatim and `stripClaudeDir` is deleted as dead code.

**Goal:** Make styre's `merge` step able to open a real pull request in the bench by seeding the throwaway repo's default branch **at the actual `inst.base_commit`** (real sha + real ancestry, nothing after it) instead of a fresh rootless snapshot — so styre's fix branch and `main` share a common ancestor and GitHub accepts the PR.

**Architecture:** Today `seedGithub` reads `base_commit`'s file *contents* and re-commits them into a brand-new `git init` repo — a commit with a **different sha and no ancestry**, so styre's fix branch (rooted at the real `base_commit` in the container's clone) shares no history with it and the PR is rejected ("no history in common with main"). This plan changes the seed to push the **real `base_commit`** as the default branch: from the same clone the firewall already uses, push *only* the `base_commit`-rooted ref (its ancestors come along; every descendant/fix commit is unreachable, so nothing leaks). Git objects are content-addressed, so `base_commit` is byte-identical in the seed clone and the container clone — they genuinely share it as the PR merge-base. The path-level firewall (`assertNoHeldOutPaths`) is unchanged: it only verifies (throws), so it composes with real-history seeding untouched.

**Tech Stack:** TypeScript + Bun. `orchestrator/seed-github.ts` (the `SeedGithubDeps` side-effect seam + the pure `seedGithub` orchestration), `orchestrator/firewall.ts` (`assertNoHeldOutPaths` reused unchanged; `stripClaudeDir` deleted), `tests/seed.test.ts`. Git plumbing via Bun `$`.

## Global Constraints

- **The default branch MUST be exactly `inst.base_commit`** (same sha) so styre's fix branch shares it as merge-base — the PR opens and `git diff base_commit..head` (the scorer's harvest) is unaffected.
- **Never push anything reachable-forward of `base_commit`.** Push exactly the `base_commit`-rooted ref (`branch:branch` after `checkout -B branch base_commit`); no `--tags`, no `--mirror`. The upstream default-branch tip and every commit after `base_commit` (including the real fix/tests, which exist only *after* base_commit) must be unreachable in the throwaway repo — this is the leak firewall, preserved by construction. The repo is created `private: true` (unchanged).
- **Path-level firewall unchanged:** `assertNoHeldOutPaths(ls-files@base_commit, inst)` still runs BEFORE the repo is created and still throws on any held-out ADDED path.
- **Auth unchanged:** the push authenticates as `BENCH_GH_TOKEN` via the `x-access-token:<token>@` URL with `GIT_TERMINAL_PROMPT=0` (as `pushSnapshot` does today).
- Full suite (`bun test`), `bun run typecheck`, `bun run lint` stay green.

## Out of scope (record in the PR description)

- The **container-side** `/testbed/.git` full-history leak (the agent could `git log --all` in the image clone) is a *separate* firewall concern, independent of the seed, NOT addressed here.
- **Held-out-in-an-ancestor (theoretical):** `assertNoHeldOutPaths` verifies `base_commit`'s tree, but the push now carries full ancestry, so a held-out file that existed in some *ancestor* and was deleted before `base_commit` would be in the pushed history though not the tree. Vanishingly unlikely (a regression test added *for this fix* does not pre-exist base_commit), same exposure class as the `/testbed` case above, and the repo is private + unread by the agent. No action; recorded so the reasoning is on file.
- No change to `run-task.ts` (container entrypoint), `fetchPrDiff`, or the scorer — they already work once `base_commit` is a real ancestor of the pushed head (and `fetchPrDiff` is made *more* robust: `base_commit` is now directly on the repo, not merely riding in on styre's push).

---

### Task 1: `pushBaseRef` — push a real base_commit as the default branch

**Files:**
- Modify: `orchestrator/seed-github.ts` (add the `pushBaseRef` default dep; extend `SeedGithubDeps`; export `defaultDeps` for the test)
- Test: `tests/seed.test.ts`

**Interfaces:**
- Produces: `pushBaseRef(repoDir: string, baseCommit: string, repoUrl: string, branch: string): Promise<void>` on `SeedGithubDeps` — from a clone at `repoDir`, checks out `base_commit` onto `branch` and pushes ONLY that ref to `repoUrl` using `BENCH_GH_TOKEN`.
- Consumes: a `repoDir` that is a real clone of the upstream repo containing `base_commit` (produced by the reworked `fetchSnapshot` in Task 2).

- [ ] **Step 1: Write the failing test (real temp git repos)**

Add a `describe("pushBaseRef")` block to `tests/seed.test.ts`. Build a real upstream temp repo with three commits (`c0 → base → future`), a bare "remote", then assert `pushBaseRef` publishes `base` (not `future`) as `main`:

```ts
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { $ } from "bun";

async function makeUpstream() {
  const dir = await mkdtemp(path.join(tmpdir(), "sbx-up-"));
  const git = (a: string) => $`git -C ${dir} ${{ raw: a }}`.quiet();
  await git("init -q -b main");
  await git("config user.email t@t"); await git("config user.name t");
  await writeFile(path.join(dir, "a.txt"), "c0"); await git("add -A"); await git("commit -q -m c0");
  await writeFile(path.join(dir, "a.txt"), "base"); await git("add -A"); await git("commit -q -m base");
  const baseSha = (await $`git -C ${dir} rev-parse HEAD`.quiet().text()).trim();
  await writeFile(path.join(dir, "FIX.txt"), "the fix"); await git("add -A"); await git("commit -q -m future");
  return { dir, baseSha };
}

test("pushBaseRef publishes base_commit as main (shared ancestor) and NOTHING after it", async () => {
  const { dir, baseSha } = await makeUpstream();
  const remote = await mkdtemp(path.join(tmpdir(), "sbx-remote-"));
  await $`git -C ${remote} init -q --bare -b main`.quiet();
  const { defaultDeps } = await import("../orchestrator/seed-github");
  await defaultDeps.pushBaseRef(dir, baseSha, `file://${remote}`, "main");

  const head = (await $`git -C ${remote} rev-parse main`.quiet().text()).trim();
  expect(head).toBe(baseSha); // main IS the real base sha
  const log = await $`git -C ${remote} log --format=%s main`.quiet().text();
  expect(log).toContain("base");
  expect(log).not.toContain("future"); // no forward/fix history leaked
  await rm(dir, { recursive: true, force: true });
  await rm(remote, { recursive: true, force: true });
});
```
(`file://` remotes carry no credential — see Step 3's token note. If `defaultDeps` is not exported, export it in Step 3.)

- [ ] **Step 2: Run the test — verify it FAILS**

Run: `bun test tests/seed.test.ts`
Expected: FAIL — `pushBaseRef` does not exist / `defaultDeps` not exported.

- [ ] **Step 3: Implement `pushBaseRef` + export `defaultDeps`**

In `orchestrator/seed-github.ts`:
- Export the deps: change `const defaultDeps: SeedGithubDeps = {` to `export const defaultDeps: SeedGithubDeps = {`.
- Add a token-guard helper near the top (factoring the guard `createRepo`/`pushSnapshot`/`deleteRepo` duplicate today):
```ts
function requireBenchToken(action: string): string {
  const token = process.env.BENCH_GH_TOKEN;
  if (!token) {
    throw new Error(
      `seedGithub: BENCH_GH_TOKEN is not set — required to ${action}. It is a PAT scoped ONLY to ` +
        "benchGithubOrg; refusing to fall back to any ambient credential.",
    );
  }
  return token;
}
```
- Add `pushBaseRef` to the `SeedGithubDeps` interface:
```ts
  /** Publish the REAL `baseCommit` (its ancestry included, nothing after it) as `branch` on
   *  `repoUrl`. styre's fix branch — rooted at the same content-addressed `baseCommit` in the
   *  container clone — then shares it as the PR merge-base, so the PR opens and `git diff
   *  baseCommit..head` is unaffected. Pushing only the `baseCommit`-rooted ref keeps every commit
   *  after it (incl. the gold fix) unreachable in the throwaway repo. */
  pushBaseRef: (repoDir: string, baseCommit: string, repoUrl: string, branch: string) => Promise<void>;
```
- Add the default implementation (next to `pushSnapshot`, which Task 2 removes):
```ts
  async pushBaseRef(repoDir, baseCommit, repoUrl, branch) {
    // Local branch AT base_commit: the pushed ref is rooted here, so its ancestors travel and every
    // commit AFTER base_commit stays unreachable in the throwaway repo (leak firewall).
    await $`git -C ${repoDir} checkout -q -B ${branch} ${baseCommit}`.quiet();
    // file:// remotes (tests) carry no credential; a real https remote gets the scoped token.
    const pushUrl = /^https:\/\//.test(repoUrl)
      ? repoUrl.replace(/^https:\/\//, `https://x-access-token:${requireBenchToken("push the base_commit ref")}@`)
      : repoUrl;
    await $`git -C ${repoDir} push -q ${pushUrl} ${branch}:${branch}`
      .env({ ...process.env, GIT_TERMINAL_PROMPT: "0" })
      .quiet();
  },
```

- [ ] **Step 4: Run the test — verify it PASSES**

Run: `bun test tests/seed.test.ts`
Expected: the `pushBaseRef` test PASSES.

- [ ] **Step 5: Commit**

```bash
git add orchestrator/seed-github.ts tests/seed.test.ts
git commit -m "feat(seed): pushBaseRef — publish the real base_commit as the default branch"
```

---

### Task 2: Wire seedGithub to push the real base_commit (retire the fresh-init snapshot)

**Files:**
- Modify: `orchestrator/seed-github.ts` (`fetchSnapshot` returns the clone dir with self-cleanup on failure; `seedGithub` uses `pushBaseRef`; delete `pushSnapshot`)
- Modify: `orchestrator/firewall.ts` (delete the now-unused `stripClaudeDir`)
- Test: `tests/seed.test.ts` (update stubs; delete `stripClaudeDir` tests)

**Interfaces:**
- `fetchSnapshot(repo, baseCommit)` return type becomes `{ files: SnapshotFile[]; repoDir: string }` — `files` still feeds `assertNoHeldOutPaths`; `repoDir` is the live clone (with `.git`) that `pushBaseRef` pushes from. `seedGithub` owns cleanup of `repoDir` on the success path; `fetchSnapshot` cleans up itself on its own internal failure.
- Removes `pushSnapshot` from `SeedGithubDeps`.

- [ ] **Step 1: Write the failing seedGithub test (stubbed deps — existing style)**

Add to `tests/seed.test.ts`:
```ts
test("seedGithub pushes the real base_commit via pushBaseRef (not a fresh snapshot)", async () => {
  const calls: Array<{ repoDir: string; baseCommit: string; branch: string }> = [];
  const inst = { id: "o__r-1", repo: "o/r", base_commit: "basesha", test_patch: "", fix_patch: "" } as never;
  const res = await seedGithub(inst, { benchGithubOrg: "org" }, {
    deps: {
      fetchSnapshot: async () => ({ files: [{ path: "src/a.py", content: "x" }], repoDir: "/tmp/fake-clone" }),
      createRepo: async () => ({ repoUrl: "https://github.com/org/r.git", defaultBranch: "main" }),
      pushBaseRef: async (repoDir, baseCommit, _url, branch) => { calls.push({ repoDir, baseCommit, branch }); },
      deleteRepo: async () => {},
    },
  });
  expect(res.defaultBranch).toBe("main");
  expect(calls).toEqual([{ repoDir: "/tmp/fake-clone", baseCommit: "basesha", branch: "main" }]);
});
```
Then update the EXISTING `seedGithub` firewall-ordering tests: change their `fetchSnapshot` stub to return `{ files, repoDir }` and replace any `pushSnapshot` stub with a `pushBaseRef` stub (the `assertNoHeldOutPaths`-before-`createRepo` assertions stay). DELETE the `describe("stripClaudeDir")` block (the function is removed in Step 4).

- [ ] **Step 2: Run the tests — verify they FAIL**

Run: `bun test tests/seed.test.ts`
Expected: FAIL — `seedGithub` still calls `pushSnapshot`; `fetchSnapshot` returns a bare array; `stripClaudeDir` import gone.

- [ ] **Step 3: Rework `fetchSnapshot` (keep the clone; self-clean on failure)**

```ts
  async fetchSnapshot(repo, baseCommit) {
    const repoDir = await mkdtemp(path.join(tmpdir(), "styre-bench-seed-src-"));
    try {
      await $`git clone --quiet https://github.com/${repo}.git ${repoDir}`.quiet();
      await $`git -C ${repoDir} fetch --quiet origin ${baseCommit}`.quiet().nothrow();
      await $`git -C ${repoDir} checkout --quiet ${baseCommit}`.quiet();
      const lsOut = await $`git -C ${repoDir} ls-files`.quiet().text();
      const paths = lsOut.split("\n").map((p) => p.trim()).filter((p) => p.length > 0);
      const files: SnapshotFile[] = [];
      for (const p of paths) {
        const content = await readFile(path.join(repoDir, p), "utf8").catch(() => "");
        files.push({ path: p, content });
      }
      return { files, repoDir };
    } catch (err) {
      // Clone/fetch/checkout failed before we could hand `repoDir` to the caller — clean it up here
      // (the caller's finally only covers the success path), then rethrow unchanged.
      await rm(repoDir, { recursive: true, force: true });
      throw err;
    }
  },
```
Update the `SeedGithubDeps.fetchSnapshot` signature to `Promise<{ files: SnapshotFile[]; repoDir: string }>`, and remove `pushSnapshot` from the interface + `defaultDeps`.

- [ ] **Step 4: Rework `seedGithub`; delete `stripClaudeDir`**

```ts
export async function seedGithub(inst, cfg, opts = {}) {
  const deps: SeedGithubDeps = { ...defaultDeps, ...opts.deps };
  const { files, repoDir } = await deps.fetchSnapshot(inst.repo, inst.base_commit);
  try {
    assertNoHeldOutPaths(files.map((f) => f.path), inst); // unchanged firewall verify (throws)
    const name = repoNameFor(inst);
    const { repoUrl, defaultBranch } = await deps.createRepo(cfg.benchGithubOrg, name);
    try {
      await deps.pushBaseRef(repoDir, inst.base_commit, repoUrl, defaultBranch);
    } catch (err) {
      await deps.deleteRepo(cfg.benchGithubOrg, name); // no orphan repo on push failure (unchanged intent)
      throw err;
    }
    return { repoUrl, defaultBranch };
  } finally {
    await rm(repoDir, { recursive: true, force: true }); // seedGithub owns the clone's lifetime
  }
}
```
Remove the `import { … stripClaudeDir } from "./firewall"` usage (keep `assertNoHeldOutPaths`), delete `stripClaudeDir` from `orchestrator/firewall.ts`, and update `seedGithub`'s doc-comment (the numbered FIREWALL block) to describe the base_commit-ref push (drop the step-3 `.claude` strip line). Also add a note to the doc-comment that pushing full ancestry is heavier per instance than the old single snapshot commit (expected; inherent to a real shared ancestor).

- [ ] **Step 5: Run the tests — verify they PASS**

Run: `bun test tests/seed.test.ts`
Expected: PASS (new + updated; `stripClaudeDir` block gone).

- [ ] **Step 6: Full green check**

Run: `bun test && bun run typecheck && bun run lint`
Expected: all pass — no dead-code/lint errors (`stripClaudeDir` and its tests fully removed; `pushSnapshot` fully removed).

- [ ] **Step 7: Commit**

```bash
git add orchestrator/seed-github.ts orchestrator/firewall.ts tests/seed.test.ts
git commit -m "fix(seed): publish the real base_commit as main so styre's PR opens (shared history)"
```

---

## Self-Review

**1. Spec coverage:** The "no history in common with main" blocker is fixed by seeding `main` at the real `base_commit` (Task 1 `pushBaseRef`, Task 2 wiring), so styre's fix branch shares an ancestor and the PR opens; `git diff base_commit..head` is unaffected. The leak firewall is preserved two ways: `assertNoHeldOutPaths` still verifies the base tree (throws pre-create), and only the `base_commit`-rooted ref is pushed so no forward/fix commit is reachable.

**2. Placeholder scan:** Every step carries real code + exact commands. No placeholder imports (the v1 `defaultSeedDepsForTest` line is removed).

**3. Type consistency:** `fetchSnapshot` return type changes in one place, consumed in one (`seedGithub`); `pushBaseRef(repoDir, baseCommit, repoUrl, branch)` is defined in Task 1 and called with matching args in Task 2. `pushSnapshot` and `stripClaudeDir` are removed from all sites (interface, `seedGithub`, `firewall.ts`, tests). `requireBenchToken` centralizes the existing token guard.

**Review-driven decisions folded (independent review, SOUND-WITH-FIXES):** (#1) `fetchSnapshot` self-cleans its temp dir on internal failure; (#2) removed the file-breaking placeholder import from the test; (#3) dropped the `.claude`-strip — the agent runs in `/testbed` and never reads the throwaway repo, and web-off is enforced by `applyWebOffPatch` + the wrapper's `--disallowedTools`, so the strip protected nothing; `main = base_commit` verbatim and `stripClaudeDir` is deleted. Minors (ancestry-push cost; held-out-in-ancestor) recorded above / in the PR.
