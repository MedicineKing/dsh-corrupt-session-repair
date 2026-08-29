#!/usr/bin/env node
/**
 * Verify a (repaired) session log against the FULL official read path shape:
 *
 *   1. physical: scanZstdFrames (same as official reader) + per-frame zstd
 *   2. frame-1 must be EXACTLY one header line (assertZstdHeaderFrame) —
 *      this is the check that the earlier single-frame rewrites failed
 *   3. remaining frames decode to JSONL records
 *   4. scanner contract: event.seq === running index (committed region)
 *   5. Session.fromRestore with the UNPATCHED official rc.2 build
 *
 * Exit 0 = the official reader would accept it; 1 = reject.
 */
import { readFileSync } from 'node:fs'
// Referee dependencies: npm i @deepseek-ai/dsh-session@0.1.1-rc.2 (the published official read path). Everything else is zero-install.
import { zstdDecompressSync } from 'node:zlib'
import { pathToFileURL } from 'node:url'

const official = await import(
  pathToFileURL(require.resolve('@deepseek-ai/dsh-session'))
)
const { decodeStorageRecord, Session } = official

const ZSTD_MAGIC = 0xfd2fb528
function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) throw new Error('truncated frame')
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
    if (buffer.length - offset < remainingHeaderBytes) throw new Error('truncated frame header')
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) throw new Error('truncated block header')
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error(`reserved block at ${offset - 3}`)
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) throw new Error('truncated payload')
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) throw new Error('truncated checksum')
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return frames
}

// assertZstdHeaderFrame (official): frame 1 plaintext = exactly one line.
function assertZstdHeaderFrame(plaintext) {
  if (plaintext.length === 0 || plaintext.indexOf(10) !== plaintext.length - 1) {
    throw new Error('first frame is not exactly one header line')
  }
}

const file = process.argv[2]
const raw = readFileSync(file)
const frames = scanZstdFrames(raw)
if (frames.length === 0) { console.error('FAIL: no frames'); process.exit(1) }

const decoders = []
for (const { start, end } of frames) {
  try { decoders.push(zstdDecompressSync(raw.subarray(start, end))) }
  catch (e) { console.error(`FAIL: frame decode error: ${e.message}`); process.exit(1) }
}
assertZstdHeaderFrame(decoders[0])
console.log(`frames=${frames.length} | frame1 = 1 header line  (assertZstdHeaderFrame PASS)`)

const text = Buffer.concat(decoders).toString('utf8')
const lines = text.split('\n').filter((l) => l.trim().length > 0)

let header = null
const events = []
let lineNo = 0
for (const rawLine of lines) {
  lineNo += 1
  let parsed
  try {
    parsed = JSON.parse(rawLine)
  } catch (e) {
    // official torn-tail semantics: a final record without a newline is
    // ignored (finish() drops it), so only the last line may be non-JSON.
    if (lineNo === lines.length && !text.endsWith('\n')) {
      console.warn(`torn tail record at line ${lineNo} ignored (official torn-tail semantics)`)
      continue
    }
    console.error(`INVALID_JSON at line ${lineNo}: ${e.message}`)
    process.exit(1)
  }
  if (parsed.type === 'session') {
    header = { version: parsed.version, id: parsed.id, createdAt: parsed.createdAt }
    continue
  }
  const decoded = decodeStorageRecord(parsed)
  for (const ev of decoded) {
    const expected = events.length
    if (ev.seq !== expected) {
      console.error(`SEQ_FAIL at line ${lineNo}: seq ${ev.seq} expected ${expected}`)
      process.exit(1)
    }
    events.push(ev)
  }
}
console.log(`scanner contract PASS: ${events.length} events contiguous from seq 0 (${lines.length} rows)`)
try {
  const session = Session.fromRestore(header.id, events, header)
  console.log(`RESTORE OK — official rc.2 accepted; log=${session.log.length}, liveSeq=${session.firstLiveSeq}`)
} catch (e) {
  console.error(`RESTORE REJECTED: ${e.message}`)
  process.exit(1)
}
