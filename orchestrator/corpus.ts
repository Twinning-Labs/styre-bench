import { readFile } from "node:fs/promises";
import path from "node:path";
import type { BENCH_CONFIG } from "../config/bench.config";
import type { Difficulty, Instance } from "./types";

export type Family = "swe-bench" | "multi-swe-bench";

// SWE-bench-Verified's own difficulty label -> our coarse 3-bucket Difficulty.
// Bucket boundaries are ours (not part of the upstream schema): the label set itself
// (`<15 min fix` / `15 min - 1 hour` / `1-4 hours` / `>4 hours`) is documented in the
// SWE-bench_Verified dataset card.
const SWEBENCH_DIFFICULTY_LABELS: Record<string, Difficulty> = {
  "<15 min fix": "easy",
  "15 min - 1 hour": "easy",
  "1-4 hours": "medium",
  ">4 hours": "hard",
};

function assertRecord(raw: unknown, family: Family): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`corpus: raw ${family} record is not an object (got ${typeof raw})`);
  }
  return raw as Record<string, unknown>;
}

function recordId(r: Record<string, unknown>): string {
  const id = r.instance_id;
  return typeof id === "string" ? id : "?";
}

/** Throws loudly (naming the key + family + record id) instead of ever defaulting. */
function requireKey<T>(r: Record<string, unknown>, key: string, family: Family): T {
  const v = r[key];
  if (v === undefined || v === null) {
    throw new Error(
      `corpus: missing required key "${key}" on a ${family} raw record (instance_id=${recordId(r)})`,
    );
  }
  return v as T;
}

function requireString(r: Record<string, unknown>, key: string, family: Family): string {
  const v = requireKey<unknown>(r, key, family);
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(
      `corpus: expected "${key}" to be a non-empty string on a ${family} raw record (instance_id=${recordId(r)}), got ${typeof v}`,
    );
  }
  return v;
}

