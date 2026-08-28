#!/usr/bin/env node
/**
 * synth-corpus.mjs — deterministic corruption-shape generator for the
 * verification-side corpus (see discussion #4945). Generates artifacts in the
 * official frame layout (header line alone in frame 1, checksummed frames),
 * so the referee judges content semantics rather than container quirks.
 *
 * Shapes (all synthetic content-free — system events only):
 *   - partial-tail-after-crash: the last record of the event frame is a truncated half-line (:666-668 crash window shape)
 *   - two-writer-interleave: two writer streams overlap seqs in the
 *     committed region (multi-process interleaving, #1452/#4178 class)
 *   - recycled-tail: resume rewrote the entire tail from a recycled seq without truncating the durable interrupt-closers (#1497 2026-08-28)
 *
 * Usage: node synth-corpus.mjs <outdir>
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { zstdCompressSync, constants as zstdConstants } from 'node:zlib'

const opts = { params: { [zstdConstants.ZSTD_c_checksumFlag]: 1 } }
const T = (ms) => ms

function header(id) {
  return JSON.stringify({
    type: 'session', version: 0, id, createdAt: T(1787833223472),
    cwd: 'E:\\twoc', agentPreset: 'chat'
  }) + '\n'
}

// Minimal system-event template (no user content): turn/step/system events.
function ev(type, seq, data) {
  return JSON.stringify({ type, seq, time: T(1787833223472 + seq), data }) + '\n'
}

function sysTurn(turn, startSeq, kind) {
  const rows = []
  rows.push(ev('turn/start', startSeq, { turn }))
  rows.push(ev('step/start', startSeq + 1, { turn, step: 1 }))
  rows.push(ev('agent/inbox/spliced', startSeq + 2, {
    target: 'splice', start: startSeq, removedCount: 0,
    inserted: [{ type: 'event', content: [{ type: 'text', text: 'system marker' }] }]
  }))
  rows.push(ev('step/end', startSeq + 3, { turn, step: 1, status: 'completed' }))
  rows.push(ev('turn/end', startSeq + 4, { turn, reason: kind ?? 'completed' }))
  return rows
}

function frame(text) {
  return zstdCompressSync(text, opts)
}

function officialFile(id, rowsText) {
  return Buffer.concat([
    frame(header(id)),
    frame(rowsText)
  ])
}

function main() {
  const outdir = process.argv[2] || 'corpus-out'
  mkdirSync(outdir, { recursive: true })

  // ---- Shape 1: partial-tail-after-crash -------------------------------
  // Writer crashed between writeFile and rollback: last record truncated.
  const id1 = 'synthetic-partial-tail-0001'
  const clean = sysTurn(1, 0).join('')
  const torn = officialFile(id1, clean + '{"type":"assistant/message","seq":6,"time":' + T(1787833223500) + ',"data":{"content":[{"type":"text","text":"half of a rec')
  const p1 = join(outdir, 'synthetic-partial-tail-0001.jsonl.zstd')
  writeFileSync(p1, torn)
  console.log('wrote', p1, torn.length, 'bytes')

  // ---- Shape 2: two-writer-interleave ----------------------------------
  // Writer A commits seqs 1..6; writer B (stale cursor) re-commits 4..9.
  const id2 = 'synthetic-two-writers-0001'
  const a1 = sysTurn(1, 0, 'completed')
  const a2 = sysTurn(2, 5, 'completed')
  const rows = a1.concat(a2).join('')
  // B attaches a second batch reusing seqs 5..10 (overlap with A's tail)
  const bRows = sysTurn(3, 4, 'completed').join('')
  const interleaved = officialFile(id2, rows + bRows)
  const p2 = join(outdir, 'synthetic-two-writers-0001.jsonl.zstd')
  writeFileSync(p2, interleaved)
  console.log('wrote', p2, interleaved.length, 'bytes')

  // ---- Shape 3: recycled-tail -------------------------------------------
  // Resume rewrote the entire tail from a recycled seq without truncating the
  // durable interrupt-closers (smallshieh's 2nd instance, #1497 2026-08-28):
  // clean prefix 0..9, stale closers 10/11/12 (step/end, turn/end interrupted,
  // session/end-seed), then a fully-formed tail starting again at seq 10
  // through EOF. Reader must refuse (REJECT) against the unpatched path; with
  // the read-side tolerance patch the three stale rows are skipped and seq 13
  // resumes contiguously (ACCEPT).
  const id3 = 'synthetic-recycled-tail-0001'
  const prefix = sysTurn(1, 0, 'completed').join('') + sysTurn(2, 5, 'completed').join('')
  const stale = [
    ev('step/end', 10, { turn: 3, step: 1, status: 'interrupted' }),
    ev('turn/end', 11, { turn: 3, reason: 'interrupted' }),
    ev('session/end-seed', 12, {})
  ].join('')
  const tail = sysTurn(3, 10, 'completed').join('') + sysTurn(4, 15, 'completed').join('')
  const recycled = officialFile(id3, prefix + stale + tail)
  const p3 = join(outdir, 'synthetic-recycled-tail-0001.jsonl.zstd')
  writeFileSync(p3, recycled)
  console.log('wrote', p3, recycled.length, 'bytes')
}
  // ---- Shape 4: frame-level-torn-after-crash -------------------------------
  // A crash mid-flush: the final frame omits its trailing bytes — here exactly
  // the 4-byte checksum (data intact). rc.2 (0.1.1) REJECTs this as a
  // structural error; alpha.1 (0.1.2) salvages all complete records via the
  // flush-only decode (decompressZstdPrefix): measured 5/5 on the release
  // tree. Cutting deeper than the checksum salvages 0 records — the frame
  // checksum is exactly the recovery boundary.
  const id4 = 'synthetic-torn-frame-0001'
  const tornBytes = officialFile(id4, clean + '{"type":"assistant/message","seq":5,"time":' + T(1787833223500) + ',"data":{"content":[{"type":"text","text":"half of a rec'])
  const cutBytes = tornBytes.subarray(0, tornBytes.length - 4)
  const p4 = join(outdir, 'synthetic-torn-frame-0001.jsonl.zstd')
  writeFileSync(p4, cutBytes)
  console.log('wrote', p4, cutBytes.length, 'bytes (checksum only)')


main()
