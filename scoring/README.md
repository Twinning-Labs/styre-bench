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
