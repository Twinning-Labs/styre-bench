# Seed the throwaway repo from the real base_commit (shared-history PR) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **v3 — folds an independent plan review (verdict: SOUND-WITH-FIXES) + an operator decision.** Review fixes kept: (a) `fetchSnapshot` cleans up its own temp dir on internal failure; (b) removed a broken placeholder import from the test block. **Operator decision (overrides review finding #3):** KEEP stripping `.claude/` from the throwaway repo as **defense-in-depth**. The review is correct that it protects nothing *today* (the agent works in the container's `/testbed` copy — universal across all repo types, not conda-specific — and never reads the throwaway repo; web-off is enforced by `applyWebOffPatch` + the wrapper's `--disallowedTools`). It is kept anyway as a cheap hedge against un-audited/future code paths. Because we now push **real history**, the strip is done as a commit layered ON TOP of `base_commit` (not by filtering a file list), so `base_commit` stays the shared ancestor and the PR still opens. The old pure `stripClaudeDir` helper — which filtered the flat snapshot we no longer push — is superseded and removed.

**Goal:** Make styre's `merge` step able to open a real pull request in the bench by seeding the throwaway repo's default branch **at the actual `inst.base_commit`** (real sha + real ancestry, nothing after it) instead of a fresh rootless snapshot — so styre's fix branch and `main` share a common ancestor and GitHub accepts the PR.

**Architecture:** Today `seedGithub` reads `base_commit`'s file *contents* and re-commits them into a brand-new `git init` repo — a commit with a **different sha and no ancestry**, so styre's fix branch (rooted at the real `base_commit` in the container's clone) shares no history with it and the PR is rejected ("no history in common with main"). This plan changes the seed to push the **real `base_commit`** as the default branch: from the same clone the firewall already uses, push *only* the `base_commit`-rooted ref (its ancestors come along; every descendant/fix commit is unreachable, so nothing leaks). Git objects are content-addressed, so `base_commit` is byte-identical in the seed clone and the container clone — they genuinely share it as the PR merge-base. `.claude/` is removed with a commit layered on top of `base_commit`, so `main = base_commit (+ .claude-strip commit)` and `base_commit` stays the shared ancestor. The path-level firewall (`assertNoHeldOutPaths`) is unchanged: it only verifies (throws), so it composes with real-history seeding untouched.

**Tech Stack:** TypeScript + Bun. `orchestrator/seed-github.ts` (the `SeedGithubDeps` side-effect seam + the pure `seedGithub` orchestration), `orchestrator/firewall.ts` (`assertNoHeldOutPaths` reused unchanged; `stripClaudeDir` deleted), `tests/seed.test.ts`. Git plumbing via Bun `$`.

## Global Constraints

- **The default-branch TIP must have `base_commit` as its merge-base with the fix branch** — i.e. `main` is `base_commit`, or `base_commit` + a single `.claude`-strip commit. This is the whole point: styre's fix branch shares `base_commit`, so the PR opens and `git diff base_commit..head` (the scorer's harvest) is unaffected (the strip commit is on the base side, never in the fix diff).
- **Never push anything reachable-forward of `base_commit`.** Push exactly the `base_commit`-rooted ref (`branch:branch` after `checkout -B branch base_commit` and the optional strip commit); no `--tags`, no `--mirror`. The upstream default-branch tip and every commit after `base_commit` (including the real fix/tests, which exist only *after* base_commit) must be unreachable in the throwaway repo — this is the leak firewall, preserved by construction. The repo is created `private: true` (unchanged).
- **`.claude/` must not be present at the default-branch TIP** (defense-in-depth — see the v3 header). Strip it with a commit on top of `base_commit`; never by rewriting `base_commit` (which would change its sha and break the shared ancestor). A no-op when the tree has no `.claude/` (the common case — real upstream repos rarely commit one).
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
- Produces: `pushBaseRef(repoDir: string, baseCommit: string, repoUrl: string, branch: string, opts: { stripClaude: boolean }): Promise<void>` on `SeedGithubDeps` — from a clone at `repoDir`, checks out `base_commit` onto `branch`, optionally layers ONE commit removing `.claude/`, and pushes ONLY that ref to `repoUrl` using `BENCH_GH_TOKEN`.
- Consumes: a `repoDir` that is a real clone of the upstream repo containing `base_commit` (produced by the reworked `fetchSnapshot` in Task 2).

- [ ] **Step 1: Write the failing tests (real temp git repos)**

Add a `describe("pushBaseRef")` block to `tests/seed.test.ts`:

```ts
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
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
  await defaultDeps.pushBaseRef(dir, baseSha, `file://${remote}`, "main", { stripClaude: false });

  const head = (await $`git -C ${remote} rev-parse main`.quiet().text()).trim();
  expect(head).toBe(baseSha); // no strip → main IS the real base sha
  const log = await $`git -C ${remote} log --format=%s main`.quiet().text();
  expect(log).toContain("base");
  expect(log).not.toContain("future"); // no forward/fix history leaked
  await rm(dir, { recursive: true, force: true });
  await rm(remote, { recursive: true, force: true });
});

