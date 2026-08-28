#!/usr/bin/env node
/**
 * dsh-corrupt-session-repair — zero-install session health scanner + auto-repair
 * for DeepSeek Harness (@deepseek-ai/dsh) session logs.
 *
 * Written for the crash-recovery "seq pair" corruption family reported in
 * discussion #1497 (replayed committed events after an unclean exit). The
 * tool does ONE thing to files: drop the duplicate `session/end-seed` row of
 * a recovery pair. Nothing else is touched; a `.bak.zstd` is written first.
 *
 * Usage (Node 24+, no npm installs):
 *   node dsh-corrupt-session-repair.mjs                      # scan all sessions (read-only)
 *   node dsh-corrupt-session-repair.mjs --root <dir>         # scan another sessions dir
 *   node dsh-corrupt-session-repair.mjs --id <session-id>    # scan one session only
 *   node dsh-corrupt-session-repair.mjs fix                  # preview repairs (dry-run)
 *   node dsh-corrupt-session-repair.mjs fix --apply          # apply repairs (.bak.zstd first)
 *   node dsh-corrupt-session-repair.mjs fix --apply --id <session-id>  # one session
 *
 * Exit codes: 0 ok · 1 usage/io error · 2 repairs were possible (dry-run) or write failure
 */
import { readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs'
import { join, sep, basename } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync, zstdCompressSync, constants as zstdConstants } from 'node:zlib'

const ZSTD_MAGIC = 0xfd2fb528

function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) throw new Error(`truncated frame at ${offset}`)
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`no frame magic at ${offset}`)
    offset += 4
    if (offset === buffer.length) return frames
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) throw new Error(`reserved header bit at ${offset - 1}`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) throw new Error(`truncated frame header at ${offset}`)
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) throw new Error(`truncated block header at ${offset}`)
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error(`reserved block at ${offset - 3}`)
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) throw new Error(`truncated payload at ${offset}`)
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) throw new Error(`truncated checksum at ${offset}`)
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return frames
}

function decompress(path) {
  const raw = readFileSync(path)
  const frames = scanZstdFrames(raw)
  const parts = frames.map(({ start, end }) => zstdDecompressSync(raw.subarray(start, end)))
  return { text: Buffer.concat(parts).toString('utf8'), frames: frames.length, bytes: raw.length }
}

function parseRow(line) {
  if (!line.trim()) return null
  try { return JSON.parse(line) } catch { return null }
}

function seqOf(row) {
  if (!row) return null
  return row.seq ?? row.seq0 ?? null
}

/** Scan one decompressed session text. Returns report. */
function examine(text) {
  const lines = text.split('\n')
  const report = { rows: 0, header: null, pairs: [], minSeq: null, maxSeq: null, monotonic: true }
  let last = null // {seq,isEndSeed,line} of previous non-null row
  let lastSeq = null
  for (let i = 0; i < lines.length; i++) {
    const row = parseRow(lines[i])
    if (!row) continue
    report.rows += 1
    if (row.type === 'session' && !report.header) {
      report.header = { id: row.id, version: row.version, createdAt: row.createdAt }
      continue
    }
    const seq = seqOf(row)
    if (seq != null) {
      if (lastSeq == null || seq >= lastSeq) lastSeq = seq
      else report.monotonic = false
      if (report.minSeq == null || seq < report.minSeq) report.minSeq = seq
      if (report.maxSeq == null || seq > report.maxSeq) report.maxSeq = seq
    }
    const isEndSeed = row.type === 'session/end-seed'
    // crash-recovery signature: end-seed row immediately followed by a row with the same seq
    if (last && last.isEndSeed && seq != null && seq === last.seq && !isEndSeed) {
      report.pairs.push({ line: last.line, seq: seq, nextType: row.type })
    }
    if (isEndSeed) last = { seq, isEndSeed: true, line: i + 1 }
    else last = null
  }
  return report
}

function healthOf(r) {
  if (r.pairs.length > 0) return 'REPAIRABLE (end-seed pair)'
  if (!r.monotonic && r.minSeq != null) return 'SEQ ANOMALY (non-monotonic, not the pair pattern)'
  return 'OK'
}

/** Apply the one allowed repair: drop duplicate end-seed rows of pairs. Lines are 1-based. */
function repair(lines, pairs) {
  const drop = new Set(pairs.map((p) => p.line)) // examine() lines are 1-based indices of the end-seed row
  const out = []
  for (let i = 1; i <= lines.length; i++) {
    if (drop.has(i)) continue
    out.push(lines[i - 1])
  }
  return out.join('\n')
}

