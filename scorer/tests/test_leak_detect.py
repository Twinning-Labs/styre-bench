"""Tests for `scorer/leak_detect.py` -- the contamination backstop.

Two signals, each independently sufficient to flag `suspected`:
  (a) diff similarity: `candidate_diff` normalized-matches `fix_patch`
      (the withheld human-accepted fix) above `similarity_threshold`.
  (b) transcript URL/PR scan: the agent's transcript references a URL or a
      PR (a sign it fetched the real fix off the web instead of solving it).

Also covers the fail-safe posture: an unavailable transcript must record
`transcript-unavailable` (never silently skip the scan without saying so),
and malformed similarity inputs must record a reason rather than silently
returning `suspected: False`.
"""

from leak_detect import DEFAULT_SIMILARITY_THRESHOLD, _diff_similarity, detect_leak

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

CLEAN_TRANSCRIPT = "Read foo.py, noticed the sign was flipped, fixed it, ran the tests."
PR_URL_TRANSCRIPT = "Checked https://github.com/org/repo/pull/123 for context, then wrote the fix."
PR_HASH_TRANSCRIPT = "This looks like the same bug fixed in #456, applying the same approach."
GENERIC_URL_TRANSCRIPT = "Consulted https://docs.python.org/3/library/functools.html for background."


# -- (a) diff similarity ------------------------------------------------------


def test_near_verbatim_diff_flags_high_similarity():
    result = detect_leak(NEAR_VERBATIM_DIFF, FIX_PATCH, CLEAN_TRANSCRIPT)
    assert result["suspected"] is True
    assert any(r.startswith("high-similarity") for r in result["reasons"])


def test_independent_diff_not_flagged():
    result = detect_leak(INDEPENDENT_DIFF, FIX_PATCH, CLEAN_TRANSCRIPT)
    assert result["suspected"] is False
    assert not any(r.startswith("high-similarity") for r in result["reasons"])


def test_normalization_ignores_diff_formatting_and_whitespace():
    # Same underlying change, different hunk/header formatting -> still
    # scores as near-identical.
    ratio = _diff_similarity(NEAR_VERBATIM_DIFF, FIX_PATCH)
    assert ratio >= DEFAULT_SIMILARITY_THRESHOLD


def test_normalization_does_not_mask_genuinely_different_content():
    ratio = _diff_similarity(INDEPENDENT_DIFF, FIX_PATCH)
    assert ratio < DEFAULT_SIMILARITY_THRESHOLD


# -- (b) transcript URL / PR scan ---------------------------------------------


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


# -- transcript unavailable ----------------------------------------------------


def test_empty_transcript_records_unavailable_and_still_scores_similarity():
    result = detect_leak(NEAR_VERBATIM_DIFF, FIX_PATCH, "")
    assert "transcript-unavailable" in result["reasons"]
    # diff-similarity is the always-available signal -- it still ran and
    # still flags, even though the transcript scan couldn't.
    assert result["suspected"] is True
    assert any(r.startswith("high-similarity") for r in result["reasons"])


def test_none_transcript_records_unavailable():
    result = detect_leak(INDEPENDENT_DIFF, FIX_PATCH, None)
    assert "transcript-unavailable" in result["reasons"]
    assert result["suspected"] is False


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
    assert any(r.startswith("high-similarity") for r in result["reasons"])
