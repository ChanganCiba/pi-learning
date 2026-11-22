# Pi 框架源码学习指南

本指南提供了系统学习 Pi Agent Harness 框架源码的推荐路径。

> **2026-11 更新说明**：同步上游最新代码后仓库结构有大变动。
> - **已删除**：`protocol`、`server`、`client`、`session-backends` 包（旧的 CBOR 协议/WebSocket 服务端架构已被 Chord/Durable 取代）
> - **【新增】核心板块**：`schema`（JSON Schema 校验）、`mcp`（MCP 客户端）、`codemode`（沙箱 JS 执行）、`durable`（持久化会话运行时）、`env`（远程执行环境）、`chord`（跨进程对象运行时）、`evals`（评测框架），以及 `apps/` 下的 `p2`、`p2-mac`、`p3` 应用
> 下文带 **【新增】** 标记的章节是本次新引入的内容；`protocol.md` 笔记对应的包已不存在，仅作历史参考。

## 目录

- [架构概览](#架构概览)
- [学习路径](#学习路径)
- [关键文件速查](#关键文件速查)
- [调试技巧](#调试技巧)
- [核心概念](#核心概念)

## 架构概览

Pi 是一个模块化的 agent harness 框架，采用 monorepo 结构：

```
schema (JSON Schema 校验)   telemetry (遥测)
        ↓
ai (LLM 统一 API)
        ↓
agent (Agent 运行时)
        ↓
coding-agent (完整 CLI) ← tui (终端 UI) + mcp (MCP 客户端)
        ↓
durable (持久化会话运行时) ← codemode (沙箱执行) + env (远程执行环境)
        ↓
chord (跨进程对象运行时) → apps/p2、apps/p3 (自托管 UI / 个人服务器)
```

### 包职责

| 包 | 职责 |
|---|---|
| `schema` 【新增】 | 不用 eval 的 JSON Schema 校验（draft 2020-12 / 7，编译为普通闭包） |
| `ai` | 统一多个 LLM 提供商（OpenAI、Anthropic、Google、Bedrock 等 40+）的 API |
| `agent` | Agent 核心运行时：工具调用、状态管理、消息循环 |
| `tui` | 终端 UI 库，支持差分渲染和交互组件 |
| `coding-agent` | 完整的编码助手 CLI，内置文件操作、搜索等工具 |
| `telemetry` | 供应商中立的遥测抽象 |
| `mcp` 【新增】 | 独立的 Model Context Protocol 客户端（含 OAuth、结果裁剪） |
| `codemode` 【新增】 | 沙箱化 JavaScript 执行：脚本唯一的能力是调用注入的工具 |
| `durable` 【新增】 | 持久化会话 / 任务 / 文档运行时（harness、compaction、signals） |
| `env` 【新增】 | 远程执行环境：经 SSH 部署的小型 daemon + ExecutionEnv 客户端 |
| `chord` 【新增】 | 跨进程对象运行时：contracts、documents、store、插件热重载、HTTP/worker/web/终端客户端 |
| `evals` 【新增】 | 评测框架（docker、harness、plan、report） |
| `apps/p2`、`apps/p3` 【新增】 | 基于 Chord 的自托管 Pi UI（p2，实验性）与个人 Pi 服务器（p3，p2 的继任者） |

## 学习路径

推荐按以下顺序阅读，从底层协议到上层应用逐步深入。

### 第一层：基础设施 (1-2天)

#### 1. packages/schema 【新增】

> 旧的 `packages/protocol`（CBOR + 分帧）已删除；进程间通信职责移交给了 `chord` 的 link 层（见第五层）。基础设施层现在值得先读的是 `schema`。

不用 eval 的 JSON Schema 校验器，工具参数、配置、MCP 输入输出的校验都靠它。

- **[`src/types.ts`](file:///Users/mac/Agent/niannian/pi-learning/packages/schema/src/types.ts)** - Schema 类型定义
- **[`src/compiler.ts`](file:///Users/mac/Agent/niannian/pi-learning/packages/schema/src/compiler.ts)** - 把 schema 编译成普通闭包（无 eval，适配 CSP 严格环境）
- **[`src/coerce.ts`](file:///Users/mac/Agent/niannian/pi-learning/packages/schema/src/coerce.ts)** - 类型纠偏（模型给的字符串数字转回 number 等）
- **[`src/explain.ts`](file:///Users/mac/Agent/niannian/pi-learning/packages/schema/src/explain.ts)** - 可读的校验错误信息

**关键点**：
- 为什么不用 ajv：ajv 依赖 `new Function`（eval），在沙箱/Worker 等 CSP 环境会被禁
- 编译成闭包与解释执行的性能权衡
 
 
#### 2. packages/telemetry

轻量级遥测抽象层。

- **[`src/index.ts`](file:///Users/mac/Agent/niannian/pi-learning/packages/telemetry/src/index.ts)** - 接口定义
- **[`src/noop.ts`](file:///Users/mac/Agent/niannian/pi-learning/packages/telemetry/src/noop.ts)** - 空实现（作为参考）
- **[`src/memory.ts`](file:///Users/mac/Agent/niannian/pi-learning/packages/telemetry/src/memory.ts)** - 内存实现（用于测试）

**关键点**：
- 供应商中立的遥测接口设计
- 如何避免与具体遥测库耦合

### 第二层：AI 抽象与 Agent 核心 (3-4天)

#### 3. packages/ai ⭐ 重要

统一多个 LLM 提供商的 API，这是理解如何抽象不同 AI 服务的关键。

**阅读顺序**：

1. **[`src/types.ts`](file:///Users/mac/Agent/niannian/pi-learning/packages/ai/src/types.ts)** - 核心类型定义
   - `Provider` 接口
   - `Model` 和 `ModelInfo`
   - `Message`、`Content` 类型
   - Tool calling 相关类型

2. **[`src/model-catalog.ts`](file:///Users/mac/Agent/niannian/pi-learning/packages/ai/src/model-catalog.ts)** - 模型注册表
   - 如何注册和查询可用模型
   - 模型元数据管理

3. **[`src/providers/openai.ts`](file:///Users/mac/Agent/niannian/pi-learning/packages/ai/src/providers/openai.ts)** - OpenAI 实现（推荐首选）
   - Provider 接口的完整实现
   - 流式响应处理
   - 错误处理模式

4. **[`src/providers/anthropic.ts`](file:///Users/mac/Agent/niannian/pi-learning/packages/ai/src/providers/anthropic.ts)** - Anthropic 实现
   - 对比 OpenAI 实现，理解差异
   - Tool use 的不同处理方式

5. **[`src/api/`](file:///Users/mac/Agent/niannian/pi-learning/packages/ai/src/api)** - 真正的协议实现层
   - `anthropic-messages.ts`、`openai-completions.ts`、`openai-responses.ts` 等 10+ 种协议方言
   - `lazy.ts` - 按需加载协议实现（provider 只是配置，api 才是协议；详见 agent-and-ai.md）

6. **[`src/oauth.ts`](file:///Users/mac/Agent/niannian/pi-learning/packages/ai/src/oauth.ts)** - OAuth 认证流程
   - 设备码流程
   - Token 管理

**关键点**：
- Provider 抽象如何屏蔽底层差异
- Tool calling 在不同 LLM 中的实现差异
- 流式响应的统一处理
- 懒加载模式（按需加载提供商 SDK）

#### 4. packages/agent ⭐⭐ 最核心

Agent 运行时是整个框架的心脏。

**阅读顺序**：

1. **[`src/types.ts`](file:///Users/mac/Agent/niannian/pi-learning/packages/agent/src/types.ts)** - Agent 类型系统
   - `Tool` 和 `ToolResult`
   - `AgentState` 状态机
   - `Message` 和 `Turn` 概念
   - Harness 接口

2. **[`src/agent-loop.ts`](file:///Users/mac/Agent/niannian/pi-learning/packages/agent/src/agent-loop.ts)** - **核心循环** ⭐⭐⭐
   - Agent 的主循环逻辑
   - Tool calling 流程
   - 错误处理和重试
   - 上下文管理

3. **[`src/agent.ts`](file:///Users/mac/Agent/niannian/pi-learning/packages/agent/src/agent.ts)** - Agent 状态管理
   - 会话状态维护
   - 消息历史管理
   - 工具注册和调用

4. **[`src/proxy.ts`](file:///Users/mac/Agent/niannian/pi-learning/packages/agent/src/proxy.ts)** / **[`src/stream-fn.ts`](file:///Users/mac/Agent/niannian/pi-learning/packages/agent/src/stream-fn.ts)** - 流式调用的代理与封装

> 注：旧版的 `src/harness/`、`src/search/` 已不在此包；harness 相关逻辑移至 `packages/durable/src/harness/`，搜索工具在 `packages/coding-agent/src/core/tools/`（grep/find/ls）。

**关键点**：
- Agent 循环如何协调 LLM 和工具调用
- 状态机的设计和转换
- 工具调用的生命周期
- 上下文窗口管理策略

**深入理解 agent-loop.ts**：

这是最值得深入研究的文件。建议：
1. 先通读一遍，标记不理解的部分
2. 画出状态机转换图
3. 跟踪一个完整的 tool calling 请求流程
4. 理解错误处理和边界情况

### 第三层：终端 UI (2-3天)

#### 5. packages/tui

终端 UI 库，支持差分渲染和丰富交互。

**阅读顺序**：

1. **[`src/terminal.ts`](file:///Users/mac/Agent/niannian/pi-learning/packages/tui/src/terminal.ts)** - 终端抽象
   - ANSI 转义序列封装
   - 光标控制

2. **[`src/tui.ts`](file:///Users/mac/Agent/niannian/pi-learning/packages/tui/src/tui.ts)** - TUI 核心
   - 渲染循环
   - 差分渲染算法
   - 事件处理

3. **[`src/layout.ts`](file:///Users/mac/Agent/niannian/pi-learning/packages/tui/src/layout.ts)** 和 **[`src/layout-node.ts`](file:///Users/mac/Agent/niannian/pi-learning/packages/tui/src/layout-node.ts)** - 布局系统
   - Flexbox 风格的布局

4. **[`src/editor-component.ts`](file:///Users/mac/Agent/niannian/pi-learning/packages/tui/src/editor-component.ts)** - 编辑器组件
   - 多行文本编辑
   - 选择和剪贴板

5. **[`src/components/`](file:///Users/mac/Agent/niannian/pi-learning/packages/tui/src/components)** - 其他 UI 组件
   - 列表、输入框等

6. **[`src/keybindings.ts`](file:///Users/mac/Agent/niannian/pi-learning/packages/tui/src/keybindings.ts)** - 按键绑定
   - 可配置的快捷键系统

**关键点**：
- 差分渲染如何提升性能
- 终端限制下的 UI 实现
- 事件循环和输入处理

### 第四层：Coding Agent CLI (3-4天)

#### 6. packages/coding-agent ⭐ 应用层

完整的编码助手 CLI，集成所有底层能力。

**阅读顺序**：

1. **[`src/main.ts`](file:///Users/mac/Agent/niannian/pi-learning/packages/coding-agent/src/main.ts)** - 入口点
   - CLI 初始化流程
   - 参数解析
   - 模式选择

2. **[`src/config.ts`](file:///Users/mac/Agent/niannian/pi-learning/packages/coding-agent/src/config.ts)** - 配置管理
   - 配置文件加载
   - 环境变量处理

3. **[`src/modes/interactive/interactive-mode.ts`](file:///Users/mac/Agent/niannian/pi-learning/packages/coding-agent/src/modes/interactive/interactive-mode.ts)** - 交互式会话
   - REPL 循环
   - 用户输入处理

4. **[`src/core/tools/`](file:///Users/mac/Agent/niannian/pi-learning/packages/coding-agent/src/core/tools)** - 核心工具
   - [`read.ts`](file:///Users/mac/Agent/niannian/pi-learning/packages/coding-agent/src/core/tools/read.ts)、[`write.ts`](file:///Users/mac/Agent/niannian/pi-learning/packages/coding-agent/src/core/tools/write.ts)、[`edit.ts`](file:///Users/mac/Agent/niannian/pi-learning/packages/coding-agent/src/core/tools/edit.ts)、[`bash.ts`](file:///Users/mac/Agent/niannian/pi-learning/packages/coding-agent/src/core/tools/bash.ts) 工具实现
   - 工具权限和安全

5. **[`src/core/system-prompt.ts`](file:///Users/mac/Agent/niannian/pi-learning/packages/coding-agent/src/core/system-prompt.ts)** - Prompt 构建
   - 系统 prompt 组装
   - 上下文注入

6. **[`src/extensions/`](file:///Users/mac/Agent/niannian/pi-learning/packages/coding-agent/src/extensions)** - 扩展系统
   - 扩展发现和加载
   - 生命周期管理

7. **[`src/modes/`](file:///Users/mac/Agent/niannian/pi-learning/packages/coding-agent/src/modes)** - 不同工作模式
   - 交互模式
   - 单次命令模式
   - 其他模式

**关键点**：
- CLI 如何组合底层组件
- 工具实现的安全考虑
- 扩展机制的设计
- Prompt 工程实践

#### 7. 扩展示例 (按需)

- **[`examples/extensions/`](file:///Users/mac/Agent/niannian/pi-learning/packages/coding-agent/examples/extensions)** - 各种扩展示例
  - [`custom-provider-anthropic/`](file:///Users/mac/Agent/niannian/pi-learning/packages/coding-agent/examples/extensions/custom-provider-anthropic) - 自定义提供商
  - [`gondolin/`](file:///Users/mac/Agent/niannian/pi-learning/packages/coding-agent/examples/extensions/gondolin) - 沙箱扩展
  - [`subagent/`](file:///Users/mac/Agent/niannian/pi-learning/packages/coding-agent/examples/extensions/subagent) - 子 agent
  - [`with-deps/`](file:///Users/mac/Agent/niannian/pi-learning/packages/coding-agent/examples/extensions/with-deps) - 带依赖的扩展

### 第五层：持久化运行时与分布式架构 (3-5天) 【新增】

> 旧的 `packages/server` / `packages/client`（WebSocket 架构）已删除，由下面这套新体系取代。

#### 8. packages/mcp 【新增】

独立的 MCP（Model Context Protocol）客户端，让 pi 接入外部工具服务器。

- **[`src/client.ts`](file:///Users/mac/Agent/niannian/pi-learning/packages/mcp/src/client.ts)** - MCP 客户端主逻辑
- **[`src/oauth/`](file:///Users/mac/Agent/niannian/pi-learning/packages/mcp/src/oauth)** - MCP 服务器的 OAuth 授权
- **[`src/output-limit.ts`](file:///Users/mac/Agent/niannian/pi-learning/packages/mcp/src/output-limit.ts)** - 工具结果体积裁剪
- 对应文档：[`packages/coding-agent/docs/mcp.md`](file:///Users/mac/Agent/niannian/pi-learning/packages/coding-agent/docs/mcp.md)

#### 9. packages/codemode 【新增】

沙箱化 JavaScript 执行：模型写脚本编排工具调用，脚本唯一的能力是调用注入的工具（无文件系统、无网络）。

- **[`src/runtime/`](file:///Users/mac/Agent/niannian/pi-learning/packages/codemode/src/runtime)** - 沙箱运行时
- **[`src/declarations.ts`](file:///Users/mac/Agent/niannian/pi-learning/packages/codemode/src/declarations.ts)** - 为注入的工具生成 TS 类型声明
- 对应文档：[`packages/coding-agent/docs/codemode.md`](file:///Users/mac/Agent/niannian/pi-learning/packages/coding-agent/docs/codemode.md)

#### 10. packages/durable 【新增】

持久化会话 / 任务 / 文档运行时，是新架构里"会话"的家。

- **[`src/harness/`](file:///Users/mac/Agent/niannian/pi-learning/packages/durable/src/harness)** - agent harness（agent.ts、compaction.ts、context.ts、inbox.ts）
- **[`src/session/`](file:///Users/mac/Agent/niannian/pi-learning/packages/durable/src/session)** - 会话持久化
- **[`src/signals.ts`](file:///Users/mac/Agent/niannian/pi-learning/packages/durable/src/signals.ts)** - 信号机制

#### 11. packages/env 【新增】

远程执行环境：经 SSH 把一个小 daemon 部署到远端机器，本地通过 `ExecutionEnv` 客户端执行命令、读写文件、开终端。

- **[`src/remote-env.ts`](file:///Users/mac/Agent/niannian/pi-learning/packages/env/src/remote-env.ts)** / **[`src/ssh.ts`](file:///Users/mac/Agent/niannian/pi-learning/packages/env/src/ssh.ts)**

#### 12. packages/chord 【新增】

跨进程对象运行时：contracts、documents、store、links、插件热重载，带 HTTP、worker、web 和终端客户端。替代了旧的 protocol + server + client 三个包的职责。

- **[`src/link/`](file:///Users/mac/Agent/niannian/pi-learning/packages/chord/src/link)** - 进程间通信链路（有自己的 README）
- **[`src/contracts/`](file:///Users/mac/Agent/niannian/pi-learning/packages/chord/src/contracts)** - 类型化契约
- **[`src/documents/`](file:///Users/mac/Agent/niannian/pi-learning/packages/chord/src/documents)** - 文档模型

#### 13. apps/p2 与 apps/p3 【新增】

- **[`apps/p2/`](file:///Users/mac/Agent/niannian/pi-learning/apps/p2)** - 基于 Chord 插件的自托管 Pi Durable UI（实验性，将被替换）
- **[`apps/p3/`](file:///Users/mac/Agent/niannian/pi-learning/apps/p3)** - "每人一个 Pi"：本机服务器 + 每会话一个 worker，p2 的继任者（Chord v2）
- 两者的 README 是理解整套新架构如何组装的最佳入口

#### 14. packages/evals 【新增】

评测框架：在 docker 里跑 agent 任务并出报告。

- **[`src/harness.ts`](file:///Users/mac/Agent/niannian/pi-learning/packages/evals/src/harness.ts)** / **[`src/plan.ts`](file:///Users/mac/Agent/niannian/pi-learning/packages/evals/src/plan.ts)** / **[`src/report.ts`](file:///Users/mac/Agent/niannian/pi-learning/packages/evals/src/report.ts)**

## 关键文件速查

### 核心流程入口

| 文件 | 描述 |
|------|------|
| [`packages/coding-agent/src/main.ts`](file:///Users/mac/Agent/niannian/pi-learning/packages/coding-agent/src/main.ts) | CLI 启动入口 |
| [`packages/agent/src/agent-loop.ts`](file:///Users/mac/Agent/niannian/pi-learning/packages/agent/src/agent-loop.ts) | Agent 主循环 ⭐⭐⭐ |
| [`packages/tui/src/tui.ts`](file:///Users/mac/Agent/niannian/pi-learning/packages/tui/src/tui.ts) | TUI 渲染循环 |
| [`packages/coding-agent/src/core/tools/`](file:///Users/mac/Agent/niannian/pi-learning/packages/coding-agent/src/core/tools) | 工具实现 |

### 类型定义（先读）

| 文件 | 描述 |
|------|------|
| [`packages/schema/src/types.ts`](file:///Users/mac/Agent/niannian/pi-learning/packages/schema/src/types.ts) | JSON Schema 类型 【新增】 |
| [`packages/ai/src/types.ts`](file:///Users/mac/Agent/niannian/pi-learning/packages/ai/src/types.ts) | AI API 类型 |
| [`packages/agent/src/types.ts`](file:///Users/mac/Agent/niannian/pi-learning/packages/agent/src/types.ts) | Agent 类型系统 ⭐ |
| [`packages/mcp/src/index.ts`](file:///Users/mac/Agent/niannian/pi-learning/packages/mcp/src/index.ts) | MCP 客户端入口 【新增】 |
| [`packages/chord/src/index.ts`](file:///Users/mac/Agent/niannian/pi-learning/packages/chord/src/index.ts) | Chord 运行时入口 【新增】 |

### 扩展机制

| 文件 | 描述 |
|------|------|
| [`packages/coding-agent/src/extensions/`](file:///Users/mac/Agent/niannian/pi-learning/packages/coding-agent/src/extensions) | 扩展加载器 |
| [`packages/coding-agent/examples/extensions/`](file:///Users/mac/Agent/niannian/pi-learning/packages/coding-agent/examples/extensions) | 扩展示例 |
| [`packages/coding-agent/docs/extensions.md`](file:///Users/mac/Agent/niannian/pi-learning/packages/coding-agent/docs/extensions.md) | 扩展文档 |

## 调试技巧

### 运行开发版本

```bash
# 从源码运行 pi
./pi-test.sh

# 或从任意目录
/path/to/pi-learning/pi-test.sh
```

### 查看包的测试

```bash
# Agent 测试
cd packages/agent
node --test test/*.test.ts

# AI 测试
cd packages/ai
npm test

# Coding agent 测试套件（使用 faux provider）
cd packages/coding-agent
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/suite/
```

### 使用 Node 调试器

```bash
# 调试 agent 循环
node --inspect-brk packages/agent/test/agent-loop.test.ts

# 调试 coding agent
node --inspect-brk packages/coding-agent/src/main.ts
```

### 添加日志

在关键位置添加 `console.error()` 查看执行流程（stdout 可能被 TUI 占用）。

## 核心概念

### Provider（提供商）

抽象不同 LLM 服务的接口。

```typescript
interface Provider {
  name: string;
  listModels(): Promise<ModelInfo[]>;
  createChatCompletion(request: ChatRequest): Promise<Response>;
  // ...
}
```

**关键实现**：
- [`packages/ai/src/providers/openai.ts`](file:///Users/mac/Agent/niannian/pi-learning/packages/ai/src/providers/openai.ts)
- [`packages/ai/src/providers/anthropic.ts`](file:///Users/mac/Agent/niannian/pi-learning/packages/ai/src/providers/anthropic.ts)

### Tool（工具）

Agent 可以调用的函数。

```typescript
interface Tool {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  handler: (args: unknown) => Promise<ToolResult>;
}
```

**关键实现**：
- [`packages/coding-agent/src/core/tools/`](file:///Users/mac/Agent/niannian/pi-learning/packages/coding-agent/src/core/tools)

### Agent Loop（Agent 循环）

协调 LLM 和工具调用的核心循环。

**流程**：
1. 收集用户输入和上下文
2. 调用 LLM 生成响应
3. 解析工具调用请求
4. 执行工具并收集结果
5. 将结果反馈给 LLM
6. 重复直到 LLM 返回最终响应

**关键实现**：
- [`packages/agent/src/agent-loop.ts`](file:///Users/mac/Agent/niannian/pi-learning/packages/agent/src/agent-loop.ts) ⭐⭐⭐

### Extension（扩展）

扩展 coding-agent 功能的机制。

**类型**：
- 自定义工具
- 自定义提供商
- 自定义主题
- 自定义技能

**关键实现**：
- [`packages/coding-agent/src/extensions/`](file:///Users/mac/Agent/niannian/pi-learning/packages/coding-agent/src/extensions)

### Session（会话）

持久化 agent 的对话历史和状态。

**关键实现**：
- [`packages/coding-agent/src/core/session-manager.ts`](file:///Users/mac/Agent/niannian/pi-learning/packages/coding-agent/src/core/session-manager.ts) - CLI 的会话管理
- [`packages/durable/src/session/`](file:///Users/mac/Agent/niannian/pi-learning/packages/durable/src/session) - 持久化运行时的会话 【新增】
- 格式文档：[`packages/coding-agent/docs/session-format.md`](file:///Users/mac/Agent/niannian/pi-learning/packages/coding-agent/docs/session-format.md)

## 学习建议

### 1. 先类型后实现

每个包的 `types.ts` 是理解该包的钥匙。先读类型定义，建立概念模型，再看具体实现。

### 2. 重点攻克 agent-loop

`packages/agent/src/agent-loop.ts` 是整个框架的核心。花时间理解这个文件，其他部分会变得清晰。

**学习方法**：
1. 通读代码，标注不理解的地方
2. 画出状态机图
3. 跟踪一个完整请求的执行路径
4. 修改代码并观察效果

### 3. 对比不同 Provider 实现

阅读 `openai-provider.ts` 和 `anthropic-provider.ts`，对比它们如何处理：
- 流式响应
- Tool calling
- 错误处理
- Token 计算

这能帮你理解抽象层的价值。

### 4. 运行并修改测试

不要只读代码，修改测试用例并观察行为变化：

```bash
# 修改测试
vim packages/agent/test/agent-loop.test.ts

# 运行测试
cd packages/agent
node --test test/agent-loop.test.ts
```

### 5. 实践扩展开发

尝试开发一个简单的扩展，比如：
- 添加一个自定义工具
- 创建一个主题
- 包装一个新的 LLM 提供商

参考 `packages/coding-agent/examples/extensions/`。

### 6. 阅读文档

Pi 的文档很完善，遇到问题时查阅：

```bash
# 扩展开发
cat packages/coding-agent/docs/extensions.md

# 主题定制
cat packages/coding-agent/docs/themes.md

# TUI 组件
cat packages/coding-agent/docs/tui.md
```

## 常见问题

### Q: 旧指南里的 CBOR 协议（packages/protocol）去哪了？

**A**: 该包已随旧的 server/client 架构一起删除。进程间通信现在由 `packages/chord` 的 link 层负责（`packages/chord/src/link/`，自带 README）。`learning-guide/protocol.md` 的笔记仅作历史参考。

### Q: Agent 如何管理上下文窗口？

**A**: 在 `agent-loop.ts` 中实现了上下文压缩策略。当超过窗口限制时，会总结旧消息。

### Q: Tool calling 如何工作？

**A**: LLM 返回工具调用请求（JSON），agent 解析后执行工具，将结果作为新消息发回 LLM。

### Q: 扩展如何加载？

**A**: `extensions/loader.ts` 在启动时扫描 `~/.pi/extensions/` 和项目 `.pi/extensions/`，使用 `jiti` 动态加载。

### Q: TUI 如何实现差分渲染？

**A**: 比较新旧虚拟 DOM，只更新变化的终端单元格，避免全屏重绘。

## 进阶主题

### 性能优化

- 流式响应的缓冲策略
- 上下文窗口管理
- 差分渲染优化

### 安全性

- 工具权限模型（见 `coding-agent/src/core/tools.ts`）
- 沙箱扩展（见 `examples/extensions/gondolin/`）
- OAuth 令牌管理

### 可扩展性

- Provider 插件化
- 工具注册机制
- 扩展生命周期

## 相关资源

- [Pi 主文档](https://pi.dev/docs/latest)
- [GitHub 仓库](https://github.com/earendil-works/pi-mono)
- [示例代码](packages/coding-agent/examples/)
- [RFC 提案](https://rfc.earendil.com/keyword/pi/)

## 下一步

完成基础学习后，考虑：

1. **贡献代码**：修复 bug、添加功能
2. **开发扩展**：创建自己的工具或提供商
3. **深入研究**：选择感兴趣的模块深入优化
4. **应用实践**：基于 Pi 构建自己的 agent 应用

祝学习愉快！
