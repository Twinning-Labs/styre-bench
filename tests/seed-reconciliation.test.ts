import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Octokit } from "octokit";
import { seedGithub } from "../orchestrator/seed-github";
import { createOwnedRepo, deleteOwnedRepo } from "../orchestrator/seed-repo";
import type { SeedEvent } from "../orchestrator/seed-repo";
import { seedStage } from "../orchestrator/seed-stage";
import type { Instance } from "../orchestrator/types";

function client(handler: (method: string, url: string, body: Record<string, unknown>) => Response) {
  const fetch = (async (url: string | URL | Request, init?: RequestInit) =>
    handler(
      init?.method ?? "GET",
      String(url),
      init?.body ? JSON.parse(String(init.body)) : {},
    )) as typeof globalThis.fetch;
  return new Octokit({
    auth: "fake-test-token",
    throttle: { enabled: false },
    retry: { retryAfterBaseValue: 1 },
    request: { fetch },
  });
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "x-github-request-id": "request-123" },
  });
}
const repo = (marker: string) => ({
  id: 123,
  full_name: "scratch/bench-abc",
  private: true,
  description: marker,
  clone_url: "https://github.com/scratch/bench-abc.git",
  default_branch: "main",
});

describe("GitHub creation reconciliation through real Octokit, fake HTTP", () => {
  test("control: unmodified SDK repeats the same POST after 500 and surfaces the later 422", async () => {
    const bodies: Record<string, unknown>[] = [];
    const octokit = client((_method, _url, body) => {
      bodies.push(body);
      return bodies.length === 1
        ? json({ message: "server error" }, 500)
        : json({ message: "name already exists" }, 422);
    });
    await expect(
      octokit.rest.repos.createInOrg({ org: "scratch", name: "bench-abc" }),
    ).rejects.toThrow("name already exists");
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toEqual(bodies[1]);
  });
  test("a 500 after server-side creation performs one POST, reconciles ownership, then disables Actions", async () => {
    let marker = "";
    const calls: string[] = [];
    const events: SeedEvent[] = [];
    const octokit = client((method, url, body) => {
      calls.push(`${method} ${url}`);
      if (method === "POST") {
        marker = String(body.description);
        return json({ message: "server error" }, 500);
      }
      if (method === "GET") return json(repo(marker));
      return json({});
    });
    const result = await createOwnedRepo(octokit, "scratch", "bench-abc", async (e) => {
      events.push(e);
    });
    expect(calls.filter((c) => c.startsWith("POST"))).toHaveLength(1);
    expect(calls.map((c) => c.split(" ")[0])).toEqual(["POST", "GET", "PUT"]);
    expect(result.ownedRepo?.id).toBe(123);
    expect(events.find((e) => e.phase === "create-error")).toMatchObject({
      status: 500,
      requestId: "request-123",
    });
    expect(events.some((e) => e.phase === "create-reconciled")).toBe(true);
    expect(JSON.stringify(events)).not.toContain("fake-test-token");
  });

  test.each(["wrong-marker", "public", "wrong-owner", "missing"])(
    "does not adopt or delete an ambiguous %s repository",
    async (mismatch) => {
      let marker = "";
      const calls: string[] = [];
      const octokit = client((method, _url, body) => {
        calls.push(method);
        if (method === "POST") {
          marker = String(body.description);
          return json({ message: "name already exists" }, 422);
        }
        const existing = repo(marker);
        if (mismatch === "wrong-marker") existing.description = "another attempt";
        if (mismatch === "public") existing.private = false;
        if (mismatch === "wrong-owner") existing.full_name = "other/bench-abc";
        return mismatch === "missing" ? json({ message: "not found" }, 404) : json(existing);
      });
      await expect(createOwnedRepo(octokit, "scratch", "bench-abc")).rejects.toThrow(
        "name already exists",
      );
      expect(calls).toEqual(["POST", "GET"]);
    },
  );

  test("a successful POST continues without a reconciliation GET", async () => {
    const calls: string[] = [];
    const octokit = client((method, _url, body) => {
      calls.push(method);
      return json(method === "POST" ? repo(String(body.description)) : {});
    });
    await createOwnedRepo(octokit, "scratch", "bench-abc");
    expect(calls).toEqual(["POST", "PUT"]);
  });

  test("Actions-disable failure rolls back owned repo before any seed can be pushed", async () => {
    let marker = "";
    const calls: string[] = [];
    const octokit = client((method, _url, body) => {
      calls.push(method);
      if (method === "POST") {
        marker = String(body.description);
        return json(repo(marker));
      }
      if (method === "PUT") return json({ message: "forbidden" }, 403);
      return json(method === "GET" ? repo(marker) : {});
    });
    await expect(createOwnedRepo(octokit, "scratch", "bench-abc")).rejects.toThrow("forbidden");
    expect(calls).toEqual(["POST", "PUT", "GET", "DELETE"]);
  });

  test("rollback refuses a replacement repository even when the marker was copied", async () => {
    const calls: string[] = [];
    const octokit = client((method) => {
      calls.push(method);
      return json({ ...repo("marker"), id: 999 });
    });
    await expect(
      deleteOwnedRepo(octokit, { org: "scratch", name: "bench-abc", id: 123, marker: "marker" }),
    ).rejects.toThrow("ownership changed");
    expect(calls).toEqual(["GET"]);
  });

  test("a missing repository is already rolled back", async () => {
    const octokit = client(() => json({ message: "not found" }, 404));
    await deleteOwnedRepo(octokit, {
      org: "scratch",
      name: "bench-abc",
      id: 123,
      marker: "marker",
    });
  });
});

