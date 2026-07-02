import { describe, expect, test } from "bun:test";
import { BENCH_CONFIG } from "../config/bench.config";

describe("BENCH_CONFIG smoke", () => {
  test("styreCommit is a non-empty string", () => {
    expect(typeof BENCH_CONFIG.styreCommit).toBe("string");
    expect(BENCH_CONFIG.styreCommit.length).toBeGreaterThan(0);
  });

  test("cohort defaults to web-off", () => {
    expect(BENCH_CONFIG.cohort).toBe("web-off");
  });
});
