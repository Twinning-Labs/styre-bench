# Seed the throwaway repo from the real base_commit (shared-history PR) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make styre's `merge` step able to open a real pull request in the bench by seeding the throwaway repo's default branch **at the actual `inst.base_commit`** (real sha + real ancestry, nothing after it) instead of a fresh rootless snapshot — so styre's fix branch and `main` share a common ancestor and GitHub accepts the PR.

**Architecture:** Today `seedGithub` reads `base_commit`'s file *contents* and re-commits them into a brand-new `git init` repo — a commit with a **different sha and no ancestry**, so styre's fix branch (rooted at the real `base_commit` in the container's clone) shares no history with it and the PR is rejected ("no history in common with main"). This plan changes the seed to push the **real `base_commit`** as the default branch: clone the upstream repo, push *only* the `base_commit`-rooted ref (its ancestors come along; every descendant/fix commit is unreachable, so nothing leaks), keeping the existing path-level firewall as a pre-push verification. `.claude/` (which we still must not ship) is removed with a single commit layered *on top of* `base_commit`, so `main = base_commit (+ optional strip commit)` and `base_commit` stays the shared ancestor.

**Tech Stack:** TypeScript + Bun. `orchestrator/seed-github.ts` (the `SeedGithubDeps` side-effect seam + the pure `seedGithub` orchestration), `orchestrator/firewall.ts` (unchanged — reused), `tests/seed.test.ts`. Git plumbing via Bun `$`.

## Global Constraints

- **The default branch tip MUST have `base_commit` as an ancestor** (equal to it, or its only descendant being a `.claude/`-strip commit). This is the whole point — styre's fix branch shares `base_commit`, so the PR opens and `git diff base_commit..head` (the scorer's harvest) is unaffected.
- **Never push anything reachable-forward of `base_commit`.** Push exactly the `base_commit`-rooted ref; the upstream default-branch tip and every commit after `base_commit` (including the real fix) must be unreachable in the throwaway repo — this is the leak firewall, preserved "prune by construction."
- **Path-level firewall unchanged:** `assertNoHeldOutPaths(ls-files@base_commit, inst)` still runs BEFORE the repo is created and still throws on any held-out ADDED path. It is a verification, so it composes with real-history seeding untouched.
- **`.claude/` must not be present at the default-branch tip.** Real upstream repos essentially never commit `.claude/`, so this is normally a no-op; when present, strip it with a commit layered on top of `base_commit` (never by rewriting `base_commit`, which would change its sha and break the shared ancestor).
- **Auth unchanged:** the push authenticates as `BENCH_GH_TOKEN` via the `x-access-token:<token>@` URL with `GIT_TERMINAL_PROMPT=0` (as `pushSnapshot` does today).
- Full suite (`bun test`), `bun run typecheck`, `bun run lint` stay green.

## Out of scope (explicitly)

- The **container-side** `/testbed/.git` full-history leak (the agent could `git log --all` in the image clone) is a *separate* firewall concern, independent of the seed, and is NOT addressed here. Note it in the PR description as related follow-up.
- No change to `run-task.ts` (the container entrypoint), `fetchPrDiff`, or the scorer — they already work once `base_commit` is a real ancestor of the pushed head.

---

### Task 1: `pushBaseRef` — push a real base_commit as the default branch

**Files:**
- Modify: `orchestrator/seed-github.ts` (add the `pushBaseRef` default dep; extend `SeedGithubDeps`)
- Test: `tests/seed.test.ts`

**Interfaces:**
- Produces: `pushBaseRef(repoDir: string, baseCommit: string, repoUrl: string, branch: string, opts: { stripClaude: boolean }): Promise<void>` on `SeedGithubDeps` — from a clone at `repoDir`, checks out `base_commit` onto `branch`, optionally layers one commit removing `.claude/`, and pushes ONLY that ref to `repoUrl` as `branch` using `BENCH_GH_TOKEN`.
- Consumes: a `repoDir` that is a real clone of the upstream repo containing `base_commit` (produced by the reworked `fetchSnapshot` in Task 2).

- [ ] **Step 1: Write the failing test (real temp git repos, mirroring how the harness pushes)**

Add to `tests/seed.test.ts` a `describe("pushBaseRef")` block. Build a real upstream temp repo with three commits (`c0 → base → future`), a bare "remote" temp repo, then assert `pushBaseRef` publishes `base` (not `future`) as `main`:

```ts
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { $ } from "bun";
import { defaultSeedDepsForTest as _unused } from "../orchestrator/seed-github"; // see note below

// helper: make a repo with commits c0, base (tagged), future; return { dir, baseSha }
async function makeUpstream() {
  const dir = await mkdtemp(path.join(tmpdir(), "sbx-up-"));
  const git = (args: string) => $`git -C ${dir} ${{ raw: args }}`.quiet();
  await git("init -q -b main");
  await git("config user.email t@t");
  await git("config user.name t");
  await writeFile(path.join(dir, "a.txt"), "c0");
  await git("add -A"); await git("commit -q -m c0");
  await writeFile(path.join(dir, "a.txt"), "base");
  await git("add -A"); await git("commit -q -m base");
  const baseSha = (await $`git -C ${dir} rev-parse HEAD`.quiet().text()).trim();
  await writeFile(path.join(dir, "FIX.txt"), "the fix"); // the secret future
  await git("add -A"); await git("commit -q -m future");
  return { dir, baseSha };
}

test("pushBaseRef publishes base_commit (with its ancestors) and NOT any commit after it", async () => {
  const { dir, baseSha } = await makeUpstream();
  const remote = await mkdtemp(path.join(tmpdir(), "sbx-remote-"));
  await $`git -C ${remote} init -q --bare -b main`.quiet();
  // pushBaseRef must accept a plain file:// url (no token) in tests — see Task 1 Step 3 note.
  const { defaultDeps } = await import("../orchestrator/seed-github");
  await (defaultDeps as any).pushBaseRef(dir, baseSha, `file://${remote}`, "main", { stripClaude: false });

  const head = (await $`git -C ${remote} rev-parse main`.quiet().text()).trim();
  expect(head).toBe(baseSha); // main IS the real base sha (shared ancestor)
  // the future/fix commit is unreachable in the remote
  const log = (await $`git -C ${remote} log --format=%s main`.quiet().text());
  expect(log).toContain("base");
  expect(log).not.toContain("future");
  await rm(dir, { recursive: true, force: true });
  await rm(remote, { recursive: true, force: true });
});

test("pushBaseRef strips .claude/ with a commit layered on top, keeping base_commit as the ancestor", async () => {
  const { dir, baseSha } = await makeUpstream();
  await writeFile(path.join(dir, "a.txt"), "base"); // back on base tree for the checkout below
  // add a .claude dir at base by amending is complex; instead assert behavior when stripClaude=true and .claude exists:
  await $`git -C ${dir} checkout -q ${baseSha}`.quiet();
  await mkdtemp(path.join(dir, ".claude-marker-")); // ensure dir writable
  await $`mkdir -p ${path.join(dir, ".claude")}`.quiet();
  await writeFile(path.join(dir, ".claude", "settings.json"), "{}");
  await $`git -C ${dir} add -A`.quiet();
  await $`git -C ${dir} -c user.email=t@t -c user.name=t commit -q -m "add .claude"`.quiet();
  const withClaude = (await $`git -C ${dir} rev-parse HEAD`.quiet().text()).trim();
  const remote = await mkdtemp(path.join(tmpdir(), "sbx-remote2-"));
  await $`git -C ${remote} init -q --bare -b main`.quiet();
  const { defaultDeps } = await import("../orchestrator/seed-github");
  await (defaultDeps as any).pushBaseRef(dir, withClaude, `file://${remote}`, "main", { stripClaude: true });

  // tip has no .claude, but withClaude is its ancestor (shared history preserved)
  const tipTree = (await $`git -C ${remote} ls-tree -r --name-only main`.quiet().text());
  expect(tipTree).not.toContain(".claude/settings.json");
  const isAncestor = await $`git -C ${remote} merge-base --is-ancestor ${withClaude} main`.quiet().nothrow();
  expect(isAncestor.exitCode).toBe(0);
  await rm(dir, { recursive: true, force: true });
  await rm(remote, { recursive: true, force: true });
});
```
(Delete the stray `defaultSeedDepsForTest` import line — it is a placeholder reminder; the tests import `{ defaultDeps }` dynamically. If `defaultDeps` is not exported, export it from `seed-github.ts` in Step 3.)

- [ ] **Step 2: Run the tests — verify they FAIL**

Run: `bun test tests/seed.test.ts`
Expected: FAIL — `pushBaseRef` does not exist / is not exported.

- [ ] **Step 3: Implement `pushBaseRef` + export `defaultDeps`**

In `orchestrator/seed-github.ts`:
- Export the deps object so tests can call the real `pushBaseRef`: `export const defaultDeps: SeedGithubDeps = { … }` (it is currently unexported `const defaultDeps`).
- Add `pushBaseRef` to the `SeedGithubDeps` interface:
```ts
  /** Publish the REAL `baseCommit` (its ancestry included, nothing after it) as `branch` on
   *  `repoUrl`, so styre's fix branch — rooted at the same `baseCommit` in the container clone —
   *  shares history and the PR can open. `stripClaude` layers ONE commit removing `.claude/` on
   *  top (never rewrites `baseCommit`, which would change its sha and break the shared ancestor). */
  pushBaseRef: (
    repoDir: string,
    baseCommit: string,
    repoUrl: string,
    branch: string,
    opts: { stripClaude: boolean },
  ) => Promise<void>;