const inst = { id: "org__repo-123" } as Instance;
describe("partial seed rollback", () => {
  test("a completed seed records the ticket mapping and never rolls back", async () => {
    const evidenceRoot = await mkdtemp(path.join(tmpdir(), "seed-complete-"));
    let deleted = false;
    try {
      const result = await seedStage(
        inst,
        { evidenceRoot, benchGithubOrg: "scratch", linearProjectId: "project" },
        {
          seedGithub: async () => ({
            repoUrl: "https://github.com/scratch/bench-abc.git",
            defaultBranch: "main",
          }),
          seedLinear: async () => ({ ident: "BENCH-1" }),
          deleteRepo: async () => {
            deleted = true;
          },
        },
      );
      expect(result.ident).toBe("BENCH-1");
      expect(deleted).toBe(false);
      expect(await readFile(path.join(evidenceRoot, "seed-events.ndjson"), "utf8")).toContain(
        '"ident":"BENCH-1"',
      );
    } finally {
      await rm(evidenceRoot, { recursive: true, force: true });
    }
  });

  test("a dependency returning no ownership proof never authorizes rollback", async () => {
    const evidenceRoot = await mkdtemp(path.join(tmpdir(), "seed-unowned-"));
    let deleted = false;
    try {
      await expect(
        seedStage(
          inst,
          { evidenceRoot, benchGithubOrg: "scratch", linearProjectId: "project" },
          {
            seedGithub: async () => ({
              repoUrl: "https://github.com/scratch/bench-abc.git",
              defaultBranch: "main",
            }),
            seedLinear: async () => {
              throw new Error("Linear failed");
            },
            deleteRepo: async () => {
              deleted = true;
            },
          },
        ),
      ).rejects.toThrow("Linear failed");
      expect(deleted).toBe(false);
      expect(await readFile(path.join(evidenceRoot, "seed-events.ndjson"), "utf8")).toContain(
        '"phase":"rollback-unowned"',
      );
    } finally {
      await rm(evidenceRoot, { recursive: true, force: true });
    }
  });
  test.each([false, true])(
    "Linear failure rolls back owned GitHub repo and preserves original error (rollback fails: %s)",
    async (rollbackFails) => {
      const evidenceRoot = await mkdtemp(path.join(tmpdir(), "seed-journal-"));
      const ownedRepo = { org: "scratch", name: "bench-abc", id: 123, marker: "marker" };
      const original = new Error("Linear rejected issue");
      const deletions: unknown[] = [];
      try {
        await expect(
          seedStage(
            inst,
            { evidenceRoot, benchGithubOrg: "scratch", linearProjectId: "project" },
            {
              seedGithub: async (_inst, _cfg, opts) => {
                await opts?.emit?.({ phase: "create-intent", ...ownedRepo });
                return {
                  repoUrl: "https://github.com/scratch/bench-abc.git",
                  defaultBranch: "main",
                  ownedRepo,
                };
              },
              seedLinear: async () => {
                throw original;
              },
              deleteRepo: async (...args) => {
                deletions.push(args);
                if (rollbackFails) throw new Error("cleanup rejected");
              },
            },
          ),
        ).rejects.toBe(original);
        expect(deletions).toEqual([["scratch", "bench-abc", ownedRepo]]);
        const events = (await readFile(path.join(evidenceRoot, "seed-events.ndjson"), "utf8"))
          .trim()
          .split("\n")
          .map((s) => JSON.parse(s));
        expect(events.map((e) => e.phase)).toEqual([
          "create-intent",
          "github-seeded",
          "linear-failed",
          rollbackFails ? "rollback-failed" : "rolled-back",
        ]);
        expect(new Set(events.map((e) => e.attempt)).size).toBe(1);
        expect(events.every((e) => e.instance === inst.id)).toBe(true);
      } finally {
        await rm(evidenceRoot, { recursive: true, force: true });
      }
    },
  );

  test("push failure remains the original error when rollback also fails", async () => {
    const repoDir = await mkdtemp(path.join(tmpdir(), "seed-push-failure-"));
    const original = new Error("push rejected");
    await expect(
      seedGithub(
        { ...inst, repo: "org/repo", base_commit: "base", fix_patch: "", test_patch: "" },
        { benchGithubOrg: "scratch" },
        {
          deps: {
            fetchSnapshot: async () => ({ repoDir, files: [] }),
            createRepo: async () => ({ repoUrl: "url", defaultBranch: "main" }),
            pushBaseRef: async () => {
              throw original;
            },
            deleteRepo: async () => {
              throw new Error("delete failed");
            },
          },
        },
      ),
    ).rejects.toBe(original);
  });
});
