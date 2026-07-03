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

function requireInt(r: Record<string, unknown>, key: string, family: Family): number {
  const v = requireKey<unknown>(r, key, family);
  if (typeof v !== "number" || !Number.isInteger(v)) {
    throw new Error(
      `corpus: expected "${key}" to be an integer on a ${family} raw record (instance_id=${recordId(r)}), got ${typeof v}`,
    );
  }
  return v;
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
 * CONFIRMED in Task 3 (scorer/adapters/multiswebench.py) against the installed
 * `multi-swe-bench==1.1.2` PyPI package source (`multi_swe_bench/harness/report.py`'s
 * `Report` dataclass): `f2p_tests`/`p2p_tests` ARE dicts keyed by fully-qualified test
 * id — `Object.keys()` is the correct id list, exactly as assumed here. (The harness's
 * own dict *values* are `{run,test,fix}` status triples, not the bare strings used in
 * this repo's tests/fixtures/msb-raw.json fixture — but this function never reads the
 * values, so that fixture simplification doesn't matter to normalizeMultiSweBench.)
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

/**
 * FAIL_TO_PASS / f2p_tests is the task definition itself — it is NEVER legitimately empty.
 * A present-but-empty list (raw `"FAIL_TO_PASS": "[]"` or `f2p_tests: {}`) makes the
 * downstream scorer's "resolved = every fail_to_pass test now passes" check vacuously
 * true over zero tests, silently inflating the pass rate. Throw loudly instead. Do NOT
 * use this for pass_to_pass — an empty regression-guard list is legal.
 */
function requireNonEmpty(list: string[], label: string, id: string): string[] {
  if (list.length === 0) {
    throw new Error(
      `corpus: "${label}" resolved to an empty list on instance_id=${id} — FAIL_TO_PASS must never be empty (empty = corrupt input, would vacuously "resolve" with zero evidence)`,
    );
  }
  return list;
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
  const fail_to_pass = requireNonEmpty(
    parseJsonStringList(r, "FAIL_TO_PASS", family),
    "FAIL_TO_PASS",
    id,
  );
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
    // SWE-bench eval image naming convention: the pullable image lives on Docker Hub under
    // the `swebench/` namespace as `swebench/sweb.eval.x86_64.<instance_id>`, with every
    // `__` in the instance_id replaced by `_1776_` (SWE-bench's own tag-sanitization rule),
    // then lowercased. VERIFIED: `swebench/sweb.eval.x86_64.astropy_1776_astropy-12907`
    // exists on Docker Hub for instance_id `astropy__astropy-12907`.
    image: `swebench/sweb.eval.x86_64.${id.replaceAll("__", "_1776_").toLowerCase()}`,
    fail_to_pass,
    pass_to_pass,
    merge_date,
    fix_patch,
    test_patch,
  };
}

function readBaseCommit(r: Record<string, unknown>, family: Family): string {
  const base = r.base;
  // CONFIRMED in Task 3 against the installed `multi-swe-bench==1.1.2` package source
  // (`multi_swe_bench.harness.pull_request.Base(label, ref, sha)`): the base commit sha
  // does live at `base.sha`. Falls back to a bare `base_commit` string field for
  // robustness against other raw shapes, but the primary lookup path is confirmed correct.
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
  const fail_to_pass = requireNonEmpty(testNamesFromDict(r, "f2p_tests", family), "f2p_tests", id);
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

  // CONFIRMED (Task-3 review) against the installed `multi-swe-bench==1.1.2` package
  // source itself (`multi_swe_bench/harness/image.py`'s `Image.image_prefix()` /
  // `image_name()` / `image_full_name()`): the image name is
  // `<prefix>/<org>_m_<repo>` (prefix = "mswebench"), lowercased. This superseded the
  // earlier `mswebench.eval.x86_64.<id>` placeholder, which does not match the harness
  // at all.
  // ASSUMPTION (verify at live pass): the tag `pr-<number>` is `SWEImageDefault`'s
  // (and every sampled per-repo `Image` subclass under
  // `multi_swe_bench/harness/repos/typescript/**`'s) documented default `image_tag()`,
  // but was not exhaustively checked against the specific repo this corpus record
  // belongs to.
  const number = requireInt(r, "number", family);
  const imageName = `mswebench/${org}_m_${repo}`.toLowerCase();
  const image = `${imageName}:pr-${number}`;

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
    // Populated so scorer/adapters/multiswebench.py's MultiSweBenchAdapter can read these
    // directly instead of re-parsing them (fragilely) off `id` — see Instance's doc.
    org,
    repo_name: repo,
    pr_number: number,
  };
}

export function normalizeInstance(raw: unknown, family: Family): Instance {
  const r = assertRecord(raw, family);
  return family === "swe-bench" ? normalizeSweBench(r) : normalizeMultiSweBench(r);
}

/** Best-effort id extraction from a raw record, for logging a dropped/corrupt one. */
function rawRecordId(rec: unknown): string {
  if (rec && typeof rec === "object") {
    const o = rec as Record<string, unknown>;
    if (typeof o.instance_id === "string") return o.instance_id;
    if (typeof o.id === "string") return o.id;
  }
  return "<unknown>";
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
  // Normalize per-record, DROPPING (not aborting on) any record the fail-closed guards reject —
  // e.g. a corrupt upstream record with an empty FAIL_TO_PASS (a real case in Multi-SWE-bench:
  // mui__material-ui-39688). A single bad record must not kill loading the whole corpus. The
  // guard still holds (a dropped record never becomes a scoreable Instance); the drop is LOGGED,
  // never silent. If EVERY record fails, the cache is corrupt → throw rather than return [].
  const instances: Instance[] = [];
  const dropped: string[] = [];
  for (const rec of raw) {
    try {
      instances.push(normalizeInstance(rec, family));
    } catch (err) {
      dropped.push(`${rawRecordId(rec)} (${(err as Error).message})`);
    }
  }
  if (dropped.length > 0) {
    console.error(
      `[corpus] dropped ${dropped.length}/${raw.length} unnormalizable "${family}" record(s); ` +
        `first: ${dropped.slice(0, 3).join("; ")}`,
    );
  }
  if (instances.length === 0) {
    throw new Error(
      `corpus: every record in ${file} failed to normalize (${dropped.length} dropped) — the ` +
        `${family} cache is empty or corrupt; refusing to return an empty corpus`,
    );
  }
  return instances;
}
