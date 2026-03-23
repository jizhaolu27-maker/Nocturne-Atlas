# Nocturne Atlas

[English README](./README.md)

**Nocturne Atlas** 是一个本地运行、零构建的 AI 小说工作台，适合维护长篇故事、持续世界观和多角色设定。

它不是单纯的聊天框，而是把“故事工作区、记忆、提案、诊断”都做成了一等功能。每个故事都有自己的独立 canon、独立工作副本、独立对话记录和独立记忆轨迹。

## 项目亮点

- 每个故事都有独立的角色卡、世界书、文风配置和工作区
- 源素材库保持不变，故事只修改自己的本地副本
- 记忆以可读的 JSONL 落盘，方便检查和调试
- 设定更新通过提案机制进入故事 canon，而不是静默覆盖
- Diagnostics 可以查看上下文压力、检索结果、提示词来源和失忆风险
- 支持 OpenAI-compatible Provider，并在本地加密保存 API Key
- 支持 chat-completions-compatible 的思考模型，并可配置 reasoning effort
- 支持可选的本地混合检索与本地 RAG 基础能力
- 前端是静态页面，不需要额外构建

## 快速开始

### 环境要求

- Node.js 18 或更高版本

### 安装

```bash
npm install
```

### 启动

```bash
npm start
```

打开：

```text
http://localhost:3000
```

### 测试

```bash
npm test
```

## 这个项目能做什么

你可以用 **Nocturne Atlas**：

- 创建多个故事，并保持它们的 canon 完全隔离
- 为某个故事启用专属角色卡、世界书和文风配置
- 在本地浏览器 UI 里和模型持续对话
- 为长剧情自动生成记忆 checkpoint
- 审核角色、关系、世界状态相关的提案更新
- 查看上下文诊断、记忆检索和遗忘风险
- 流式输出回复，并在中途停止生成

## 核心工作流

1. 创建或打开一个故事
2. 为这个故事启用角色卡、世界书和文风配置
3. 配置 Provider 并开始对话
4. 让系统自动记录紧凑记忆，并生成可审阅的 canon 提案
5. 只接受你希望进入该故事工作 canon 的更新

## 本地 RAG 与 Embedding

**Nocturne Atlas** 可以在不依赖远程 embedding API 的情况下，走完整的本地 embedding 路径。

当前默认配置：

- 默认检索模式：`lexical`
- 默认本地 embedding：`off`
- 本地神经网络 embedding 后端：`@xenova/transformers`
- 默认本地 embedding 模型：`Xenova/all-MiniLM-L6-v2`
- 回退方案：当本地神经网络不可用时，使用确定性的本地哈希向量

如果你想在克隆后启用本地 RAG 风格检索：

1. 运行 `npm install`
2. 运行 `npm start`
3. 在界面中把 `Global Default: Memory Retrieval` 设为 `Hybrid`
4. 把 `Global Default: Local Embeddings` 设为 `On`
5. 点击一次 `Prewarm Local Embedding Model`

这个预热按钮的作用是：

- 主动触发一次真正的本地 embedding 调用
- 如果本地模型还没有缓存，这一步会开始下载模型并写入缓存目录
- 这样第一次正式聊天时，就不会把冷启动成本全部堆到第一轮对话里

## 配置层级

检索相关设置分成两层：

- 全局默认值
  作用于所有故事，除非某个故事单独覆盖
- 故事级覆盖
  只对当前故事生效

常见组合：

- `Lexical Only` + `Off`
  最稳、最轻量，不启用向量增强
- `Hybrid` + `On`
  启用本地向量增强检索
- `Inherit App Default`
  跟随当前全局默认值

## 数据目录

项目尽量把数据保存在本地、并保持可读。

```text
data/library/characters/                 源角色素材
data/library/worldbooks/                 源世界书素材
data/library/styles/                     源文风素材
data/stories/<storyId>/workspace/        故事工作副本
data/stories/<storyId>/messages.jsonl    对话记录
data/stories/<storyId>/memory/records.jsonl
data/stories/<storyId>/proposals/records.jsonl
data/stories/<storyId>/snapshots/context.jsonl
```

补充说明：

- 当前仓库配置里，`data/stories/` 默认被 `.gitignore` 忽略
- 本地模型缓存目录也被 `.gitignore` 忽略
- 这意味着别人拉取仓库后，需要在自己的机器上重新生成故事数据和本地模型缓存

## 项目结构

```text
server.js                         后端装配入口与启动
lib/http.js                       HTTP 辅助与静态文件服务
lib/server-config.js              app config、story config 与 embedding runtime 辅助
lib/api-router.js                 API 路由匹配与资源处理
lib/providers.js                  Provider 辅助与 OpenAI-compatible 请求封装
lib/story-store.js                Story、library、config、JSON/JSONL 存储辅助
lib/workspace.js                  Story workspace 同步与加载
lib/context.js                    上下文 block 组装与压力判断
lib/chat.js                       聊天上下文构建、回合收尾与流式输出
lib/memory.js                     记忆编排与失忆检测
lib/memory-engine.js              词面记忆检索与格式化
lib/memory-retrieval.js           混合检索编排
lib/memory-vector.js              本地向量打分辅助
lib/embeddings.js                 本地 embedding 生成辅助
lib/knowledge-retrieval.js        工作区知识 chunk 化与检索
lib/memory-consolidation.js       长期记忆整合
lib/proposals.js                  提案生成与审阅
public/index.html                 主界面
public/styles.css                 样式与布局
public/app-chat.js                聊天相关交互
public/app-library.js             素材编辑相关交互
public/app-workspace.js           工作区渲染相关交互
public/app-review.js              Review、memory、diagnostics 渲染
public/app-provider.js            Provider 设置与本地 embedding 相关交互
public/app-shell.js               主题、侧边栏和右侧面板框架交互
public/app.js                     前端启动、状态和跨模块协调
```

## 记忆系统是怎么工作的

这套记忆系统是显式的、本地优先的。

1. 系统会定期把最近对话压缩成紧凑的记忆记录
2. 每条记录写入 `data/stories/<storyId>/memory/records.jsonl`
3. 记录里会包含 `kind`、`importance`、`entities`、`keywords`、`tier` 等字段
4. 在下一轮生成前，系统会根据词面重叠、结构化字段、新近性、重要性和可选向量相似度进行排序
5. 最相关的记忆会作为紧凑的 context block 再次注入 prompt
6. 稳定的短期记忆之后还可以整合成长时记忆

这样做的好处是：故事连续性是可检查、可理解、可调试的，而不是藏在一个黑盒 prompt 里。

## Provider 支持

项目当前面向 OpenAI-compatible chat completion API。

你可以配置：

- base URL
- model name
- context window
- API key

故事生成设置里也可以为兼容的思考模型配置 reasoning effort。

Provider key 会保存在本地，并加密存储。

## 说明

- Forgetfulness 指标是启发式风险提示，不代表模型一定真的“失忆”
- Proposal review 的目标是让 canon 更新可审阅，而不是自动合并
- 这个仓库是本地优先、单用户优先的设计
- 当前本地 RAG 路径主要由记忆检索和工作区知识检索组成

## License

**Nocturne Atlas** 使用 `MIT` License。

见 [LICENSE](./LICENSE)。
