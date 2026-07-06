"""Contamination detector -- diff-vs-fix similarity + transcript URL scan.

BACKSTOP, not the primary control: the bench runs styre WEB-OFF (behavioral
guarantee, Task 4) and splits results by pre/post-cutoff (memorization
signal) as the primary defenses. This module exists because web-off is not
airtight -- pretrained-weight memorization of a merged fix is possible even
with tools disabled, and a web-on cohort exists deliberately. `detect_leak`
flags a run for human review; it never itself drops or rescoring a result.

Three independent signals, any one sufficient to set `suspected: True`:

  (a) diff similarity (symmetric) -- `candidate_diff` (styre's fix)
      compared against `fix_patch` (the withheld human-accepted fix, which
      never enters the ticket/repo/container -- see the firewall invariant
      in the plan's Global Constraints). Computed via `difflib.
      SequenceMatcher` on sorted, normalized diff-hunk lines (context +
      changed): diff formatting noise (`+++`/`---`/`@@` headers, `diff
      --git`/`index` preamble, the leading `+`/`-` marker, surrounding
      whitespace) is stripped first, so two diffs that make the same
      underlying change via different hunk boundaries, context, or
      whitespace still compare as near-identical -- and two diffs that
      just happen to touch the same file/lines with genuinely different
      content still compare as dissimilar. Being symmetric (whole-diff
      length matters to the ratio), this signal is blind to the exact
      fix pasted into a LARGER candidate diff (fix + unrelated noise
      edits) -- that scores low on `ratio` even though the fix is present
      verbatim. Signal (b) below exists to close that gap.

  (b) diff containment (asymmetric) -- the set of `fix_patch`'s CHANGED
      lines only (the `+`/`-` hunk lines, normalized -- NOT context
      lines) checked for how much of itself reappears in `candidate_
      diff`'s changed-line set: `containment = |fix_changed ∩
      candidate_changed| / |fix_changed|`. Unlike (a), this is insensitive
      to how much unrelated content surrounds the copied fix in
      `candidate_diff` -- memorize-the-fix-and-paste-plus-noise still
      scores `containment` near 1.0. Guarded against div-by-zero: a
      `fix_patch` with no extractable changed lines makes containment
      uncomputable, recorded as `"similarity-unavailable"` rather than
      silently skipped.

  (c) transcript URL/PR scan -- any `http(s)://` URL, `github.com/.../
      pull/<n>` reference, or contextual PR/issue `#<number>` reference
      (see `_PR_HASH_RE`) anywhere in `transcript` is a sign the agent
      fetched (or referenced) something off the web instead of solving
      the issue itself. `transcript` is the `transcriptPath` stream teed
      by the run-task `claude` wrapper (Task 6) -- a stream-json file of
      tool-use blocks. Styre's own NDJSON summary carries no tool-call
      transcript, so without that wrapper this scan has no data to run
      on. `transcript` must be the RAW teed text, not a path or parsed
      object.

Fail-safe posture (load-bearing): this is a backstop, so it must never
silently no-op. An unavailable or non-string transcript records
`"transcript-unavailable"` rather than skipping the scan without saying so
(and never raises) -- callers (the report's validity panel) must be able to
tell "clean" apart from "didn't run". A malformed similarity input
(non-string diff, or a missing/empty `fix_patch` -- the real fix should
never legitimately be empty) records `"similarity-unavailable"` rather than
silently returning `suspected: False` on data it couldn't actually
evaluate; the same reason is used when `fix_patch` is well-formed but has
no extractable changed lines (containment uncomputable). An empty
`candidate_diff` against a real `fix_patch` is a different case -- a
legitimate (if bad) input, not malformed -- and is scored normally (low
similarity/containment, no special-case reason).

Reason strings are CANONICAL and BARE (exact-matchable by Task 10's
`TaskRecord.leak_reasons` contract): `"high-similarity"`,
`"high-containment"`, `"pr-url-in-transcript"`, `"url-in-transcript"`,
`"transcript-unavailable"`, `"similarity-unavailable"`. Numeric detail
(the actual ratio/containment score) is NOT baked into the reason string --
it's returned in the separate `"similarity"` / `"containment"` result
fields instead.
"""

