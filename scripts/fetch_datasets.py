#!/usr/bin/env python3
"""
One-time dataset fetch → populates the local corpus cache that `loadInstances`
(orchestrator/corpus.ts) reads at `data/<family>.json`.

  Python (SWE-bench Verified) → data/swe-bench.json
  TypeScript (Multi-SWE-bench) → data/multi-swe-bench.json

Each output is a plain JSON array of the RAW upstream records; the TS/Python
normalizers in corpus.ts map them into `Instance` objects (do NOT pre-transform
here — the normalizers are what the rest of the rig is tested against).

Run from the repo root, using the scorer venv that already has `datasets`:

    .venv/bin/python scripts/fetch_datasets.py

Needs network access to Hugging Face. Both datasets are public (no HF token
required); if you hit a rate limit, `huggingface-cli login` first.
"""

from __future__ import annotations

import json
import pathlib
import sys

from datasets import load_dataset

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA_DIR = REPO_ROOT / "data"

# The exact upstream sources (confirmed against Hugging Face, 2026-07).
SWE_BENCH_VERIFIED = "princeton-nlp/SWE-bench_Verified"      # Python, human-validated
MULTI_SWE_BENCH = "ByteDance-Seed/Multi-SWE-bench"           # multilingual; we take TS only


def _dump(records: list[dict], out: pathlib.Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(records, indent=2), encoding="utf8")
    print(f"  wrote {len(records)} records -> {out.relative_to(REPO_ROOT)}")


def fetch_swe_bench_verified() -> None:
    print(f"[python] loading {SWE_BENCH_VERIFIED} (split=test) ...")
    ds = load_dataset(SWE_BENCH_VERIFIED, split="test")
    records = [dict(r) for r in ds]
    # `instance_id` MUST survive verbatim — the scorer (swebench.py) re-fetches by it.
    missing = [i for i, r in enumerate(records) if not r.get("instance_id")]
    if missing:
        sys.exit(f"FATAL: {len(missing)} SWE-bench records missing instance_id — refusing to write")
    _dump(records, DATA_DIR / "swe-bench.json")


def fetch_multi_swe_bench_ts() -> None:
    # MSB is stored as per-repo JSONL under a language directory: `ts/<owner>__<repo>_dataset.jsonl`.
    # Glob just the TypeScript files so we don't pull Go/Rust/Java/etc.
    print(f"[ts] loading {MULTI_SWE_BENCH} (data_files=ts/*.jsonl) ...")
    ds = load_dataset(MULTI_SWE_BENCH, data_files="ts/*.jsonl", split="train")
    records = [dict(r) for r in ds]
    if not records:
        sys.exit(
            "FATAL: 0 TypeScript records loaded from Multi-SWE-bench — the `ts/*.jsonl` glob "
            "returned nothing. Check the dataset layout at "
            "https://huggingface.co/datasets/ByteDance-Seed/Multi-SWE-bench (the language "
            "subdirectory may have been renamed)."
        )
    _dump(records, DATA_DIR / "multi-swe-bench.json")


def main() -> None:
    print("Fetching corpus cache into data/ ...")
    fetch_swe_bench_verified()
    fetch_multi_swe_bench_ts()
    print("Done. Next: `SMOKE=1 bun bin/run-pilot.ts` for the one-each plumbing run.")


if __name__ == "__main__":
    main()
