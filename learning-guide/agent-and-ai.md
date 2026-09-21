# 第二层：AI 抽象与 Agent 核心

## packages/ai — AI 适配层

统一多个 LLM 提供商的 API，屏蔽底层差异。

- **[`src/types.ts`](file:///Users/mac/Agent/niannian/pi-learning/packages/ai/src/types.ts)** - 核心类型定义
- **[`src/model-catalog.ts`](file:///Users/mac/Agent/niannian/pi-learning/packages/ai/src/model-catalog.ts)** - 模型注册表
- **[`src/providers/openai.ts`](file:///Users/mac/Agent/niannian/pi-learning/packages/ai/src/providers/openai.ts)** - OpenAI 实现
- **[`src/providers/anthropic.ts`](file:///Users/mac/Agent/niannian/pi-learning/packages/ai/src/providers/anthropic.ts)** - Anthropic 实现

### 核心设计：适配器模式

各家 AI 的原始格式不一样：

```
OpenAI:     { choices: [{ message: { content: "hello" } }] }
Anthropic:  { content: [{ type: "text", text: "hello" }] }
Google:     { candidates: [{ content: { parts: [{ text: "hello" }] } }] }
```

Pi 统一成内部格式：

```ts
{
    role: "assistant",
    content: [{ type: "text", text: "hello" }],
    usage: { input: 10, output: 20, ... },
    stopReason: "stop"
}
```

上层代码只处理 Pi 的统一格式，不感知底层是哪家 AI。新增模型只需要实现转换层。

### 统一消息格式

```ts
// 用户消息
interface UserMessage {
    role: "user";
    content: string | (TextContent | ImageContent)[];
    timestamp: number;
}

// AI 回复
interface AssistantMessage {
    role: "assistant";
    content: (TextContent | ThinkingContent | ToolCall)[];
    provider: string;   // 哪家服务商
    model: string;      // 哪个模型
    usage: Usage;       // token 消耗
    stopReason: StopReason;
}
```

### ToolCall：AI 不自己执行工具

```ts
interface ToolCall {
    type: "toolCall";
    id: string;
    name: string;              // 工具名，比如 "readFile"
    arguments: Record<string, any>;  // 参数
}
```

AI 返回的 `ToolCall` 只是一个数据对象，不是真正的执行。外部的 agent 层负责执行，再把结果传回给 AI。

**为什么这样设计：**
- 不同业务场景的工具完全不同（编码 Agent vs 客服 Agent）
- AI 和执行环境解耦，换一套工具 AI 照样工作
- 调用方决定哪些工具允许执行，有更大的控制权

---

## packages/agent — Agent 核心

Agent 运行时是整个框架的心脏，协调 AI 和工具调用。

- **[`src/agent-loop.ts`](file:///Users/mac/Agent/niannian/pi-learning/packages/agent/src/agent-loop.ts)** - 核心循环
- **[`src/types.ts`](file:///Users/mac/Agent/niannian/pi-learning/packages/agent/src/types.ts)** - Agent 类型系统

### 核心设计：agent loop

本质是一个 while 循环：

```ts
while (true) {
    // 外层：有新消息就继续
    while (有工具调用 || 有待处理消息) {
        const message = await 问AI();

        if (出错或中止) break;
        if (token超限) { 让工具调用失败; continue; }

        const toolResults = await 执行工具();

        if (shouldStop()) break;
    }

    if (没有新消息) break;
}
```

### 停止条件（全部外部注入，不写死）

| 情况 | 代码里的体现 | 处理方式 |
|---|---|---|
| 用户中止 / 超时 | `signal: AbortSignal` | `stopReason === "aborted"` 立即退出 |
| token 超限 | `stopReason === "length"` | 工具调用参数可能残缺，统一标记失败 |
| 自定义停止 | `shouldStopAfterTurn` 回调 | 调用方注入判断逻辑 |
| 任务没有推进 | `shouldStopAfterTurn` 回调 | 多轮结果相同则停，通知用户 |
| 需要用户介入 | `shouldStopAfterTurn` 回调 | AI 无法自主判断时停下 |

**为什么停止条件外部注入，不写死 50 次：**

不同工具的风险和预期调用频率完全不同。`bash` 调 3 次可能就该警觉，`readFile` 调 100 次很正常。写死阈值对高风险工具太宽松，对低风险工具太严格，只有调用方知道业务语境。

### AgentLoopConfig：agent 的配置对象

```ts
interface AgentLoopConfig extends SimpleStreamOptions {
    model: Model<any>;
    convertToLlm: (messages: AgentMessage[]) => Message[];
    transformContext?: (messages: AgentMessage[]) => Promise<AgentMessage[]>;
    shouldStopAfterTurn?: (ctx) => boolean | Promise<boolean>;
    prepareNextTurn?: (ctx) => Promise<NextTurnSnapshot>;
    // ...
}
```

**`convertToLlm` — 格式转换层**

Pi 内部用 `AgentMessage`，AI 只认 `user` / `assistant` / `tool` 三种角色。发给 AI 前必须转换，过滤掉 UI 通知等 AI 不需要知道的消息：

```ts
convertToLlm: (messages) => messages.flatMap(m => {
    if (m.role === "notification") return [];  // 过滤 UI 消息
    return [m];
})
```

**`transformContext` — 上下文管理层**

发给 AI 前裁剪历史，防止 token 超限：

```ts
transformContext: async (messages) => {
    if (estimateTokens(messages) > MAX_TOKENS) {
        return pruneOldMessages(messages);
    }
    return messages;
}
```

**为什么拆成两个函数（单一职责）：**

- `transformContext`：操作 Pi 内部格式，关心"消息是否太多"
- `convertToLlm`：操作格式映射，关心"怎么翻译成 AI 格式"

合并成一个函数，裁剪逻辑和转换逻辑会互相耦合，改一个功能容易影响另一个。

### 状态机：五个互斥状态

```ts
type SessionPhase =
    | "idle"           // 等待用户输入
    | "turn"           // AI 正在响应或执行工具
    | "compaction"     // 上下文太长，正在压缩历史
    | "branch_summary" // 对分支做摘要
    | "retry"          // 出错，正在重试
```

状态转换路径：

```
idle
  └─ 用户发消息 → turn
        ├─ AI 不再调用工具 → idle
        ├─ 出错 → retry
        │     ├─ 可自动恢复（网络抖动等）→ turn
        │     └─ 超次数 / 任务没推进 / 需要用户介入 → idle
        └─ 上下文太长 → compaction → turn
```

**为什么用 status 字段而不是多个布尔值：**

`isLoading: boolean` + `isError: boolean` 组合出的状态可能在逻辑上不应该存在（比如同时 loading 和 error）。`status` 字段保证任何时刻只处于一个状态，互斥、可扩展，新增状态只加一个 literal。

### 上下文压缩（compaction）分层原则

Pi 不会把整个历史压缩成一段话，而是保留最近若干轮原始消息，只压缩远端历史。

**什么不能压缩（原文保留）：**
- 用户明确的约束和否定："不要用 lodash"、"不要改这个函数"
- 指令性时序："先部署测试环境，验证后再上生产"（还没执行完的约束）
- 最近 N 轮对话（当前任务的上下文）
- 未结算的中间状态（"上一步失败原因是权限问题"）

**什么可以压缩成摘要：**
- 已完成且结论明确的步骤
- 过程性时序（已有结论）："读了 20 个文件，找到目标函数在 utils.ts:45"

**什么可以直接丢弃：**
- 纯重复内容
- 已被后续内容覆盖的状态

**时序是否可压缩，判断标准：**

- 指令性时序（用户说的先后顺序）→ 不能压，是还没执行完的约束
- 过程性时序（agent 自己的执行记录）→ 结算后可压，保留结论即可
- 时序是否"结算"：A、B 都完成了可压缩；A 完成了 B 还没做，不能压

### 多模型策略（prepareNextTurn）

`prepareNextTurn` 回调可以在每轮结束后动态切换模型：

```ts
prepareNextTurn: async ({ message, toolResults }) => {
    // 工具调用阶段用快模型，最终回答用慢模型
    if (toolResults.length > 0) {
        return { model: fastModel };
    }
    return { model: smartModel };
}
```

**选模型原则：**

| 场景 | 推荐模型 |
|---|---|
| 主推理 / 复杂规划 | 慢而准的大模型 |
| 工具调用结果判断 | 快而便宜的小模型 |
| 历史压缩摘要（compaction） | 快而便宜的小模型 |
| 意图分类 | 快而便宜的小模型 |

### 工具并发执行

AI 一次可能返回多个 `ToolCall`（比如同时读 3 个文件）。Pi 并发执行这批工具，全部完成后统一返回结果给 AI，不串行等待。