test("pushBaseRef with stripClaude removes .claude/ at the TIP but keeps base_commit as the ancestor", async () => {
  const { dir, baseSha } = await makeUpstream();
  // Add a .claude/ file on top of base (detached at baseSha), so the checkout base HAS a .claude tree.
  await $`git -C ${dir} checkout -q ${baseSha}`.quiet();
  await mkdir(path.join(dir, ".claude"), { recursive: true });
  await writeFile(path.join(dir, ".claude", "settings.json"), "{}");
  await $`git -C ${dir} add -A`.quiet();
  await $`git -C ${dir} -c user.email=t@t -c user.name=t commit -q -m "add .claude"`.quiet();
  const withClaude = (await $`git -C ${dir} rev-parse HEAD`.quiet().text()).trim();

  const remote = await mkdtemp(path.join(tmpdir(), "sbx-remote2-"));
  await $`git -C ${remote} init -q --bare -b main`.quiet();
  const { defaultDeps } = await import("../orchestrator/seed-github");
  await defaultDeps.pushBaseRef(dir, withClaude, `file://${remote}`, "main", { stripClaude: true });

  const tip = await $`git -C ${remote} ls-tree -r --name-only main`.quiet().text();
  expect(tip).not.toContain(".claude/settings.json"); // stripped at the tip
  const anc = await $`git -C ${remote} merge-base --is-ancestor ${withClaude} main`.quiet().nothrow();
  expect(anc.exitCode).toBe(0); // withClaude is still the ancestor (shared history preserved)
  await rm(dir, { recursive: true, force: true });
  await rm(remote, { recursive: true, force: true });
});
```
(`file://` remotes carry no credential — see Step 3's token note. If `defaultDeps` is not exported, export it in Step 3.)

- [ ] **Step 2: Run the tests — verify they FAIL**

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
   *  after it (incl. the gold fix) unreachable in the throwaway repo. `stripClaude` layers ONE
   *  commit removing `.claude/` on top (defense-in-depth) — never rewrites `baseCommit`. */
  pushBaseRef: (
    repoDir: string,
    baseCommit: string,
    repoUrl: string,
    branch: string,
    opts: { stripClaude: boolean },
  ) => Promise<void>;
```
- Add the default implementation (next to `pushSnapshot`, which Task 2 removes):
```ts
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
      ? repoUrl.replace(/^https:\/\//, `https://x-access-token:${requireBenchToken("push the base_commit ref")}@`)
      : repoUrl;
    await $`git -C ${repoDir} push -q ${pushUrl} ${branch}:${branch}`
      .env({ ...process.env, GIT_TERMINAL_PROMPT: "0" })
      .quiet();
  },
```

- [ ] **Step 4: Run the tests — verify they PASS**

Run: `bun test tests/seed.test.ts`
Expected: both `pushBaseRef` tests PASS.

- [ ] **Step 5: Commit**

```bash
git add orchestrator/seed-github.ts tests/seed.test.ts
git commit -m "feat(seed): pushBaseRef — publish the real base_commit as the default branch"
```

---

### Task 2: Wire seedGithub to push the real base_commit (retire the fresh-init snapshot)

**Files:**
- Modify: `orchestrator/seed-github.ts` (`fetchSnapshot` returns the clone dir with self-cleanup on failure; `seedGithub` uses `pushBaseRef`; delete `pushSnapshot`)
- Modify: `orchestrator/firewall.ts` (delete the now-superseded `stripClaudeDir` — the strip is now a git commit in `pushBaseRef`, not a file-array filter)
- Test: `tests/seed.test.ts` (update stubs; delete `stripClaudeDir` tests)

**Interfaces:**
- `fetchSnapshot(repo, baseCommit)` return type becomes `{ files: SnapshotFile[]; repoDir: string }` — `files` still feeds `assertNoHeldOutPaths` AND the `stripClaude` decision; `repoDir` is the live clone `pushBaseRef` pushes from. `seedGithub` owns cleanup of `repoDir` on success; `fetchSnapshot` cleans up itself on its own internal failure.
- Removes `pushSnapshot` from `SeedGithubDeps`.

- [ ] **Step 1: Write the failing seedGithub tests (stubbed deps — existing style)**

Add to `tests/seed.test.ts`:
```ts
test("seedGithub pushes the real base_commit via pushBaseRef, stripClaude when .claude/ present", async () => {
  const calls: Array<{ baseCommit: string; branch: string; opts: { stripClaude: boolean } }> = [];
  const inst = { id: "o__r-1", repo: "o/r", base_commit: "basesha", test_patch: "", fix_patch: "" } as never;
  await seedGithub(inst, { benchGithubOrg: "org" }, {
    deps: {
      fetchSnapshot: async () => ({
        files: [{ path: "src/a.py", content: "x" }, { path: ".claude/settings.json", content: "{}" }],
        repoDir: "/tmp/fake-clone",
      }),
      createRepo: async () => ({ repoUrl: "https://github.com/org/r.git", defaultBranch: "main" }),
      pushBaseRef: async (_d, baseCommit, _u, branch, opts) => { calls.push({ baseCommit, branch, opts }); },
      deleteRepo: async () => {},
    },
  });
  expect(calls).toEqual([{ baseCommit: "basesha", branch: "main", opts: { stripClaude: true } }]);
});

