# tako-pi

给 [Pi](https://github.com/earendil-works/pi) 用的插件包。

两件事：

1. **你用 Tako** → 装完就能选 Tako 模型、搜网页、看配额、中途压缩。
2. **你不用 Tako** → 只装中途压缩也行。任何 provider 到窗口 85% 会自己摘要，同一回合继续，不甩 overflow。

```bash
# 全套（Tako 用户）
pi install git:github.com/Barrierml/tako-pi
```

只要 compact、不用 Tako 的人：先同样装包，再在 `~/.pi/agent/settings.json` 里改成只加载这一条：

```json
{
  "packages": [
    {
      "source": "git:github.com/Barrierml/tako-pi",
      "extensions": ["extensions/tako-autocompact.ts"]
    }
  ]
}
```

然后 `/reload`。没有 `~/.tako/config.json` 也不会报错。

---

## 30 秒上手

已经装了 Pi：

```bash
npm i -g @earendil-works/pi-coding-agent
pi install git:github.com/Barrierml/tako-pi
pi
```

Tako 用户再确认本机有 key：

```bash
# ~/.tako/config.json
{ "apiKey": "sk-..." }
```

插件只读这个文件，从不写 key。

临时试一次、不写进 settings：

```bash
pi -e git:github.com/Barrierml/tako-pi
```

本地开发：

```bash
pi install ~/.pi/agent/local/tako-pi
```

---

## 装完长什么样

Footer：

```
📁 ~/proj │ 🌿 main │ 🤖 grok-4.6 │ ⚡73% 34k/128k │ 💰 5h 0% · 7d 100% │ 🐙 Tako
```

- `⚡` 上下文**剩余** %
- `💰` 配额**已用** %（有 5 小时窗口就显示 5h + 7d）

`/model` 之后不弹居中浮层，同一页两行 chip：

```
🪟 Context    128k    256k    500k
🧠 Effort     💤 Off  🌱 Low  ⚡ Medium  🔥 High
```

默认勾好当前值，Enter 一次两边一起生效。

回合堆到窗口 **85%**（grok-4.6 ≈ 425k）会自动 compact，然后继续当前任务。屏幕上先闪 `mid-turn auto-compact`，再转圈 `Context overflow detected, Auto-compacting...`，`⚡` 会掉下来。

---

## 不用 Tako 也能用的部分

| 功能 | 要不要 Tako key |
|---|---|
| 中途压缩 `/tcompact` | 不要。跟当前对话模型走 |
| 同页 Context + Effort | 不要 |
| `/installed` | 不要 |
| Tako 模型目录 | 要。没有 key 就跳过，不崩 |
| `web_search` | 要。没有 key 工具会报缺配置 |
| footer 配额 / 启动公告 | 要。没有 key 就只显示上下文 |

所以「我只用 Anthropic / OpenRouter，但想要 Codex 那种边跑边压」——只留 `tako-autocompact.ts` 即可。

---

## 中途压缩

Pi 插件写不进真正的 `compaction` 记录。能换上下文并且同一回合继续的，只有官方 overflow compact-and-retry。tako-pi 走这条路：

```
工具回合结束
        │
        ▼
占用 ≥ 窗口 × 85% ? ──否──▶ 下一轮照常请求
        │是
        ▼
包一层当前 provider 的 streamSimple
        │
        ▼
下一次 LLM 调用返回
context_length_exceeded: mid-turn auto-compact
        │
        ▼
官方 Pi 写入 type: "compaction"
messages = 摘要 + 最近 keepRecentTokens
        │
        ▼
agent.continue()   ← 同一回合接着干
```

- 摘要模型 = **当前对话模型**
- 触发比例默认 85%，`/tcompact 80` 可改（50–95）
- 没有 `auto-compact.json`，不写死 compactionModel
- 官方 `keepRecentTokens` 仍是 20k。历史切不出 20k 时官方会拒压，合成 overflow 就会变成可见 Error。测的时候用真实小窗口模型，把会话堆过 20k，不要用假 32k provider 验收

| 命令 | 作用 |
|---|---|
| `/tcompact` | 当前占用 %、触发线、是否 armed |
| `/tcompact on` / `off` | 开关 |
| `/tcompact now` | 立刻武装下一次请求 |
| `/tcompact 80` / `85%` | 改触发百分比 |

---

## 全套里还有什么

| 文件 | 作用 |
|---|---|
| `tako-provider.ts` | 注册 `tako`，目录来自 `GET /v1/models`。改写 Tako/Grok 超长报错 |
| `tako-search.ts` | `web_search` → Tako `POST /v1/search`（默认 `kab`） |
| `tako-footer.ts` | 状态栏 |
| `tako-capsules.ts` | `/installed` |
| `tako-welcome.ts` | 启动公告。`/welcome` |
| `tako-model-picker.ts` | `/model` 之后的同页选择器。`/tmodel` `/effort` |
| `tako-autocompact.ts` | 中途压缩 |
| `tako-tiny32k.ts` | 假 32k 测试 provider，日常别用 |
| `skills/tako-subagents` | 按任务选 Tako 模型委派内置壳，不预创建角色 |

`/model` 是 Pi 内置命令，插件替换不了。选择器挂在 `model_select` 后面。

---

## 子代理

不要预先创建一堆 named agent。装 `npm:pi-subagents` 后，父会话按任务选壳 + 选模型：

```text
用便宜模型先摸 auth
找个模型审这个 diff
这个问题先问 oracle，别开写
```

档位在 `skills/tako-subagents/SKILL.md`：scout 用 flash-lite，写代码用 grok / kimi-code，难决策用 grok / opus。只有现成壳对不上才 `subagent create`，用完不必留着。

---

## 推荐 settings

Tako 全套：

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
    "git:github.com/Barrierml/tako-pi"
  ]
}
```

只要压缩：

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  },
  "packages": [
    {
      "source": "git:github.com/Barrierml/tako-pi",
      "extensions": ["extensions/tako-autocompact.ts"]
    }
  ]
}
```

触发比例：`~/.pi/agent/tako-autocompact.json`

```json
{ "enabled": true, "triggerRatio": 0.85 }
```

---

## 不要踩的坑

- 不要再叠第二个 compact 插件。Pi 会跑每一个 compact handler。
- wrap `streamSimple` 时不要带 `models`，否则会把现场目录覆盖掉。
- 配额 API 的 id 是 `POST /apiStats/api/get-key-id` 的数字，不是 config 里的 UUID。
- 不要装 `pi-claude-code-tui`，它会清 footer、叠第二套 header。

安全提醒：Pi 包和本机权限相同。装别人的包之前先看源码。
