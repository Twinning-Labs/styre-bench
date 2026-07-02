"""Tests for `scorer/leak_detect.py` -- the contamination backstop.

Three signals, each independently sufficient to flag `suspected`:
  (a) diff similarity (symmetric): `candidate_diff` normalized-matches
      `fix_patch` (the withheld human-accepted fix) above
      `similarity_threshold`.
  (b) diff containment (asymmetric): `fix_patch`'s changed lines reappear
      in `candidate_diff`'s changed lines above `containment_threshold` --
      catches the exact fix pasted into a much larger candidate diff, which
      (a) alone would miss (low symmetric ratio).
  (c) transcript URL/PR scan: the agent's transcript references a URL or a
      PR (a sign it fetched the real fix off the web instead of solving it).

Also covers the fail-safe posture: an unavailable/non-string transcript
must record `transcript-unavailable` (never silently skip the scan without
saying so, and never raise), and malformed similarity/containment inputs
must record a reason rather than silently returning `suspected: False`.

Reason strings are canonical and bare (exact-matched, not `.startswith`) --
see the `TaskRecord.leak_reasons` contract in `orchestrator/types.ts`.
"""

from leak_detect import (
    DEFAULT_CONTAINMENT_THRESHOLD,
    DEFAULT_SIMILARITY_THRESHOLD,
    _diff_containment,
    _diff_similarity,
    detect_leak,
)

FIX_PATCH = """--- a/foo.py
+++ b/foo.py
@@ -1,3 +1,3 @@
 def add(a, b):
-    return a - b
+    return a + b
"""

# Same content as FIX_PATCH, but produced with different diff formatting:
# a `diff --git`/`index` preamble, trailing whitespace on the context line,
# and blob-hash noise -- none of which should affect the normalized compare.
NEAR_VERBATIM_DIFF = """diff --git a/foo.py b/foo.py
index 1111111..2222222 100644
--- a/foo.py
+++ b/foo.py
@@ -1,3 +1,3 @@
 def add(a, b):
-    return a - b
+    return a + b
"""

# Genuinely different fix: different file, different function, different
# approach (guard clause vs sign flip) -- should score low similarity.
INDEPENDENT_DIFF = """--- a/bar.py
+++ b/bar.py
@@ -10,6 +10,9 @@
 def multiply(a, b):
-    return a * b
+    if a == 0 or b == 0:
+        return 0
+    return a * b
"""

# The exact fix, embedded verbatim inside a much larger candidate diff that
# also makes several unrelated edits ("memorize-and-paste-plus-noise"). The
# symmetric similarity ratio scores this LOW (~0.2) because the unrelated
# noise dominates the whole-diff comparison -- containment is what catches it.
LARGE_CANDIDATE_WITH_EMBEDDED_FIX = """diff --git a/foo.py b/foo.py
index 1111111..2222222 100644
--- a/foo.py
+++ b/foo.py
@@ -1,3 +1,3 @@
 def add(a, b):
-    return a - b
+    return a + b
diff --git a/unrelated1.py b/unrelated1.py
--- a/unrelated1.py
+++ b/unrelated1.py
@@ -1,5 +1,8 @@
 def foo():
-    pass
+    x = 1
+    y = 2
+    z = 3
+    return x + y + z
diff --git a/unrelated2.py b/unrelated2.py
--- a/unrelated2.py
+++ b/unrelated2.py
@@ -1,4 +1,7 @@
 class Bar:
-    def method(self):
-        return None
+    def method(self):
+        result = compute_something()
+        log(result)
+        return result
"""

# A genuinely independent, larger diff that happens to share ONE of
# FIX_PATCH's two changed lines ("return a - b", as an unrelated deletion
# elsewhere) but replaces it with different content -- containment should
# be well below the 0.9 threshold (1 of 2 fix lines present), not flagged.
LARGE_INDEPENDENT_DIFF_SHARING_FEW_LINES = """diff --git a/baz.py b/baz.py
--- a/baz.py
+++ b/baz.py
@@ -1,10 +1,14 @@
 def add(a, b):
-    return a - b
+    if a is None or b is None:
+        raise ValueError("bad input")
+    return compute(a, b)
diff --git a/qux.py b/qux.py
--- a/qux.py
+++ b/qux.py
@@ -1,5 +1,9 @@
 def multiply(a, b):
-    return a * b
+    if a == 0 or b == 0:
+        return 0
+    return a * b
diff --git a/quux.py b/quux.py
--- a/quux.py
+++ b/quux.py
@@ -1,4 +1,7 @@
 def divide(a, b):
-    return a / b
+    if b == 0:
+        raise ZeroDivisionError()
+    return a / b
"""

# A fix_patch that is a well-formed, non-empty string but has no `+`/`-`
# changed lines at all (context-only) -- containment is uncomputable
# (div-by-zero guard), not a legitimate 0.0.
NO_CHANGED_LINES_FIX_PATCH = """--- a/foo.py
+++ b/foo.py
@@ -1,3 +1,3 @@
 def add(a, b):
     pass
"""