test("seedGithub does not stripClaude when the snapshot has no .claude/ path", async () => {
  const calls: Array<{ opts: { stripClaude: boolean } }> = [];
  const inst = { id: "o__r-2", repo: "o/r", base_commit: "b2", test_patch: "", fix_patch: "" } as never;
  await seedGithub(inst, { benchGithubOrg: "org" }, {
    deps: {
      fetchSnapshot: async () => ({ files: [{ path: "src/a.py", content: "x" }], repoDir: "/tmp/c2" }),
      createRepo: async () => ({ repoUrl: "https://github.com/org/r.git", defaultBranch: "main" }),
      pushBaseRef: async (_d, _b, _u, _br, opts) => { calls.push({ opts }); },
      deleteRepo: async () => {},
    },
  });
  expect(calls[0].opts).toEqual({ stripClaude: false });
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
    const stripClaude = files.some((f) => f.path === ".claude" || f.path.startsWith(".claude/"));
    const name = repoNameFor(inst);
    const { repoUrl, defaultBranch } = await deps.createRepo(cfg.benchGithubOrg, name);
    try {
      await deps.pushBaseRef(repoDir, inst.base_commit, repoUrl, defaultBranch, { stripClaude });
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
Remove the `stripClaudeDir` usage/import from `seed-github.ts` (keep `assertNoHeldOutPaths`), delete `stripClaudeDir` from `orchestrator/firewall.ts` (its job is now the git-commit strip in `pushBaseRef`), and update `seedGithub`'s doc-comment (the numbered FIREWALL block) to describe the base_commit-ref push + the on-top `.claude` strip. Add a note that pushing full ancestry is heavier per instance than the old single snapshot commit (expected; inherent to a real shared ancestor).

- [ ] **Step 5: Run the tests — verify they PASS**

Run: `bun test tests/seed.test.ts`
Expected: PASS (new + updated; `stripClaudeDir` block gone).

- [ ] **Step 6: Full green check**

Run: `bun test && bun run typecheck && bun run lint`
Expected: all pass — `stripClaudeDir` and its tests fully removed; `pushSnapshot` fully removed; no dead-code/lint errors.

- [ ] **Step 7: Commit**

```bash
git add orchestrator/seed-github.ts orchestrator/firewall.ts tests/seed.test.ts
git commit -m "fix(seed): publish the real base_commit as main so styre's PR opens (shared history)"
```

---

## Self-Review

**1. Spec coverage:** The "no history in common with main" blocker is fixed by seeding `main` at the real `base_commit` (Task 1 `pushBaseRef`, Task 2 wiring), so styre's fix branch shares an ancestor and the PR opens; `git diff base_commit..head` is unaffected. The leak firewall is preserved two ways: `assertNoHeldOutPaths` still verifies the base tree (throws pre-create), and only the `base_commit`-rooted ref is pushed so no forward/fix commit is reachable. `.claude/` defense-in-depth is retained via the on-top strip commit (base_commit stays the merge-base).

**2. Placeholder scan:** Every step carries real code + exact commands. No placeholder imports (the v1 `defaultSeedDepsForTest` line is gone).

**3. Type consistency:** `fetchSnapshot` return type changes in one place, consumed in one (`seedGithub`); `pushBaseRef(repoDir, baseCommit, repoUrl, branch, opts)` is defined in Task 1 and called with matching args in Task 2. `pushSnapshot` and `stripClaudeDir` are removed from all sites (interface, `seedGithub`, `firewall.ts`, tests). `requireBenchToken` centralizes the existing token guard.

**Review-driven changes folded (independent review, SOUND-WITH-FIXES):** (#1) `fetchSnapshot` self-cleans its temp dir on internal failure; (#2) removed the file-breaking placeholder import from the test. **(#3 — operator override):** the `.claude` strip is KEPT as documented defense-in-depth (not "the firewall"), implemented as an on-top commit since real history is now pushed; the superseded pure `stripClaudeDir` helper is deleted. Minors (ancestry-push cost; held-out-in-ancestor) recorded above / in the PR.
