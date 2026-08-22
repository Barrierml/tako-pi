# tako-pi

Tako 的官方 Pi 插件。装上之后，`pi` 直接走 Tako 的模型、搜索、配额和中途压缩，不必再配第三方 provider。

```bash
pi install git:github.com/Barrierml/tako-pi
```

前提：本机已有 `~/.tako/config.json`，里面有 `apiKey`。插件只读这个 key，永远不会写回去。

---

## 它解决什么

Pi 开箱是通用 harness。用 Tako 时缺四件事：

1. **模型从哪来** — Tako 的窗口、价格、id 要以网关目录为准，不能手写死。
2. **选完模型别弹层** — `/model` 之后要停在同一页，顺手把 Context / Effort 一起定完。
3. **状态一眼能看** — 还剩多少上下文、5 小时 / 7 天配额用了多少，放在 footer，不要第二套 UI。
4. **超长回合别停** — 工具循环把窗口堆满时，要像 Codex 那样自己摘要、换上下文、同一回合继续填，而不是甩一个 overflow Error。

tako-pi 就是这四件事。

---

## 装完你能看到什么

Footer：

```
📁 ~/proj │ 🌿 main │ 🤖 grok-4.6 │ ⚡73% 34k/128k │ 💰 5h 0% · 7d 100% │ 🐙 Tako
```

- `⚡` = 上下文**剩余**百分比
- `💰` = 配额**已用**百分比（有 5h 窗口就显示 5h + 7d；没有 5h 才显示 daily）

`/model` 之后不会再弹居中浮层。同一页两行 chip：

```
🪟 Context    128k    256k    500k
🧠 Effort     💤 Off  🌱 Low  ⚡ Medium  🔥 High
```

默认已经勾好当前值，Enter 一次同时生效。

回合中上下文到 **窗口的 85%**（grok-4.6 约 425k）会自动 compact，然后继续当前任务。成功时先闪一条 `mid-turn auto-compact`，再转圈 `Context overflow detected, Auto-compacting...`，footer 的 `⚡` 会掉下来。

---

## 扩展一览

| 文件 | 作用 |
|---|---|
| `tako-provider.ts` | 注册 `tako` provider，目录来自 `GET /v1/models`。把 Tako/Grok 的超长报错改写成 Pi 能认的 overflow。 |
| `tako-search.ts` | `web_search` → Tako `POST /v1/search`（默认 `kab`）。 |
| `tako-footer.ts` | 上面那条状态栏。 |
| `tako-capsules.ts` | `/installed` 列出 skill / package。不常驻胶囊。 |
| `tako-welcome.ts` | 启动公告。配额只在 footer。`/welcome` 开关。 |
| `tako-model-picker.ts` | 官方 `/model` 之后的同页 Context + Effort 选择器。`/tmodel`、`/effort` 也能打开。 |
| `tako-autocompact.ts` | 中途压缩。默认 85%。`/tcompact`。 |
| `tako-tiny32k.ts` | 假 32k 测试用 provider。日常不要用；测 compact 请换真实小窗口模型。 |

---

## 中途压缩怎么工作

Pi 插件**写不进**真正的 `compaction` session 记录。能换上下文并且同一回合继续的，只有官方 overflow compact-and-retry。所以 tako-pi 走这条官方路，不自己改 `agent.state`：

```
工具回合结束
    │
    ▼
占用 ≥ 窗口 × 85% ？ ──否──▶ 下一轮照常请求
    │是
    ▼
给当前 provider 包一层 streamSimple
    │
    ▼
下一次 LLM 调用返回合成的
context_length_exceeded: mid-turn auto-compact
    │
    ▼
官方 Pi 写 type: "compaction"
重建 messages = 摘要 + 最近 keepRecentTokens
    │
    ▼
agent.continue()  —— 同一回合接着干
```

摘要模型 = **当前对话模型**。如果正在用缩小窗口的测试 provider（`tako-tiny32k`），摘要仍走目录里的 `tako/<同一 id>` 真窗口。没有 `auto-compact.json`，也不写死 compactionModel。

`/tcompact 80` / `/tcompact 85%` 改触发比例（50–95）。`/tcompact now` 立刻武装下一次请求。

官方 `keepRecentTokens` 仍是 20k。会话里切得出来的历史不够 20k 时，官方会拒绝 compact，合成 overflow 就会变成可见 Error。所以不要用假小窗口硬测；换一个真实小窗口模型，把历史堆过 20k 再测。

---

## 命令

| 命令 | 作用 |
|---|---|
| `/tcompact` | 状态：当前占用 %、触发线、是否 armed、上次 compact |
| `/tcompact on` / `off` | 开关 |
| `/tcompact now` | 立刻武装下一次 LLM 请求 |
| `/tcompact 80` / `85%` | 设置触发百分比 |
| `/tmodel` / `/effort` | 同页 Context + Effort |
| `/installed` | 列出 skill / package |
| `/welcome` | 启动公告开关 |

`/model` 是 Pi 内置命令，插件替换不了。选择器挂在 `model_select` 之后。

---

## 推荐 settings

`~/.pi/agent/settings.json`：

```json
{
  "defaultProvider": "tako",
  "defaultModel": "grok-4.6",
  "defaultThinkingLevel": "high",
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  },
  "packages": [
    "git:github.com/Barrierml/tako-pi",
    "npm:pi-cc-header",
    "npm:pi-subagents"
  ]
}
```

触发比例在 `~/.pi/agent/tako-autocompact.json`：

```json
{
  "enabled": true,
  "triggerRatio": 0.85
}
```

模型偏好在 `~/.pi/agent/tako-model-prefs.json`（不含 key）。

---

## 不要踩的坑

- 不要再叠第二个 compact 插件。Pi 会跑**每一个** compact handler。
- wrap `streamSimple` 时不要带 `models`，否则会把现场 Tako 目录覆盖掉。
- 配额 API 的 id 是 `POST /apiStats/api/get-key-id` 返回的数字，不是 `~/.tako/config.json` 里的 UUID。
- 本地配套：`npm:pi-cc-header`（顶栏 logo）、`npm:pi-subagents`。不要装 `pi-claude-code-tui`，它会清 footer、叠第二套 header。

本地开发目录：`~/.pi/agent/local/tako-pi`。改完 `/reload` 即可。
