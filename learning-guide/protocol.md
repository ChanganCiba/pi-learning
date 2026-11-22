> **【已废弃——仅作历史参考】** 2026-11 同步上游后，`packages/protocol`（以及 server/client/session-backends）已从仓库删除。
> 进程间通信现在由 `packages/chord` 的 link 层负责（见 [`packages/chord/src/link/`](file:///Users/mac/Agent/niannian/pi-learning/packages/chord/src/link)）。
> 本文中的文件链接已失效，但"消息边界 + 格式校验 + 编解码"的设计思路仍适用于理解新的 link 层。
> telemetry 部分（本文后半）仍然有效，`packages/telemetry` 未变。

#### 1. packages/protocol（已删除）

理解进程间通信的基础。

- **[`src/schemas.ts`](file:///Users/mac/Agent/niannian/pi-learning/packages/protocol/src/schemas.ts)** - 使用 TypeBox 定义的消息模式
- **[`src/codec.ts`](file:///Users/mac/Agent/niannian/pi-learning/packages/protocol/src/codec.ts)** - CBOR 编解码实现
- **[`src/framing.ts`](file:///Users/mac/Agent/niannian/pi-learning/packages/protocol/src/framing.ts)** - 消息分帧协议（处理大消息）

**关键点**：
- TypeBox 如何定义类型安全的序列化模式
- CBOR 相比 JSON 的优势（二进制、紧凑）
- 帧协议如何处理流式传输

让我们看 encodeClientMessage 的实际步骤：

 ────────────────────────────────────────────────────────────────────────────────

 编码流程（发送方）

 客户端发送 rename 命令时，从 JS 对象到字节的步骤：

 ```
   JS 对象
     ↓
   1. parseClientMessage(value)  ← 验证格式（schema 校验）
     ↓
   2. encodeCbor(validated)      ← 序列化成二进制（CBOR 格式）
     ↓
   3. encodeFrame(cbor)          ← 加 4 字节长度前缀
     ↓
   4. assertCompleteFrame(frame) ← 检查总长度是否超限
     ↓
   Uint8Array（完整的帧）
 ```

 看 codec.ts:58-70 的 encodeProtocolMessage：

 ```ts
   const validated = parse(value);  // 1. schema 验证
   const maxFrameLength = options?.maxFrameLength ?? DEFAULT_MAX_FRAME_LENGTH;
   const frame = encodeFrame(encodeCbor(validated, { maxByteLength: maxFrameLength }));  // 2+3
   assertCompleteFrame(frame, { maxFrameLength });  // 4
   return frame;
 ```

 编码是一次性的：给一个 JS 对象 → 立刻返回完整字节数组，不存在"等待"。

 ────────────────────────────────────────────────────────────────────────────────

 解码流程（接收方）

 你说的"存储写入，等待消息完整后输出"——这是 FrameDecoder 的逻辑：

 接收方从网络收到字节流，可能一条消息分多次到达：

 ```
   网络字节流（不完整）
     ↓
   decoder.push(chunk1)  → []          还没攒够
     ↓
   decoder.push(chunk2)  → [message1]  攒够了，输出
     ↓
   decoder.push(chunk3)  → []          新消息还没完整
 ```

 FrameDecoder 内部维护缓冲区，攒够一条完整消息才返回。


第一层总结

 packages/protocol 解决的核心问题：两个进程怎么可靠地交换消息？ 
 Protocol 层 = 通信规则 + 消息边界 + 格式验证 + 版本协商

 三个文件分工：

 1. framing.ts - 消息边界
     - 用 4 字节长度前缀切分字节流
     - FrameDecoder 处理"消息可能分多次到达"的问题

 2. schemas.ts - 消息格式
     - TypeBox 定义所有命令和响应的结构
     - 版本握手确保客户端和服务器说同一种"方言"

 3. codec.ts - 编码解码 + 验证
     - JS 对象 ↔ CBOR 字节
     - 顺便做格式验证，拒绝非法消息

---

#### 2. packages/telemetry

轻量级遥测抽象层。解决的核心问题：**程序运行时发生了什么，花了多久，有没有出错？**

- **[`src/index.ts`](file:///Users/mac/Agent/niannian/pi-learning/packages/telemetry/src/index.ts)** - 接口定义
- **[`src/noop.ts`](file:///Users/mac/Agent/niannian/pi-learning/packages/telemetry/src/noop.ts)** - 空实现（默认，什么都不记录）
- **[`src/memory.ts`](file:///Users/mac/Agent/niannian/pi-learning/packages/telemetry/src/memory.ts)** - 内存实现（用于测试）

### 核心概念：span（跨度）

span 是一段带名字、时间、父子关系的记录，类似 Chrome DevTools Performance 面板里的横杠：

```
创建会话 ──────────── 1500ms
  ├─ 连接数据库 ── 100ms
  └─ 调用AI ─────────── 1400ms  ← 原来是这里慢
```

业务代码手动埋点：

```ts
await telemetry.startSpan({ name: "创建会话" }, async (span) => {
  span.setAttributes({ userId: "123" });
  await telemetry.startSpan({ name: "调用AI" }, async () => {
    await callAI();
  });
});
```

### 三种实现

| 实现 | 文件 | 用途 |
|---|---|---|
| `NOOP_TELEMETRY_CONTEXT` | `noop.ts` | 默认，什么都不记录 |
| `InMemoryTelemetryContext` | `memory.ts` | 测试用，记在内存数组里，测完可以检查 |
| （自己实现） | - | 比如发到 OpenTelemetry / Datadog |

### 核心设计：Null Object Pattern（空对象模式）

noop 实现不是 `null`，而是一个「什么都不做但接口完整」的对象：

```ts
const noopTelemetrySpan = {
    startSpan: startNoopSpan,  // 照样执行回调，只是不记录
    addEvent: () => {},
    setAttributes: () => {},
    setStatus: () => {},
};
```

**为什么不用 `null`？**

- 用 null 需要每个调用点加 `if (telemetry)` 判断，一百个埋点就是一百个 `if`，漏一个就是运行时崩溃
- 更严重的是：`startSpan` 里的回调包含业务逻辑，如果 telemetry 是 null，回调不执行，业务就坏了
- noop 实现照样执行回调，只是不记录——关掉遥测不影响功能

### 核心设计：接口与实现分离（供应商中立）

`index.ts` 只定义接口，不依赖任何具体服务商（OpenTelemetry、Datadog 等）。

使用方只依赖接口，换实现不需要改业务代码：

```ts
// 本地开发：什么都不记录
const telemetry = NOOP_TELEMETRY_CONTEXT;

// 生产环境：发到 Datadog
const telemetry = new DatadogTelemetryContext(...);

// 业务代码完全不知道用的是哪个，也不需要知道
await telemetry.startSpan({ name: "创建会话" }, async (span) => { ... });
```

### 核心设计：sensitive 标记与数据路由

`TelemetryAttributeMetadata` 里有 `sensitive?: boolean` 字段，标记哪些数据不能发到第三方服务器。

**判断原则：这个数据发到服务器，用户会介意吗？**

| 数据 | sensitive | 原因 |
|---|---|---|
| `user.prompt` 的内容 | true | 可能含身份证 / 银行卡号 / 机密文件 |
| `file.read` 的文件路径 | true | 暴露用户本地目录结构 |
| `tool.output` 的内容 | true | 可能包含文件内容或命令输出 |
| `session.rename` 的新名字 | false | 只是会话标签，无隐私 |
| `ai.request` 的耗时 | false | 性能数据，不含用户内容 |

**自定义路由实现思路：**

```ts
class RouterTelemetryContext implements TelemetryContext {
    constructor(
        private readonly remote: TelemetryContext,  // 发到 Datadog
        private readonly local: TelemetryContext,   // 写本地文件
    ) {}

    startSpan<T>(options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T> {
        // sensitive span 只走本地，其他发到远端
        const target = LOCAL_ONLY_SPANS.has(options.name) ? this.local : this.remote;
        return target.startSpan(options, callback);
    }
}
```

链路图：

```
业务代码
  └─ telemetry.startSpan("ai.request", ...)
        ↓
  RouterTelemetryContext
        ├─ "ai.request"  → 不敏感 → 发到 Datadog
        └─ "user.prompt" → 敏感   → 写本地文件
```

### telemetry 层小结

- **span**：一段带名字、时间、父子关系的记录
- **接口与实现分离**：业务代码不绑定具体服务商
- **noop 默认实现**：不配置就什么都不记录，业务代码无感知，功能不受影响
- **memory 实现**：测试时记录 span，测完可以断言哪些 span 被触发、带了什么属性
- **sensitive 标记**：schema 定义阶段标注，路由层据此决定数据去向，防止用户敏感数据流出
