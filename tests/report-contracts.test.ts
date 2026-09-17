import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertNoHeldOut, measureTicketOverlap } from "../orchestrator/firewall";
import { type LeakResult, LeakResultSchema } from "../orchestrator/leak-contract";
import type { Instance, TaskRecord } from "../orchestrator/types";
import { controlsQualified, measurePopulation, normalizeReportRecord } from "../report/measurement";
import { renderReport } from "../report/render";
import { reprocessRecords } from "../report/reprocess";

function record(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    instance: "synthetic__project-100",
    language: "python",
    difficulty: "easy",
    styre_commit: "abc",
    cohort: "web-off",
    post_cutoff: false,
    resolved: null,
    score_attempted: false,
    pr_opened: false,
    pr_self_reported: false,
    pr_lookup_error: null,
    self_authored_test: null,
    self_test_passed: null,
    ticks: 0,
    cycle_count: 0,
    escalation_count: 0,
    escalation_reasons: [],
    outcome: "paused",
    status: "needs_you",
    exit_code: 0,
    parked: false,
    cost_usd_measured: null,
    cost_usd_estimated: 0,
    tokens_in: null,
    tokens_out: null,
    evidence_dir: "/remote/run-1",
    blind_quality: null,
    ab_preference: null,
    ab_notes: null,
    suspected_leak: null,
    leak_reasons: [],
    taxonomy: "loop-exhausted",
    controls: { gold_resolved: true, base_fails: true, deterministic: true },
    ...overrides,
  };
}
const meta = {
  styreRef: "abc",
  dataset: "synthetic",
  seed: 1,
  runDate: "2026-09-17",
  budgetUsd: 1,
};
const complete: LeakResult = {
  suspected: false,
  reasons: [],
  exposure: "unknown",
  network_indicators: [],
  transcript_scan: {
    status: "complete",
    assistant_messages: 1,
    unparsed_lines: 0,
    unknown_entries: 0,
  },
};
const instance: Instance = {
  id: "synthetic__project-100",
  language: "python",
  difficulty: "easy",
  repo: "synthetic/project",
  base_commit: "abc",
  problem_statement: "Synthetic issue",
  image: "synthetic",
  fail_to_pass: [],
  pass_to_pass: [],
  fix_patch: "--- a/a.py\n+++ b/a.py\n@@ -1 +1 @@\n-old\n+if not item.attribute_name:\n",
  test_patch: "",
};

