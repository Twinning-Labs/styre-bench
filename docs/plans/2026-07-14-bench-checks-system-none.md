# Force `checksSystem: "none"` for bench scratch repos — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the styre-bench harness pass `--checks none` to its in-container `styre setup` call so bench scratch repos get `checksSystem: "none"`, flipping the merge-stage outcome from `no-progress` (stuck polling CI that never runs) to `pr-ready`.

**Architecture:** One-flag change to the generated container entrypoint. `buildEntrypoint` in `orchestrator/run-task.ts` emits a bash script whose `[5/6] styre setup` step currently runs `styre setup <repo> --out <profile> --trust-agent-commands`. We insert `--checks none` — an existing, supported styre-core CLI flag (`src/cli/setup.ts:216`) — into that command. No styre-core change, no `profile.json` mutation, no downstream harness change.

**Tech Stack:** TypeScript, Bun (`bun test`), the styre-bench orchestrator.

**Design doc:** `docs/design/2026-07-14-bench-checks-system-none.md` (read it first — it carries the full rationale and the gate-ordering proof).

## Global Constraints

- **styre core is untouched.** The change lives entirely in `orchestrator/run-task.ts` (the bench harness). Do not edit any file under the styre core repo. `--checks` is already a supported core flag; using it is not a core change.
- **Unconditional.** The flag is always appended — not gated behind a `bench.config` toggle. Every bench cohort runs a CI-less throwaway scratch repo, so `none` is always correct here.
- **Exact flag string:** `--checks none` (spelled `--checks`, value `none` — a bare literal, no quotes).
- **Flag placement:** immediately after `--out "${CONTAINER_PROFILE_PATH}"` and before `--trust-agent-commands`, so the emitted `styre setup` command reads `… --out "/out/profile.json" --checks none --trust-agent-commands`. (`citty` parses flags position-independently, so placement is functional-equivalent; this placement is chosen to match the test assertions in this plan.)
- **Commit footer:** end the commit message with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **Branch:** work is on `fix/bench-checks-system-none` (already created; the design doc is already committed there).

---

### Task 1: Append `--checks none` to the bench `styre setup` command

