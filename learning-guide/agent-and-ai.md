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

## 深挖：Provider / API 分层与两家协议对比

### Q1 指南说要读 `providers/openai.ts` 和 `anthropic.ts` 对比实现，但它们只有 15 行和 59 行，找错文件了？

没找错，是指南的表述把两层当成一层了。`providers/openai.ts` 全文就是一次配置调用：

```ts
export function openaiProvider(): Provider<"openai-responses"> {
    return createProvider({
        id: "openai",
        name: "OpenAI",
        baseUrl: "https://api.openai.com/v1",
        auth: { apiKey: envApiKeyAuth("OpenAI API key", ["OPENAI_API_KEY"]) },
        models: Object.values(OPENAI_MODELS),
        api: openAIResponsesApi(),   // ← 真正的协议实现在这里
    });
}
```

provider 工厂只回答四个问题：**我是谁**（id / name）、**连哪儿**（baseUrl）、**怎么认证**（auth）、**我有哪些模型**（models）。协议怎么说话是 `api` 字段指向的实现负责，代码在 [`src/api/`](file:///Users/mac/Agent/niannian/pi-learning/packages/ai/src/api) 下——`anthropic-messages.ts` 1401 行，`openai-completions.ts` 1588 行。

对比 `anthropic.ts` 剩下的 59 行是什么？全是 auth。Anthropic 有三种凭据来源要按优先级试：stored credential → `ANTHROPIC_AUTH_TOKEN`（走 Bearer header）→ `ANTHROPIC_OAUTH_TOKEN` / `ANTHROPIC_API_KEY`，外加一个 `lazyOAuth` 处理 Claude Pro/Max 订阅登录。**auth 的复杂度才是 provider 层真正的差异所在**，协议反而不属于这一层。

### Q2 那 provider 和 api 是什么关系？为什么不合并成一层？

多对一，而且是高度倾斜的多对一。[`types.ts`](file:///Users/mac/Agent/niannian/pi-learning/packages/ai/src/types.ts) 里 `KnownApi` 列了 10 种协议，`KnownProvider` 列了 40 个 provider，实际映射：

| API 实现 | 用它的 provider | 数量 |
|---|---|---|
| `openai-completions` | deepseek, groq, cerebras, together, moonshotai, qwen×3, xiaomi×4, zai, nvidia, baseten, huggingface, openrouter, cloudflare-workers-ai, ant-ling | 21 |
| `anthropic-messages` | anthropic, **fireworks**, **github-copilot**, **vercel-ai-gateway**, minimax×2, opencode×2, kimi-coding, cloudflare-ai-gateway | 10 |
| 其余 8 种 | openai/xai（responses）、openai-codex、mistral、google×2、bedrock、radius（pi-messages） | 9 |

加粗的几个是理解的关键：`fireworks`、`github-copilot`、`vercel-ai-gateway` 都不是 Anthropic 的服务，却走 Anthropic 协议。所以 **"OpenAI 兼容"和"Anthropic 兼容"是事实上的两大网络协议方言，不是公司边界**。合并的话，40 个 provider 要复制 40 份 1500 行的流式解析代码。

这也修正了上面「新增模型只需要实现转换层」的说法，更准确的表述是：

- 新增 **provider**（新服务商）→ 挑一个现成的 api 实现，只写配置
- 新增 **api 实现** → 只有出现新的协议方言时才需要写

顺带一个 TS 技巧：`export type Api = KnownApi | (string & {})`。`| (string & {})` 让类型保持"任意字符串"的同时，编辑器的自动补全仍然优先提示 `KnownApi` 里的 10 个字面量。纯 `Api = KnownApi | string` 会退化成 `string`，补全就没了。

### Q3 为什么 api 实现都是 `.lazy.ts` 包一层？

`providers/openai.ts` 导入的是 `openai-responses.lazy.ts`，[`api/lazy.ts`](file:///Users/mac/Agent/niannian/pi-learning/packages/ai/src/api/lazy.ts) 里的 `lazyApi()` 把动态 import 藏在第一次调用后面：

```ts
stream: (model, context, options) =>
    lazyStream(model, async () => (await load()).stream(model, context, options)),
```

两个原因叠在一起：

1. **启动体积**。10 个 api 实现加起来 11000+ 行，全加载就是纯浪费。你用 Anthropic 就完全不该加载 openai-codex 的 1650 行。
2. **启动路径是同步的，不能 await**。所以 `lazyStream()` 同步返回一个空壳 stream，异步加载在后面跑，加载完成后再把事件转发进去。

```ts
setup()
    .then((inner) => forwardStream(outer, inner))
    .catch((error) => {
        const message = createSetupErrorMessage(model, error);
        outer.push({ type: "error", reason: "error", error: message });
        outer.end(message);
    });
```

注意加载失败**不抛异常**，而是构造成一条 `stopReason: "error"` 的 AssistantMessage 推进流里。这和 telemetry 的 noop 是同一个思路：**错误走数据通道，不走异常通道**，调用方只需要处理流事件这一条路径，不用在两个地方都写错误处理。

### Q4 两家的流式协议结构差在哪？

差异比"字段名不同"要深，是**消息边界的有无**。

**Anthropic 是显式三段式**，每个内容块有 `index`，生命周期完整告知：

```
content_block_start  (type: text | thinking | tool_use)
  content_block_delta (text_delta | thinking_delta | input_json_delta | signature_delta)
content_block_stop
```

定位块靠 `blocks.findIndex(b => b.index === event.index)`。

**OpenAI 没有块边界**，只有一条平坦的 `choices[0].delta` 流：

- 文本块靠 `ensureTextBlock()` 懒创建——第一个非空 delta 到了才建块，之前一直是 `undefined`
- thinking 更麻烦，兼容端点字段名不统一：`reasoning_content`（llama.cpp）/ `reasoning` / `reasoning_text` 三个都试，取第一个非空的（注释说 chutes.ai 会同时返回两个相同内容，不去重就会重复）
- 所有块在流结束时统一 `for (const block of blocks) finishBlock(block)`

一句话概括：**Anthropic 告诉你"这段结束了"，OpenAI 要你自己推断"开始了"和"全部结束了"。**

Anthropic 侧还有个 OpenAI 不需要的完整性校验：

```ts
if (sawMessageStart && !sawMessageEnd) {
    throw new Error("Anthropic stream ended before message_stop");
}
```

SSE 是手写解析的（`iterateSseMessages`，处理 `\r` / `\n` / `\r\n` 三种换行和跨 chunk 断行），没有 SDK 兜底，所以断流必须自己检测。而且 `parseJsonWithRepair` 失败时抛的错会带上 `data=` 和 `raw=` 原始行——线上排查时能直接看到服务端发了什么。

### Q5 tool call 的参数是流式 JSON 片段，半截的怎么变成对象？

两家用同一个套路：**累加原始字符串到 scratch buffer，每个 delta 都试着解析一次**。

```ts
// Anthropic
block.partialJson += event.delta.partial_json;
block.arguments = parseStreamingJson(block.partialJson);

// OpenAI
block.partialArgs += toolCall.function.arguments;
block.arguments = parseStreamingJson(block.partialArgs);
```

[`parseStreamingJson`](file:///Users/mac/Agent/niannian/pi-learning/packages/ai/src/utils/json-parse.ts) 是三级降级，**永不抛异常**：

```ts
parseJsonWithRepair(partialJson)        // 1. 直接解析（带修复）
  ↓ 失败
partialParse(partialJson)               // 2. 解析出多少算多少
  ↓ 失败
partialParse(repairJson(partialJson))   // 3. 先修复再部分解析
  ↓ 失败
{}                                      // 4. 兜底空对象
```

为什么每个 delta 都重解析，而不是等流结束解析一次？因为 UI 要边流边显示参数——`read` 工具的 `path` 先出来，用户就能看到它准备读哪个文件，`content` 后填。这是拿 CPU 换体感。

流结束时的收尾很讲究：

```ts
block.arguments = parseStreamingJson(block.partialJson);
delete block.partialJson;   // 注释：so replay only carries parsed arguments
stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: output });
```

scratch buffer（`partialJson` / `partialArgs` / `streamIndex`）在结束前全部 `delete`。因为这个 block 会被塞进会话历史并回放给模型，留着中间态既浪费 token 又可能让模型困惑。

### Q6 stopReason 怎么统一？`max_tokens` 那条和 agent-loop 有什么关系？

Anthropic 的 [`mapStopReason`](file:///Users/mac/Agent/niannian/pi-learning/packages/ai/src/api/anthropic-messages.ts) 是显式映射表：

| Anthropic | Pi 统一 | 含义 |
|---|---|---|
| `end_turn` | `stop` | 正常说完 |
| `max_tokens` | `length` | **token 用尽，输出被截断** |
| `tool_use` | `toolUse` | 要调工具 |
| `refusal` / `sensitive` | `error` + errorMessage | 拒答 / 安全过滤 |
| `pause_turn` | `stop` | 注释："Stop is good enough -> resubmit" |
| `stop_sequence` | `stop` | 注释：从不传 stop sequences，理论上不会发生 |
| 其他 | **throw** | 未知值直接抛 |

`max_tokens → length` 这一条正是 agent-loop 里那句「token 超限时工具调用参数可能残缺，统一标记失败」的**上游来源**：截断发生在 tool call 的 JSON 参数中途，`parseStreamingJson` 只能解析出半个对象甚至 `{}`。与其让 agent 拿着残缺参数去执行工具，不如整批标记失败让模型重来。

default 分支抛异常而不是兜底成 `stop`，是有意的：未知的 stop reason 意味着漏掉了新的终止语义，静默兜底会把错误传播到上层变成难查的 bug。

### Q7 消息转换最大的差异是什么？

是 **tool result 归属哪个角色**。

Anthropic 协议里**根本没有 tool 角色**，`tool_result` 是 user 消息里的一个 content block：

```ts
// 收集所有连续的 toolResult，合并进同一条 user 消息
let j = i;
while (j < transformedMessages.length && transformedMessages[j].role === "toolResult") {
    toolResults.push(convertToolResult(transformedMessages[j]));
    j++;
}
i = j - 1;
params.push({ role: "user", content: [...toolResults, ...siblingContent] });
```

那个 while 循环不是优化，是硬约束——注释写着 "needed for z.ai Anthropic endpoint"，部分兼容端点拒绝连续的 user 消息。OpenAI 侧则有独立的 `role: "tool"` 消息，一条工具结果一条消息，不需要合并。

其他几处差异：

- **system prompt 不在 messages 数组里**，是 Anthropic 的顶层 `system` 参数
- **thinking 块必须带 signature 回传**。签名是 Anthropic 用来验证思考内容未被篡改的，缺了就降级：

```ts
if (!hasThinkingSignature) {
    blocks.push(allowEmptySignature
        ? { type: "thinking", thinking: block.thinking, signature: "" }
        : { type: "text",     text: block.thinking });   // 降级成普通文本
}
```

注释说明了触发场景：**"e.g., from aborted stream"**——用户按 Ctrl-C 打断，之前那条 thinking 就没有 signature。降级成 text 是为了不丢内容，同时不违反 Anthropic 的签名校验。`allowEmptySignature` 是给那些接受空签名的兼容端点用的逃生舱。

- **空文本块全被过滤**（`trim().length === 0` 就 `continue`），因为 Anthropic 拒绝空 content 的块

### Q8 prompt cache 在协议层是怎么落地的？

在 `convertMessages` 的最后，给**最后一条 user 消息的最后一个 block** 打标记：

```ts
if (cacheControl && params.length > 0) {
    const lastMessage = params[params.length - 1];
    if (lastMessage.role === "user") {
        lastBlock.cache_control = cacheControl;
    }
}
```

能这么做的前提是 Anthropic 的 cache 走**前缀匹配**——标记在哪，缓存边界就到哪。所以每轮对话都把标记推到最新位置，前面所有历史自动命中缓存。

注意只在 `lastMessage.role === "user"` 时加。最后一条是 assistant 的话（prefill 场景）就不加。

这也解释了 `usage` 里为什么有四个字段：`input` / `output` / `cacheRead` / `cacheWrite`，外加一个 `cacheWrite1h` 对应 `ephemeral_1h_input_tokens`（1 小时缓存档位）。Anthropic 不返回 `total_tokens`，Pi 自己加：

```ts
output.usage.totalTokens = input + output + cacheRead + cacheWrite;
calculateCost(model, output.usage);   // 按模型单价算钱
```

顺带一个细节：`message_start` 事件里就先把 input token 数记下来，注释写明 "This ensures we have input token counts even if the stream is aborted early"——流中途断了也要能算出这次请求花了多少钱。

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
