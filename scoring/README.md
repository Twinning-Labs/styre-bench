# scoring/

Payloads for the `score` workflow. Each is `{instance: {id, language}, candidate_diff}` and
**nothing else** — see `docs/scoring.md` for why corpus fields must never appear here.

A payload contains styre's own diff output, which is safe to commit. Build one with:

```bash
bun bin/emit-score-payload.ts <instance-id> <language> <diff-file> > scoring/payload.json
```
