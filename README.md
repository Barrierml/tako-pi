# tako-pi

[Pi](https://github.com/earendil-works/pi) 插件包。给 Tako 用户补齐目录、搜索、配额和中途压缩；不用 Tako 也可以只装压缩。

```bash
pi install git:github.com/Barrierml/tako-pi
```

仓库：https://github.com/Barrierml/tako-pi

---

## 能力一览

| # | 能力 | 命令 / 入口 | 要 Tako key？ | 文件 |
|---|---|---|---|---|
| 1 | Tako 模型目录 | `/model tako grok-4.6` | 要（没有就跳过，不崩） | `tako-provider.ts` |
| 2 | 网页搜索 | 工具 `web_search` | 要 | `tako-search.ts` |
| 3 | Footer 状态栏 | 自动 | 配额要；上下文不要 | `tako-footer.ts` |
| 4 | 启动公告 | `/welcome` | 要 | `tako-welcome.ts` |
| 5 | 同页 Context + Effort | `/model` 之后，或 `/tmodel` `/effort` | 不要 | `tako-model-picker.ts` |
| 6 | 中途压缩 | `/tcompact` | 不要，任意 provider | `tako-autocompact.ts` |
| 7 | 已装清单 | `/installed` | 不要 | `tako-capsules.ts` |
| 8 | 子代理选模型 | 自然语言委派 | 建议有，用来选 Tako 模型 | `skills/tako-subagents` |
| 9 | 32k 测试 provider | `/model tako-tiny32k grok-4.6` | 要 | `tako-tiny32k.ts` |

下面按这个顺序逐项说明。

---

## 安装

### 全套（Tako 用户）

```bash
npm i -g @earendil-works/pi-coding-agent
pi install git:github.com/Barrierml/tako-pi
```

本机准备 key（插件只读，不写回去）：

```json
// ~/.tako/config.json
{ "apiKey": "sk-..." }
```

推荐 `~/.pi/agent/settings.json`：

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

### 只要中途压缩（任意模型）

先同样 `pi install git:github.com/Barrierml/tako-pi`，再把 packages 改成只加载这一条：

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

没有 `~/.tako/config.json` 也不会报错。

### 其它装法

```bash
# 临时试一次，不写 settings
pi -e git:github.com/Barrierml/tako-pi

# 本地开发
pi install ~/.pi/agent/local/tako-pi
```

改完 `/reload`。

---

## 1. Tako 模型目录

注册 provider `tako`。模型列表来自网关 `GET /v1/models`，窗口以目录为准，不手写死。

```text
/model tako grok-4.6
/model tako grok-4.6 high
```

同时会把 Tako / Grok 的超长报错改写成 Pi 能认的 `context_length_exceeded`，这样官方 compact-and-retry 才能续跑。

没有 key、目录又拉不到时：**不注册 tako，其它能力照常加载**。

---

## 2. 网页搜索

给 agent 一个 `web_search` 工具，打到 Tako `POST /v1/search`。

- 默认 provider：`kab`（结果带 `url`）
- 可选：`groq` / `grok` / `grok_x`
- 密钥同样只读 `~/.tako/config.json`

没有 key 时工具会报缺配置，不会把整个插件打挂。

---

## 3. Footer 状态栏

```
📁 ~/proj │ 🌿 main │ 🤖 grok-4.6 │ ⚡73% 34k/128k │ 💰 5h 0% · 7d 100% │ 🐙 Tako
```

| 段 | 含义 |
|---|---|
| `⚡` | 上下文**剩余**百分比 |
| `💰` | 配额**已用**百分比。有 5 小时窗口就显示 `5h` + `7d`；没有 5h 才显示 daily |
| 颜色 | 已用 &lt;70% 绿，70–90% 黄，≥90% 红 |

配额 API 用的是 `POST /apiStats/api/get-key-id` 返回的**数字 id**，不是 config 里的 UUID。没有 key 时只显示路径 / 分支 / 模型 / 上下文。

---

## 4. 启动公告

会话开始时，编辑器上方拉一条当日公告。第一次 agent 回合后自动收起。

```text
/welcome
```

开关同一条公告。配额不在这里，只在 footer。生产环境公告接口若 404，这里静默跳过。

---

## 5. 同页 Context + Effort

官方 `/model` **替换不了**（Pi 写死了）。选完模型后，本插件在同一页换上两行 chip，不弹居中浮层：

```
🪟 Context    128k    256k    500k
🧠 Effort     💤 Off  🌱 Low  ⚡ Medium  🔥 High
```

- 当前值预勾
- Enter 一次两边一起生效
- Effort 只有 off / low / medium / high
- Context 选项 ≤ 该模型真实窗口，不以假窗口当真相

也可以直接开选择器：

```text
/tmodel
/effort
```

偏好写在 `~/.pi/agent/tako-model-prefs.json`（不含 key）。

---

## 6. 中途压缩

工具回合把窗口堆满时，自动摘要、换上下文、**同一回合继续**，不甩一个可见 overflow 就停。

默认触发：**窗口的 85%**（`grok-4.6` 500k ≈ 425k），不用等到官方 `window − 16k`（约 97%）。

```text
/tcompact          状态：占用 %、触发线、是否 armed
/tcompact on|off   开关
/tcompact now      立刻武装下一次 LLM 请求
/tcompact 80       改触发比例（50–95，也支持 85%）
```

比例存在 `~/.pi/agent/tako-autocompact.json`：

```json
{ "enabled": true, "triggerRatio": 0.85 }
```

怎么工作：

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

要点：

- 摘要模型 = **当前对话模型**，不写死 compactionModel，没有 `auto-compact.json`
- 用户在 tuner 里缩小的窗口（例如 128k）压完后仍保持，不会被目录满窗口盖掉
- 任意 provider 都能用，不依赖 Tako
- 官方 `keepRecentTokens` 仍是 20k。历史切不出 20k 时官方会拒压，合成 overflow 就会变成可见 Error
- **不要用假 32k provider 验收**；换真实小窗口模型，把会话堆过 20k 再测
- 不要再叠第二个 compact 插件，Pi 会跑每一个 compact handler
- wrap `streamSimple` 时不要带 `models`，否则会把现场目录覆盖掉

成功时先闪 `mid-turn auto-compact`，再转圈 `Context overflow detected, Auto-compacting...`，footer 的 `⚡` 会掉下来。

---

## 7. 已装清单

不常驻胶囊（占编辑器上方）。需要时：

```text
/installed
```

列出当前配置的 skill 和 package。

---

## 8. 子代理选模型

不要预先创建一堆 named agent。配合 `npm:pi-subagents` 的 6 个壳，父会话按任务选壳 + 选模型：

| 壳 | 干什么 |
|---|---|
| `scout` | 摸代码 |
| `researcher` | 查资料 |
| `worker` | 动手改 |
| `reviewer` | 审 diff |
| `oracle` | 拍板前第二意见，不改文件 |
| `delegate` | 轻量替身 |

档位（id 都是 `tako/<id>`）：

| 档 | 模型 | 适合 |
|---|---|---|
| 便宜快 | `gemini-3.5-flash-lite` `deepseek-v4-flash` `claude-haiku-4-5` | scout、机械查找 |
| 日常写代码 | `grok-4.6` `kimi-k2.7-code` `kimi-k3` | worker |
| 审代码 | `kimi-k2.7-code` `grok-4.6` `claude-sonnet-4-6` | reviewer |
| 难决策 | `grok-4.6` `claude-opus-4-7` `claude-sonnet-5` | oracle |
| 口味 / 文案 | `claude-fable-5` | 含糊需求、UX、计划 |

直接说人话即可：

```text
用便宜模型先摸 auth
找个模型审这个 diff
这个问题先问 oracle，别开写
```

只有现成壳对不上才 `subagent create`，用完不必留着。完整路由在 `skills/tako-subagents/SKILL.md`。

配套安装：

```bash
pi install npm:pi-subagents
```

---

## 9. 32k 测试 provider

`tako-tiny32k / grok-4.6`，窗口假成 32k，方便堆上下文。

```text
/model tako-tiny32k grok-4.6
/new
/effort off
```

**只用来看触发逻辑。** 官方 compact 要切出超过 20k 的历史，假窗口通常过不去。日常默认请留在 `tako / grok-4.6`。

---

## 命令速查

| 命令 | 作用 |
|---|---|
| `/model [tako] <id> [effort]` | 官方选模型；选完进入同页 tuner |
| `/tmodel` `/effort` | 直接打开 Context + Effort |
| `/tcompact` | 中途压缩状态 |
| `/tcompact on\|off\|now\|80` | 开关 / 立刻压 / 改百分比 |
| `/installed` | 已装 skill / package |
| `/welcome` | 启动公告开关 |

---

## 不要踩的坑

- `/model` 是 Pi 内置命令，插件替换不了。
- 不要叠第二个 compact 插件。
- wrap `streamSimple` 不要带 `models`。
- 配额 id 是数字，不是 UUID。
- 不要装 `pi-claude-code-tui`，它会清 footer、叠第二套 header。
- 顶栏 logo 如需 Claude 风可另装 `npm:pi-cc-header`，与本包 footer 不冲突。

Pi 包和本机权限相同。装别人的包之前先看源码。
