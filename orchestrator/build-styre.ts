import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { $ } from "bun";
import type { Cohort } from "./types";

/** Path (relative to a styre checkout root) of the file that carries the WebSearch/WebFetch
 *  capability grant this patch removes. Confirmed against the styre repo's
 *  src/dispatch/tool-allowlists.ts: a `design:dispatch` allowlist array literal containing
 *  the string literals "WebSearch" and "WebFetch" among other tool names. */
const ALLOWLIST_FILE_REL = "src/dispatch/tool-allowlists.ts";

/**
 * Removes every occurrence of the quoted literal `"<tool>"` from `text`, preferring to also
 * consume an adjacent comma so the surrounding array literal stays syntactically valid
 * (no dangling/double commas). Order of preference: a comma BEFORE the literal (the common
 * case — the literal is a non-first array element, e.g. `..., "WebSearch"`), then a comma
 * AFTER (the literal is the first element, e.g. `"WebSearch", ...`), then the bare literal
 * as a last resort (single-element array — not the real styre shape today, but handled
 * rather than left to produce broken syntax).
 */
function removeToolLiteral(text: string, tool: string): string {
  const commaBefore = `, "${tool}"`;
  const commaAfter = `"${tool}", `;
  const bare = `"${tool}"`;
  if (text.includes(commaBefore)) return text.split(commaBefore).join("");
  if (text.includes(commaAfter)) return text.split(commaAfter).join("");
  if (text.includes(bare)) return text.split(bare).join("");
  return text;
}

/**
 * PURE. Removes the `"WebSearch"` and `"WebFetch"` string literals from the text of
 * styre's `src/dispatch/tool-allowlists.ts`, leaving every other tool/allowlist entry
 * untouched. This is the load-bearing web-off guarantee for the "web-off" cohort: with
 * these literals gone, `claude -p --allowed-tools` is never handed either tool for any
 * step, so the dispatched agent cannot fetch the real fix off the web via styre's own
 * allowlist (belt-and-suspenders atop the container's `--disallowedTools` — see Task 6).
 *
 * THROWS if either literal is missing from `text` — a styre refactor that renames, relocates,
 * or restructures the allowlist (even partially, e.g. renaming just one of the two tools)
 * must never silently leave the other tool's grant in place; a missing anchor is treated as
 * a hard failure, not a no-op success. Fail-closed: if we can't be sure BOTH tools were
 * actually removed, we refuse to report a "web-off" build at all.
 */
export function applyWebOffPatch(fileText: string): string {
  const hasWebSearch = fileText.includes('"WebSearch"');
  const hasWebFetch = fileText.includes('"WebFetch"');
  if (!hasWebSearch || !hasWebFetch) {
    const missing = [!hasWebSearch ? '"WebSearch"' : null, !hasWebFetch ? '"WebFetch"' : null]
      .filter((x): x is string => x !== null)
      .join(" and ");
    throw new Error(
      `applyWebOffPatch: the ${missing} string literal anchor was not found in ${ALLOWLIST_FILE_REL} — the web-off patch anchor is missing (styre likely refactored its tool-allowlist shape, possibly renaming only one of the two tools). Refusing to silently leave a web tool grant in place; update this patch to match the new shape before re-running.`,
    );
  }
  let patched = fileText;
  patched = removeToolLiteral(patched, "WebSearch");
  patched = removeToolLiteral(patched, "WebFetch");
  return patched;
}

export interface BuildStyreConfig {
  styreRepo: string;
  styreCommit: string;
  cohort: Cohort;
}

export interface BuildStyreResult {
  binaryPath: string;
  commit: string;
  webTools: "off" | "on";
}

/** Side-effecting steps, split out so `buildStyre`'s cohort-branching logic (does it patch
 *  the allowlist or not, in what order) can be unit-tested with stubs — no network, no
 *  clone, no compile. The default implementations (used in production and the RUN_BUILD=1
 *  gated tests) do the real git/bun/build.sh work. */
export interface BuildStyreDeps {
  clone: (repo: string, cacheDir: string) => Promise<void>;
  checkout: (cacheDir: string, commit: string) => Promise<void>;
  bunInstall: (cacheDir: string) => Promise<void>;
  readAllowlist: (cacheDir: string) => Promise<string>;
  writeAllowlist: (cacheDir: string, text: string) => Promise<void>;
  runBuildScript: (cacheDir: string) => Promise<void>;
}

