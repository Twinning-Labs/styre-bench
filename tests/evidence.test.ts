import { describe, expect, test } from "bun:test";
import { evidenceDirName, selectPrunable } from "../orchestrator/evidence";

describe("evidenceDirName", () => {
  test("is chronologically sortable as a plain string", () => {
    const a = evidenceDirName("astropy__astropy-12907", new Date("2026-09-08T19:41:05Z"), "aaaa");
    const b = evidenceDirName("astropy__astropy-12907", new Date("2026-09-08T21:15:00Z"), "bbbb");
    const c = evidenceDirName("astropy__astropy-12907", new Date("2026-09-09T01:00:00Z"), "cccc");
    expect([c, a, b].sort()).toEqual([a, b, c]);
  });

  test("carries the instance id and the suffix", () => {
    const n = evidenceDirName("astropy__astropy-12907", new Date("2026-09-08T19:41:05Z"), "9f2c");
    expect(n).toContain("astropy__astropy-12907");
    expect(n).toContain("9f2c");
    expect(n).toContain("20260908");
  });

  test("replaces path separators so an instance id can never escape the root", () => {
    const n = evidenceDirName("../../etc/passwd", new Date("2026-09-08T19:41:05Z"), "x");
    expect(n).not.toContain("/");
    expect(n).not.toContain("..");
  });
});

describe("selectPrunable", () => {
  const dirs = [
    "i-20260901-000000-a",
    "i-20260902-000000-b",
    "i-20260903-000000-c",
    "i-20260904-000000-d",
  ];

  test("keeps the N most recent and returns the rest", () => {
    expect(selectPrunable(dirs, 2)).toEqual(["i-20260901-000000-a", "i-20260902-000000-b"]);
  });

  test("returns nothing when there are fewer than N", () => {
    expect(selectPrunable(dirs, 10)).toEqual([]);
  });

  test("input order does not matter", () => {
    const shuffled = [dirs[3], dirs[0], dirs[2], dirs[1]] as string[];
    expect(selectPrunable(shuffled, 1)).toEqual(dirs.slice(0, 3));
  });

  test("keep=0 prunes everything", () => {
    expect(selectPrunable(dirs, 0)).toEqual(dirs);
  });

  test("a negative keep is treated as 0 rather than slicing from the end", () => {
    expect(selectPrunable(dirs, -3)).toEqual(dirs);
  });
});