from __future__ import annotations

import json
import re
import sys
from difflib import SequenceMatcher
from typing import Any

DEFAULT_SIMILARITY_THRESHOLD = 0.9
DEFAULT_CONTAINMENT_THRESHOLD = 0.9

_HUNK_NOISE_PREFIXES = ("+++", "---", "@@")
_FILE_HEADER_PREFIXES = ("diff --git", "index ", "new file mode", "deleted file mode", "similarity index", "rename from", "rename to")

# Any bare URL.
_URL_RE = re.compile(r"https?://\S+")
# A GitHub PR link specifically, e.g. github.com/org/repo/pull/123.
_PR_URL_RE = re.compile(r"github\.com/[^\s/]+/[^\s/]+/pull/\d+", re.IGNORECASE)
# A PR/issue-number reference in context, e.g. "fixes #456", "PR #123", or
# the GitHub repo-shorthand "org/repo#456". A bare "#123456" (hex color) or
# "priority #1" (ranked list) must NOT match -- those aren't PR references.
_PR_HASH_RE = re.compile(
    r"\b(?:pull request|pr|issue|fixes|closes)\b\s*#\d+"
    r"|github\.com/\S+#\d+",
    re.IGNORECASE,
)


def _normalize_diff(diff_text: str) -> list[str]:
    """Strip diff-format noise from `diff_text`, returning sorted content lines.

    Drops file/hunk headers and blob-hash preamble (pure formatting, not
    content), strips the leading `+`/`-` change marker and surrounding
    whitespace from the remaining lines, drops blank lines, and sorts --
    so the comparison is over the actual changed content, insensitive to
    hunk ordering, context-line choice, and formatting differences between
    two diffs of the same underlying change.

    Includes BOTH context and changed lines -- this feeds the symmetric
    whole-diff similarity ratio. Contrast with `_changed_lines`, which
    isolates only the `+`/`-` content for the asymmetric containment check.
    """
    lines: list[str] = []
    for raw in diff_text.splitlines():
        stripped = raw.strip()
        if not stripped:
            continue
        if stripped.startswith(_HUNK_NOISE_PREFIXES):
            continue
        if stripped.startswith(_FILE_HEADER_PREFIXES):
            continue
        if stripped[0] in "+-":
            stripped = stripped[1:].strip()
        if stripped:
            lines.append(stripped)
    return sorted(lines)


def _changed_lines(diff_text: str) -> set[str]:
    """Extract only the changed-content lines (`+`/`-` hunk lines) from
    `diff_text`, normalized (marker + surrounding whitespace stripped) and
    deduplicated into a set. Context lines, file/hunk headers, and
    blob-hash preamble are excluded -- this isolates the substance of a
    change from both its diff formatting and its unchanged surroundings,
    which is what the asymmetric containment signal needs: a fix pasted
    verbatim into a much larger candidate diff should still register as
    "contains the fix", even though the candidate's TOTAL content (changed
    + context + noise) looks nothing like the fix's.
    """
    lines: set[str] = set()
    for raw in diff_text.splitlines():
        stripped = raw.strip()
        if not stripped:
            continue
        if stripped.startswith(_HUNK_NOISE_PREFIXES):
            continue
        if stripped.startswith(_FILE_HEADER_PREFIXES):
            continue
        if stripped[0] not in "+-":
            continue
        content = stripped[1:].strip()
        if content:
            lines.add(content)
    return lines


def _diff_similarity(candidate_diff: str, fix_patch: str) -> float:
    """Normalized similarity ratio in [0.0, 1.0] between two diffs."""
    a = _normalize_diff(candidate_diff)
    b = _normalize_diff(fix_patch)
    if not a and not b:
        return 1.0
    if not a or not b:
        return 0.0
    return SequenceMatcher(a=a, b=b, autojunk=False).ratio()


def _diff_containment(candidate_diff: str, fix_patch: str) -> float | None:
    """Fraction of `fix_patch`'s changed lines that reappear in
    `candidate_diff`'s changed lines. Returns None (uncomputable) if
    `fix_patch` has no extractable changed lines -- caller must guard the
    div-by-zero and record a reason rather than silently returning 0.0.
    """
    fix_changed = _changed_lines(fix_patch)
    if not fix_changed:
        return None
    candidate_changed = _changed_lines(candidate_diff)
    return len(fix_changed & candidate_changed) / len(fix_changed)


