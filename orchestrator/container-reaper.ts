/**
 * Stop bench containers outliving the pilot that started them (ENG follow-up to the 2026-09-10
 * darkreader runs).
 *
 * WHY THIS EXISTS. `buildDockerArgs` passes `--rm`, which removes the container when it EXITS.
 * Killing the pilot does not make it exit: the `docker run` client dies, the daemon keeps the
 * container, and `--rm` never fires. One was found still running four hours after its pilot was
 * killed, holding a worktree, an agent process and ~200MB. Across a full matrix that accumulates.
 *
 * Two mechanisms, because one is not enough:
 *
 *   - a graceful stop on SIGINT/SIGTERM, which covers Ctrl-C and an ordinary `kill`;
 *   - a REAPER at pilot start, which is the only thing that helps after SIGKILL, since no handler
 *     can run then. That is precisely how the four-hour container survived.
 *
 * Containers are identified by a `styre-bench-` name prefix rather than by image, so a bench
 * container is never confused with an operator's own container built from the same corpus image.
 */

export const CONTAINER_NAME_PREFIX = "styre-bench-";

/** Docker names allow `[a-zA-Z0-9][a-zA-Z0-9_.-]*`; evidence dir basenames can carry anything. */
export function containerNameFor(runId: string): string {
  const safe = runId.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+/, "");
  return `${CONTAINER_NAME_PREFIX}${safe || "run"}`;
}

/** PURE. Bench container names in `docker ps` output, one name per line. */
export function benchContainerNames(psOutput: string): string[] {
  return psOutput
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith(CONTAINER_NAME_PREFIX));
}

export interface ReaperDeps {
  /** `docker ps --format {{.Names}}` (running only). */
  listRunning: () => Promise<string>;
  kill: (name: string) => Promise<void>;
}

const defaultDeps: ReaperDeps = {
  async listRunning() {
    const proc = Bun.spawn(["docker", "ps", "--format", "{{.Names}}"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return out;
  },
  async kill(name) {
    const proc = Bun.spawn(["docker", "kill", name], { stdout: "ignore", stderr: "ignore" });
    await proc.exited;
  },
};

/**
 * Kill every running bench container, returning the names killed.
 *
 * Best-effort by design: a docker daemon that is down or a container that exited between the list
 * and the kill must not fail the pilot — reaping is hygiene, not a precondition. Never throws.
 */
export async function reapBenchContainers(deps: Partial<ReaperDeps> = {}): Promise<string[]> {
  const d: ReaperDeps = { ...defaultDeps, ...deps };
  let names: string[];
  try {
    names = benchContainerNames(await d.listRunning());
  } catch {
    return [];
  }
  const killed: string[] = [];
  for (const name of names) {
    try {
      await d.kill(name);
      killed.push(name);
    } catch {
      /* already gone, or the daemon went away — hygiene, not a precondition */
    }
  }
  return killed;
}
