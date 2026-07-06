import type { Difficulty, Instance } from "./types";

const LANGUAGES: Instance["language"][] = ["ts", "python"];
const DIFFICULTIES: Difficulty[] = ["easy", "medium", "hard"];
const DIFFICULTY_RANK: Record<Difficulty, number> = { easy: 0, medium: 1, hard: 2 };

/** Seeded PRNG (mulberry32) — deterministic given the same seed, no external deps. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Selects exactly one instance per (language x difficulty) cell for the pilot matrix:
 * {ts, python} x {easy, medium, hard} = 6 instances. Deterministic for a given seed
 * (fixed cell-iteration order + candidates sorted by id before drawing, so PRNG draws
 * don't depend on pool/array ordering). Throws, naming the empty cell, if any of the 6
 * required cells has zero candidates.
 */
export function selectPilot(pool: Instance[], seed: number): Instance[] {
  const rng = mulberry32(seed);

  const byCell = new Map<string, Instance[]>();
  for (const inst of pool) {
    const key = `${inst.language}:${inst.difficulty}`;
    const existing = byCell.get(key);
    if (existing) {
      existing.push(inst);
    } else {
      byCell.set(key, [inst]);
    }
  }

  const picked: Instance[] = [];
  for (const language of LANGUAGES) {
    for (const difficulty of DIFFICULTIES) {
      const key = `${language}:${difficulty}`;
      const candidates = byCell.get(key);
      if (!candidates || candidates.length === 0) {
        throw new Error(
          `matrix: no candidates for cell "${key}" — the pilot requires exactly one instance per language x difficulty cell (ts|python x easy|medium|hard)`,
        );
      }
      // Byte-wise compare, not localeCompare: localeCompare's default-locale dependence is
      // a cross-machine reproducibility risk for this reproducibility-critical sort. IDs are
      // ASCII so behavior is unchanged in practice; this just removes the ambiguity.
      const sorted = [...candidates].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const idx = Math.min(Math.floor(rng() * sorted.length), sorted.length - 1);
      const chosen = sorted[idx];
      if (!chosen) {
        throw new Error(`matrix: internal error selecting from cell "${key}"`);
      }
      picked.push(chosen);
    }
  }
  return picked;
}

/**
 * SMOKE-mode selection: exactly one instance per language (one ts + one python), preferring
 * the EASIEST available difficulty, for a first plumbing run that validates the live gate
 * (Docker / claude install / oracle harness) without spending the full 6-cell pilot. Fully
 * deterministic (sorts by difficulty then id; the `_seed` param exists only to mirror
 * `selectPilot`'s signature so both slot into the same runner dep). Throws, naming the
 * language, if either ts or python has zero candidates.
 */
export function selectSmoke(pool: Instance[], _seed: number): Instance[] {
  const picked: Instance[] = [];
  for (const language of LANGUAGES) {
    const candidates = pool.filter((i) => i.language === language);
    if (candidates.length === 0) {
      throw new Error(
        `matrix (smoke): no candidates for language "${language}" — SMOKE mode requires at least one ts and one python instance in the loaded corpus`,
      );
    }
    const sorted = [...candidates].sort((a, b) => {
      const byDifficulty = DIFFICULTY_RANK[a.difficulty] - DIFFICULTY_RANK[b.difficulty];
      return byDifficulty !== 0 ? byDifficulty : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    const chosen = sorted[0];
    if (!chosen) {
      throw new Error(`matrix (smoke): internal error selecting language "${language}"`);
    }
    picked.push(chosen);
  }
  return picked;
}

/**
 * True iff the instance's merge_date is strictly after the model cutoff — used to tag
 * `post_cutoff` on a TaskRecord. Null-safe: an instance with no known merge_date is
 * treated as NOT post-cutoff (false), never throws.
 */
export function tagCutoff(i: { merge_date?: string | undefined }, cutoffISO: string): boolean {
  if (!i.merge_date) return false;
  const mergeTime = new Date(i.merge_date).getTime();
  const cutoffTime = new Date(cutoffISO).getTime();
  if (Number.isNaN(mergeTime) || Number.isNaN(cutoffTime)) return false;
  return mergeTime > cutoffTime;
}
