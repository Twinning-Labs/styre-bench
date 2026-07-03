import { describe, expect, test } from "bun:test";
import { dockerPlatform, hostImageArch } from "../orchestrator/platform";

describe("hostImageArch", () => {
  test("maps an arm64 host to arm64", () => {
    expect(hostImageArch({}, "arm64")).toBe("arm64");
  });

  test("maps an x64 host to x86_64", () => {
    expect(hostImageArch({}, "x64")).toBe("x86_64");
  });

  test("maps any non-arm64 arch (e.g. ppc64) to x86_64 (only arm64 gets the native path)", () => {
    expect(hostImageArch({}, "ppc64")).toBe("x86_64");
  });

  test("BENCH_IMAGE_ARCH override wins over the host arch (force x86_64 emulation on an arm64 host)", () => {
    expect(hostImageArch({ BENCH_IMAGE_ARCH: "x86_64" }, "arm64")).toBe("x86_64");
  });

  test("BENCH_IMAGE_ARCH override can force arm64 on an x64 host", () => {
    expect(hostImageArch({ BENCH_IMAGE_ARCH: "arm64" }, "x64")).toBe("arm64");
  });

  test("override is case/whitespace-insensitive", () => {
    expect(hostImageArch({ BENCH_IMAGE_ARCH: "  ARM64 " }, "x64")).toBe("arm64");
  });

  test("an empty override string falls through to host detection (not an error)", () => {
    expect(hostImageArch({ BENCH_IMAGE_ARCH: "" }, "arm64")).toBe("arm64");
  });

  test("throws on an invalid override rather than silently pulling the wrong image", () => {
    expect(() => hostImageArch({ BENCH_IMAGE_ARCH: "amd64" }, "arm64")).toThrow(
      /BENCH_IMAGE_ARCH must be/,
    );
  });
});

describe("dockerPlatform", () => {
  test("arm64 -> linux/arm64", () => {
    expect(dockerPlatform("arm64")).toBe("linux/arm64");
  });

  test("x86_64 -> linux/amd64", () => {
    expect(dockerPlatform("x86_64")).toBe("linux/amd64");
  });
});
