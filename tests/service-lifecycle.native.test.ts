import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { containerNameFor } from "../orchestrator/container-reaper";
import { SERVICE_LIFECYCLE, supervisedCommand } from "../orchestrator/service-launcher";
const native = process.env.RUN_SERVICE_LIFECYCLE === "1" ? test : test.skip;
const image = process.env.LIFECYCLE_IMAGE ?? "styre-lifecycle-fixture";
async function command(argv: string[]) {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  if ((await proc.exited) !== 0) throw new Error(`${argv[0]} failed: ${err}`);
  return out.trim();
}
for (const early of [false, true]) {
  native(
    `real systemd user service cancellation (${early ? "during launch" : "after readiness"})`,
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "styre-service-fixture-"));
      const unit = `${path.basename(dir)}.service`;
      const childRoot = path.join(dir, path.basename(dir));
      const name = containerNameFor(`${path.basename(dir)}-0`);
      const script = path.join(dir, "launch.sh");
      const fixture = path.resolve(import.meta.dir, "fixtures/container-lifecycle-child.ts");
      await writeFile(
        script,
        `#!/bin/bash\nset -euo pipefail\n${supervisedCommand([process.execPath, fixture, childRoot, image, "hold"], dir)}`,
      );
      try {
        await command([
          "systemd-run",
          "--user",
          `--unit=${unit}`,
          "--property=Type=exec",
          ...Object.entries(SERVICE_LIFECYCLE).map(([k, v]) => `--property=${k}=${v}`),
          "--property=Environment=PATH=/home/rajatgoyal/.bun/bin:/usr/local/bin:/usr/bin:/bin",
          "/bin/bash",
          script,
        ]);
        expect(
          await command(["systemctl", "--user", "show", unit, "--property=KillMode", "--value"]),
        ).toBe("mixed");
        const marker = path.join(
          childRoot,
          `${path.basename(dir)}-0`,
          early ? "entrypoint.sh" : "ready",
        );
        for (let n = 0; n < 300 && !(await Bun.file(marker).exists()); n++) await Bun.sleep(20);
        expect(await Bun.file(marker).exists()).toBe(true);
        await command(["systemctl", "--user", "stop", unit]);
        expect((await readFile(path.join(dir, "exit-code.txt"), "utf8")).trim()).toBe("143");
        expect((await readFile(path.join(dir, "interrupted.txt"), "utf8")).trim()).toBe("TERM");
        expect(await command(["docker", "ps", "-aq", "--filter", `name=^/${name}$`])).toBe("");
      } finally {
        await command(["systemctl", "--user", "stop", unit]).catch(() => {});
        await command(["systemctl", "--user", "reset-failed", unit]).catch(() => {});
        await command(["docker", "rm", "-f", name]).catch(() => {});
        await rm(dir, { recursive: true, force: true });
      }
    },
    60000,
  );
}
