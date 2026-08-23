---
name: tako-subagents
description: >
  用 task 委派一个子代理：写提示词、选档位、等它交回文字。
  用户提到 subagent、子代理、开个模型去干时使用。
---

# 子代理

只要一个工具：`task({ prompt, tier })`。

父模型只评任务强度，不要写具体模型 id。

| tier | 什么时候用 |
|---|---|
| `normal` | 默认。摸文件、归类、机械查找 |
| `self` | 难、要改关键代码、要稳。跟父会话同一个模型 |

不要写 `workflowScript`，不要开 scout / reviewer / oracle / worker，不要 `create` 角色，不要调 `spawn` / `subagent` / `subagent_wait`。

并行：调两次 `task`。串行：先看第一次结果，再调第二次。

```js
task({
  prompt: "只读摸 /Users/hashiro/Downloads 顶层，按类型归类，交中文报告。不要改文件。",
  tier: "normal",
  readonly: true
})
```

```js
task({
  prompt: "按现有风格改超时逻辑，最小 diff。",
  tier: "self"
})
```

进度在编辑器下面：`● task  normal · ro  <任务>  12s  bash`。

折叠行是档位 + 任务。Ctrl+O 展开同一行，看发给孩子的 system / user 和回来的报告。
