import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { RunSeed } from "./run-task";
import { defaultDeps as githubDeps, seedGithub } from "./seed-github";
import { seedLinear } from "./seed-linear";
import type { SeedEvent } from "./seed-repo";
import type { Instance } from "./types";

export interface SeedStageConfig {
  benchGithubOrg: string;
  linearProjectId: string;
  evidenceRoot: string;
}

const defaultDeps = {
  seedGithub,
  seedLinear,
  deleteRepo: githubDeps.deleteRepo,
};

/** Persist intent before creation and partial results before the next external stage.
 * This host-only journal survives failures before run-task allocates its evidence directory.
 * It contains no issue text, patches, tokens, or SDK error objects. */
export async function seedStage(
  inst: Instance,
  cfg: SeedStageConfig,
  overrides: Partial<typeof defaultDeps> = {},
): Promise<RunSeed> {
  const deps = { ...defaultDeps, ...overrides };
  const attempt = crypto.randomUUID();
  const target = path.resolve(cfg.evidenceRoot, "seed-events.ndjson");
  const emit = async (event: SeedEvent): Promise<void> => {
    try {
      await mkdir(path.dirname(target), { recursive: true });
      await appendFile(
        target,
        `${JSON.stringify({ at: new Date().toISOString(), attempt, instance: inst.id, ...event })}\n`,
      );
    } catch {
      console.error(`[seed] could not write seed journal ${target}`);
    }
  };
  const gh = await deps.seedGithub(inst, cfg, { emit });
  await emit({ phase: "github-seeded", ...gh.ownedRepo });
  try {
    const li = await deps.seedLinear(inst, cfg);
    await emit({ phase: "linear-seeded", ident: li.ident });
    return { ...gh, ident: li.ident };
  } catch (error) {
    await emit({ phase: "linear-failed" });
    // No complete RunSeed exists, so the normal pipeline cleanup cannot reach this repo.
    // Retain-on-failure applies to started runs, not these incomplete seeds.
    if (gh.ownedRepo) {
      try {
        await deps.deleteRepo(gh.ownedRepo.org, gh.ownedRepo.name, gh.ownedRepo);
        await emit({ phase: "rolled-back", ...gh.ownedRepo });
      } catch {
        await emit({ phase: "rollback-failed", ...gh.ownedRepo });
      }
    } else {
      await emit({ phase: "rollback-unowned" });
    }
    throw error;
  }
}
