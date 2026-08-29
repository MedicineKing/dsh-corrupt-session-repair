# Corpus & verify pipeline (from discussion #4945)

Deterministic, content-free corruption shapes in the OFFICIAL frame layout (header line alone in frame 1, checksummed frames). Referee = unpatched npm 0.1.1-rc.2 official read path (`Session.fromRestore`, `assertZstdHeaderFrame`, scanner contract) via `verify-frame-format.mjs`.

| shape | artifact | official rc.2 expectation |
|---|---|---|
| partial-tail-after-crash | synthetic-partial-tail-0001.jsonl.zstd | **ACCEPT, tail-trimmed to last committed boundary** — torn last record dropped per official torn-tail semantics (RESTORE OK, 5 events contiguous) |
| two-writer-interleave | synthetic-two-writers-0001.jsonl.zstd | **REJECT** — SEQ_FAIL at the overlapped region (a write-side fix must turn this row into ACCEPT) |
| recycled-tail | synthetic-recycled-tail-0001.jsonl.zstd | **REJECT** — SEQ_FAIL at the recycled seq (unpatched); with the read-side tolerance patch, the three stale closers are skipped and seq resumes contiguously → ACCEPT || frame-level-torn-after-crash | synthetic-torn-frame-0001.jsonl.zstd | rc.2: **REJECT** (truncated payload, structural) — alpha.1 (0.1.2): **ACCEPT**, flush-only decode salvages 5/5 complete records (deeper cuts salvage 0: the frame checksum is exactly the recovery boundary) |

Second-referee note (2026-08-29): the alpha.1 column above is measured against the 0.1.2-alpha.1 release tree (cd5ef81), not npm. The two published readers disagree only on this row; interleave and recycled rows were re-tested identically.
| recovery-pair (REPAIRABLE) | synthetic-recovery-pair-0001.jsonl.zstd | rc.2: **REJECT** (seq conflict at the replayed row) — the scanner reports `REPAIRABLE (end-seed pair)`; `fix --apply` drops the stale end-seed row and the reader accepts (production run: 931,455 events, zero seq gap) |

Generator: `node synth-corpus.mjs <outdir>` (deterministic, no entropy, no user content).
Referee: `node verify-frame-format.mjs <artifact>` (exit 0 = accept, 1 = reject).

Real-artifact policy (from #4945): user conversations are PII and never enter this repository — the public corpus ships synthetic shapes plus a metadata table (shape class / frames / rows / reader error / expected outcome) only.

Referee note: `verify-frame-format.mjs` ships in this repo. It is the only file that needs the published official package (`npm i @deepseek-ai/dsh-session@0.1.1-rc.2`); everything else stays zero-install.
