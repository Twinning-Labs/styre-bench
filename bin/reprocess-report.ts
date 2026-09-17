import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type Family, normalizeInstance } from "../orchestrator/corpus";
import { LeakResultSchema } from "../orchestrator/leak-contract";
import type { Instance, TaskRecord } from "../orchestrator/types";
import { normalizeReportRecord } from "../report/measurement";
import { ReportMetaSchema, renderReport } from "../report/render";
import { reprocessRecords } from "../report/reprocess";

/** Offline-only CLI. Requires explicit source, evidence, corpus and metadata paths; writes a
 * NEW directory so an old report or prior correction cannot be overwritten accidentally. */
async function main() {
  const [source, evidenceRoot, dataDir, metaPath, outputDir] = process.argv.slice(2);
  if (!source || !evidenceRoot || !dataDir || !metaPath || !outputDir || process.argv.length !== 7)
    throw new Error(
      "usage: bun bin/reprocess-report.ts <report.json> <runs-dir> <corpus-dir> <meta.json> <new-output-dir>",
    );
  const input = await readFile(source, "utf8");
  const raw: unknown = JSON.parse(input);
  if (!Array.isArray(raw)) throw new Error("report must be an array of task records");
  const records = raw as TaskRecord[]; // reprocessRecords validates each record before using it
  for (const record of records) normalizeReportRecord(record);
  const metadataInput = await readFile(metaPath, "utf8");
  const meta = ReportMetaSchema.parse(JSON.parse(metadataInput));
  const wanted = new Set(records.map((r) => r.instance));
  const instances: Instance[] = [];
  const corpusHashes: Record<string, string> = {};
  for (const family of ["swe-bench", "multi-swe-bench"] as Family[]) {
    const content = await readFile(join(dataDir, `${family}.json`), "utf8");
    corpusHashes[family] = createHash("sha256").update(content).digest("hex");
    const dataset: unknown = JSON.parse(content);
    if (!Array.isArray(dataset)) throw new Error(`${family}: expected corpus array`);
    // Normalize only selected records; unrelated corrupt corpus rows cannot obscure this audit.
    for (const row of dataset) {
      if (row === null || typeof row !== "object") continue;
      const candidateId =
        family === "swe-bench" ? row.instance_id : `${row.org}__${row.repo}-${row.number}`;
      if (wanted.has(candidateId)) instances.push(normalizeInstance(row, family));
    }
  }
  for (const id of wanted)
    if (instances.filter((i) => i.id === id).length !== 1)
      throw new Error(`${id}: requires exactly one matching corpus record`);
  const { records: corrected, corrections } = await reprocessRecords({
    records,
    evidenceRoot,
    instances,
    scan: async (transcript, instance) => {
      const proc = Bun.spawn(
        [
          process.env.BENCH_PYTHON ?? "python3",
          new URL("../scorer/leak_detect.py", import.meta.url).pathname,
        ],
        { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
      );
      proc.stdin.write(
        JSON.stringify({
          candidate_diff: null,
          fix_patch: null,
          transcript,
          instance_id: instance.id,
          problem_statement: instance.problem_statement,
        }),
      );
      await proc.stdin.end();
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (code !== 0) throw new Error(`transcript detector failed: ${stderr || stdout}`);
      const result = LeakResultSchema.parse(JSON.parse(stdout));
      return result;
    },
  });
  const report = renderReport(corrected, meta);
  const evaluatorFiles = [
    "bin/reprocess-report.ts",
    "report/reprocess.ts",
    "report/measurement.ts",
    "report/render.ts",
    "orchestrator/corpus.ts",
    "orchestrator/collect.ts",
    "orchestrator/firewall.ts",
    "orchestrator/leak-contract.ts",
    "scorer/leak_detect.py",
    "bun.lock",
  ];
  const evaluatorSha256: Record<string, string> = {};
  const evaluatorRoot = new URL("../", import.meta.url).pathname;
  for (const file of evaluatorFiles)
    evaluatorSha256[file] = createHash("sha256")
      .update(await readFile(join(evaluatorRoot, file)))
      .digest("hex");
  const revision = Bun.spawn(["git", "rev-parse", "HEAD"], {
    cwd: evaluatorRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [revisionText, revisionError, revisionCode] = await Promise.all([
    new Response(revision.stdout).text(),
    new Response(revision.stderr).text(),
    revision.exited,
  ]);
  if (revisionCode !== 0) throw new Error(`Cannot establish evaluator revision: ${revisionError}`);
  const provenance = {
    version: 1,
    mode: "offline-reanalysis-no-oracle-or-agent-runs",
    generatedAt: new Date().toISOString(),
    source: resolve(source),
    sourceSha256: createHash("sha256").update(input).digest("hex"),
    corpusSha256: corpusHashes,
    corrections,
    metadataSha256: createHash("sha256").update(metadataInput).digest("hex"),
    evaluator: { commit: revisionText.trim(), sourceSha256: evaluatorSha256, bun: Bun.version },
  };
  await mkdir(outputDir); // intentionally exclusive: EEXIST must fail loudly
  await Promise.all([
    writeFile(join(outputDir, "report.json"), JSON.stringify(report.json, null, 2)),
    writeFile(join(outputDir, "metrics.json"), JSON.stringify(report.metrics, null, 2)),
    writeFile(join(outputDir, "report.md"), report.markdown),
    writeFile(join(outputDir, "corrections.json"), JSON.stringify(provenance, null, 2)),
  ]);
  console.log(`Corrected report written to ${resolve(outputDir)}; original preserved.`);
}
if (import.meta.main)
  main().catch((err) => {
    console.error(String(err));
    process.exitCode = 1;
  });
