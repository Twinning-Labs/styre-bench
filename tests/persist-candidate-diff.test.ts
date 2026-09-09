import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CANDIDATE_DIFF_NAME, persistCandidateDiff } from "../orchestrator/evidence";

describe("persistCandidateDiff", () => {
  test("writes the diff into the run's evidence dir and returns the path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "styre-diff-"));
    const p = await persistCandidateDiff(dir, "diff --git a/x b/x\n+one\n");
    expect(p).toBe(join(dir, CANDIDATE_DIFF_NAME));
    expect(readFileSync(p as string, "utf8")).toBe("diff --git a/x b/x\n+one\n");
  });

  test("an EMPTY diff is still written, because it is a real finding", async () => {
    // Every scored attempt so far produced an empty diff. An absent file and an empty
    // file mean different things; writing it keeps that distinction on disk.
    const dir = mkdtempSync(join(tmpdir(), "styre-diff-"));
    const p = await persistCandidateDiff(dir, "");
    expect(existsSync(p as string)).toBe(true);
    expect(readFileSync(p as string, "utf8")).toBe("");
  });

  test("no evidence dir -> no write, no throw", async () => {
    expect(await persistCandidateDiff(null, "x")).toBeNull();
    expect(await persistCandidateDiff(undefined, "x")).toBeNull();
  });

  test("an unwritable destination does not throw — the diff is evidence, not an output", async () => {
    // A capture failure must never fail a run that otherwise succeeded.
    expect(await persistCandidateDiff("/proc/nonexistent/nope", "x")).toBeNull();
  });
});
