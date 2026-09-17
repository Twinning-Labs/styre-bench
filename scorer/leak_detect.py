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

  (c) assistant transcript indicators -- URL references and typed network-tool requests.
      Bare issue references are neutral observations. A request is not a tool result and
      neither a URL mention nor a shell-command pattern establishes successful retrieval.
      `exposure` stays unknown; `transcript_scan` reports parser coverage independently.
      Complete coverage means the retained text was parsed, not that the full run was captured.
      The input is the RAW teed stream-json text, not a path or parsed object.

Fail-safe posture (load-bearing): this is a backstop, so it must never
silently no-op. An unavailable or non-string transcript records
`"transcript-unavailable"` rather than skipping the scan without saying so
(and never raises) -- callers (the report's validity panel) must be able to
tell no observed indicators apart from an unavailable scan. A malformed similarity input
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

# Containment is |fix_changed ∩ candidate_changed| / |fix_changed|. When `fix_patch` has few
# changed lines there is essentially ONE way to write the correct fix, so ANY correct candidate
# scores 1.0 and the signal measures CORRECTNESS, not copying. Measured on SWE-bench Verified
# (n=500): median gold patch is 6 changed lines; 25.8% have <= 2 and 53.4% have <= 6. Left
# ungated, `high-containment` therefore fires on most SUCCESSFUL runs -- observed on
# astropy__astropy-12907, whose gold patch is 2 lines and which scored containment 1.0 with
# similarity only 0.133 and zero web-tool calls.
#
# Below this many gold changed lines the containment signal is reported as
# `containment-uninformative` instead of `high-containment`: the score is still returned, but it
# is never treated as a positive leak finding.
#
# UNCALIBRATED, deliberately: separating "reproduced the fix" from "solved it the same way"
# needs a labelled set of known-independent solutions, which does not exist yet. 10 is a
# judgement call -- above it, matching >=90% of gold's exact changed lines (naming, ordering and
# all) is unlikely from independent work. Treat it the way the report already treats
# gold-divergence: provisional until inter-rater agreement exists.
DEFAULT_MIN_FIX_CHANGED_LINES = 10

_HUNK_NOISE_PREFIXES = ("+++", "---", "@@")
_FILE_HEADER_PREFIXES = ("diff --git", "index ", "new file mode", "deleted file mode", "similarity index", "rename from", "rename to")

# Typed requests for network tools. A request does not establish execution or retrieval.
_WEB_TOOLS = frozenset({"WebFetch", "WebSearch"})
# A shell fetch inside a Bash tool_use input -- the other way an agent reaches the network.
_NET_CMD_RE = re.compile(r"\b(?:curl|wget)\b[^\n]*https?://", re.IGNORECASE)

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


# Text the TOOLING injects into agent-authored content. Same principle as the harness-supplied
# issue numbers: something styre or the agent CLI puts there is not evidence the agent went
# looking for it. Observed on darkreader__darkreader-7241 (ENG-406), where the run came back
# suspected purely because every `git commit -m` heredoc carried the Claude Code attribution
# trailer, which contains a URL:
#
#     🤖 Generated with [Claude Code](https://claude.com/claude-code)
#     Co-Authored-By: Claude <noreply@anthropic.com>
#
# Stripped before the URL scan, never before the web-tool scan — a real WebFetch is still a real
# WebFetch regardless of what else is in the text.
_TOOLING_BOILERPLATE = (
    re.compile(r"Generated with \[Claude Code\]\(https?://[^)\s]+\)", re.IGNORECASE),
    re.compile(r"Co-Authored-By:[^\n\\]*", re.IGNORECASE),
)


def strip_tooling_boilerplate(text: str) -> str:
    for pattern in _TOOLING_BOILERPLATE:
        text = pattern.sub("", text)
    return text


def _transcript_data(transcript: str) -> tuple[str | None, list[str], list[str], dict[str, Any]]:
    """Read the supported Claude stream schema; report holes instead of treating them as clean.

    Tool inputs establish requested actions, not successful retrieval or solution exposure.
    Recognized CLI version banners are framing, not missing transcript records.
    """
    texts: list[str] = []
    tools: list[str] = []
    network: list[str] = []
    assistant = malformed = unknown = recognized = 0
    for raw in transcript.splitlines():
        line = raw.strip()
        if not line or re.fullmatch(r"\d+\.\d+\.\d+(?:[-+][^ ]+)? \(Claude Code\)", line):
            continue
        try:
            entry = json.loads(line)
        except (ValueError, TypeError):
            malformed += 1
            continue
        if not isinstance(entry, dict):
            unknown += 1
            continue
        message = entry.get("message")
        if isinstance(message, dict) and message.get("role") == "assistant":
            assistant += 1
            recognized += 1
            content = message.get("content")
            if isinstance(content, str):
                texts.append(content)
                continue
            if not isinstance(content, list):
                unknown += 1
                continue
            for block in content:
                if not isinstance(block, dict):
                    unknown += 1
                    continue
                kind = block.get("type")
                if kind == "text" and isinstance(block.get("text"), str):
                    texts.append(block["text"])
                elif kind == "tool_use" and isinstance(block.get("name"), str) and isinstance(block.get("input"), dict):
                    name = block["name"]
                    tools.append(name)
                    tool_input = block["input"]
                    texts.append(json.dumps(tool_input, default=str))
                    if name in _WEB_TOOLS or (name == "Bash" and isinstance(tool_input, dict)
                            and isinstance(tool_input.get("command"), str)
                            and _NET_CMD_RE.search(tool_input["command"])):
                        network.append(name if name in _WEB_TOOLS else "shell-network-pattern")
                elif kind not in {"thinking", "redacted_thinking"}:
                    unknown += 1
        elif entry.get("type") in {"system", "user", "result", "rate_limit_event"} or (
            isinstance(message, dict) and message.get("role") in {"user", "system"}
        ):
            recognized += 1
        else:
            unknown += 1
    status = ("unavailable" if not transcript.strip() else "unstructured" if recognized == 0
              else "partial" if malformed or unknown or assistant == 0 else "complete")
    coverage = {"status": status, "assistant_messages": assistant,
                "unparsed_lines": malformed, "unknown_entries": unknown}
    return ("\n".join(texts) if recognized else None), tools, network, coverage


def _agent_authored(transcript: str) -> tuple[str | None, list[str]]:
    text, tools, _, _ = _transcript_data(transcript)
    return text, tools


def _scan_agent_transcript(
    transcript: str,
    own_numbers: frozenset[str] = frozenset(),
    harness_text: str = "",
) -> list[str]:
    """URL/PR + web-tool reasons drawn from AGENT-AUTHORED text only.

    `web-tool-used` requires a typed WebFetch/WebSearch request. Bash command patterns
    use the weaker `shell-network-pattern` label: quoted examples or comments may match.
    Neither is proof of execution or exposure. URL scans examine assistant-authored text.
    """
    agent_text, tool_names, network, coverage = _transcript_data(transcript)
    reasons: list[str] = []
    if agent_text is None:
        # Not stream-json (a plain-text transcript, or a format change). Fall back to scanning
        # the whole blob rather than reporting a clean bill of health on unparsed input, and
        # SAY SO -- a fallback scan re-admits the repo-content false positive above.
        reasons.append("transcript-unstructured-scan")
        agent_text = transcript
    if coverage["status"] == "partial":
        reasons.append("transcript-partial-scan")
    if any(name in _WEB_TOOLS for name in network):
        reasons.append("web-tool-used")
    if "shell-network-pattern" in network:
        reasons.append("shell-network-pattern")
    # Boilerplate is stripped for the URL/PR scan only; `web-tool-used` above already ran against
    # the unmodified text and tool list.
    reasons.extend(_scan_transcript(strip_tooling_boilerplate(agent_text), own_numbers, harness_text))
    return reasons


def _harness_supplied_numbers(
    instance_id: Any = None, problem_statement: Any = None
) -> frozenset[str]:
    """Issue/PR numbers the HARNESS itself put in front of the agent.

    Repeating an identifier you were handed is not evidence of going to look one up. Two sources,
    both observed producing false positives on real runs:

    * `instance_id` — `buildIssueTitle` used to put it in the seeded ticket title, so the agent
      was told it was working `astropy__astropy-12907` and wrote "issue #12907" while doing the
      job (astropy's changelog convention requires the number as a filename).

    * `problem_statement` — for Multi-SWE-bench the corpus `body` IS the upstream PR description,
      and darkreader__darkreader-7241's begins literally "Fixes #7238.". That text is seeded into
      the ticket, so the agent read #7238 there and repeated it. An earlier version of this
      module excused only `instance_id`, which did not cover it.

    Only issue-REFERENCE shapes are harvested from the problem statement (`#123`, `issues/123`,
    `pull/123`) — never every integer in it, which would excuse any number the agent mentioned.
    """
    numbers: set[str] = set()
    if isinstance(instance_id, str):
        numbers.update(re.findall(r"\d+", instance_id))
    if isinstance(problem_statement, str):
        numbers.update(re.findall(r"#(\d+)", problem_statement))
        numbers.update(re.findall(r"(?:issues|pull)/(\d+)", problem_statement, re.IGNORECASE))
    return frozenset(numbers)


def _hash_numbers(match: str) -> list[str]:
    return re.findall(r"#(\d+)", match)


def _scan_transcript(
    transcript: str,
    own_numbers: frozenset[str] = frozenset(),
    harness_text: str = "",
) -> list[str]:
    """Return URL/PR-reference reasons found in `transcript` (possibly empty).

    Unescapes JSON-style escaped forward slashes (`\\/` -> `/`) first, so a
    URL embedded in a JSON-serialized transcript blob (e.g. `https:\\/\\/
    github.com\\/o\\/r\\/pull\\/5`) is still detected.
    """
    text = transcript.replace("\\/", "/")
    supplied = harness_text.replace("\\/", "/") if harness_text else ""
    supplied_prs = {m.group(0) for m in _PR_URL_RE.finditer(supplied)}
    supplied_urls = {m.group(0) for m in _URL_RE.finditer(supplied)}
    reasons: list[str] = []
    for match in _PR_URL_RE.finditer(text):
        if match.group(0) not in supplied_prs:
            reasons.append("pr-url-in-transcript")
            break
    for match in _PR_HASH_RE.finditer(text):
        numbers = _hash_numbers(match.group(0))
        if numbers and all(n in own_numbers for n in numbers):
            continue
        reasons.append("reference-in-transcript")
        break
    # A neutral reference must not suppress a separate URL indicator. Exact supplied URLs
    # are exempt from both URL scans; their repetition says nothing about retrieval.
    if "pr-url-in-transcript" not in reasons and any(
        m.group(0) not in supplied_urls for m in _URL_RE.finditer(text)
    ):
        reasons.append("url-in-transcript")
    return reasons



def detect_leak(
    candidate_diff: Any,
    fix_patch: Any,
    transcript: Any,
    *,
    similarity_threshold: float = DEFAULT_SIMILARITY_THRESHOLD,
    containment_threshold: float = DEFAULT_CONTAINMENT_THRESHOLD,
    min_fix_changed_lines: int = DEFAULT_MIN_FIX_CHANGED_LINES,
    instance_id: Any = None,
    problem_statement: Any = None,
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
    result: dict[str, Any] = {
        "exposure": "unknown",
        "transcript_scan": _transcript_data(transcript if isinstance(transcript, str) else "")[3],
        "network_indicators": _transcript_data(transcript if isinstance(transcript, str) else "")[2],
    }

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

        fix_changed = _changed_lines(fix_patch)
        if not fix_changed:
            if "similarity-unavailable" not in reasons:
                reasons.append("similarity-unavailable")
        else:
            candidate_changed = _changed_lines(candidate_diff)
            containment = len(fix_changed & candidate_changed) / len(fix_changed)
            result["containment"] = containment
            # Reported so the validity panel can show WHY a containment score was or was not
            # treated as a finding, instead of the reader having to infer it.
            result["fix_changed_lines"] = len(fix_changed)
            if len(fix_changed) < min_fix_changed_lines:
                # Too few gold changed lines for containment to separate copying from simply
                # being correct. Report, never conclude.
                reasons.append("containment-uninformative")
            elif containment >= containment_threshold:
                reasons.append("high-containment")
                suspected = True

    if not isinstance(transcript, str) or not transcript:
        reasons.append("transcript-unavailable")
    else:
        url_reasons = _scan_agent_transcript(
            transcript,
            _harness_supplied_numbers(instance_id, problem_statement),
            problem_statement if isinstance(problem_statement, str) else "",
        )
        reasons.extend(url_reasons)
        # `transcript-unstructured-scan` reports that the scan degraded, not that a leak was
        # found -- it must never set `suspected` on its own.
        if any(r not in {"transcript-unstructured-scan", "transcript-partial-scan", "reference-in-transcript"} for r in url_reasons):
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
        if "min_fix_changed_lines" in payload:
            kwargs["min_fix_changed_lines"] = payload["min_fix_changed_lines"]
        if "instance_id" in payload:
            kwargs["instance_id"] = payload["instance_id"]
        if "problem_statement" in payload:
            kwargs["problem_statement"] = payload["problem_statement"]
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
