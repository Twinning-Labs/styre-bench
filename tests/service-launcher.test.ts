import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SERVICE_LIFECYCLE, supervisedCommand } from "../orchestrator/service-launcher";

for (const code of [0, 7]) {
  test(`supervisor preserves normal exit ${code}`, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "bench-supervisor-"));
    try {
      const script = path.join(dir, "launch.sh");
      await writeFile(
        script,
        `#!/bin/bash\nset -euo pipefail\n${supervisedCommand(["bash", "-c", `exit ${code}`], dir)}`,
      );
      const proc = Bun.spawn(["bash", script], { stdout: "pipe", stderr: "pipe" });
      expect(await proc.exited).toBe(code);
      expect((await readFile(path.join(dir, "exit-code.txt"), "utf8")).trim()).toBe(String(code));
      expect(await readFile(path.join(dir, "finished-at.txt"), "utf8")).toMatch(/Z\n$/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test("supervisor TERM forwards cancellation and records nonzero independently of child status", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bench-supervisor-"));
  try {
    const child = path.join(dir, "child.ts");
    await writeFile(
      child,
      `import {writeFileSync} from 'node:fs'; process.on('SIGTERM',()=>{writeFileSync(${JSON.stringify(path.join(dir, "cleaned"))},'yes');process.exit(0)});writeFileSync(${JSON.stringify(path.join(dir, "ready"))},'yes');setInterval(()=>{},1000);`,
    );
    const script = path.join(dir, "launch.sh");
    await writeFile(
      script,
      `#!/bin/bash\nset -euo pipefail\n${supervisedCommand([process.execPath, child], dir)}`,
    );
    const proc = Bun.spawn(["bash", script], { stdout: "pipe", stderr: "pipe" });
    for (let n = 0; n < 100 && !(await Bun.file(path.join(dir, "ready")).exists()); n++)
      await Bun.sleep(10);
    expect(await Bun.file(path.join(dir, "ready")).exists()).toBe(true);
    proc.kill("SIGTERM");
    expect(await proc.exited).toBe(143);
    expect((await readFile(path.join(dir, "exit-code.txt"), "utf8")).trim()).toBe("143");
    expect((await readFile(path.join(dir, "interrupted.txt"), "utf8")).trim()).toBe("TERM");
    expect(await readFile(path.join(dir, "cleaned"), "utf8")).toBe("yes");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("service shutdown grants pilot its bounded cleanup interval", () => {
  expect(SERVICE_LIFECYCLE.KillMode).toBe("mixed");
  expect(SERVICE_LIFECYCLE.TimeoutStopSec).toBe("45s");
  expect(() => supervisedCommand([], "/tmp")).toThrow();
  expect(() => supervisedCommand(["echo"], "relative")).toThrow();
});

test("TERM in the background-child registration gap is deferred then forwarded", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bench-supervisor-gap-"));
  try {
    const child = path.join(dir, "child.ts");
    await writeFile(
      child,
      `import {writeFileSync} from 'node:fs'; process.on('SIGTERM',()=>{writeFileSync(${JSON.stringify(path.join(dir, "cleaned"))},'yes');process.exit(0)});writeFileSync(${JSON.stringify(path.join(dir, "ready"))},'yes');setInterval(()=>{},1000);`,
    );
    const script = path.join(dir, "launch.sh");
    const body = supervisedCommand([process.execPath, child], dir).replace(
      "run_child=$!",
      () => `while [ ! -f '${dir}/ready' ]; do sleep 0.01; done\nkill -TERM $$\nrun_child=$!`,
    );
    await writeFile(script, `#!/bin/bash\nset -euo pipefail\n${body}`);
    const proc = Bun.spawn(["bash", script], { stdout: "pipe", stderr: "pipe" });
    const err = await new Response(proc.stderr).text();
    expect(err).toBe("");
    expect(await proc.exited).toBe(143);
    expect((await readFile(path.join(dir, "exit-code.txt"), "utf8")).trim()).toBe("143");
    expect(await readFile(path.join(dir, "cleaned"), "utf8")).toBe("yes");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
