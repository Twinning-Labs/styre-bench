import { describe, expect, test } from "bun:test";
import { buildScorePayload } from "../bin/emit-score-payload";

describe("buildScorePayload", () => {
  test("carries exactly id, language and the diff", () => {
    const p = buildScorePayload("astropy__astropy-12907", "python", "diff --git a/x b/x\n");
    expect(p.instance).toEqual({ id: "astropy__astropy-12907", language: "python" });
    expect(p.candidate_diff).toBe("diff --git a/x b/x\n");
  });

  test("FIREWALL: no gold patch or held-out tests can appear in the payload", () => {
    // orchestrator/types.ts:29-30 mark fix_patch/test_patch FIREWALL, and /data/ is gitignored
    // so the corpus never enters the public repo. A payload is committed or uploaded for CI,
    // so this assertion is the guard that keeps the oracle's answer key out of it.
    const json = JSON.stringify(buildScorePayload("x__y-1", "python", "d"));
    for (const forbidden of ["fix_patch", "test_patch", "FAIL_TO_PASS", "PASS_TO_PASS", "patch"]) {
      expect(json).not.toContain(forbidden);
    }
  });

  test("an empty diff is preserved as an explicit empty string", () => {
    // The harness CLI filters empty patches out before starting a container, which is why the
    // adapter calls run_instance directly. An empty diff must still reach it explicitly so the
    // outcome is `resolved: false`, not a crash or a silent skip.
    const p = buildScorePayload("x__y-1", "python", "");
    expect(p.candidate_diff).toBe("");
    expect(Object.hasOwn(p, "candidate_diff")).toBe(true);
  });
});