describe("report evidence populations", () => {
  test("six-record shape separates measured verdicts from qualified delivery and PR state", () => {
    const rs = [
      record({ instance: "success", resolved: true, score_attempted: true, pr_opened: true }),
      record({ instance: "negative1", resolved: false, score_attempted: true }),
      record({ instance: "negative2", resolved: false, score_attempted: true }),
      record({ instance: "unscored1" }),
      record({ instance: "unscored2" }),
      record({
        instance: "drop",
        taxonomy: "dropped-flaky",
        controls: { gold_resolved: true, base_fails: true, deterministic: false },
      }),
    ];
    expect(measurePopulation(rs)).toMatchObject({
      recorded: 6,
      qualified: 5,
      submitted: 3,
      oracleResolved: { numerator: 1, denominator: 3 },
      confirmedDelivery: { numerator: 1, denominator: 5 },
      prOpened: { numerator: 1, denominator: 6 },
      openedUnresolved: { numerator: 0, denominator: 3 },
    });
    // Relabeling a submitted record must not change whether its oracle result was measured.
    rs[0] = record({ resolved: true, score_attempted: true, pr_opened: true, taxonomy: "parked" });
    expect(measurePopulation(rs).oracleResolved).toEqual({ numerator: 1, denominator: 3 });
  });
  test("no-run defaults do not create a negative Styre self-report", () => {
    const dropped = record({
      instance: "not-run",
      taxonomy: "dropped-flaky",
      evidence_dir: null,
      outcome: "",
      pr_self_reported: false,
    });
    const observed = record({ instance: "real-negative", pr_self_reported: false });
    const result = renderReport([dropped, observed], meta);
    expect(result.json[0]?.pr_self_reported).toBeNull();
    expect(result.json[1]?.pr_self_reported).toBe(false);
    expect(result.markdown).toContain("agree on 1 comparable instance(s); 1 not compared");
    expect(result.metrics.webOff.prOpened.denominator).toBe(2);
  });
  test("unknown PR state leaves both sides of the opened-unresolved comparison", () => {
    expect(
      measurePopulation([record({ resolved: false, score_attempted: true, pr_opened: null })])
        .openedUnresolved,
    ).toEqual({ numerator: 0, denominator: 0 });
  });
  test("legacy defaults are copied and normalized, not silently treated as measurements", () => {
    const original = record({ score_attempted: undefined, resolved: false, taxonomy: "probe" });
    const corrected = normalizeReportRecord(original);
    expect(corrected.resolved).toBeNull();
    expect(original.resolved).toBe(false);
    expect(corrected.reporting_notes?.length).toBe(1);
    expect(() => normalizeReportRecord(record({ resolved: true, score_attempted: false }))).toThrow(
      "conflicts",
    );
  });
  test("unknown legacy submission is counted independently of its missing verdict", () => {
    const r = record({ taxonomy: "oracle-unmeasured", score_attempted: undefined });
    expect(measurePopulation([r]).submitted).toBe(1);
    expect(measurePopulation([r]).oracleResolved.denominator).toBe(0);
  });
  test("explicit failed base preservation never qualifies delivery", () => {
    expect(
      controlsQualified(
        record({
          controls: {
            gold_resolved: true,
            base_fails: true,
            deterministic: true,
            base_preserved: false,
          },
        }),
      ),
    ).toBe(false);
  });
  test("unparsed reviews, empty populations and missing baseline do not create numeric evidence", () => {
    const report = renderReport(
      [
        record({
          cohort: "web-on",
          resolved: false,
          score_attempted: true,
          blind_quality: "unparsed",
        }),
      ],
      meta,
    ).markdown;
    expect(report).toContain("Δ n/a: no measured web-off baseline");
    expect(report).toContain("no comparable parsed review");
    expect(report).toContain("ticks (median / p90) | n/a / n/a | n/a / n/a");
    expect(() => renderReport([], { ...meta, budgetUsd: Number.NaN })).toThrow();
  });
  test("archived detector metadata is validated as strictly as fresh Python output", () => {
    for (const bad of [
      { status: "completed", transcript_scan: { status: "bogus" } },
      { status: "completed", scope: "full", ...complete, exposure: "confirmed" },
      {
        status: "completed",
        scope: "full",
        ...complete,
        transcript_scan: { ...complete.transcript_scan, unknown_entries: -1 },
      },
      {
        status: "completed",
        scope: "full",
        ...complete,
        transcript_scan: { ...complete.transcript_scan, assistant_messages: 0 },
      },
      { status: "error" },
    ])
      expect(() =>
        normalizeReportRecord(record({ leak_check: bad as TaskRecord["leak_check"] })),
      ).toThrow();
    expect(() => LeakResultSchema.parse({ ...complete, similarity: 2 })).toThrow();
  });
});

test("exact lexical measurement avoids buggy-expression substrings without weakening the firewall", () => {
  const text = "if not item.attribute_name.startswith(prefix):";
  const patch = {
    ...instance,
    fix_patch: instance.fix_patch.replace("attribute_name:", "attribute_name"),
  };
  expect(measureTicketOverlap(text, patch).fix_lines).toBe(0);
  expect(measureTicketOverlap("  if not item.attribute_name  ", patch).fix_lines).toBe(1);
  expect(measureTicketOverlap(text, patch).method).toBe("exact-trimmed-added-lines-v2");
  expect(() => assertNoHeldOut(text, patch)).toThrow("FIREWALL");
});

