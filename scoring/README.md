# Score payloads

- `payload.json` — the real artifact from the 2026-09-09 styre run of
  `astropy__astropy-12907`. Captured BEFORE the dirty-tree baseline fix, so it still carries the
  `pyproject.toml` hunk (`setuptools==68.0.0`) that the SWE-bench image had already applied.
  Scoring it now goes RED on the degraded-apply gate, which is correct: that patch cannot be
  applied cleanly, so no verdict from it would be trustworthy.

- `payload-control-no-env-hunk.json` — **a control, not a measurement.** Byte-identical to
  `payload.json` with the single `pyproject.toml` file section removed, which is exactly what the
  entrypoint's dirty-tree baseline now produces. It exists to answer one question: was
  `resolved: false` in run 34432706755 a false negative? It is NOT a capability measurement —
  an authoritative number requires a fresh styre run with the baseline fix in place.

## Result of the control (run 34435268164)

`resolved: true` — all 2 FAIL_TO_PASS and all 13 PASS_TO_PASS pass, and the apply log shows a
clean `git apply` with no fallback line.

Removing exactly one hunk, the environment pin styre never authored, flips the verdict from
false to true. Run 34432706755's `resolved: false` was therefore a false negative: styre solved
`astropy__astropy-12907` correctly, and the bench misreported it.

Scoring `payload.json` (unchanged) now goes red on the degraded-apply gate rather than returning
that false verdict — run 34434722395.
