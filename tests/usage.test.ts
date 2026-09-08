import { describe, expect, test } from "bun:test";
import { sumTranscriptUsage } from "../orchestrator/usage";

function line(o: unknown): string {
  return JSON.stringify(o);
}
function result(cost: number | null, tin: number, tout: number): string {
  const o: Record<string, unknown> = { type: "result", result: "ok" };
  if (cost !== null) o.total_cost_usd = cost;
  o.usage = { input_tokens: tin, output_tokens: tout };
  return line(o);
}

describe("sumTranscriptUsage", () => {
  test("sums cost and tokens across every result event", () => {
    const t = [result(1.5, 100, 200), result(2.25, 10, 20), result(0.25, 1, 2)].join("\n");
    const u = sumTranscriptUsage(t);
    expect(u.costUsd).toBeCloseTo(4.0, 6);
    expect(u.tokensIn).toBe(111);
    expect(u.tokensOut).toBe(222);
    expect(u.resultEvents).toBe(3);
  });

  test("ignores non-result events and unparseable lines", () => {
    const t = [
      "not json at all {{{",
      line({ type: "assistant", usage: { input_tokens: 999, output_tokens: 999 } }),
      line({ type: "system", total_cost_usd: 99 }),
      "",
      result(3.0, 5, 6),
    ].join("\n");
    const u = sumTranscriptUsage(t);
    expect(u.costUsd).toBeCloseTo(3.0, 6);
    expect(u.tokensIn).toBe(5);
    expect(u.tokensOut).toBe(6);
    expect(u.resultEvents).toBe(1);
  });

  test("an empty transcript yields unknown (null), never zero", () => {
    const u = sumTranscriptUsage("");
    expect(u.costUsd).toBeNull();
    expect(u.tokensIn).toBeNull();
    expect(u.tokensOut).toBeNull();
    expect(u.resultEvents).toBe(0);
  });

  test("result events carrying no cost field yield null cost, not 0", () => {
    const t = [result(null, 4, 8), result(null, 1, 1)].join("\n");
    const u = sumTranscriptUsage(t);
    expect(u.costUsd).toBeNull();
    expect(u.tokensIn).toBe(5);
    expect(u.tokensOut).toBe(9);
    expect(u.resultEvents).toBe(2);
  });

  test("a mix of costed and uncosted result events sums only the costed ones", () => {
    const t = [result(2.0, 1, 1), result(null, 1, 1)].join("\n");
    expect(sumTranscriptUsage(t).costUsd).toBeCloseTo(2.0, 6);
  });

  test("tolerates a missing usage object", () => {
    const t = line({ type: "result", total_cost_usd: 1.25 });
    const u = sumTranscriptUsage(t);
    expect(u.costUsd).toBeCloseTo(1.25, 6);
    expect(u.tokensIn).toBeNull();
    expect(u.tokensOut).toBeNull();
  });

  test("reproduces the 2026-09-08 astropy run totals", () => {
    // 12 result events, $11.84 total — the run the bench reported as $0.50 (ENG-390).
    const events = Array.from({ length: 12 }, () => result(11.84 / 12, 0, 2442.5));
    const u = sumTranscriptUsage(events.join("\n"));
    expect(u.costUsd).toBeCloseTo(11.84, 6);
    expect(u.resultEvents).toBe(12);
  });
});
