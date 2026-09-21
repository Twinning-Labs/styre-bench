import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { removeOwnedContainer, spawnManagedDocker } from "../orchestrator/docker-lifecycle";

test("invalid ownership token is rejected before Docker access", async () => {
  await expect(removeOwnedContainer("other-container")).rejects.toThrow(
    "Invalid container ownership",
  );
});

test("cleanup failure terminates the pilot nonzero rather than returning success/retry", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bench-cleanup-"));
  try {
    await writeFile(
      path.join(dir, "docker"),
      '#!/bin/sh\nif [ "$1" = run ]; then exit 0; fi\nexit 42\n',
      { mode: 0o700 },
    );
    const driver = path.join(dir, "driver.ts");
    await writeFile(
      driver,
      `import {spawnManagedDocker} from ${JSON.stringify(path.resolve(import.meta.dir, "../orchestrator/docker-lifecycle.ts"))}; await spawnManagedDocker(['run','--label','dev.styre.bench.owner=${"a".repeat(32)}'],'${"a".repeat(32)}'); throw Error('must not return');`,
    );
    const proc = Bun.spawn([process.execPath, driver], {
      env: { PATH: `${dir}:/usr/bin:/bin` },
      stdout: "pipe",
      stderr: "pipe",
    });
    const err = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(70);
    expect(err).toContain("cleanup could not be confirmed");
    expect(err).not.toContain("must not return");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("owner binding is checked before a client can spawn", async () => {
  await expect(spawnManagedDocker(["run"], "a".repeat(32))).rejects.toThrow("does not bind");
  await expect(
    spawnManagedDocker(
      ["run", "--label", `dev.styre.bench.owner=${"b".repeat(32)}`],
      "a".repeat(32),
    ),
  ).rejects.toThrow("does not bind");
});

test("auto-removal race accepts verified absence even when rm exits nonzero", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bench-rm-race-"));
  try {
    await writeFile(
      path.join(dir, "docker"),
      `#!/bin/sh
if [ "$1" = ps ]; then
 if [ ! -f '${dir}/listed' ]; then touch '${dir}/listed'; echo abcdef123456; fi
 exit 0
fi
exit 1
`,
      { mode: 0o700 },
    );
    const driver = path.join(dir, "driver.ts");
    await writeFile(
      driver,
      `import {removeOwnedContainer} from ${JSON.stringify(path.resolve(import.meta.dir, "../orchestrator/docker-lifecycle.ts"))}; await removeOwnedContainer('${"a".repeat(32)}');`,
    );
    const proc = Bun.spawn([process.execPath, driver], {
      env: { PATH: `${dir}:/usr/bin:/bin` },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await proc.exited).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
