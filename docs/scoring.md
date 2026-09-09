# Scoring a styre run against the oracle

## Why this is split across two machines

The SWE-bench harness needs `sweb.env.py.x86_64.*` environment images. They do not exist for
arm64, so on an Apple Silicon host the oracle fails before it starts:

```
BuildImageError: Environment image sweb.env.py.x86_64.428468730904ff6b4232aa:latest
not found for astropy__astropy-12907
```

That is the only reason a second machine is involved. **Scoring does not need styre.**
`scorer/score.py score` takes `{"instance": {...}, "candidate_diff": "..."}` on stdin and
returns a verdict, so the expensive, credentialed half — running styre — stays local where it
already works, and only the oracle moves to x86-64 Linux.

`styre-bench` is public, so GitHub Actions minutes are free and **scoring needs no secrets**:
no agent key, no GitHub token beyond the default.

## The firewall

`orchestrator/types.ts:29-30` mark `fix_patch` (the accepted human fix) and `test_patch` (the
held-out regression tests) as FIREWALL fields, and `/data/` is gitignored so the corpus stays
out of this public repo.

**A payload must therefore carry only an instance id, a language and the candidate diff.**
That is sufficient: `SweBenchAdapter.score` reads only `instance["id"]`
(`scorer/adapters/swebench.py:222`) and re-fetches `version`, `environment_setup_commit`,
`test_patch` and the `FAIL_TO_PASS`/`PASS_TO_PASS` lists from Hugging Face via
`load_swebench_dataset` (`:150`). The runner needs no corpus.

Two guards enforce this: a unit test in `tests/emit-score-payload.test.ts`, and a step in the
workflow that refuses any payload containing a corpus field.

## Running it

1. **Run styre locally** and keep the diff it produced.

   ```bash
   ONLY=astropy__astropy-12907 bun bin/run-pilot.ts
   ```

2. **Build the payload.**

   ```bash
   bun bin/emit-score-payload.ts astropy__astropy-12907 python /path/to/candidate.diff \
     > scoring/payload.json
   ```

3. **Commit it and dispatch the workflow.**

   ```bash
   git add scoring/payload.json && git commit -m "chore(score): payload for astropy-12907"
   git push
   gh workflow run score.yml -f payload_path=scoring/payload.json
   gh run watch
   ```

4. **Read the job summary.** It reports `resolved = true|false`, or a transport failure.

## Reading the result

- **`resolved = true|false`** — a real oracle verdict. This is the number the bench exists to
  produce, and as of this writing none has ever been recorded.
- **Transport failure** — per `scorer/score.py`'s own contract, a harness or transport problem
  to investigate. It is explicitly **not** `resolved: false`. Treat it as naming the next
  blocker, not as a negative result.

## Known constraints

- **Disk.** SWE-bench images are large and the standard runner has roughly 14 GB free. The
  workflow's reclaim step frees ~25 GB more by removing preinstalled toolchains.
- **Network.** `load_swebench_dataset` reaches Hugging Face at score time; the adapter's own
  header documents this. A sandboxed runner without that access will fail in the Score step.
- **Not the qualification matrix.** Lifecycle fixtures — reboot, surviving child, PID reuse,
  cgroup delegation — cannot run here: you cannot reboot an ephemeral runner and observe boot
  identity. Those need a persistent host and are out of scope for this workflow.
