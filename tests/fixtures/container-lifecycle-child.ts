// Harmless native lifecycle payload. Never setup/run an agent or load real credentials.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { runStyre } from "../../orchestrator/run-task";
import type { Instance } from "../../orchestrator/types";
const [root, image, mode] = process.argv.slice(2);
if (!root || !image || !["hold", "zero", "failure", "concurrent"].includes(mode ?? ""))
  throw new Error("Bad fixture arguments");
const count = mode === "concurrent" ? 2 : 1;
const jobs = Array.from({ length: count }, (_, i) => {
  const outDir = path.join(root, `${path.basename(root)}-${i}`);
  const instance: Instance = {
    id: "fixture__lifecycle-1",
    language: "python",
    difficulty: "easy",
    repo: "fixture/lifecycle",
    base_commit: "fixture",
    problem_statement: "fixture",
    image,
    platform: "linux/amd64",
    fix_patch: "",
    test_patch: "",
    fail_to_pass: [],
    pass_to_pass: [],
  };
  const payload =
    mode === "zero" ? "exit 0" : mode === "failure" ? "exit 7" : "while sleep 1; do :; done";
  return runStyre(
    instance,
    { repoUrl: "https://example.invalid/fixture", defaultBranch: "main", ident: "FIXTURE-1" },
    process.execPath,
    {
      outDir,
      creds: {
        anthropicApiKey: "fixture",
        linearApiKey: "fixture",
        githubToken: "fixture",
        benchGhToken: "fixture",
        slackBotToken: "",
      },
    },
    {
      deps: {
        writeEntrypoint: async (file) => {
          await writeFile(
            file,
            `#!/bin/bash\nset -euo pipefail\nif [ "$#" -eq 0 ]; then exec /usr/bin/xvfb-run -a /bin/bash "$0" ready; fi\n[ "$1" = ready ]\nprintf ready > /out/ready\n${payload}\n`,
            { mode: 0o700 },
          );
        },
      },
    },
  );
});
const results = await Promise.all(jobs);
process.exit(results.find((r) => r.exitCode !== 0)?.exitCode ?? 0);
