import type { Subprocess } from "bun";

export const OWNER_LABEL = "dev.styre.bench.owner";
const active = new Set<() => Promise<void>>();
let cancelling = false;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function docker(args: string[]): Promise<string> {
  const p = Bun.spawn(["docker", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 5000,
    killSignal: "SIGKILL",
  });
  const [out, , code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  // Never include argv or daemon output here: callers may hold credentials.
  if (code !== 0) throw new Error(`Docker lifecycle ${args[0]} failed (exit ${code})`);
  return out.trim();
}

export async function removeOwnedContainer(owner: string): Promise<void> {
  if (!/^[a-f0-9]{32}$/.test(owner)) throw new Error("Invalid container ownership token");
  const list = () => docker(["ps", "-aq", "--filter", `label=${OWNER_LABEL}=${owner}`]);
  const ids = (await list()).split("\n").filter(Boolean);
  if (ids.some((id) => !/^[a-f0-9]{12,64}$/.test(id)))
    throw new Error("Invalid container inventory");
  if (ids.length) {
    // --rm may win the race after listing. Only the final inventory decides whether
    // cleanup succeeded; a daemon/inventory failure still fails loudly.
    await docker(["rm", "--force", ...ids]).catch(() => {});
  }
  if (await list()) throw new Error("Owned container survived cleanup");
}

async function cancel(code: number): Promise<void> {
  if (cancelling) return;
  cancelling = true;
  const results = await Promise.allSettled([...active].map((stop) => stop()));
  const failed = results.some((r) => r.status === "rejected");
  if (failed) console.error("FATAL: candidate container cleanup could not be confirmed");
  // Cancellation terminates the pilot, never returning an infra result that can be retried.
  process.exit(failed ? 70 : code);
}
const onInt = () => {
  void cancel(130);
};
const onTerm = () => {
  void cancel(143);
};

/** Own the Docker client and its labeled container until both have settled.
 * Services must signal the supervisor only (KillMode=mixed), allowing this cleanup to run.
 * SIGKILL/daemon failure cannot be made graceful; a failed cleanup is explicitly nonzero.
 */
export async function spawnManagedDocker(args: string[], owner: string): Promise<number> {
  if (cancelling) throw new Error("Pilot cancellation already in progress");
  const labels = args.filter(
    (arg, i) => args[i - 1] === "--label" && arg.startsWith(`${OWNER_LABEL}=`),
  );
  if (
    !/^[a-f0-9]{32}$/.test(owner) ||
    args[0] !== "run" ||
    labels.length !== 1 ||
    labels[0] !== `${OWNER_LABEL}=${owner}`
  ) {
    throw new Error("Docker command does not bind the claimed owner");
  }
  let proc: Subprocess | undefined;
  let settled = false;
  let stopping: Promise<void> | undefined;
  const stop = () => {
    stopping ??= (async () => {
      // Keep the client alive while Docker finishes creating the owned container. Killing
      // it first races server-side creation and can leave an unobserved orphan.
      const deadline = Date.now() + 5000;
      while (!settled && Date.now() < deadline) {
        const ids = await docker(["ps", "-aq", "--filter", `label=${OWNER_LABEL}=${owner}`]);
        if (ids) break;
        await pause(50);
      }
      try {
        await removeOwnedContainer(owner);
        if (proc && !settled) {
          await Promise.race([proc.exited, pause(1000)]);
          if (!settled) {
            proc.kill("SIGKILL");
            await proc.exited;
            await removeOwnedContainer(owner);
            throw new Error(
              "Docker client did not settle after container cleanup; creation may be incomplete",
            );
          }
        }
      } catch (error) {
        if (proc && !settled) proc.kill("SIGKILL");
        throw error;
      }
    })();
    return stopping;
  };
  if (active.size === 0) {
    process.on("SIGINT", onInt);
    process.on("SIGTERM", onTerm);
  }
  active.add(stop);
  try {
    proc = Bun.spawn(["docker", ...args], { stdout: "inherit", stderr: "inherit" });
    const code = await proc.exited.finally(() => {
      settled = true;
    });
    if (cancelling) {
      await stop();
      // Global cancellation drains every active candidate before exiting.
      await new Promise<never>(() => {});
    }
    try {
      await removeOwnedContainer(owner);
    } catch {
      console.error(
        "FATAL: cleanup after Docker client exit failed; refusing infrastructure retry",
      );
      await cancel(70);
    }
    if (cancelling) await new Promise<never>(() => {});
    return code;
  } finally {
    active.delete(stop);
    if (active.size === 0 && !cancelling) {
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
    }
  }
}
