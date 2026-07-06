/**
 * Host-architecture detection for pulling the right bench eval images.
 *
 * SWE-bench publishes single-arch images whose architecture is encoded in the NAME
 * (`swebench/sweb.eval.arm64.<id>` = linux/arm64, `swebench/sweb.eval.x86_64.<id>` =
 * linux/amd64), so an Apple-Silicon host should pull the native `arm64` image rather than
 * emulate `x86_64` — emulation is slower and can introduce test flakiness. Multi-SWE-bench,
 * by contrast, currently publishes amd64-only images (`mswebench/<org>_m_<repo>:pr-<n>`, no
 * arch in the name), so those always run as linux/amd64 (native on an x86_64 host, emulated
 * on arm64) regardless of `hostImageArch`.
 */
export type ImageArch = "arm64" | "x86_64";

/**
 * The image architecture to pull SWE-bench eval images for. Detected from the host
 * (`process.arch === "arm64"` -> arm64, everything else -> x86_64), overridable via the
 * `BENCH_IMAGE_ARCH` env var. The override exists for two cases: (1) a specific arm64 image
 * isn't published on Docker Hub, so the operator forces `x86_64` to fall back to emulation
 * for the whole run; (2) pinning the arch for the scored Linux run irrespective of where the
 * process happens to be driven from.
 */
export function hostImageArch(
  env: Record<string, string | undefined> = process.env,
  arch: string = process.arch,
): ImageArch {
  const raw = env.BENCH_IMAGE_ARCH?.trim().toLowerCase();
  if (raw === "arm64" || raw === "x86_64") return raw;
  if (raw !== undefined && raw !== "") {
    throw new Error(`BENCH_IMAGE_ARCH must be "arm64" or "x86_64" (got "${env.BENCH_IMAGE_ARCH}")`);
  }
  return arch === "arm64" ? "arm64" : "x86_64";
}

/** The `docker run --platform` value matching an image architecture. */
export function dockerPlatform(arch: ImageArch): string {
  return arch === "arm64" ? "linux/arm64" : "linux/amd64";
}

/** Inverse of `dockerPlatform`: the `ImageArch` a `docker --platform` value denotes. Anything
 *  other than `linux/arm64` maps to `x86_64` (we only ever run linux/arm64 or linux/amd64). */
export function archFromPlatform(platform: string): ImageArch {
  return platform === "linux/arm64" ? "arm64" : "x86_64";
}

/**
 * The Bun `--compile --target` value for a Linux binary of the given arch. The styre binary
 * runs INSIDE a Linux eval container, so it is ALWAYS cross-compiled to Linux (never the
 * macOS host target) — `arm64` -> `bun-linux-arm64` (runs native in a linux/arm64 container),
 * `x86_64` -> `bun-linux-x64` (native on linux/amd64, emulated on an arm64 host). glibc
 * variants: the swebench/mswebench eval images are Debian/Ubuntu-based.
 */
export function bunLinuxTarget(arch: ImageArch): string {
  return arch === "arm64" ? "bun-linux-arm64" : "bun-linux-x64";
}
