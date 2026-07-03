import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BENCH_CONFIG } from "../config/bench.config";
import { loadInstances, normalizeInstance } from "../orchestrator/corpus";
import msbRaw from "./fixtures/msb-raw.json";
import sweRaw from "./fixtures/swebench-raw.json";

describe("normalizeInstance: swe-bench", () => {
  test("maps patch -> fix_patch (NOT a fix_patch passthrough)", () => {
    const inst = normalizeInstance(sweRaw, "swe-bench");
    expect(inst.fix_patch).toBe(sweRaw.patch);
    expect(inst.fix_patch).toContain("Decimal");
  });

  test("maps id, test_patch, hints, merge_date verbatim", () => {
    const inst = normalizeInstance(sweRaw, "swe-bench");
    expect(inst.id).toBe(sweRaw.instance_id);
    expect(inst.test_patch).toBe(sweRaw.test_patch);
    expect(inst.hints).toBe(sweRaw.hints_text);
    expect(inst.merge_date).toBe(sweRaw.created_at);
    expect(inst.repo).toBe(sweRaw.repo);
    expect(inst.base_commit).toBe(sweRaw.base_commit);
    expect(inst.language).toBe("python");
  });

  test("parses UPPERCASE JSON-encoded string lists into populated string[]", () => {
    const inst = normalizeInstance(sweRaw, "swe-bench");
    expect(Array.isArray(inst.fail_to_pass)).toBe(true);
    expect(inst.fail_to_pass.length).toBeGreaterThan(0);
    expect(inst.fail_to_pass).toEqual(["tests/test_json.py::test_decimal_serialization"]);
    expect(inst.pass_to_pass.length).toBeGreaterThan(0);
    expect(inst.pass_to_pass).toEqual([
      "tests/test_json.py::test_basic_serialization",
      "tests/test_json.py::test_datetime_serialization",
    ]);
  });

  test("derives image by the sweb.eval.x86_64.<instance_id> convention, lowercased", () => {
    const inst = normalizeInstance(sweRaw, "swe-bench");
    expect(inst.image).toBe(`sweb.eval.x86_64.${sweRaw.instance_id.toLowerCase()}`);
  });

  test("missing FAIL_TO_PASS throws loudly instead of silently yielding []", () => {
    const { FAIL_TO_PASS, ...broken } = sweRaw as Record<string, unknown> & {
      FAIL_TO_PASS?: unknown;
    };
    expect(() => normalizeInstance(broken, "swe-bench")).toThrow(/FAIL_TO_PASS/);
  });

  test("missing patch (gold fix) throws loudly", () => {
    const { patch, ...broken } = sweRaw as Record<string, unknown> & { patch?: unknown };
    expect(() => normalizeInstance(broken, "swe-bench")).toThrow(/patch/);
  });

  test("empty FAIL_TO_PASS ([]) throws loudly instead of vacuously resolving", () => {
    const emptied = { ...sweRaw, FAIL_TO_PASS: "[]" };
    expect(() => normalizeInstance(emptied, "swe-bench")).toThrow(/FAIL_TO_PASS/);
  });

  test("empty PASS_TO_PASS ([]) does NOT throw (empty pass_to_pass is legal)", () => {
    const emptied = { ...sweRaw, PASS_TO_PASS: "[]" };
    const inst = normalizeInstance(emptied, "swe-bench");
    expect(inst.pass_to_pass).toEqual([]);
    expect(inst.fail_to_pass.length).toBeGreaterThan(0);
  });

  test("org/repo_name/pr_number are NOT populated (swe-bench has no MSB org/repo/number split)", () => {
    const inst = normalizeInstance(sweRaw, "swe-bench");
    expect(inst.org).toBeUndefined();
    expect(inst.repo_name).toBeUndefined();
    expect(inst.pr_number).toBeUndefined();
  });
});

