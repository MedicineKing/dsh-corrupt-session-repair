# 重放首轮输出(留档)

- 来源:Claude Code 会话 0f657ea4-1fc2-4a39-a957-be517b6309ee,行 25590(tool result,2026-09-10T09:00:57Z = 17:00 +08)
- 脚本:replay-real.mjs(原样×2 max + high×1 + 瘦身×1)
- 说明:本文件共 4 条记录;其中「瘦身(系统+尾30条)」为非 1:1 对照(仅裁剪历史消息,且请求结构无效返回 400),**不计入**所述"两轮共 6 次调用"统计(该统计口径:1:1 原样重发,首轮 3 次 + 次轮 3 次)。
- 次轮输出见 replay-0910b.json

```
thinking 参数: {"type":"enabled"} | effort: max | msgs: 408
[
 {
  "label": "原样-1",
  "status": 200,
  "ms": 11451,
  "r": 1835,
  "c": 0,
  "finish": "stop",
  "pt": 220715
 },
 {
  "label": "原样-2",
  "status": 200,
  "ms": 9243,
  "r": 1298,
  "c": 0,
  "finish": "stop",
  "pt": 220715
 },
 {
  "label": "effort=high",
  "status": 200,
  "ms": 9145,
  "r": 1314,
  "c": 0,
  "finish": "stop",
  "pt": 220715
 },
 {
  "label": "瘦身(系统+尾30条)",
  "status": 400,
  "ms": 72,
  "r": 0,
  "c": 0,
  "finish": null,
  "pt": null
 }
]
```