describe("offline correction provenance", () => {
  test("reclassifies an old probe without inventing an oracle score; hashes and preserves input evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "report-evidence-"));
    try {
      await mkdir(join(root, "run-1"));
      const summary = JSON.stringify({
        type: "summary",
        outcome: "paused",
        reason: "needs_you",
        status: "needs_you",
        ticks: 12,
        cycle_count: 1,
        escalation_count: 1,
        escalation_reasons: ["review"],
      });
      await writeFile(join(root, "run-1/run.ndjson"), summary);
      await writeFile(
        join(root, "run-1/profile.json"),
        JSON.stringify({
          components: [
            { name: "fixture", role: "fixture", commands: { test: { unavailable: true } } },
            { name: "primary", commands: { test: "test-runner" } },
          ],
        }),
      );
      await writeFile(join(root, "run-1/transcript.jsonl"), "retained transcript");
      const original = record({
        taxonomy: "probe",
        resolved: false,
        score_attempted: undefined,
        suspected_leak: true,
        leak_reasons: ["pr-url-in-transcript"],
      });
      const before = JSON.stringify(original);
      const result = await reprocessRecords({
        records: [original],
        evidenceRoot: root,
        instances: [instance],
        scan: async () => complete,
      });
      expect(result.records[0]).toMatchObject({
        taxonomy: "loop-exhausted",
        resolved: null,
        score_attempted: false,
        test_configuration: { status: "declared", components: ["primary"] },
        prior_leak_assessment: { suspected: true, reasons: ["pr-url-in-transcript"] },
        leak_check: { status: "completed", scope: "transcript-only" },
      });
      expect(result.corrections[0]?.evidence["run.ndjson"]).toBe(
        createHash("sha256").update(summary).digest("hex"),
      );
      expect(await readFile(join(root, "run-1/run.ndjson"), "utf8")).toBe(summary);
      expect(JSON.stringify(original)).toBe(before);
      expect(renderReport(result.records, meta).markdown).toContain(
        "retrospective transcript-only",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test("partial negative rescan preserves previous positive evidence and exposes the coverage hole", async () => {
    const root = await mkdtemp(join(tmpdir(), "report-partial-"));
    try {
      await mkdir(join(root, "run-1"));
      await writeFile(join(root, "run-1/transcript.jsonl"), "truncated");
      const result = await reprocessRecords({
        records: [record({ suspected_leak: true, leak_reasons: ["web-tool-used"] })],
        evidenceRoot: root,
        instances: [instance],
        scan: async () => ({
          ...complete,
          transcript_scan: {
            status: "partial",
            assistant_messages: 0,
            unparsed_lines: 1,
            unknown_entries: 0,
          },
        }),
      });
      expect(result.records[0]?.suspected_leak).toBe(true);
      expect(result.records[0]?.leak_reasons).toContain("web-tool-used");
      expect(result.records[0]?.reporting_notes?.[0]).toContain("Incomplete retrospective scan");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test("missing exact evidence directory is recorded; no heuristic is guessed", async () => {
    const root = await mkdtemp(join(tmpdir(), "report-missing-"));
    try {
      const result = await reprocessRecords({ records: [record()], evidenceRoot: root });
      expect(result.records[0]?.suspected_leak).toBeNull();
      expect(result.corrections[0]?.unavailable).toContain("No exact evidence directory: run-1");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("offline CLI writes auditable artifacts and refuses to overwrite a correction", async () => {
  const root = await mkdtemp(join(tmpdir(), "report-cli-"));
  try {
    const source = join(root, "source.json");
    const evidence = join(root, "evidence");
    const corpus = join(root, "data");
    const metadata = join(root, "meta.json");
    const output = join(root, "corrected");
    await mkdir(evidence);
    await mkdir(join(evidence, "run-1"));
    await mkdir(corpus);
    await writeFile(source, JSON.stringify([record()]));
    await writeFile(metadata, JSON.stringify(meta));
    await writeFile(join(corpus, "multi-swe-bench.json"), "[]");
    await writeFile(
      join(corpus, "swe-bench.json"),
      JSON.stringify([
        {
          instance_id: instance.id,
          repo: instance.repo,
          base_commit: instance.base_commit,
          problem_statement: instance.problem_statement,
          patch: instance.fix_patch,
          test_patch: instance.fix_patch,
          FAIL_TO_PASS: '["test_synthetic"]',
          PASS_TO_PASS: "[]",
          difficulty: "<15 min fix",
        },
      ]),
    );
    await writeFile(
      join(evidence, "run-1/transcript.jsonl"),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Working on the supplied issue." }],
        },
      }),
    );
    const run = async () => {
      const proc = Bun.spawn(
        [process.execPath, "bin/reprocess-report.ts", source, evidence, corpus, metadata, output],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { stdout, stderr, code };
    };
    const first = await run();
    expect(first.code).toBe(0);
    expect(first.stderr).toBe("");
    const manifestText = await readFile(join(output, "corrections.json"), "utf8");
    const manifest = JSON.parse(manifestText);
    expect(manifest.sourceSha256).toBe(
      createHash("sha256")
        .update(await readFile(source))
        .digest("hex"),
    );
    expect(manifest.evaluator.sourceSha256["scorer/leak_detect.py"]).toBe(
      createHash("sha256")
        .update(await readFile("scorer/leak_detect.py"))
        .digest("hex"),
    );
    expect(manifest.evaluator.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(JSON.parse(await readFile(join(output, "report.json"), "utf8"))[0].resolved).toBeNull();
    expect(
      JSON.parse(await readFile(join(output, "metrics.json"), "utf8")).webOff.oracleResolved
        .denominator,
    ).toBe(0);
    const second = await run();
    expect(second.code).toBe(1);
    expect(second.stderr).toContain("EEXIST");
    expect(await readFile(join(output, "corrections.json"), "utf8")).toBe(manifestText);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
