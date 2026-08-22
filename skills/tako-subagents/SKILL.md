---
name: tako-subagents
description: >
  按任务选 Tako 模型并委派 pi-subagents，不要预先创建一堆角色。
  用户提到 subagent、子代理、scout、reviewer、oracle、分模型、谁适合干什么时使用。
---

# Tako 子代理怎么用

不要预先建一堆 named agent。`pi-subagents` 已有 6 个壳：

| 壳 | 干什么 |
|---|---|
| `scout` | 摸代码、找入口、交上下文 |
| `researcher` | 查资料（要有搜索工具） |
| `worker` | 动手改代码 |
| `reviewer` | 审 diff / 找回归 |
| `oracle` | 拍板前第二意见，不改文件 |
| `delegate` | 轻量替身，接近父会话 |

你的工作是：**看任务选壳 + 选模型**，用 `model` 覆盖这一次运行。父会话继续当编排。

```js
subagent({ agent: "scout", model: "tako/gemini-3.5-flash-lite", task: "..." })
subagent({ agent: "reviewer", model: "tako/kimi-k2.7-code", task: "..." })
subagent({ agent: "oracle", model: "tako/grok-4.6", task: "..." })
```

只有现成壳对不上（比如只要读图、只要写提交说明）才 `subagent({ action: "create", config: { ... } })`。一次性、范围写清、用完不必留着。

## 选模型（Tako 目录）

id 都是 `tako/<id>`。没把握就跟父会话走（现在默认 `tako/grok-4.6`）。

| 档 | 模型 | 适合 |
|---|---|---|
| 便宜快 | `gemini-3.5-flash-lite` `gemini-3.6-flash` `deepseek-v4-flash` `glm-4.7-flash` `claude-haiku-4-5` | scout、机械查找、长日志扫一眼 |
| 日常写代码 | `grok-4.6` `kimi-k2.7-code` `kimi-k3` `minimax-m2.7` | worker 常规改动 |
| 审代码 | `kimi-k2.7-code` `grok-4.6` `claude-sonnet-4-6` | reviewer |
| 难决策 / 第二意见 | `grok-4.6` `claude-opus-4-7` `claude-sonnet-5` `gemini-3.1-pro-preview` | oracle |
| 口味 / 产品 / 文案 | `claude-fable-5` | 含糊需求、UX、计划 |
| 超长上下文扫 | `gemini-3.5-flash` `deepseek-v4-flash` `gemini-3.1-pro-preview` | 百万窗口，先扫再精读 |

不要 6 个角色全开 `grok-4.6` high。scout / 机械活用便宜快的。

## 编排规矩

- 父会话只编排、拍板、最后改。
- 同一工作树同时只能有一个 `worker`。并行只开只读（scout / reviewer / oracle）。
- 先 scout 再 worker；改完用 **fresh** reviewer，不要 fork 审自己刚写的。
- 用户没点名模型时按上表选，并在回复里用一句话说选了谁、为什么。
- 不要为「可能以后用得到」去 `create` 永久 agent。

## 用户怎么说

直接自然语言即可，不必记 slash：

- 「用便宜模型先摸一下 auth」
- 「找个模型审这个 diff」
- 「这个问题先问 oracle，别开写」
- 「并行两个 reviewer：正确性 / 测试」