def _scan_transcript(transcript: str) -> list[str]:
    """Return URL/PR-reference reasons found in `transcript` (possibly empty).

    Unescapes JSON-style escaped forward slashes (`\\/` -> `/`) first, so a
    URL embedded in a JSON-serialized transcript blob (e.g. `https:\\/\\/
    github.com\\/o\\/r\\/pull\\/5`) is still detected.
    """
    text = transcript.replace("\\/", "/")
    if _PR_URL_RE.search(text) or _PR_HASH_RE.search(text):
        return ["pr-url-in-transcript"]
    if _URL_RE.search(text):
        return ["url-in-transcript"]
    return []


def detect_leak(
    candidate_diff: Any,
    fix_patch: Any,
    transcript: Any,
    *,
    similarity_threshold: float = DEFAULT_SIMILARITY_THRESHOLD,
    containment_threshold: float = DEFAULT_CONTAINMENT_THRESHOLD,
) -> dict[str, Any]:
    """Flag a styre run whose fix suspiciously resembles the withheld human fix.

    Returns `{"suspected": bool, "reasons": [...], ...}`, where the reasons
    are canonical bare strings (see module docstring) and any computed
    scores are reported separately as `"similarity"` / `"containment"`
    float fields (present only when computed). `suspected` is True iff at
    least one of the diff-similarity, diff-containment, or transcript-scan
    signals fired; `"transcript-unavailable"` and `"similarity-unavailable"`
    are recorded as reasons but do NOT by themselves set `suspected` --
    they report a signal that could not be evaluated, not a positive leak
    finding.
    """
    reasons: list[str] = []
    suspected = False
    result: dict[str, Any] = {}

    candidate_is_str = isinstance(candidate_diff, str)
    fix_patch_valid = isinstance(fix_patch, str) and bool(fix_patch.strip())

    if not candidate_is_str or not fix_patch_valid:
        reasons.append("similarity-unavailable")
    else:
        ratio = _diff_similarity(candidate_diff, fix_patch)
        result["similarity"] = ratio
        if ratio >= similarity_threshold:
            reasons.append("high-similarity")
            suspected = True

        containment = _diff_containment(candidate_diff, fix_patch)
        if containment is None:
            if "similarity-unavailable" not in reasons:
                reasons.append("similarity-unavailable")
        else:
            result["containment"] = containment
            if containment >= containment_threshold:
                reasons.append("high-containment")
                suspected = True

    if not isinstance(transcript, str) or not transcript:
        reasons.append("transcript-unavailable")
    else:
        url_reasons = _scan_transcript(transcript)
        if url_reasons:
            reasons.extend(url_reasons)
            suspected = True

    result["suspected"] = suspected
    result["reasons"] = reasons
    return result


def main(argv: list[str]) -> int:
    """JSON-stdio CLI entrypoint, invoked from TS via subprocess.

    Mirrors `scorer/score.py`'s transport contract: reads a single JSON
    object from stdin (`{"candidate_diff": ..., "fix_patch": ...,
    "transcript": ..., "similarity_threshold": <optional float>,
    "containment_threshold": <optional float>}`) and writes a single JSON
    object to stdout. On any exception, writes `{"error": "..."}` and exits
    non-zero -- a transport failure to the TS caller (re-dispatch/
    investigate), never a silent "suspected: false".
    """
    del argv  # no subcommands -- this module exposes exactly one operation
    try:
        payload = json.load(sys.stdin)
        kwargs: dict[str, Any] = {}
        if "similarity_threshold" in payload:
            kwargs["similarity_threshold"] = payload["similarity_threshold"]
        if "containment_threshold" in payload:
            kwargs["containment_threshold"] = payload["containment_threshold"]
        result = detect_leak(
            payload.get("candidate_diff"),
            payload.get("fix_patch"),
            payload.get("transcript"),
            **kwargs,
        )
    except Exception as exc:  # noqa: BLE001 - deliberately catch-all: transport boundary
        print(json.dumps({"error": f"{type(exc).__name__}: {exc}"}))
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