describe("normalizeInstance: multi-swe-bench", () => {
  test("maps to the SAME Instance shape as swe-bench (fix_patch/test_patch passthrough)", () => {
    const inst = normalizeInstance(msbRaw, "multi-swe-bench");
    expect(inst.fix_patch).toBe(msbRaw.fix_patch);
    expect(inst.test_patch).toBe(msbRaw.test_patch);
    expect(inst.id).toBe(msbRaw.instance_id);
    expect(inst.language).toBe("ts");
  });

  test("derives fail_to_pass/pass_to_pass from the test-name dicts, populated (not [])", () => {
    const inst = normalizeInstance(msbRaw, "multi-swe-bench");
    expect(inst.fail_to_pass).toEqual(["test.js::negative odd numbers"]);
    expect(inst.pass_to_pass).toEqual(["test.js::positive odd numbers", "test.js::even numbers"]);
  });

  test("builds repo from org/repo and reads base_commit from base.sha", () => {
    const inst = normalizeInstance(msbRaw, "multi-swe-bench");
    expect(inst.repo).toBe(`${msbRaw.org}/${msbRaw.repo}`);
    expect(inst.base_commit).toBe(msbRaw.base.sha);
  });

  test("derives image by the mswebench/<org>_m_<repo>:pr-<number> convention", () => {
    const inst = normalizeInstance(msbRaw, "multi-swe-bench");
    expect(inst.image).toBe(
      `mswebench/${msbRaw.org}_m_${msbRaw.repo}:pr-${msbRaw.number}`.toLowerCase(),
    );
  });

  test("problem_statement is built from title + body", () => {
    const inst = normalizeInstance(msbRaw, "multi-swe-bench");
    expect(inst.problem_statement).toContain(msbRaw.title);
    expect(inst.problem_statement).toContain(msbRaw.body);
  });

  test("missing f2p_tests throws loudly instead of silently yielding []", () => {
    const { f2p_tests, ...broken } = msbRaw as Record<string, unknown> & { f2p_tests?: unknown };
    expect(() => normalizeInstance(broken, "multi-swe-bench")).toThrow(/f2p_tests/);
  });

  test("empty f2p_tests ({}) throws loudly instead of vacuously resolving", () => {
    const emptied = { ...msbRaw, f2p_tests: {} };
    expect(() => normalizeInstance(emptied, "multi-swe-bench")).toThrow(/f2p_tests/);
  });

  test("empty p2p_tests ({}) does NOT throw (empty pass_to_pass is legal)", () => {
    const emptied = { ...msbRaw, p2p_tests: {} };
    const inst = normalizeInstance(emptied, "multi-swe-bench");
    expect(inst.pass_to_pass).toEqual([]);
    expect(inst.fail_to_pass.length).toBeGreaterThan(0);
  });

  test("populates org/repo_name/pr_number from the raw record (for MultiSweBenchAdapter, not a re-parse of id)", () => {
    const inst = normalizeInstance(msbRaw, "multi-swe-bench");
    expect(inst.org).toBe(msbRaw.org);
    expect(inst.repo_name).toBe(msbRaw.repo);
    expect(inst.pr_number).toBe(msbRaw.number);
  });
});

describe("normalizeInstance: shared error handling", () => {
  test("non-object raw input throws", () => {
    expect(() => normalizeInstance(null, "swe-bench")).toThrow();
    expect(() => normalizeInstance("nope", "multi-swe-bench")).toThrow();
  });
});

describe("loadInstances: drops corrupt records without aborting the whole corpus", () => {
  test("an empty-FAIL_TO_PASS record is dropped; the valid records still load", async () => {
    // Real case: Multi-SWE-bench's mui__material-ui-39688 has an empty FAIL_TO_PASS. One such
    // record must NOT crash loading the entire dataset (it did, before this fix).
    const bad = { ...sweRaw, instance_id: "bad__corrupt-1", FAIL_TO_PASS: "[]" };
    const dir = await mkdtemp(path.join(tmpdir(), "corpus-drop-"));
    await writeFile(
      path.join(dir, "swe-bench.json"),
      JSON.stringify([sweRaw, bad, sweRaw]),
      "utf8",
    );
    const instances = await loadInstances("swe-bench", BENCH_CONFIG, dir);
    expect(instances.length).toBe(2); // two valid; the corrupt one dropped
    expect(instances.every((i) => i.fail_to_pass.length > 0)).toBe(true);
  });

  test("a corpus where EVERY record is corrupt throws (refuses to return an empty corpus)", async () => {
    const bad = { ...sweRaw, FAIL_TO_PASS: "[]" };
    const dir = await mkdtemp(path.join(tmpdir(), "corpus-allbad-"));
    await writeFile(path.join(dir, "swe-bench.json"), JSON.stringify([bad, bad]), "utf8");
    await expect(loadInstances("swe-bench", BENCH_CONFIG, dir)).rejects.toThrow(/empty or corrupt/);
  });
});