CLEAN_TRANSCRIPT = "Read foo.py, noticed the sign was flipped, fixed it, ran the tests."
PR_URL_TRANSCRIPT = "Checked https://github.com/org/repo/pull/123 for context, then wrote the fix."
PR_HASH_TRANSCRIPT = "This looks like the same bug fixed in issue #456, applying the same approach."
GENERIC_URL_TRANSCRIPT = "Consulted https://docs.python.org/3/library/functools.html for background."


# -- (a) diff similarity ------------------------------------------------------


def test_near_verbatim_diff_flags_high_similarity():
    result = detect_leak(NEAR_VERBATIM_DIFF, FIX_PATCH, CLEAN_TRANSCRIPT)
    assert result["suspected"] is True
    assert "high-similarity" in result["reasons"]
    assert result["similarity"] >= DEFAULT_SIMILARITY_THRESHOLD


def test_independent_diff_not_flagged():
    result = detect_leak(INDEPENDENT_DIFF, FIX_PATCH, CLEAN_TRANSCRIPT)
    assert result["suspected"] is False
    assert "high-similarity" not in result["reasons"]


def test_normalization_ignores_diff_formatting_and_whitespace():
    # Same underlying change, different hunk/header formatting -> still
    # scores as near-identical.
    ratio = _diff_similarity(NEAR_VERBATIM_DIFF, FIX_PATCH)
    assert ratio >= DEFAULT_SIMILARITY_THRESHOLD


def test_normalization_does_not_mask_genuinely_different_content():
    ratio = _diff_similarity(INDEPENDENT_DIFF, FIX_PATCH)
    assert ratio < DEFAULT_SIMILARITY_THRESHOLD


# -- (b) diff containment (asymmetric) -----------------------------------------


def test_embedded_fix_in_larger_candidate_flags_high_containment():
    # The silent-miss case: exact fix + unrelated noise. Symmetric
    # similarity is low, but containment (fix-lines-found-in-candidate)
    # is 1.0 -- this must be caught.
    result = detect_leak(LARGE_CANDIDATE_WITH_EMBEDDED_FIX, FIX_PATCH, CLEAN_TRANSCRIPT)
    assert result["suspected"] is True
    assert "high-containment" in result["reasons"]
    assert result["containment"] == 1.0
    # Confirm this really is the silent-miss scenario: similarity alone
    # would NOT have flagged it.
    assert result["similarity"] < DEFAULT_SIMILARITY_THRESHOLD
    assert "high-similarity" not in result["reasons"]


def test_independent_large_diff_sharing_few_lines_not_suspected():
    result = detect_leak(
        LARGE_INDEPENDENT_DIFF_SHARING_FEW_LINES, FIX_PATCH, CLEAN_TRANSCRIPT
    )
    assert result["suspected"] is False
    assert "high-containment" not in result["reasons"]
    assert "high-similarity" not in result["reasons"]
    assert result["containment"] < DEFAULT_CONTAINMENT_THRESHOLD


def test_containment_direct_computation():
    containment = _diff_containment(LARGE_CANDIDATE_WITH_EMBEDDED_FIX, FIX_PATCH)
    assert containment == 1.0


def test_fix_patch_with_no_changed_lines_records_similarity_unavailable():
    # Containment is div-by-zero-uncomputable when fix_patch has no `+`/`-`
    # lines -- must record a reason, not silently skip or crash.
    result = detect_leak(NEAR_VERBATIM_DIFF, NO_CHANGED_LINES_FIX_PATCH, CLEAN_TRANSCRIPT)
    assert "similarity-unavailable" in result["reasons"]
    assert "containment" not in result


# -- (c) transcript URL / PR scan ---------------------------------------------


def test_transcript_with_pr_url_flags_pr_reason():
    result = detect_leak(INDEPENDENT_DIFF, FIX_PATCH, PR_URL_TRANSCRIPT)
    assert result["suspected"] is True
    assert "pr-url-in-transcript" in result["reasons"]


def test_transcript_with_hash_pr_reference_flags_pr_reason():
    result = detect_leak(INDEPENDENT_DIFF, FIX_PATCH, PR_HASH_TRANSCRIPT)
    assert result["suspected"] is True
    assert "pr-url-in-transcript" in result["reasons"]


def test_transcript_with_generic_url_flags_url_reason_not_pr():
    result = detect_leak(INDEPENDENT_DIFF, FIX_PATCH, GENERIC_URL_TRANSCRIPT)
    assert result["suspected"] is True
    assert "url-in-transcript" in result["reasons"]
    assert "pr-url-in-transcript" not in result["reasons"]


def test_clean_transcript_has_no_url_reason():
    result = detect_leak(INDEPENDENT_DIFF, FIX_PATCH, CLEAN_TRANSCRIPT)
    assert "url-in-transcript" not in result["reasons"]
    assert "pr-url-in-transcript" not in result["reasons"]
    assert "transcript-unavailable" not in result["reasons"]


# -- transcript unavailable / type-safety ---------------------------------------