/**
 * Same physical shape as the official writer: the header line alone in frame 1,
 * the remaining records in frame 2+. The official reader asserts frame 1 is
 * exactly one header line (assertZstdHeaderFrame), so a single-frame rewrite
 * (header + all events compressed together) would be refused on open.
 */
function officialFormatFrames(text) {
  const nl = text.indexOf('\n')
  if (nl === -1) throw new Error('log text has no newline-terminated header line')
  const header = text.slice(0, nl + 1)
  const rest = text.slice(nl + 1)
  const opts = { params: { [zstdConstants.ZSTD_c_checksumFlag]: 1 } }
  return Buffer.concat([zstdCompressSync(header, opts), zstdCompressSync(rest, opts)])
}

function findDefaultRoot() {
  if (process.env.DSH_HOME) return join(process.env.DSH_HOME, 'sessions')
  return join(homedir(), '.dsh', 'sessions')
}

function collectSessions(root) {
  const out = []
  if (!root) return out
  let projects
  try { projects = readdirSync(root, { withFileTypes: true }) } catch { return out }
  for (const p of projects) {
    if (!p.isDirectory()) continue
    const pdir = join(root, p.name)
    let ids
    try { ids = readdirSync(pdir, { withFileTypes: true }) } catch { continue }
    for (const s of ids) {
      if (!s.isDirectory()) continue
      const log = join(pdir, s.name, 'session.jsonl.zstd')
      out.push({ id: s.name, log, project: p.name })
    }
  }
  return out
}

function main() {
  const argv = process.argv.slice(2)
  const mode = argv.includes('fix') ? 'fix' : 'scan'
  const apply = argv.includes('--apply')
  const idArg = argv.indexOf('--id')
  const id = idArg >= 0 ? argv[idArg + 1] : null
  const rootArg = argv.indexOf('--root')
  const root = rootArg >= 0 ? argv[rootArg + 1] : findDefaultRoot()

  console.log(`dsh-corrupt-session-repair · sessions root: ${root}`)
  if (id) console.log(`(filtered to one session)`)
  const all = collectSessions(root)
  if (all.length === 0) {
    console.log('no sessions found')
    process.exit(1)
  }

  let fixed = 0, repairable = 0, failed = 0
  for (const s of all) {
    if (id && !s.id.includes(id)) continue
    let r
    try {
      const { text, frames, bytes } = decompress(s.log)
      r = examine(text)
      r.text = text
      r.frames = frames
      r.bytes = bytes
    } catch (e) {
      failed += 1
      console.log(`- ${s.id}\n    ! READ ERROR: ${e.message} (physical corruption — not repaired by design)`)
      continue
    }
    const health = healthOf(r)
    const size = (r.bytes / 1024 / 1024).toFixed(1) + ' MB'
    console.log(`- ${s.id}  [{$health}]  ${r.rows} rows / ${r.frames} frames / ${size}`)
    for (const p of r.pairs) {
      console.log(`    repair: drop session/end-seed row at line ${p.line} (seq ${p.seq}) -> ${p.nextType}`)
    }
    if (r.pairs.length > 0) {
      repairable += 1
      if (!apply) continue
      // safety: refuse if the file was written in the last 10 s (dsh may be live)
      const age = Date.now() - statSync(s.log).mtimeMs
      if (age < 10_000) {
        failed += 1
        console.log('    ! SKIPPED: file modified <10s ago (dsh may be writing it); close dsh and re-run')
        continue
      }
      const lines = r.text.split('\n')
      const newText = repair(lines, r.pairs)
      writeFileSync(s.log + '.bak.zstd', readFileSync(s.log))
      // same checksummed frames as the official writer (CHECKSUM_OPTIONS)
      // official frame layout: header line alone in frame 1 (assertZstdHeaderFrame)
      writeFileSync(s.log, officialFormatFrames(newText))
      // round-trip verify
      const rt = decompress(s.log)
      const rr = examine(rt.text)
      if (rr.pairs.length === 0) {
        fixed += 1
        console.log(`    + REPAIRED + verified (${rt.frames} frames, ${rr.rows} rows); backup: ${basename(s.log)}.bak.zstd`)
      } else {
        failed += 1
        console.log('    ! REPAIR FAILED verification — restore the .bak.zstd')
      }
    }
  }

  if (id) {
    console.log(`summary: 1 session (${all.filter((s) => id && s.id.includes(id)).length} matched)`)
  } else {
    console.log(`summary: ${all.length} sessions scanned · ${repairable} repairable · ${fixed} repaired · ${failed} failed`)
  }
  if (repairable > 0 && !apply) console.log('hint: re-run with fix --apply to repair (backups are written first)')
}

try {
  main()
} catch (e) {
  console.error('error:', e.message)
  process.exit(1)
}
