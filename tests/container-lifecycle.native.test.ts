import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { containerNameFor } from "../orchestrator/container-reaper";
import { supervisedCommand } from "../orchestrator/service-launcher";
const native = process.env.RUN_CONTAINER_LIFECYCLE === "1" ? test : test.skip;
const image = process.env.LIFECYCLE_IMAGE ?? "styre-lifecycle-fixture";
const driver = path.resolve(import.meta.dir, "fixtures/container-lifecycle-child.ts");
async function docker(args: string[]) {
  const p = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  const code = await p.exited;
  if (code !== 0) throw new Error(`fixture Docker ${args[0]} failed`);
  return out.trim();
}
async function ready(dir: string, count: number) {
  for (let n = 0; n < 300; n++) {
    if (
      (
        await Promise.all(
          Array.from({ length: count }, (_, i) =>
            Bun.file(path.join(dir, `${path.basename(dir)}-${i}`, "ready")).exists(),
          ),
        )
      ).every(Boolean)
    )
      return;
    await Bun.sleep(50);
  }
  throw new Error("Native payload did not start within15seconds");
}
for (const mode of ["zero", "failure", "hold", "hold-int", "client-death", "concurrent"] as const) {
  native(
    `exact production launch: ${mode}, init and supervisor cancellation`,
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "bench-native-"));
      // Unique evidence basename matters: production names derive from it.
      const script = path.join(dir, "launch.sh");
      const count = mode === "concurrent" ? 2 : 1;
      const childRoot = path.join(dir, path.basename(dir));
      await writeFile(
        script,
        `#!/bin/bash\nset -euo pipefail\n${supervisedCommand([process.execPath, driver, childRoot, image, ["hold-int", "client-death"].includes(mode) ? "hold" : mode], dir)}`,
      );
      const proc = Bun.spawn(["bash", script], { stdout: "pipe", stderr: "pipe" });
      try {
        if (["hold", "hold-int", "client-death", "concurrent"].includes(mode)) {
          await ready(childRoot, count);
          for (let i = 0; i < count; i++) {
            const name = containerNameFor(`${path.basename(dir)}-${i}`);
            expect(await docker(["inspect", "--format", "{{.HostConfig.Init}}", name])).toBe(
              "true",
            );
          }
          if (mode === "client-death") {
            const ps = Bun.spawnSync(["ps", "-eo", "pid,ppid,comm"], {
              stdout: "pipe",
            }).stdout.toString();
            const rows = ps.split("\n").map((l) => l.trim().split(/\s+/));
            const pilot = rows.find((r) => Number(r[1]) === proc.pid && r[2]?.endsWith("bun"));
            expect(pilot).toBeDefined();
            const cli = rows.find(
              (r) => Number(r[1]) === Number(pilot?.[0]) && r[2]?.endsWith("docker"),
            );
            expect(cli).toBeDefined();
            process.kill(Number(cli?.[0]), "SIGKILL");
          } else proc.kill(mode === "hold-int" ? "SIGINT" : "SIGTERM");
        }
        const code = await proc.exited;
        const expected =
          mode === "zero"
            ? 0
            : mode === "failure"
              ? 7
              : mode === "hold-int"
                ? 130
                : mode === "client-death"
                  ? 137
                  : 143;
        expect(code).toBe(expected);
        expect(Number((await readFile(path.join(dir, "exit-code.txt"), "utf8")).trim())).toBe(
          expected,
        );
        for (let i = 0; i < count; i++)
          expect(
            await docker([
              "ps",
              "-aq",
              "--filter",
              `name=^/${containerNameFor(`${path.basename(dir)}-${i}`)}$`,
            ]),
          ).toBe("");
      } finally {
        proc.kill("SIGKILL");
        for (let i = 0; i < count; i++)
          await docker(["rm", "-f", containerNameFor(`${path.basename(dir)}-${i}`)]).catch(
            () => {},
          );
        await rm(dir, { recursive: true, force: true });
      }
    },
    60000,
  );
}