def test_empty_transcript_records_unavailable_and_still_scores_similarity():
    result = detect_leak(NEAR_VERBATIM_DIFF, FIX_PATCH, "")
    assert "transcript-unavailable" in result["reasons"]
    # diff-similarity is the always-available signal -- it still ran and
    # still flags, even though the transcript scan couldn't.
    assert result["suspected"] is True
    assert "high-similarity" in result["reasons"]


def test_none_transcript_records_unavailable():
    result = detect_leak(INDEPENDENT_DIFF, FIX_PATCH, None)
    assert "transcript-unavailable" in result["reasons"]
    assert result["suspected"] is False


def test_int_transcript_records_unavailable_and_does_not_raise():
    # A non-string truthy transcript (e.g. an int, or a parsed-json blob
    # passed by mistake) must never crash `_scan_transcript` -- it's a
    # type-safety bug, not a "no leak" verdict.
    result = detect_leak("a", "a", 123)
    assert isinstance(result, dict)
    assert "transcript-unavailable" in result["reasons"]


def test_list_transcript_records_unavailable_and_does_not_raise():
    result = detect_leak("a", "a", ["x"])
    assert isinstance(result, dict)
    assert "transcript-unavailable" in result["reasons"]


# -- fail-safe posture: malformed similarity inputs never silently no-op -----


def test_malformed_candidate_diff_records_reason_not_silent_false():
    result = detect_leak(None, FIX_PATCH, CLEAN_TRANSCRIPT)
    assert "similarity-unavailable" in result["reasons"]


def test_malformed_fix_patch_records_reason_not_silent_false():
    result = detect_leak(NEAR_VERBATIM_DIFF, None, CLEAN_TRANSCRIPT)
    assert "similarity-unavailable" in result["reasons"]


def test_empty_fix_patch_records_similarity_unavailable():
    # An empty fix_patch is malformed upstream data (the real fix should
    # never be empty) -- must not be silently treated as "trivially
    # identical" to an equally-empty candidate.
    result = detect_leak("", "", CLEAN_TRANSCRIPT)
    assert "similarity-unavailable" in result["reasons"]
    assert result["suspected"] is False


def test_empty_candidate_diff_scores_low_not_unavailable():
    # An empty candidate against a real fix_patch is a valid (if bad) input
    # -- similarity is computable (and low), not "unavailable".
    result = detect_leak("", FIX_PATCH, CLEAN_TRANSCRIPT)
    assert "similarity-unavailable" not in result["reasons"]
    assert result["suspected"] is False


# -- custom threshold ----------------------------------------------------------


def test_custom_similarity_threshold_is_honored():
    ratio = _diff_similarity(INDEPENDENT_DIFF, FIX_PATCH)
    result = detect_leak(
        INDEPENDENT_DIFF, FIX_PATCH, CLEAN_TRANSCRIPT, similarity_threshold=ratio
    )
    assert result["suspected"] is True
    assert "high-similarity" in result["reasons"]


def test_custom_containment_threshold_is_honored():
    containment = _diff_containment(LARGE_INDEPENDENT_DIFF_SHARING_FEW_LINES, FIX_PATCH)
    result = detect_leak(
        LARGE_INDEPENDENT_DIFF_SHARING_FEW_LINES,
        FIX_PATCH,
        CLEAN_TRANSCRIPT,
        containment_threshold=containment,
    )
    assert result["suspected"] is True
    assert "high-containment" in result["reasons"]


# -- URL-scan hardening ----------------------------------------------------------


def test_escaped_slash_pr_url_is_detected():
    # JSON-escaped transcript text (e.g. `\/` for `/`) must be unescaped
    # before scanning, or a real PR URL slips through undetected.
    transcript = 'Checked https:\\/\\/github.com\\/o\\/r\\/pull\\/5 for context.'
    result = detect_leak(INDEPENDENT_DIFF, FIX_PATCH, transcript)
    assert result["suspected"] is True
    assert "pr-url-in-transcript" in result["reasons"]


def test_hex_color_hash_not_flagged():
    result = detect_leak(INDEPENDENT_DIFF, FIX_PATCH, "Set the banner to #123456.")
    assert "pr-url-in-transcript" not in result["reasons"]
    assert result["suspected"] is False


def test_ranked_list_hash_not_flagged():
    result = detect_leak(INDEPENDENT_DIFF, FIX_PATCH, "This is priority #1 for the team.")
    assert "pr-url-in-transcript" not in result["reasons"]
    assert result["suspected"] is False


def test_fixes_hash_reference_flagged():
    result = detect_leak(INDEPENDENT_DIFF, FIX_PATCH, "Same root cause as fixes #123.")
    assert "pr-url-in-transcript" in result["reasons"]
    assert result["suspected"] is True


def test_real_pr_url_flagged():
    result = detect_leak(
        INDEPENDENT_DIFF, FIX_PATCH, "See https://github.com/org/repo/pull/42."
    )
    assert "pr-url-in-transcript" in result["reasons"]
    assert result["suspected"] is True
