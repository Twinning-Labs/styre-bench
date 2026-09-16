import { Octokit } from "octokit";
import type { SeedGithubResult } from "./seed-github";

type Repo = Pick<
  Awaited<ReturnType<Octokit["rest"]["repos"]["get"]>>["data"],
  "id" | "description" | "private" | "full_name" | "clone_url" | "html_url" | "default_branch"
>;

/** Keep throttling's request pacing, but never let its separate retry limiter repeat
 * a guarded mutation. request.retries only controls plugin-retry, not plugin-throttling.
 * Reconciliation and ownership checks, not hidden SDK POST/DELETE retries, own recovery. */
export function createSeedClient(auth: string, fetch?: typeof globalThis.fetch): Octokit {
  return new Octokit({
    auth,
    throttle: {
      onRateLimit: () => false,
      onSecondaryRateLimit: () => false,
    },
    ...(fetch ? { request: { fetch } } : {}),
  });
}

export interface OwnedRepo {
  org: string;
  name: string;
  id: number;
  marker: string;
}

/** Allowlisted diagnostics only: never serialize SDK errors (which contain auth headers). */
export interface SeedEvent {
  phase: string;
  org?: string;
  name?: string;
  id?: number;
  marker?: string;
  ident?: string;
  status?: number;
  requestId?: string;
}

export function githubFailure(error: unknown): Pick<SeedEvent, "status" | "requestId"> {
  if (!error || typeof error !== "object") return {};
  const e = error as { status?: unknown; response?: { headers?: Record<string, unknown> } };
  const requestId = e.response?.headers?.["x-github-request-id"];
  return {
    ...(typeof e.status === "number" ? { status: e.status } : {}),
    ...(typeof requestId === "string" ? { requestId } : {}),
  };
}

/** A fresh, opaque marker is written in the same POST as creation. A duplicate name alone
 * never authorizes adoption or deletion. No benchmark instance identity reaches GitHub. */
export async function createOwnedRepo(
  octokit: Octokit,
  org: string,
  name: string,
  record: (event: SeedEvent) => Promise<void> = async () => {},
): Promise<SeedGithubResult> {
  const emit = async (event: SeedEvent): Promise<void> => {
    try {
      await record(event);
    } catch {
      console.error("[seed] could not record GitHub seed event");
    }
  };
  const marker = `styre-bench seed ${crypto.randomUUID()}`;
  await emit({ phase: "create-intent", org, name, marker });
  let repo: Repo | undefined;
  try {
    repo = (
      await octokit.rest.repos.createInOrg({
        org,
        name,
        private: true,
        auto_init: false,
        description: marker,
        // Non-idempotent POST: retain the FIRST response, then reconcile explicitly.
        // Octokit otherwise retries a 500 and can replace it with a misleading 422.
        request: { retries: 0 },
      })
    ).data;
  } catch (error) {
    await emit({ phase: "create-error", org, name, ...githubFailure(error) });
    try {
      const existing = (await octokit.rest.repos.get({ owner: org, repo: name })).data;
      if (
        existing.description === marker &&
        existing.private &&
        existing.full_name.toLowerCase() === `${org}/${name}`.toLowerCase()
      ) {
        repo = existing;
        await emit({ phase: "create-reconciled", org, name, id: repo.id });
      } else {
        await emit({ phase: "ownership-mismatch", org, name });
      }
    } catch (lookupError) {
      await emit({ phase: "reconcile-error", org, name, ...githubFailure(lookupError) });
    }
    if (!repo) throw error;
  }
  const ownedRepo = { org, name, id: repo.id, marker };
  await emit({ phase: "created", ...ownedRepo });
  try {
    // Fail closed before publishing upstream workflows. A failed disable must not leave
    // an active repo that can execute copied upstream deployment workflows.
    await octokit.rest.actions.setGithubActionsPermissionsRepository({
      owner: org,
      repo: name,
      enabled: false,
    });
    const repoUrl = repo.clone_url ?? repo.html_url;
    if (!repoUrl) throw new Error(`seedGithub: no URL returned for ${org}/${name}`);
    return { repoUrl, defaultBranch: repo.default_branch ?? "main", ownedRepo };
  } catch (error) {
    try {
      await deleteOwnedRepo(octokit, ownedRepo);
      await emit({ phase: "rolled-back", org, name, id: repo.id });
    } catch (rollbackError) {
      await emit({
        phase: "rollback-failed",
        org,
        name,
        id: repo.id,
        ...githubFailure(rollbackError),
      });
    }
    throw error;
  }
}

export async function deleteOwnedRepo(octokit: Octokit, owned: OwnedRepo): Promise<void> {
  let repo: Repo;
  try {
    repo = (await octokit.rest.repos.get({ owner: owned.org, repo: owned.name })).data;
  } catch (error) {
    if (githubFailure(error).status === 404) return;
    throw error;
  }
  if (
    repo.id !== owned.id ||
    repo.description !== owned.marker ||
    !repo.private ||
    repo.full_name.toLowerCase() !== `${owned.org}/${owned.name}`.toLowerCase()
  ) {
    throw new Error(
      `seedGithub: refusing rollback; ownership changed for ${owned.org}/${owned.name}`,
    );
  }
  await octokit.rest.repos.delete({ owner: owned.org, repo: owned.name, request: { retries: 0 } });
}
