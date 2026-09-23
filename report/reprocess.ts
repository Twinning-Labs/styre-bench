import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { collect, parseProbeProfile } from "../orchestrator/collect";
import { measureTicketOverlap } from "../orchestrator/firewall";
import { type LeakResult, LeakResultSchema } from "../orchestrator/leak-contract";
import type { Instance, TaskRecord } from "../orchestrator/types";
import { normalizeReportRecord } from "./measurement";

/** Offline evidence correction. Never scores candidates, calls agents/forge, or mutates inputs.
 * Corpus (when supplied) is used only for host-side lexical analysis, never copied to outputs.
 * Every field change and every unavailable artifact is recorded in the correction manifest. */
export async function reprocessRecords(p: {
  records: TaskRecord[];
  evidenceRoot: string;
  instances?: Instance[];
  scan?: (transcript: string, instance: Instance) => Promise<LeakResult>;
}) {
  const dirs = await readdir(p.evidenceRoot, { withFileTypes: true });
  const corrections: Array<{
    instance: string;
    changes: Record<
      string,
      { before: unknown; after: unknown; beforePresent: boolean; afterPresent: boolean }
    >;
    evidence: Record<string, string>;
    unavailable: string[];
  }> = [];
  const records: TaskRecord[] = [];
  for (const original of p.records) {
    const record = normalizeReportRecord(original);
    const correction = {
      instance: record.instance,
      changes: {} as Record<
        string,
        { before: unknown; after: unknown; beforePresent: boolean; afterPresent: boolean }
      >,
      evidence: {} as Record<string, string>,
      unavailable: [] as string[],
    };
    // Preserve submission facts before taxonomy correction. A historical false default is not a score.
    if (original.resolved !== record.resolved) record.score_attempted = false;
    const dirName = original.evidence_dir ? basename(original.evidence_dir) : null;
    const matching = dirs.filter((d) => d.isDirectory() && d.name === dirName);
    if (matching.length === 1 && dirName) {
      const read = async (file: string): Promise<string | null> => {
        try {
          const text = await readFile(join(p.evidenceRoot, dirName, file), "utf8");
          correction.evidence[file] = createHash("sha256").update(text).digest("hex");
          return text;
        } catch (err) {
          correction.unavailable.push(`${file}: ${String(err)}`);
          return null;
        }
      };
      if (original.taxonomy === "probe") {
        const [ndjson, profile] = await Promise.all([read("run.ndjson"), read("profile.json")]);
        if (ndjson !== null && profile !== null) {
          // The profile feeds only the descriptive test_configuration: one this rig cannot read
          // is recorded unreadable, with a note, and never aborts the batch.
          let parsed: ReturnType<typeof parseProbeProfile> | null = null;
          try {
            parsed = parseProbeProfile(JSON.parse(profile));
          } catch (err) {
            correction.unavailable.push(
              `profile.json: unreadable under this rig's contract: ${String(err)}`,
            );
          }
          const derived = collect(ndjson, "", parsed, {
            language: record.language,
            pr_opened: record.pr_opened,
          });
          if (derived.outcome) {
            record.taxonomy = derived.taxonomy ?? "unscored";
            record.test_configuration = derived.test_configuration;
          }
        }
      }
      // A retrospective text scan is explicit new offline evidence, not a claim the old pipeline ran it.
      const instance = p.instances?.find((i) => i.id === record.instance);
      if (p.scan && instance) {
        const transcript = await read("transcript.jsonl");
        if (transcript !== null) {
          const scan = LeakResultSchema.parse(await p.scan(transcript, instance));
          const { suspected, reasons, ...measurements } = scan;
          record.prior_leak_assessment = {
            suspected: original.suspected_leak,
            reasons: [...original.leak_reasons],
          };
          const retained = original.leak_reasons.filter(
            (reason) =>
              scan.transcript_scan.status !== "complete" ||
              ["high-similarity", "high-containment"].includes(reason),
          );
          record.leak_check = {
            status: "completed",
            ...measurements,
            scope: "transcript-only",
            reason:
              "retrospective scan of retained transcript; original assessment preserved in prior_leak_assessment",
          };
          record.suspected_leak =
            suspected ||
            retained.some((reason) => ["high-similarity", "high-containment"].includes(reason)) ||
            (scan.transcript_scan.status !== "complete" && original.suspected_leak === true);
          record.leak_reasons = [
            ...new Set([
              ...retained,
              ...reasons.filter((reason) => reason !== "similarity-unavailable"),
            ]),
          ];
          if (scan.transcript_scan.status !== "complete")
            record.reporting_notes = [
              ...(record.reporting_notes ?? []),
              "Incomplete retrospective scan: prior positive findings retained; no negative conclusion is supported.",
            ];
        }
      }
    } else if (dirName) correction.unavailable.push(`No exact evidence directory: ${dirName}`);
    const instance = p.instances?.find((i) => i.id === record.instance);
    if (instance)
      record.ticket_fix_overlap = measureTicketOverlap(instance.problem_statement, instance);
    else correction.unavailable.push("Corpus unavailable: ticket overlap not recomputed");
    for (const key of new Set([...Object.keys(original), ...Object.keys(record)])) {
      const before = (original as unknown as Record<string, unknown>)[key];
      const after = (record as unknown as Record<string, unknown>)[key];
      if (JSON.stringify(before) !== JSON.stringify(after))
        correction.changes[key] = {
          before: before ?? null,
          after: after ?? null,
          beforePresent: Object.hasOwn(original, key),
          afterPresent: Object.hasOwn(record, key),
        };
    }
    corrections.push(correction);
    records.push(normalizeReportRecord(record));
  }
  return { records, corrections };
}