const defaultDeps: BuildStyreDeps = {
  async clone(repo, cacheDir) {
    if (existsSync(path.join(cacheDir, ".git"))) return; // reuse an existing cache dir
    await mkdir(path.dirname(cacheDir), { recursive: true });
    await $`git clone --no-checkout ${repo} ${cacheDir}`;
  },
  async checkout(cacheDir, commit) {
    // Fetch first so a commit not already in the shallow/default clone is reachable; ignore
    // fetch failures (e.g. the commit is already present) and let checkout be the real check.
    await $`git -C ${cacheDir} fetch origin ${commit}`.quiet().nothrow();
    // Force a byte-pristine tree on EVERY build, regardless of what a previous cohort's run
    // left behind in a REUSED cache dir. `-f` discards local modifications to tracked files
    // (e.g. a prior web-off run's stripped tool-allowlists.ts), and `clean -fdx` removes any
    // untracked/ignored leftovers (build artifacts, stray files). Without this, a repeat
    // web-off build reads the already-stripped file and throws a false anchor-missing error,
    // and a web-off-then-web-on sequence silently compiles the STALE web-off-patched file
    // under a "web-on" label — mislabeling the cohort and invalidating the contamination
    // delta. Defense-in-depth: `cacheDir` is also cohort-scoped (see `buildStyre`) so web-off
    // and web-on never share a working tree, but this reset is the real fix — cohort-scoping
    // alone does not protect a REPEATED build of the SAME cohort against its own prior patch.
    await $`git -C ${cacheDir} checkout -f ${commit}`;
    await $`git -C ${cacheDir} clean -fdx`;
  },
  async bunInstall(cacheDir) {
    // REQUIRED before `bun build --compile`: a fresh --no-checkout clone has no
    // node_modules, and the compile bundles from node_modules — it fails without this.
    await $`bun install --frozen-lockfile`.cwd(cacheDir);
  },
  async readAllowlist(cacheDir) {
    return readFile(path.join(cacheDir, ALLOWLIST_FILE_REL), "utf8");
  },
  async writeAllowlist(cacheDir, text) {
    // Applied to the local checkout ONLY — never committed or pushed back to styre.
    await writeFile(path.join(cacheDir, ALLOWLIST_FILE_REL), text, "utf8");
  },
  async runBuildScript(cacheDir) {
    await $`bash scripts/build.sh`.cwd(cacheDir);
  },
};

export interface BuildStyreOpts {
  /** Directory the styre checkout is cloned/built into. Defaults to a commit-AND-cohort-scoped
   *  cache dir under .cache/, so re-runs at the same commit+cohort reuse the clone. Cohort is
   *  part of the default key (not just the commit) as defense-in-depth so web-off and web-on
   *  never share a working tree — the `checkout` force-reset above is the primary fix for
   *  cache reuse mislabeling a cohort; this alone would not fix a REPEATED build of the same
   *  cohort clobbering itself. */
  cacheDir?: string;
  /** Override any subset of the side-effecting steps (tests only — production always uses
   *  the real git/bun/build.sh implementations). */
  deps?: Partial<BuildStyreDeps>;
}

/**
 * Builds styre from a pinned commit into a single self-contained binary.
 *
 * 1. `git clone --no-checkout` into a cache dir + `git checkout -f <styreCommit>` +
 *    `git clean -fdx` (force-resets the tree to a byte-pristine checkout on EVERY call, so a
 *    REUSED cache dir — same commit, same or different cohort — can never carry forward a
 *    prior run's web-off patch or other leftovers; see `checkout` above).
 * 2. `bun install --frozen-lockfile` (required — see `bunInstall` above).
 * 3. If `cfg.cohort === "web-off"`, applies `applyWebOffPatch` to the local checkout's
 *    `src/dispatch/tool-allowlists.ts` (never committed/pushed to styre). `"web-on"` skips
 *    this step entirely — the file is left byte-for-byte untouched.
 * 4. Runs `scripts/build.sh` (bun `--compile` + macOS ad-hoc re-sign) and returns the
 *    resulting binary path (`<cacheDir>/dist/styre`, matching `build.sh`'s `OUTFILE`
 *    default).
 */
export async function buildStyre(
  cfg: BuildStyreConfig,
  opts: BuildStyreOpts = {},
): Promise<BuildStyreResult> {
  const deps: BuildStyreDeps = { ...defaultDeps, ...opts.deps };
  const cacheDir =
    opts.cacheDir ??
    path.join(process.cwd(), ".cache", "styre-build", `${cfg.styreCommit}-${cfg.cohort}`);

  await deps.clone(cfg.styreRepo, cacheDir);
  await deps.checkout(cacheDir, cfg.styreCommit);
  await deps.bunInstall(cacheDir);

  if (cfg.cohort === "web-off") {
    const original = await deps.readAllowlist(cacheDir);
    const patched = applyWebOffPatch(original);
    await deps.writeAllowlist(cacheDir, patched);
  }

  await deps.runBuildScript(cacheDir);

  return {
    binaryPath: path.join(cacheDir, "dist", "styre"),
    commit: cfg.styreCommit,
    webTools: cfg.cohort === "web-off" ? "off" : "on",
  };
}