```
- Add the default implementation (place next to `pushSnapshot`; `pushSnapshot` is removed in Task 2):
```ts
  async pushBaseRef(repoDir, baseCommit, repoUrl, branch, opts) {
    // Local branch AT base_commit (detached-safe): the pushed ref is rooted here, so its ancestors
    // travel and every commit AFTER base_commit stays unreachable in the throwaway repo (leak firewall).
    await $`git -C ${repoDir} checkout -q -B ${branch} ${baseCommit}`.quiet();
    if (opts.stripClaude) {
      // Remove .claude/ at the TIP with one commit on top of base_commit — base_commit stays the
      // shared ancestor. `--ignore-unmatch` keeps this a no-op when the tree has no .claude/.
      await $`git -C ${repoDir} rm -r -q --ignore-unmatch .claude`.quiet().nothrow();
      await $`git -C ${repoDir} -c user.email=bench@styre.dev -c user.name=styre-bench commit -q -m "seed: strip .claude/"`
        .quiet()
        .nothrow(); // nothrow: nothing staged (no .claude present) → no commit, tip stays base_commit
    }
    // file:// remotes (tests) carry no credential; a real https remote gets the scoped token.
    const isHttps = /^https:\/\//.test(repoUrl);
    const pushUrl = isHttps
      ? repoUrl.replace(/^https:\/\//, `https://x-access-token:${requireBenchToken("push the base_commit ref")}@`)
      : repoUrl;
    await $`git -C ${repoDir} push -q ${pushUrl} ${branch}:${branch}`
      .env({ ...process.env, GIT_TERMINAL_PROMPT: "0" })
      .quiet();
  },
```
Add a small helper near the top of the file (factoring the repeated token guard used by `createRepo`/`pushSnapshot`/`deleteRepo`):
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
- Modify: `orchestrator/seed-github.ts` (`fetchSnapshot` returns the clone dir; `seedGithub` uses `pushBaseRef`; delete `pushSnapshot`)
- Test: `tests/seed.test.ts`

**Interfaces:**
- Changes `fetchSnapshot(repo, baseCommit)` return type to `{ files: SnapshotFile[]; repoDir: string }` — `files` still feeds `assertNoHeldOutPaths`; `repoDir` is the live clone (with `.git`) that `pushBaseRef` pushes from. `seedGithub` owns cleanup of `repoDir`.
- Removes `pushSnapshot` from `SeedGithubDeps` (superseded).

- [ ] **Step 1: Write the failing seedGithub test (stubbed deps — the existing test style)**

Add to `tests/seed.test.ts` (mirror the existing `seedGithub` firewall-ordering tests that stub the deps):
```ts
test("seedGithub pushes the real base_commit via pushBaseRef (not a fresh snapshot), stripClaude when .claude present", async () => {
  const calls: any[] = [];
  const inst = { id: "o__r-1", repo: "o/r", base_commit: "basesha", test_patch: "", fix_patch: "" } as any;
  await seedGithub(inst, { benchGithubOrg: "org" }, {
    deps: {
      fetchSnapshot: async () => ({
        files: [{ path: "src/a.py", content: "x" }, { path: ".claude/settings.json", content: "{}" }],
        repoDir: "/tmp/fake-clone",
      }),
      createRepo: async () => ({ repoUrl: "https://github.com/org/r.git", defaultBranch: "main" }),
      pushBaseRef: async (repoDir, baseCommit, repoUrl, branch, opts) => {
        calls.push({ repoDir, baseCommit, repoUrl, branch, opts });
      },
      deleteRepo: async () => {},
    },
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    repoDir: "/tmp/fake-clone",
    baseCommit: "basesha",
    branch: "main",
    opts: { stripClaude: true }, // .claude/ present in the snapshot
  });
});

test("seedGithub does not stripClaude when the snapshot has no .claude/ path", async () => {
  const calls: any[] = [];
  const inst = { id: "o__r-2", repo: "o/r", base_commit: "b2", test_patch: "", fix_patch: "" } as any;
  await seedGithub(inst, { benchGithubOrg: "org" }, {
    deps: {
      fetchSnapshot: async () => ({ files: [{ path: "src/a.py", content: "x" }], repoDir: "/tmp/c2" }),
      createRepo: async () => ({ repoUrl: "https://github.com/org/r.git", defaultBranch: "main" }),
      pushBaseRef: async (...a: any[]) => { calls.push(a); },
      deleteRepo: async () => {},
    },
  });
  expect(calls[0][4]).toEqual({ stripClaude: false });
});
```
Also update the EXISTING `seedGithub` tests that stub `fetchSnapshot`/`pushSnapshot`: change their `fetchSnapshot` stub to return `{ files, repoDir }` and replace any `pushSnapshot` stub with a `pushBaseRef` stub (the firewall-ordering assertions stay — `assertNoHeldOutPaths` still runs before `createRepo`).

- [ ] **Step 2: Run the tests — verify they FAIL**

Run: `bun test tests/seed.test.ts`
Expected: FAIL — `seedGithub` still calls `pushSnapshot` and `fetchSnapshot` returns a bare array.

- [ ] **Step 3: Rework `fetchSnapshot` to keep the clone**

In the default `fetchSnapshot`, do NOT `rm` the clone in `finally`; return it:
```ts
  async fetchSnapshot(repo, baseCommit) {
    const repoDir = await mkdtemp(path.join(tmpdir(), "styre-bench-seed-src-"));
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
  },
```
Update the `SeedGithubDeps.fetchSnapshot` signature to `Promise<{ files: SnapshotFile[]; repoDir: string }>` and remove `pushSnapshot` from the interface + defaults.

- [ ] **Step 4: Rework `seedGithub` orchestration**

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
    await rm(repoDir, { recursive: true, force: true }); // seedGithub now owns the clone's lifetime
  }
}
```
Notes: `stripClaudeDir` is no longer called (the strip now happens in `pushBaseRef` as a commit); leave the pure `stripClaudeDir` export + its tests in place (still unit-tested, harmless) OR delete it if unused — pick one and keep lint green. The firewall doc-comment block on `seedGithub` should be updated to describe the base_commit-ref push.

- [ ] **Step 5: Run the tests — verify they PASS**

Run: `bun test tests/seed.test.ts`
Expected: PASS (new + updated).

- [ ] **Step 6: Full green check**

Run: `bun test && bun run typecheck && bun run lint`
Expected: all pass. If `stripClaudeDir` was left unused and lint flags it, either keep its call removed but retain the export (it is referenced by its own tests) or delete it and its tests together.

- [ ] **Step 7: Commit**

```bash
git add orchestrator/seed-github.ts tests/seed.test.ts
git commit -m "fix(seed): publish the real base_commit as main so styre's PR opens (shared history)"
```

---

## Self-Review

**1. Spec coverage:** The "no history in common with main" blocker is fixed by seeding `main` at the real `base_commit` (Task 1 `pushBaseRef`, Task 2 wiring), so styre's fix branch shares an ancestor and the PR opens; `git diff base_commit..head` is unaffected. The leak firewall is preserved two ways: `assertNoHeldOutPaths` still verifies the base tree (throws pre-create), and only the `base_commit`-rooted ref is pushed so no forward/fix commit is reachable. `.claude/` is stripped at the tip via an on-top commit without disturbing the shared ancestor.

**2. Placeholder scan:** Every step carries real code + exact commands. The one reminder-comment (`defaultSeedDepsForTest` placeholder import) is explicitly called out to delete.

**3. Type consistency:** `fetchSnapshot` return type is changed in one place and consumed in one place (`seedGithub`); `pushBaseRef` signature is defined in Task 1 and called with matching args in Task 2. `pushSnapshot` is removed from both the interface and `seedGithub`. `requireBenchToken` centralizes the existing token guard.

**Key decisions for the reviewer to stress-test:**
- Is pushing the real `base_commit` (real ancestry) leak-safe given only the `base_commit`-rooted ref is pushed (no forward commits reachable)? Compare against the container-side `/testbed` full-history leak (explicitly out of scope).
- Is the `.claude/`-strip-on-top commit the right call vs. accepting `base_commit`'s tree verbatim (the agent reads the container's `/testbed`, not the throwaway repo — does the throwaway `.claude/` matter at all)?
- Does any consumer other than `fetchPrDiff` rely on `main` being a single rootless snapshot commit? (Scorer, cleanup, corpus.)