function optionalString(r: Record<string, unknown>, key: string): string | undefined {
  const v = r[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * SWE-bench's FAIL_TO_PASS/PASS_TO_PASS are UPPERCASE keys whose value is itself a
 * JSON-encoded string (e.g. `"[\"tests/x.py::test_y\"]"`), not a native array. Parse it
 * and throw loudly on any shape mismatch — never fall back to `[]`.
 */
function parseJsonStringList(r: Record<string, unknown>, key: string, family: Family): string[] {
  const v = requireKey<unknown>(r, key, family);
  if (typeof v !== "string") {
    throw new Error(
      `corpus: expected "${key}" to be a JSON-encoded string on a ${family} raw record (instance_id=${recordId(r)}), got ${typeof v}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(v);
  } catch (err) {
    throw new Error(
      `corpus: "${key}" on a ${family} raw record (instance_id=${recordId(r)}) is not valid JSON: ${(err as Error).message}`,
    );
  }
  if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === "string")) {
    throw new Error(
      `corpus: "${key}" on a ${family} raw record (instance_id=${recordId(r)}) did not parse to a string[]`,
    );
  }
  return parsed;
}

/**
 * ASSUMPTION (verify in Task 3 against a live Multi-SWE-bench dataset sample):
 * `f2p_tests`/`p2p_tests` are documented (HF dataset card) as "dict" fields without a
 * confirmed value shape. We assume they are keyed by fully-qualified test name (dict
 * keys = test ids) and take `Object.keys()` as the id list. If the real dataset instead
 * nests test names under a per-environment/per-run key, this will silently produce the
 * wrong strings (env names, not test ids) — must be checked against a live record before
 * Task 3's scorer trusts these lists for real scoring.
 */
function testNamesFromDict(r: Record<string, unknown>, key: string, family: Family): string[] {
  const v = requireKey<unknown>(r, key, family);
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new Error(
      `corpus: expected "${key}" to be a dict of test names on a ${family} raw record (instance_id=${recordId(r)}), got ${typeof v}`,
    );
  }
  return Object.keys(v as Record<string, unknown>);
}

function difficultyFromPatchSize(patch: string): Difficulty {
  const changedLines = patch
    .split("\n")
    .filter(
      (l) =>
        (l.startsWith("+") || l.startsWith("-")) && !l.startsWith("+++") && !l.startsWith("---"),
    ).length;
  if (changedLines <= 10) return "easy";
  if (changedLines <= 40) return "medium";
  return "hard";
}

function normalizeSweBench(r: Record<string, unknown>): Instance {
  const family: Family = "swe-bench";
  const id = requireString(r, "instance_id", family);
  // The gold fix is named `patch` in the raw schema, NOT `fix_patch` — do not rename this line.
  const fix_patch = requireString(r, "patch", family);
  const test_patch = requireString(r, "test_patch", family);
  const fail_to_pass = parseJsonStringList(r, "FAIL_TO_PASS", family);
  const pass_to_pass = parseJsonStringList(r, "PASS_TO_PASS", family);
  const repo = requireString(r, "repo", family);
  const base_commit = requireString(r, "base_commit", family);
  const problem_statement = requireString(r, "problem_statement", family);
  const hints = optionalString(r, "hints_text");
  const merge_date = optionalString(r, "created_at");

  const label = typeof r.difficulty === "string" ? (r.difficulty as string) : undefined;
  const difficulty =
    (label ? SWEBENCH_DIFFICULTY_LABELS[label] : undefined) ?? difficultyFromPatchSize(fix_patch);

  return {
    id,
    language: "python",
    difficulty,
    repo,
    base_commit,
    problem_statement,
    hints,
    // SWE-bench eval image naming convention: sweb.eval.x86_64.<instance_id>, lowercased.
    image: `sweb.eval.x86_64.${id.toLowerCase()}`,
    fail_to_pass,
    pass_to_pass,
    merge_date,
    fix_patch,
    test_patch,
  };
}

function readBaseCommit(r: Record<string, unknown>, family: Family): string {
  const base = r.base;
  // ASSUMPTION (verify in Task 3): the base commit sha lives at `base.sha`, mirroring the
  // shape of a GitHub PR API "base" ref. Falls back to a bare `base_commit` string field
  // if `base.sha` isn't present — the real dataset's exact shape is unconfirmed.
  if (typeof base === "object" && base !== null) {
    const sha = (base as Record<string, unknown>).sha;
    if (typeof sha === "string" && sha.length > 0) return sha;
  }
  const flat = r.base_commit;
  if (typeof flat === "string" && flat.length > 0) return flat;
  throw new Error(
    `corpus: missing required key "base.sha"/"base_commit" on a ${family} raw record (instance_id=${recordId(r)})`,
  );
}

function normalizeMultiSweBench(r: Record<string, unknown>): Instance {
  const family: Family = "multi-swe-bench";
  const id = requireString(r, "instance_id", family);
  const fix_patch = requireString(r, "fix_patch", family);
  const test_patch = requireString(r, "test_patch", family);
  const fail_to_pass = testNamesFromDict(r, "f2p_tests", family);
  const pass_to_pass = testNamesFromDict(r, "p2p_tests", family);
  const org = requireString(r, "org", family);
  const repo = requireString(r, "repo", family);
  const base_commit = readBaseCommit(r, family);

  // ASSUMPTION (verify in Task 3): problem_statement is assembled from `title` + `body`
  // (both confirmed present in the HF Multi-SWE-bench schema as PR title/body); the split
  // mirrors SWE-bench's own problem_statement convention (issue title + body concatenated).
  const title = requireString(r, "title", family);
  const body = requireString(r, "body", family);
  const problem_statement = `${title}\n\n${body}`;

  // ASSUMPTION (verify in Task 3): `created_at` as the merge/PR-creation date field name
  // is unconfirmed against the live dataset schema (not in the field list we could
  // independently verify) — treat as best-effort; absent -> merge_date stays undefined
  // (Instance.merge_date is optional) rather than silently guessing a wrong value.
  const merge_date = optionalString(r, "created_at");

  const difficulty = difficultyFromPatchSize(fix_patch);

  // ASSUMPTION (verify in Task 3): no confirmed MSB image-tag convention was found; this
  // mirrors SWE-bench's `sweb.eval.x86_64.<id>` pattern with an "mswebench" prefix as a
  // placeholder. Must be corrected against the actual Multi-SWE-bench runner's image
  // naming before Task 3's scorer tries to `docker pull`/`run` it.
  const image = `mswebench.eval.x86_64.${id.toLowerCase()}`;

  return {
    id,
    // Hardcoded, not inferred from the raw record: BENCH_CONFIG.tsCorpus is a zod
    // `z.literal("multi-swe-bench")` and is the ONLY corpus family ever routed through
    // this branch (see config/bench.config.ts) — so every instance normalized here is,
    // by construction of this codebase's config, the TS work-unit corpus. We deliberately
    // do NOT try to read a "language" field off the raw record (no such per-record field
    // was confirmed in the live schema; MSB's per-language split lives at the dataset-
    // config level, not the record level).
    language: "ts",
    difficulty,
    repo: `${org}/${repo}`,
    base_commit,
    problem_statement,
    image,
    fail_to_pass,
    pass_to_pass,
    merge_date,
    fix_patch,
    test_patch,
  };
}

export function normalizeInstance(raw: unknown, family: Family): Instance {
  const r = assertRecord(raw, family);
  return family === "swe-bench" ? normalizeSweBench(r) : normalizeMultiSweBench(r);
}

/**
 * Reads the pinned corpus for `family` off disk and returns normalized Instances.
 *
 * SCOPE NOTE: this repo has no dataset-download/fetch step yet (nothing in the plan owns
 * pulling SWE-bench-Verified / Multi-SWE-bench from HuggingFace into this repo) — that is
 * out of scope for Task 2, which owns normalization + sampling only. `loadInstances`
 * therefore reads a local cache file at `data/<family>.json` (a JSON array of raw
 * records, one dataset config's worth) and normalizes each record. The cache file is
 * expected to be populated by whatever fetch step lands later; a missing file throws a
 * clear, actionable error rather than silently returning `[]`.
 */
export async function loadInstances(
  family: Family,
  cfg: typeof BENCH_CONFIG,
  dataDir = path.join(process.cwd(), "data"),
): Promise<Instance[]> {
  const corpusId = family === "swe-bench" ? cfg.pythonCorpus : cfg.tsCorpus;
  const file = path.join(dataDir, `${family}.json`);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    throw new Error(
      `corpus: could not read pinned dataset cache for family "${family}" (corpus "${corpusId}") at ${file} — ` +
        `a dataset-fetch step must populate this file before loadInstances can run (${(err as Error).message})`,
    );
  }
  const raw: unknown = JSON.parse(text);
  if (!Array.isArray(raw)) {
    throw new Error(`corpus: expected ${file} to contain a JSON array of raw ${family} records`);
  }
  return raw.map((rec) => normalizeInstance(rec, family));
}