**Files:**
- Modify: `orchestrator/run-task.ts:359` (the `styre setup` line inside `buildEntrypoint`)
- Modify: `orchestrator/run-task.ts:182` (the `buildEntrypoint` doc-comment's step-5 summary — keep it in sync)
- Test: `tests/run-task.test.ts:224` (update existing exact-match assertion) + a new focused assertion in the same `describe` block

**Interfaces:**
- Consumes: `buildEntrypoint({ seed, repoDirInImage? })` — the existing exported function in `orchestrator/run-task.ts` that returns the container entrypoint bash script as a single string. `CONTAINER_PROFILE_PATH` = `"/out/profile.json"`, default `repoDirInImage` = `"/testbed"`.
- Produces: no new interface. The emitted script string now contains `setup "/testbed" --out "/out/profile.json" --checks none --trust-agent-commands`.

- [ ] **Step 1: Update the existing exact-match assertion and add a focused one (write the failing tests)**

In `tests/run-task.test.ts`, the test at line ~219 (`"runs styre setup with --out a deterministic profile path + --trust-agent-commands, on the repoDirInImage default (/testbed)"`) currently asserts the old command. Change its exact-match assertion (line 224) from:

```ts
    expect(script).toContain('setup "/testbed" --out "/out/profile.json" --trust-agent-commands');
```

to the new full command (adds `--checks none`):

```ts
    expect(script).toContain(
      'setup "/testbed" --out "/out/profile.json" --checks none --trust-agent-commands',
    );
```

Then add a new, focused test immediately after that test's closing `});` (i.e. right before the `"honors a repoDirInImage override"` test at line ~227), guarding the override flag on its own:

```ts
  test("forces checksSystem:none via `styre setup --checks none` so a CI-less bench scratch repo does not stall merge on external_checks", () => {
    // Bench instance repos ship .github/workflows in-tree, so styre setup would probe
    // checksSystem:"github" and merge would idle forever polling for GH-Actions check-runs that
    // a throwaway scratch repo never produces. Forcing "none" makes external_checks resolve
    // "skipped" so the run reaches pr-ready. See docs/design/2026-07-14-bench-checks-system-none.md.
    const script = buildEntrypoint({ seed: makeSeed() });
    expect(script).toContain("--checks none");
  });
```

Note: the `"honors a repoDirInImage override"` test at line ~227 asserts the prefix substring `setup "/repo" --out "/out/profile.json"`, which is still present after the change — leave it unchanged.

- [ ] **Step 2: Run the tests to verify they fail (red)**

Run: `cd /Users/rajatgoyal/code/styre-bench && bun test tests/run-task.test.ts`
Expected: FAIL — the updated exact-match assertion and the new `--checks none` assertion both fail because the emitted command does not yet contain `--checks none` (the other tests in the file still pass).

- [ ] **Step 3: Add `--checks none` to the `styre setup` command (minimal implementation)**

In `orchestrator/run-task.ts`, find the `styre setup` line (currently line 359):

```ts
    `"${CONTAINER_BINARY_PATH}" setup "${repoDirInImage}" --out "${CONTAINER_PROFILE_PATH}" --trust-agent-commands`,
```

Replace it with the version that inserts `--checks none`, and add a comment above it explaining why. The surrounding lines already carry a `--trust-agent-commands` comment; add the `--checks none` rationale just before the command line (after the existing `--trust-agent-commands` comment block that ends at line 358):

```ts
    // --checks none: bench instance repos ship .github/workflows in-tree, so styre setup would
    // probe checksSystem:"github" — but the throwaway scratch repo never runs Actions, so merge
    // would idle forever polling for check-runs that never arrive (external_checks stays pending
    // → no-progress). Forcing "none" makes styre deliver external_checks="skipped", so the run
    // reaches pr-ready. Narrow to the bench; styre core detection is untouched.
    // See docs/design/2026-07-14-bench-checks-system-none.md.
    `"${CONTAINER_BINARY_PATH}" setup "${repoDirInImage}" --out "${CONTAINER_PROFILE_PATH}" --checks none --trust-agent-commands`,
```

Also keep the `buildEntrypoint` doc-comment's step-5 summary in sync. In the same file, the JSDoc block for `buildEntrypoint` has a step-5 line (currently line 182):

```ts
 * 5. `styre setup <repoDirInImage> --out <profilePath> --trust-agent-commands` (see the flag's
```

Change it to include `--checks none` (matching the emitted command):

```ts
 * 5. `styre setup <repoDirInImage> --out <profilePath> --checks none --trust-agent-commands` (see the flag's
```

This is a comment only — no test depends on it — but it keeps the summary honest.

- [ ] **Step 4: Run the tests to verify they pass (green), then the full suite**

Run: `cd /Users/rajatgoyal/code/styre-bench && bun test tests/run-task.test.ts`
Expected: PASS — all tests in the file green, including the updated exact-match assertion and the new `--checks none` assertion.

Then run the full suite to confirm nothing else regressed:

Run: `cd /Users/rajatgoyal/code/styre-bench && bun test`
Expected: PASS — same pass/skip counts as before, plus one new passing test.

- [ ] **Step 5: Commit**

```bash
cd /Users/rajatgoyal/code/styre-bench
git add orchestrator/run-task.ts tests/run-task.test.ts
git commit -F - <<'EOF'
fix(run-task): force checksSystem:"none" for bench scratch repos (ENG-295)

The bench runs `styre setup <repo>` live in each instance container; setup
probes checksSystem from `.github/workflows/`, so SWE/multi-SWE repos (which
ship workflows in-tree) get `checksSystem:"github"`. But the throwaway scratch
repo never runs CI, so at merge the `external_checks` signal stays `pending`
forever and the run idles to `no-progress` instead of reaching `pr-ready`
(confirmed by the 2026-07-13 captured SoT: darkreader ENG-293 opened its PR
cleanly and stalled only on the stuck checks signal).

Append `--checks none` to the bench's existing `styre setup` call. `--checks`
is an existing supported styre-core flag, so core detection is untouched and no
profile.json mutation is needed; a real repo run (no flag) still probes
`github` when Actions genuinely exist. Narrow to the harness and unconditional
(every bench cohort is a CI-less scratch repo).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Self-Review

**1. Spec coverage.** The spec's three acceptance criteria map to this one task:
- "Bench runs pass `checksSystem:"none"` into `styre run`" → Step 3 (the `--checks none` flag) + Steps 1/4 (assertions on the emitted command).
- "A ticket at `stage=merge` with a PR advances past `external_checks`" → verified in the design doc's gate-ordering proof; the flag is the mechanism, and the emitted-command assertion is the harness-level check (a full container run is out of scope for a unit test, as the design's Testing section states).
- "styre core is untouched" → Global Constraints + the change touching only `orchestrator/run-task.ts` and `tests/run-task.test.ts`.

**2. Placeholder scan.** No TBD/TODO/"handle edge cases"/vague steps. Every code step shows the exact code and the exact command with expected output.

**3. Type consistency.** `buildEntrypoint`, `makeSeed`, `CONTAINER_PROFILE_PATH`, `repoDirInImage` are used consistently with their existing definitions in `run-task.ts`/`run-task.test.ts`. No new types introduced. Flag string `--checks none` is identical across the constraint, both test assertions, and the implementation line.

Single task; no cross-task naming to reconcile.
