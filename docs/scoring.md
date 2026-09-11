# Scoring a styre run against the oracle

## Why this is split across two machines

**Scoring does not need styre.** `scorer/score.py score` takes
`{"instance": {...}, "candidate_diff": "..."}` on stdin and returns a verdict, so the
expensive, credentialed half — running styre — stays local where it already works, and only
the oracle runs in CI. Two things make CI the better home for the oracle: `styre-bench` is
public, so Actions minutes are free and scoring needs no secrets, and the runners are x86-64,
so the SWE-bench images build and run natively instead of under emulation.

### Correction: this is not an architecture constraint

An earlier version of this document claimed the oracle *cannot* run on Apple Silicon because
`sweb.env.py.x86_64.*` images "do not exist for arm64", citing this error:

```
BuildImageError: Environment image sweb.env.py.x86_64.428468730904ff6b4232aa:latest
not found for astropy__astropy-12907
```

That explanation was wrong, and the evidence that disproved it is that **the identical error
then occurred on an x86-64 Linux runner**. The real cause was in this repo: the adapter called
`run_instance()` without ever calling `build_env_images()`, so the image it asked for had never
been built on any host. `make_test_spec` hardcodes `arch="x86_64"` with no host detection, so
architecture never entered into it.

Two further defects sat behind the same failure and are fixed alongside it:

- The harness writes progress to stdout, which polluted the JSON channel and made the
  `Summarise` step fail with a `JSONDecodeError` at character 0. `score.py` now redirects
  command stdout to stderr so the JSON transport carries exactly one object.
- `build_env_images` must be passed **explicit** image tags. swebench 4.1.0 calls
  `make_test_spec(x, namespace, instance_image_tag, env_image_tag)` positionally against the
  signature `(instance, namespace, base_image_tag, env_image_tag, instance_image_tag, arch)`,
  so the third positional lands in the `base_image_tag` slot; the `None` defaults then trip
  `assert base_image_tag is not None`. The harness's own `main()` avoids this only because it
  passes `"latest"`. `scorer/tests/test_env_image_tags.py` pins every call site to doing the
  same.

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

### What the seed-side firewall does and does not gate (ENG-411)

`assertNoHeldOut` exists to catch a **bench bug**: did we compose a line of `fix_patch` /
`test_patch` into a ticket *we* wrote? It runs over `buildIssueBody`'s `benchAuthored` half,
before `createIssue`, and stays fail-closed — including on an unparseable corpus patch.

It does **not** gate the corpus's own `problem_statement`. That text is a public GitHub issue
written before any fix existed, and real issues routinely contain the fix: in
`astropy__astropy-13398` the reporter says *"I have put together the makings of a pull
request"* and pastes the code that was merged. Gating on it blocked **154 of 500 (30.8%)** of
SWE-bench Verified, and refusing to run cannot un-write a 2022 issue — it only discards a
fifth of the corpus and makes the resolve rate incomparable with published numbers. (The
blocking was roughly difficulty-neutral, 26–33% across bands, so it was not a skew so much as
a straight loss of sample.)

Instead, `measureTicketOverlap` records how much the ticket gave away, on every record, and
`report/render.ts` prints the rate twice: the **headline** rate over everything (comparable
with published SWE-bench numbers) and, directly beneath it, the rate over **clean tickets
only**. Both functions share `heldOutLines`, so the gate and the measurement cannot drift on
what counts as a held-out line.

A record whose overlap is `null` was never measured, which is not the same claim as measured
zero; it is excluded from the clean subset's numerator **and** denominator.

After this change, across the full corpora:

| | blocked | clean tickets | overlap recorded |
|---|---|---|---|
| SWE-bench Verified (500) | 0 | 393 (78.6%) | 107 (21.4%) |
| Multi-SWE-bench (224) | 0 | 212 (94.6%) | 12 (5.4%) |

### `hints_text` is never read

`corpus.ts` deliberately does not read it. It is the issue's comment thread collected up to
the fix commit, so it routinely contains a maintainer pasting the accepted patch — and
SWE-bench itself never puts it in front of a model: all four prompt builders in
`swebench/inference/make_datasets/create_instance.py` use `problem_statement` alone, and
`swebench/harness/test_spec/test_spec.py` reads it only to mark it `# Unused`. Sending it made
us the outlier, contaminated instances in prose no sentinel could ever match, and accounted for
9.4 of the 30.8 points. The ticket's `## Refs` section went with it.

## Running it

1. **Run styre locally.** The run writes its candidate diff to
   `<evidence_dir>/candidate.diff`, where `evidence_dir` is the value on that instance's row in
   `report/out/report.json`. It is captured before the oracle and before cleanup, so a
   successful run no longer destroys the artifact the oracle needs.

   ```bash
   ONLY=astropy__astropy-12907 bun bin/run-pilot.ts
   DIFF="$(python3 -c "import json;print(json.load(open('report/out/report.json'))[0]['evidence_dir'])")/candidate.diff"
   ```

2. **Build the payload.**

   ```bash
   bun bin/emit-score-payload.ts astropy__astropy-12907 python "$DIFF" > scoring/payload.json
   ```

   An **empty** `candidate.diff` is a real finding, not a missing file: every attempt so far
   produced one, because the branch never reached the remote. Score it anyway — the oracle
   returns `resolved: false` for an empty patch, which is a true verdict about that run.

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
