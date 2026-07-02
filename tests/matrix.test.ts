import { describe, expect, test } from "bun:test";
import { selectPilot, tagCutoff } from "../orchestrator/matrix";
import type { Difficulty, Instance } from "../orchestrator/types";

function makeInstance(
  id: string,
  language: Instance["language"],
  difficulty: Difficulty,
  merge_date?: string,
): Instance {
  return {
    id,
    language,
    difficulty,
    repo: "org/repo",
    base_commit: "deadbeef",
    problem_statement: `problem for ${id}`,
    image: `img.${id}`,
    fail_to_pass: ["a::b"],
    pass_to_pass: ["c::d"],
    merge_date,
    fix_patch: "diff --git a/f b/f\n",
    test_patch: "diff --git a/t b/t\n",
  };
}

function buildFullPool(): Instance[] {
  const pool: Instance[] = [];
  const languages: Instance["language"][] = ["ts", "python"];
  const difficulties: Difficulty[] = ["easy", "medium", "hard"];
  for (const language of languages) {
    for (const difficulty of difficulties) {
      // two candidates per cell so selection is a real choice, not a degenerate single-option pick
      pool.push(makeInstance(`${language}-${difficulty}-1`, language, difficulty));
      pool.push(makeInstance(`${language}-${difficulty}-2`, language, difficulty));
    }
  }
  return pool;
}

describe("selectPilot", () => {
  test("returns exactly 6, one per language x difficulty cell", () => {
    const pool = buildFullPool();
    const picked = selectPilot(pool, 42);
    expect(picked.length).toBe(6);
    const cells = new Set(picked.map((i) => `${i.language}:${i.difficulty}`));
    expect(cells.size).toBe(6);
    expect(cells).toEqual(
      new Set(["ts:easy", "ts:medium", "ts:hard", "python:easy", "python:medium", "python:hard"]),
    );
  });

  test("is deterministic for a given seed", () => {
    const pool = buildFullPool();
    const first = selectPilot(pool, 42).map((i) => i.id);
    const second = selectPilot(pool, 42).map((i) => i.id);
    expect(second).toEqual(first);
  });

  test("a different seed can select a different set (sampling is not seed-inert)", () => {
    const pool = buildFullPool();
    const bySeed42 = selectPilot(pool, 42).map((i) => i.id);
    const seeds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const anyDifferent = seeds.some((s) => {
      const ids = selectPilot(pool, s).map((i) => i.id);
      return ids.join(",") !== bySeed42.join(",");
    });
    expect(anyDifferent).toBe(true);
  });

  test("throws naming the empty cell when a language x difficulty combination has no candidates", () => {
    const pool = buildFullPool().filter((i) => !(i.language === "ts" && i.difficulty === "hard"));
    expect(() => selectPilot(pool, 42)).toThrow(/ts:hard/);
  });
});

describe("tagCutoff", () => {
  test("merge_date after cutoff -> true", () => {
    expect(tagCutoff({ merge_date: "2025-06-01" }, "2025-01-01")).toBe(true);
  });

  test("merge_date before cutoff -> false", () => {
    expect(tagCutoff({ merge_date: "2024-06-01" }, "2025-01-01")).toBe(false);
  });

  test("missing merge_date is null-safe -> false", () => {
    expect(tagCutoff({ merge_date: undefined }, "2025-01-01")).toBe(false);
  });
});
