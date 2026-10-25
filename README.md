> **本仓库**：`song-xunxue/dsh-plugins` —— DSH（DeepSeek Harness）插件仓库，计划收录多个插件。
> 目前只有 `dsh-peer-agents`（位于仓库根，所以可以直接 `dsh plugin add github:song-xunxue/dsh-plugins` 装）；
> 以后新插件各自发布到 npm 时，就平铺到 `plugins/<name>/`，安装按包名走。
# dsh-peer-agents

把你的**其他 CLI 智能体**（Claude Code、Codex、Gemini、或者你自己写的任何命令）当成同事，让 DSH 里的 agent 直接跟它们说话。

> 给 DeepSeek Harness 用的 cordis 插件。装进 profile 后，agent 多出三个工具：`peer_list`、`peer_ask`、`peer_ask_all`。

## 它解决什么问题

一个 agent 再强也只是一个人。你机器上可能还跑着 Claude Code（接 GLM）、Codex、Gemini CLI —— 它们各自在自己的工作区里干活，彼此看不见。

这个插件给它们发工牌：每个同事 = **一条命令 + 一个工作目录**。于是大组长可以：

- 「`peer_ask(claude, "项目指南写到哪了？")`」→ 直接拿到它的回答
- 「`peer_ask_all("这个方案你怎么看？")`」→ 同时问所有人，横向对比
- 「`peer_ask(command: "codex", cwd: "...", prompt: "...")`」→ 临时叫一个没登记在册的

插件本身**不实现任何智能**：它只负责 spawn、喂 prompt、收 stdout。所以任何能非交互执行的 CLI 都能接进来。

## 安装

```bash
# 从 GitHub 装
dsh plugin --profile <profile> add github:song-xunxue/dsh-plugins

# 或者本地目录（开发用）
dsh plugin --profile <profile> add /path/to/dsh-peer-agents
```

Desktop 版请用它自带的命令运行时管理 desktop profile（npm 版 CLI 会拒绝管理该 profile）。

## 配置

在 profile 的 `cordis.patch.yml` 里给 `peer-agents` 这一行写 `peers`：

```yaml
- id: peer-agents
  name: dsh-peer-agents
  config:
    maxOutputChars: 12000
    peers:
      - id: claude
        label: Claude Code (GLM)
        command: claude
        cwd: 'D:\code\Git\Local\ChatBot'
        kind: claude
        promptVia: stdin
        timeoutMs: 300000
      - id: codex
        label: Codex
        command: codex
        cwd: 'D:\code\Git\Local\Project'
        kind: generic
        promptVia: arg
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `id` | — | `peer_ask` 里用的短名，必填 |
| `label` | = id | `peer_list` 里显示的名字 |
| `command` | `claude` | 要 spawn 的可执行文件（PATH 上的都行） |
| `cwd` | profile 目录 | 它干活的工作区；相对路径相对 profile |
| `args` | `[]` | 每次都带上的额外参数 |
| `kind` | `claude` | `claude` 会加 `-p`，并支持 `--continue`/`--model`；`generic` 只把 prompt 放最后 |
| `promptVia` | `stdin` | `stdin` 写进标准输入；`arg` 作为最后一个参数 |
| `timeoutMs` | `300000` | 单次调用超时 |

## 工具

### `peer_list`

列出所有同事、它们的命令、工作区是否存在。

### `peer_ask`

```jsonc
{
  "prompt": "项目指南写到哪了？给我一段摘要。",
  "peer": "claude",          // 可选，默认第一个
  "cwd": "D:\\code\\...",     // 可选，覆盖工作区
  "command": "codex",        // 可选，临时叫一个不在册的
  "continue": true,          // 可选，claude only：续上它最近那段对话（-c）
  "model": "glm-4.6",        // 可选，claude only
  "permissionMode": "plan",  // 可选，claude only
  "timeoutMs": 120000        // 可选
}
```

返回格式：

```
【Claude Code (GLM) @ D:\code\Git\Local\ChatBot】exit=0 · 18.4s
<它打印的内容>
```

### `peer_ask_all`

同一个问题群发，并行跑，按同事顺序拼接结果。

## 设计取舍

- **不解析 JSON 输出**：不同 CLI、不同版本的 `--output-format` 差别很大，文本最稳。要结构化就自己在 prompt 里要求。
- **不自动续话**：`-c` 续的是「该工作区最近的一段对话」，可能和你手上正在跑的交互式窗口撞车。默认每次新起一段，要续显式传 `continue: true`。
- **超时杀进程树**：Windows 上 `cmd` 包一层，`child.kill()` 杀不掉孙子进程，所以额外 `taskkill /T /F`。
- **输出有上限**：默认单流 12000 字符，防止一个同事把上下文灌满。超了标注截断。

## 安全

`peer_ask` 会在你配置的工作区里执行那个 CLI —— 它的权限就是你的权限。**只把信任的命令写进 `peers`**；`command` 参数是给 agent 临时点将用的，想收紧就别开放它（删掉该参数即可）。

## License

MIT
