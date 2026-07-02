"""Contamination detector -- diff-vs-fix similarity + transcript URL scan.

BACKSTOP, not the primary control: the bench runs styre WEB-OFF (behavioral
guarantee, Task 4) and splits results by pre/post-cutoff (memorization
signal) as the primary defenses. This module exists because web-off is not
airtight -- pretrained-weight memorization of a merged fix is possible even
with tools disabled, and a web-on cohort exists deliberately. `detect_leak`
flags a run for human review; it never itself drops or rescoring a result.

Two independent signals, either one sufficient to set `suspected: True`:

  (a) diff similarity -- `candidate_diff` (styre's fix) compared against
      `fix_patch` (the withheld human-accepted fix, which never enters the
      ticket/repo/container -- see the firewall invariant in the plan's
      Global Constraints). Computed via `difflib.SequenceMatcher` on
      sorted, normalized diff-hunk lines: diff formatting noise (`+++`/
      `---`/`@@` headers, `diff --git`/`index` preamble, the leading `+`/
      `-` marker, surrounding whitespace) is stripped first, so two diffs
      that make the same underlying change via different hunk boundaries,
      context, or whitespace still compare as near-identical -- and two
      diffs that just happen to touch the same file/lines with genuinely
      different content still compare as dissimilar. This signal is
      ALWAYS available (it needs no transcript) and is computed even when
      the transcript scan below cannot run.

  (b) transcript URL/PR scan -- any `http(s)://` URL, `github.com/.../
      pull/<n>` reference, or `#<pr-number>` reference anywhere in
      `transcript` is a sign the agent fetched (or referenced) something
      off the web instead of solving the issue itself. `transcript` is
      the `transcriptPath` stream teed by the run-task `claude` wrapper
      (Task 6) -- a stream-json file of tool-use blocks. Styre's own
      NDJSON summary carries no tool-call transcript, so without that
      wrapper this scan has no data to run on.

Fail-safe posture (load-bearing): this is a backstop, so it must never
silently no-op. An unavailable transcript records `"transcript-unavailable"`
rather than skipping the scan without saying so -- callers (the report's
validity panel) must be able to tell "clean" apart from "didn't run". A
malformed similarity input (non-string diff, or a missing/empty `fix_patch`
-- the real fix should never legitimately be empty) records
`"similarity-unavailable"` rather than silently returning `suspected:
False` on data it couldn't actually evaluate. An empty `candidate_diff`
against a real `fix_patch` is a different case -- a legitimate (if bad)
input, not malformed -- and is scored normally (low similarity, no
special-case reason).
"""

from __future__ import annotations

import json
import re
import sys
from difflib import SequenceMatcher
from typing import Any

DEFAULT_SIMILARITY_THRESHOLD = 0.9

_HUNK_NOISE_PREFIXES = ("+++", "---", "@@")
_FILE_HEADER_PREFIXES = ("diff --git", "index ", "new file mode", "deleted file mode", "similarity index", "rename from", "rename to")

# Any bare URL.
_URL_RE = re.compile(r"https?://\S+")
# A GitHub PR link specifically, e.g. github.com/org/repo/pull/123.
_PR_URL_RE = re.compile(r"github\.com/[^\s/]+/[^\s/]+/pull/\d+", re.IGNORECASE)
# A bare PR/issue-number reference, e.g. "#456".
_PR_HASH_RE = re.compile(r"#\d+")


def _normalize_diff(diff_text: str) -> list[str]:
    """Strip diff-format noise from `diff_text`, returning sorted content lines.

    Drops file/hunk headers and blob-hash preamble (pure formatting, not
    content), strips the leading `+`/`-` change marker and surrounding
    whitespace from the remaining lines, drops blank lines, and sorts --
    so the comparison is over the actual changed content, insensitive to
    hunk ordering, context-line choice, and formatting differences between
    two diffs of the same underlying change.
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


def _diff_similarity(candidate_diff: str, fix_patch: str) -> float:
    """Normalized similarity ratio in [0.0, 1.0] between two diffs."""
    a = _normalize_diff(candidate_diff)
    b = _normalize_diff(fix_patch)
    if not a and not b:
        return 1.0
    if not a or not b:
        return 0.0
    return SequenceMatcher(a=a, b=b, autojunk=False).ratio()


def _scan_transcript(transcript: str) -> list[str]:
    """Return URL/PR-reference reasons found in `transcript` (possibly empty)."""
    if _PR_URL_RE.search(transcript) or _PR_HASH_RE.search(transcript):
        return ["pr-url-in-transcript"]
    if _URL_RE.search(transcript):
        return ["url-in-transcript"]
    return []


def detect_leak(
    candidate_diff: Any,
    fix_patch: Any,
    transcript: Any,
    *,
    similarity_threshold: float = DEFAULT_SIMILARITY_THRESHOLD,
) -> dict[str, Any]:
    """Flag a styre run whose fix suspiciously resembles the withheld human fix.

    Returns `{"suspected": bool, "reasons": [...]}`. `suspected` is True iff
    at least one of the diff-similarity or transcript-scan signals fired;
    `"transcript-unavailable"` and `"similarity-unavailable"` are recorded
    as reasons but do NOT by themselves set `suspected` -- they report a
    signal that could not be evaluated, not a positive leak finding.
    """
    reasons: list[str] = []
    suspected = False

    if not isinstance(candidate_diff, str) or not isinstance(fix_patch, str) or not fix_patch.strip():
        reasons.append("similarity-unavailable")
    else:
        ratio = _diff_similarity(candidate_diff, fix_patch)
        if ratio >= similarity_threshold:
            reasons.append(f"high-similarity:{ratio:.3f}")
            suspected = True

    if not transcript:
        reasons.append("transcript-unavailable")
    else:
        url_reasons = _scan_transcript(transcript)
        if url_reasons:
            reasons.extend(url_reasons)
            suspected = True

    return {"suspected": suspected, "reasons": reasons}


def main(argv: list[str]) -> int:
    """JSON-stdio CLI entrypoint, invoked from TS via subprocess.

    Mirrors `scorer/score.py`'s transport contract: reads a single JSON
    object from stdin (`{"candidate_diff": ..., "fix_patch": ...,
    "transcript": ..., "similarity_threshold": <optional float>}`) and
    writes a single JSON object to stdout. On any exception, writes
    `{"error": "..."}` and exits non-zero -- a transport failure to the TS
    caller (re-dispatch/investigate), never a silent "suspected: false".
    """
    del argv  # no subcommands -- this module exposes exactly one operation
    try:
        payload = json.load(sys.stdin)
        kwargs: dict[str, Any] = {}
        if "similarity_threshold" in payload:
            kwargs["similarity_threshold"] = payload["similarity_threshold"]
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
