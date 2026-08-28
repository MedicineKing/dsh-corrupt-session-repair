# dsh-corrupt-session-repair

One-file, zero-install health scanner and auto-repair for `@deepseek-ai/dsh`
session logs that refuse to load after an unclean exit. Written for the
**crash-recovery "seq pair"** corruption family reported in
[discussion #1497](https://github.com/deepseek-ai/deepseek-harness/discussions/1497)
(see also #1586): after a crash, the first replayed event shares the seq of
the stale `session/end-seed` marker, and every reader then rejects the whole
log — your history looks lost even though nothing was deleted.

The repair has an art to it: keep the replayed event, drop only the stale
marker. The event stream becomes contiguous again, and every reader —
including stock, unpatched releases — accepts the session. Nothing is ever
invented.

## Usage (Node 24+, no npm installs)

```bash
node dsh-corrupt-session-repair.mjs                       # scan every session (read-only)
node dsh-corrupt-session-repair.mjs --root <sessions>     # scan another sessions dir
node dsh-corrupt-session-repair.mjs --id <session-id>     # one session only
node dsh-corrupt-session-repair.mjs fix                   # preview the repair (dry-run)
node dsh-corrupt-session-repair.mjs fix --apply           # repair (backup first, verified)
node dsh-corrupt-session-repair.mjs fix --apply --id <id> # repair one session
```

The sessions directory is auto-detected from `DSH_HOME` (or `~/.dsh/sessions`).

```
$ node dsh-corrupt-session-repair.mjs
- session-57e92a5b-84da-...  [REPAIRABLE (end-seed pair)]  23900 rows / 4989 frames / 6.7 MB
    repair: drop session/end-seed row at line 20503 (seq 886745) -> agent/inbox/spliced
- session-eb5f9201-38a2-...  [OK]  33325 rows / 17531 frames / 9.1 MB
summary: 19 sessions scanned · 1 repairable

$ node dsh-corrupt-session-repair.mjs fix --apply
    + REPAIRED + verified (23899 rows); backup: session.jsonl.zstd.bak.zstd
summary: 19 sessions scanned · 1 repairable · 1 repaired · 0 failed
```

## What it fixes — and only that

Exactly one operation on files: it **drops the duplicate `session/end-seed`
row of a crash-recovery pair** — a row immediately followed by another row
starting at the same seq. Nothing else is touched.

- **Preview before writing.** `fix` without `--apply` prints the exact
  line / seq / type of every planned change; it is a no-op by default.
- **Backup first.** `--apply` writes `<file>.bak.zstd` before modifying.
- **Official byte format.** Rewrites use the same checksummed Zstandard
  frames as the official writer (`ZSTD_c_checksumFlag: 1`), so the repaired
  file is indistinguishable from one dsh wrote itself.
- **Live-writer guard.** A file modified in the last 10 seconds is skipped
  (dsh may be writing it at that moment).
- **Self-verifying.** After a rewrite the tool decodes and rescans the file;
  a repaired session reports `OK` on the next scan.
- **Idempotent.** Re-running on an already-repaired file changes nothing.

Verified against the **unpatched published npm release** (0.1.1-rc.2): the
repaired 11k-round session decodes to **931,455 events with no seq gap** and
passes the official restore-level validation (`Session.fromRestore`, whose
constructor even re-appends its own `session/end-seed` marker when the seed
lacks one, so the removed marker is expected-and-accepted).

## Why keep the replayed event and drop the end-seed row

- The replayed row already carries seq X, so deleting the marker leaves the
  event stream contiguous from seq 0 — every reader accepts it again.
- Keeping the splice row preserves the inbox projection's full insert→remove
  chain, so the next `removedCount` does not blow up
  (`invalid persisted inbox splice …`).
- Removing only the marker is exactly what the read-side tolerance patch in
  the discussion does internally (`pop()` the duplicate end-seed, `push()`
  the replayed event) — so a file repaired by this tool and a reader fixed
  by that patch agree on the same story.

True anomalies are still refused by design. A real `seq > expected` jump or
physical corruption is never silently rewritten: the tool reports `SEQ
ANOMALY` / `READ ERROR` and leaves the file alone.

## Relation to the source-level patch

File repair is first aid for logs that are *already* broken. The read-side
tolerance patch discussed in #1497 makes future crashes invisible — readers
collapse the same pair automatically and this tool becomes unnecessary for
patched installs. Both are useful: patch the readers if you can, run this
tool if you already have an unreadable session on disk.


## Second referee: 0.1.2-alpha.1

The #4945 gate now has a second referee column (measured 2026-08-29 against the 0.1.2-alpha.1 release tree, cd5ef81 — the published npm line is still 0.1.1-rc.2). The only row where the two published readers disagree is the new frame-level-torn corpus row: rc.2 rejects it structurally; alpha.1 salvages the complete records via flush-only decode. Interleave and recycled-tail rows re-tested identical. Full write-up in discussion #4942.

## Requirements

- Node 24+ — `node:zlib` ships `zstdDecompressSync` / `zstdCompressSync`
  (the zstd APIs dsh itself needs). No npm packages, no dsh plugin
  installation, no dsh instance required to run.
- A path to the broken `session.jsonl.zstd` — or just let it scan your
  whole sessions root.

## License

MIT

---

## 中文说明（Chinese）

**这个工具修什么？** dsh（DeepSeek Harness）崩溃后恢复会话时，重放的第一个事件会和残留的 `session/end-seed` 标记共享同一个 seq（问题类型见 [discussion #1497](https://github.com/deepseek-ai/deepseek-harness/discussions/1497)，参见 #1586）。官方读端要求 seq 从 0 严格连续，于是整份日志被拒读——你的历史看起来"丢了"，实际上什么也没丢。

**修复动作很克制：** 只删除恢复配对中重复的 `session/end-seed` 行（签名 = 该行后紧跟一个同 seq 的行），保留重放事件（seq 不变），事件流恢复从 0 连续，任何未打补丁的官方版本都能重新打开该会话。其余的一概不动。

**特性：**

- **零安装**：单文件，无 npm 依赖，Node 24+ 直接跑（`node:zlib` 自带 zstd）
- **全库体检**：一条命令扫描所有会话，报告每个会话的健康状态、行数/帧数/大小，精确指出坏在**哪一行、什么 seq、什么类型**
- **预览后动手**：`fix` 默认只预览（dry-run），`fix --apply` 才写入，写前先存 `.bak.zstd`
- **与官方格式一致**：重写使用与官方写端相同的 checksummed zstd 帧（`ZSTD_c_checksumFlag: 1`），写出的文件与 dsh 自己写的无法区分
- **自动验证**：修完立即回读重扫；实测一个 11k 轮会话修复后解出 **931,455 个事件零 seq gap**，通过官方 rc.2 `Session.fromRestore` 校验
- **幂等**：已修复的文件再跑一遍不会改动任何东西
- **保守边界**：真跳号（`seq > expected`）和物理损坏只报告、拒绝动手，绝不做越界手术

**用法：**

```bash
node dsh-corrupt-session-repair.mjs                 # 全库体检（只读）
node dsh-corrupt-session-repair.mjs fix             # 预览修复内容
node dsh-corrupt-session-repair.mjs fix --apply     # 执行修复（先备份）
```

会话目录自动从 `DSH_HOME` 或 `~/.dsh/sessions` 定位，也支持 `--root <目录>` 和 `--id <会话ID>`。
