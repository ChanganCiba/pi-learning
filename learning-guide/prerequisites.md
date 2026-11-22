# Pi 框架学习前置知识清单

学习 Pi 框架源码需要一定的技术基础。本文档列出所有前置知识点，并标注优先级和推荐学习资源。

## 优先级说明

- ⭐⭐⭐ **必须掌握** - 不掌握无法阅读代码
- ⭐⭐ **强烈推荐** - 不掌握会有较大理解障碍
- ⭐ **建议了解** - 遇到时再查也可以

---

## 编程语言基础

### 1. JavaScript (ES2022+) ⭐⭐⭐

**必须掌握的特性：**

- 异步编程
  - `Promise` 和 `async/await`
  - 错误处理 (`try/catch`)
  - `Promise.all()`, `Promise.race()`
  
- 现代语法
  - 解构赋值
  - 展开运算符 (`...`)
  - 可选链 (`?.`)
  - 空值合并 (`??`)
  - 模板字符串

- 模块系统
  - ES Modules (`import/export`)
  - 动态导入（`import()`，但 Pi 项目禁止在类型中使用）

- 常用 API
  - `Array` 方法 (`map`, `filter`, `reduce`, `find` 等)
  - `Object` 方法
  - `Set` 和 `Map`

**推荐资源：**
- [MDN JavaScript 指南](https://developer.mozilla.org/zh-CN/docs/Web/JavaScript/Guide)
- [JavaScript.info](https://zh.javascript.info/)
- [ES6+ 特性](https://github.com/lukehoban/es6features)

### 2. TypeScript ⭐⭐⭐

**必须掌握：**

- 基础类型系统
  - 基本类型 (`string`, `number`, `boolean` 等)
  - 数组和元组
  - 对象类型和接口 (`interface`)
  - 联合类型 (`|`) 和交叉类型 (`&`)
  - 字面量类型
  - `type` vs `interface`

- 高级类型
  - 泛型 (`<T>`)
  - 条件类型 (`T extends U ? X : Y`)
  - 映射类型 (`{ [K in keyof T]: ... }`)
  - `Partial`, `Required`, `Pick`, `Omit` 等工具类型
  - `unknown` vs `any`
  - 类型守卫 (`is`, `typeof`, `instanceof`)

- 模块和命名空间
  - 模块导入导出
  - 类型导入 (`import type`)

- 配置
  - `tsconfig.json` 常用选项
  - 严格模式 (`strict: true`)

**Pi 项目特殊要求：**
- 只使用可擦除语法（不用 `enum`, `namespace`, `import =` 等）
- 不使用 `any`（除非绝对必要）
- 理解 `Node16` 模块解析

**推荐资源：**
- [TypeScript 官方文档](https://www.typescriptlang.org/docs/)
- [TypeScript 深度指南](https://basarat.gitbook.io/typescript/)
- [Type Challenges](https://github.com/type-challenges/type-challenges) - 练习高级类型

---

## Node.js 生态

### 3. Node.js 核心 API ⭐⭐⭐

**必须了解的模块：**

- `fs` / `fs/promises` - 文件系统操作
- `path` - 路径处理
- `stream` - 流式处理
- `child_process` - 子进程
- `events` - 事件发射器
- `buffer` - 二进制数据处理
- `process` - 进程信息和环境变量

**关键概念：**
- 事件循环 (Event Loop)
- 非阻塞 I/O
- Stream 的四种类型（Readable, Writable, Duplex, Transform）
- 错误处理约定

**推荐资源：**
- [Node.js 官方文档](https://nodejs.org/docs/latest/api/)
- [Node.js 设计模式](https://www.nodejsdesignpatterns.com/)

### 4. npm 和包管理 ⭐⭐

**需要掌握：**

- `package.json` 结构
  - `dependencies` vs `devDependencies` vs `optionalDependencies`
  - `scripts` 生命周期
  - `engines` 约束
  - `exports` 字段（Node.js 模块导出）

- npm 命令
  - `npm install`, `npm ci`
  - `npm run`
  - `npm link` (本地包开发)
  - `--ignore-scripts` 安全标志

- Workspaces (Monorepo)
  - 多包管理
  - 包间依赖 (`^0.84.2` 约定)
  - `package-lock.json` 作用

**推荐资源：**
- [npm 文档](https://docs.npmjs.com/)
- [Workspaces 介绍](https://docs.npmjs.com/cli/v10/using-npm/workspaces)

---

## 核心技术栈

### 5. 异步编程和流式处理 ⭐⭐⭐

**关键概念：**

- `async/await` 模式
- 错误传播（Promise rejection）
- 并发控制
  - `Promise.all()` - 并行执行
  - `Promise.race()` - 竞态
  - `Promise.allSettled()` - 容错并行

- Stream 编程
  - 背压 (backpressure)
  - 流式读写文件
  - 流式网络传输

- AsyncIterator / AsyncGenerator
  ```typescript
  async function* streamData() {
    for await (const chunk of source) {
      yield transform(chunk);
    }
  }
  ```

**在 Pi 中的应用：**
- LLM 流式响应处理
- 大文件增量读取
- WebSocket 消息流

**推荐资源：**
- [JavaScript Promise 迷你书](https://javascript.info/async)
- [Node.js Stream 手册](https://github.com/substack/stream-handbook)

### 6. WebSocket 协议 ⭐⭐

**需要理解：**

- WebSocket vs HTTP
  - 全双工通信
  - 持久连接
  - 低延迟

- WebSocket 生命周期
  - 握手 (Handshake)
  - 连接、消息、关闭事件
  - 心跳 (Ping/Pong)

- 常见库：`ws`, `uWebSockets.js`

**在 Pi 中的应用：**
- `packages/server` 使用 WebSocket 提供 agent 服务
- 客户端通过 WebSocket 与 agent 通信

**推荐资源：**
- [MDN WebSocket API](https://developer.mozilla.org/zh-CN/docs/Web/API/WebSocket)
- [WebSocket 协议 RFC 6455](https://tools.ietf.org/html/rfc6455)

### 7. ANSI 终端控制 ⭐⭐

**需要了解：**

- ANSI 转义序列 (Escape Sequences)
  - 光标移动 (`\x1b[{n}A` 上移 n 行)
  - 清屏 (`\x1b[2J`)
  - 颜色控制 (`\x1b[31m` 红色)
  - 样式 (粗体、下划线等)

- 终端尺寸检测
- 原始模式 (Raw Mode) vs 常规模式
- 标准输入输出 (`stdin`, `stdout`, `stderr`)

**在 Pi 中的应用：**
- `packages/tui` 实现终端 UI
- 差分渲染（只更新变化部分）
- 交互式输入处理

**推荐资源：**
- [ANSI 转义序列参考](https://en.wikipedia.org/wiki/ANSI_escape_code)
- [Build Your Own Command Line with ANSI Codes](https://www.lihaoyi.com/post/BuildyourownCommandLinewithANSIescapecodes.html)

---

## 协议和数据格式

### 8. JSON 和 JSON Schema ⭐⭐⭐

**需要掌握：**

- JSON 语法
- JSON 序列化/反序列化
- JSON 的限制（无二进制、无日期类型）

- JSON Schema
  - 类型定义
  - 验证规则
  - `$ref` 引用

**在 Pi 中的应用：**
- 工具参数定义使用 JSON Schema
- TypeBox 生成 JSON Schema

**推荐资源：**
- [JSON Schema 官方文档](https://json-schema.org/)
- [Understanding JSON Schema](https://json-schema.org/understanding-json-schema/)

### 9. CBOR (Concise Binary Object Representation) ⭐

**需要了解：**

- CBOR vs JSON
  - 二进制格式
  - 更紧凑
  - 支持二进制数据
  - 解析更快

- 使用场景
  - 进程间通信
  - 网络传输优化

**在 Pi 中的应用：**
- `packages/protocol` 使用 CBOR 编码消息
- 支持传输图片等二进制数据

**推荐资源：**
- [CBOR 规范 RFC 8949](https://tools.ietf.org/html/rfc8949)
- [cbor.io](https://cbor.io/) - 在线工具

### 10. TypeBox ⭐⭐

**需要了解：**

- TypeBox 是什么
  - TypeScript 类型 → JSON Schema
  - 运行时类型验证
  - 零依赖

- 基本用法
  ```typescript
  import { Type } from 'typebox';
  
  const User = Type.Object({
    name: Type.String(),
    age: Type.Number(),
  });
  ```

**在 Pi 中的应用：**
- `packages/protocol/src/schemas.ts` 定义消息模式
- Agent 工具参数定义

**推荐资源：**
- [TypeBox GitHub](https://github.com/sinclairzx81/typebox)

---

## LLM 和 AI 基础

### 11. 大语言模型 (LLM) 基础 ⭐⭐

**需要理解的概念：**

- LLM 的工作原理（高层次理解即可）
  - Token 和分词
  - 上下文窗口
  - Temperature 和采样
  - Top-p / Top-k

- Prompt Engineering
  - System prompt vs User prompt
  - Few-shot learning
  - Chain of thought

- 流式生成 (Streaming)
  - Server-Sent Events (SSE)
  - 逐 token 返回

**在 Pi 中的应用：**
- `packages/ai` 统一多个 LLM 提供商
- Agent 使用 LLM 理解任务和生成响应

**推荐资源：**
- [OpenAI API 文档](https://platform.openai.com/docs/)
- [Anthropic Claude 文档](https://docs.anthropic.com/)
- [Prompt Engineering Guide](https://www.promptingguide.ai/zh)

### 12. Tool Calling (函数调用) ⭐⭐⭐

**核心概念：**

- 什么是 Tool Calling
  - LLM 识别出需要调用外部工具
  - 返回结构化的函数调用请求
  - Agent 执行工具，将结果反馈给 LLM

- 工具定义格式
  ```json
  {
    "name": "read_file",
    "description": "Read file contents",
    "parameters": {
      "type": "object",
      "properties": {
        "path": { "type": "string" }
      },
      "required": ["path"]
    }
  }
  ```

- Tool Calling 流程
  1. 用户输入 → LLM
  2. LLM 返回工具调用 → Agent
  3. Agent 执行工具 → 结果
  4. 结果 → LLM
  5. LLM 生成最终响应

**在 Pi 中的应用：**
- `packages/agent/src/agent-loop.ts` 实现工具调用循环
- 这是整个框架最核心的功能

**推荐资源：**
- [OpenAI Function Calling](https://platform.openai.com/docs/guides/function-calling)
- [Anthropic Tool Use](https://docs.anthropic.com/claude/docs/tool-use)

### 13. OAuth 2.0 ⭐

**需要了解：**

- OAuth 基本流程
  - 授权码流程 (Authorization Code)
  - 设备码流程 (Device Code) - Pi 使用这个

- 令牌管理
  - Access Token
  - Refresh Token
  - Token 过期和刷新

**在 Pi 中的应用：**
- `packages/ai/src/oauth.ts` 实现 OAuth 认证
- 用于 Google Gemini 等需要 OAuth 的提供商

**推荐资源：**
- [OAuth 2.0 简明教程](https://oauth.net/2/)
- [理解 OAuth 2.0](https://www.ruanyifeng.com/blog/2019/04/oauth_design.html)

---

## 软件工程实践

### 14. Monorepo 开发 ⭐⭐

**需要理解：**

- Monorepo vs Polyrepo
- npm Workspaces 原理
  - 包间依赖解析
  - 统一依赖管理
  - `package-lock.json` 的作用

- 常见 Monorepo 工具对比
  - npm workspaces（Pi 使用）
  - Lerna
  - Turborepo
  - pnpm workspaces

**推荐资源：**
- [Monorepo 实践指南](https://monorepo.tools/)

### 15. 测试框架 ⭐⭐

**需要了解：**

- Vitest
  - 单元测试
  - 模拟 (Mock)
  - 快照测试

- Node.js `node:test`（内置测试框架）
  - `packages/tui` 使用

- 测试最佳实践
  - AAA 模式 (Arrange-Act-Assert)
  - 测试隔离
  - 避免测试脆弱性

**推荐资源：**
- [Vitest 文档](https://vitest.dev/)
- [Node.js Test Runner](https://nodejs.org/api/test.html)

### 16. 代码质量工具 ⭐

**需要了解：**

- Biome（Pi 使用的 Linter + Formatter）
  - 替代 ESLint + Prettier
  - 性能更高
  - 配置：`biome.json`

- TypeScript 编译器检查
  - `tsc --noEmit` 类型检查

**推荐资源：**
- [Biome 文档](https://biomejs.dev/)

### 17. Git 和版本控制 ⭐⭐

**需要掌握：**

- 基本命令
  - `git add`, `git commit`, `git push`
  - `git branch`, `git checkout`, `git merge`
  - `git status`, `git diff`, `git log`

- 暂存区概念
- 提交信息规范（Conventional Commits）
  - Pi 格式：`feat(ai): add new provider`

- 分支策略

**推荐资源：**
- [Pro Git 中文版](https://git-scm.com/book/zh/v2)
- [Learn Git Branching](https://learngitbranching.js.org/?locale=zh_CN)

---

## 设计模式和架构

### 18. 常见设计模式 ⭐⭐

**在 Pi 中用到的模式：**

- **抽象工厂 (Abstract Factory)**
  - `Provider` 接口统一不同 LLM

- **策略模式 (Strategy)**
  - 不同的工具实现

- **观察者模式 (Observer)**
  - 事件发射器

- **装饰器模式 (Decorator)**
  - 扩展系统

- **代理模式 (Proxy)**
  - `packages/agent/src/proxy.ts`

**推荐资源：**
- [JavaScript 设计模式](https://www.patterns.dev/)
- [重构与模式](https://refactoring.guru/design-patterns)

### 19. 状态机 ⭐⭐

**需要理解：**

- 状态机基本概念
  - 状态 (State)
  - 转换 (Transition)
  - 事件 (Event)

- 有限状态机 (FSM)

**在 Pi 中的应用：**
- `packages/agent/src/agent.ts` - Agent 状态管理
- Agent 循环的状态转换

**推荐资源：**
- [有限状态机理解](https://www.ruanyifeng.com/blog/2013/09/finite-state_machine_for_javascript.html)

### 20. 插件化架构 ⭐

**需要理解：**

- 插件系统设计
  - 插件发现
  - 动态加载
  - 生命周期管理

- 扩展点 (Extension Points)

**在 Pi 中的应用：**
- `packages/coding-agent/src/extensions/` - 扩展系统
- 自定义工具、提供商、主题

**推荐资源：**
- [插件架构实践](https://martinfowler.com/articles/plugins.html)

---

## 安全与最佳实践

### 21. 安全编码 ⭐⭐

**需要注意：**

- 命令注入防护
  - 参数转义
  - 避免直接拼接 shell 命令

- 路径遍历防护
  - 验证文件路径
  - 使用 `path.resolve()` 规范化

- 依赖安全
  - `npm audit`
  - 固定版本（Pi 使用精确版本）
  - `--ignore-scripts` 标志

**在 Pi 中的实践：**
- 工具权限检查
- 用户确认机制
- 安全指南：`SECURITY.md`

**推荐资源：**
- [Node.js 安全最佳实践](https://github.com/goldbergyoni/nodebestpractices#6-security-best-practices)

---

## 工具和环境

### 22. 命令行工具 ⭐⭐

**需要熟悉的命令：**

- 文件操作
  - `ls`, `cd`, `pwd`, `mkdir`, `rm`, `mv`, `cp`
  - `cat`, `head`, `tail`, `less`

- 文本处理
  - `grep`, `sed`, `awk`
  - `find`

- 进程管理
  - `ps`, `top`, `kill`

- 网络
  - `curl`, `wget`

**推荐资源：**
- [命令行的艺术](https://github.com/jlevy/the-art-of-command-line/blob/master/README-zh.md)

### 23. 开发环境 ⭐⭐

**推荐工具：**

- **编辑器**
  - VS Code（推荐）
    - TypeScript 支持
    - 调试配置
    - 插件：ESLint, Prettier

- **终端**
  - iTerm2 (macOS)
  - Windows Terminal (Windows)
  - tmux（多窗口管理）

- **Node.js 版本管理**
  - nvm (Node Version Manager)
  - 确保 Node.js >= 22.19.0

**推荐资源：**
- [VS Code 文档](https://code.visualstudio.com/docs)

---

## 学习路径建议

### 阶段一：基础巩固 (2-4周)

如果你是小白，建议先学习：

1. JavaScript 基础（⭐⭐⭐）
2. TypeScript 基础（⭐⭐⭐）
3. Node.js 核心 API（⭐⭐⭐）
4. 异步编程（⭐⭐⭐）
5. npm 和包管理（⭐⭐）

**学习方式：**
- 跟着教程做小项目
- 实现一些简单的 CLI 工具
- 熟悉 `async/await` 和 Stream

### 阶段二：核心技术 (2-3周)

掌握 Pi 特有的技术：

6. LLM 基础（⭐⭐）
7. Tool Calling（⭐⭐⭐）
8. WebSocket（⭐⭐）
9. ANSI 终端控制（⭐⭐）
10. TypeBox（⭐⭐）

**学习方式：**
- 调用 OpenAI/Anthropic API
- 实现一个简单的 tool calling agent
- 用 ANSI 码做一个终端进度条

### 阶段三：高级主题 (1-2周)

深入理解架构：

11. Monorepo 开发（⭐⭐）
12. 设计模式（⭐⭐）
13. 状态机（⭐⭐）
14. 插件化架构（⭐）

**学习方式：**
- 搭建一个简单的 Monorepo
- 重构代码使用设计模式
- 实现一个简单的插件系统

### 阶段四：开始读 Pi 源码

完成前三阶段后，你已经具备读懂 Pi 源码的能力。

按照 `learning-guide/README.md` 的学习路径开始阅读。

---

## 自测清单

在开始学习 Pi 源码前，确保你能回答以下问题：

**JavaScript/TypeScript:**
- [ ] 什么是 Promise？如何处理 Promise 错误？
- [ ] `async/await` 和 `.then()` 有什么区别？
- [ ] TypeScript 的泛型如何使用？
- [ ] `unknown` 和 `any` 有什么区别？

**Node.js:**
- [ ] 如何异步读取文件？
- [ ] 什么是 Stream？什么时候使用它？
- [ ] 如何启动一个子进程？
- [ ] `process.env` 是什么？

**LLM:**
- [ ] 什么是 Tool Calling？
- [ ] 什么是流式响应？
- [ ] 什么是上下文窗口？
- [ ] 如何定义一个工具的 JSON Schema？

**其他:**
- [ ] Monorepo 是什么？和普通 repo 有什么区别？
- [ ] ANSI 转义序列如何控制终端颜色？
- [ ] WebSocket 和 HTTP 有什么区别？
- [ ] 什么是状态机？

如果以上问题你大部分能回答，那么你已经准备好学习 Pi 源码了！

---

## 推荐学习顺序

### 完全小白（0 基础）

1. JavaScript 入门（2-3周）
2. Node.js 入门（1-2周）
3. TypeScript 入门（1-2周）
4. 构建一个简单的 CLI 工具（1周）
5. 学习 LLM API 使用（1周）
6. 开始阅读 Pi 源码

**总计：6-9周**

### 有一定基础（会 JS/TS）

1. 补充 Node.js Stream, async 知识（1周）
2. 学习 LLM 和 Tool Calling（1周）
3. 了解 ANSI 终端控制（3天）
4. 快速过一遍 TypeBox, CBOR（2天）
5. 开始阅读 Pi 源码

**总计：2-3周**

### 有丰富经验（做过类似项目）

直接开始阅读 Pi 源码，遇到不懂的概念再查。

---

## 最后的建议

1. **不要试图一次学完所有内容**。先掌握最核心的（标注 ⭐⭐⭐ 的），其他的可以边读源码边学。

2. **实践是最好的学习方式**。每学一个概念，就写一个小 demo。

3. **不要害怕看不懂**。Pi 是一个复杂的项目，第一遍看不懂很正常。多看几遍，结合调试，慢慢就清晰了。

4. **善用搜索和 AI 助手**。遇到不懂的概念，先搜索学习，实在不理解再深挖。

5. **跟着测试学习**。测试用例往往展示了 API 的使用方式，是很好的学习材料。

祝学习愉快！
