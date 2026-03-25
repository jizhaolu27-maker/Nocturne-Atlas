# Nocturne Atlas

[English README](./README.md)

**Nocturne Atlas** 是一个本地运行、零前端构建的 AI 小说工作台，适合长篇、多轮、持续演化的故事创作。

它不是一个只有聊天框的写作工具。每个故事都会拥有独立的工作区、检索上下文、记忆轨迹、诊断快照和提案审阅流程，让故事可以一边推进，一边保持 canon 可控。

## 它能做什么

- 每个故事拥有独立的角色卡、世界书和文风工作区
- 源素材库与故事工作副本严格分离
- 默认启用 Memory RAG 和 Knowledge RAG 保持连续性
- 聊天、记忆、提案、诊断都以本地 JSON / JSONL 存储
- 通过提案审阅更新设定，而不是静默改写 canon
- 支持流式输出、停止生成和“回退后重生成”的上轮重写
- 支持 OpenAI 兼容的 chat-completions Provider
- 支持完全本地的 embedding，同时保留 lexical fallback
- 浏览器端零构建，直接运行即可

## 快速开始

### 环境要求

- Node.js 18+

### 安装依赖

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

### 运行测试

```bash
npm test
```

## 第一次使用

1. 创建一个故事。
2. 启用这个故事要使用的角色卡、世界书和文风。
3. 配置一个 OpenAI 兼容 Provider，并选择模型。
4. 在浏览器里开始写作。
5. 随着故事推进，查看记忆、诊断和提案。
6. 只接受那些你希望真正写入该故事 canon 的工作区更新。

如果你希望启用语义检索，把 `Global Local Embeddings` 打开，并先执行一次 `Prewarm Local Embedding Model`。

## 核心概念

### 源素材库 vs 故事工作区

- `data/library/*` 保存可复用的源素材。
- `data/stories/<storyId>/workspace/*` 保存该故事自己的可变副本。
- 故事推进不会直接改动源素材库。
- 接受提案时，只会更新当前故事的工作区副本。

### 记忆系统

- 记忆记录存放在 `data/stories/<storyId>/memory/records.jsonl`
- 支撑证据和 episodic chunk 存放在 `data/stories/<storyId>/memory/chunks.jsonl`
- 检索时会把稳定事实、近期事实和场景证据重新注入 prompt
- 旧故事里的 memory keywords 会在运行时懒刷新，所以历史数据也能吃到新的检索逻辑

### 提案系统

- 模型可以提出结构化的工作区更新建议，而不是直接偷改设定
- 提案可以逐条接受、拒绝或留待之后处理
- 接受提案只影响当前故事的本地工作副本

### Diagnostics 面板

Diagnostics 用来回答一个很重要的问题：这一轮模型到底看到了什么。

常见标签包括：

- `Character anchors`、`Worldbook anchors`、`Style anchors`
  已启用素材生成的稳定提示锚点
- `Retrieved knowledge chunks`
  为当前这一轮动态召回的工作区知识片段
- `Critical memory`、`Recent memory`、`Memory evidence`
  实际注入到 prompt 里的不同记忆层
- `Grounding Check`
  用已检索到的记忆和知识，对回复做事后支撑检查

## 检索与 RAG

Nocturne Atlas 现在有两层检索：

- **Memory RAG**：负责故事连续性、canon 事实和近期剧情证据
- **Knowledge RAG**：负责角色卡、世界书和文风资料

两者默认始终开启。lexical recall 依然存在，但只作为内部兜底路径，在语义检索不可用或命中过弱时补位。

### Memory RAG

- 稳定 memory fact 负责保护连续性
- recent memory fact 负责保留短期剧情推进
- episodic evidence 负责支持场景细节与时间顺序
- 同一轮里可以联合使用事实和证据，而不是只靠摘要记忆

### Knowledge RAG

- 工作区素材会按故事切块并建立索引
- 开启本地 embedding 后，优先走语义检索
- 语义检索不够强时，lexical chunk recall 会补位
- 当 knowledge index version 变化时，旧的 story-local 知识索引会自动重建

## 本地 Embedding

项目可以在本地运行语义检索，不需要额外的远程 embedding API。

当前本地路径：

- 后端：`@xenova/transformers`
- 默认模型：`Xenova/all-MiniLM-L6-v2`
- 可选镜像源：`Providers & Retrieval -> Local Embedding Mirror`
- 回退路径：当神经推理不可用时，使用确定性的本地 `hash_v1` 向量

推荐启用方式：

1. 运行 `npm install`
2. 启动应用 `npm start`
3. 把 `Global Local Embeddings` 设为 `On`
4. 如果当前网络访问 Hugging Face 较慢或不稳定，可把 `Local Embedding Mirror` 设成可用镜像，例如 `https://hf-mirror.com/`
5. 点击一次 `Prewarm Local Embedding Model`

Prewarm 会执行一次真实的本地 embedding 调用，这样首次需要重检索的对话就不会在最关键的时候才开始下载模型。

## 配置层级

故事级配置包括：

- provider / model
- reasoning effort
- temperature
- max completion tokens

应用级检索配置包括：

- global local embeddings
- local embedding mirror host

## Provider

当前 Provider 层主要面向 OpenAI 兼容的 **chat completions** 接口。

可配置内容包括：

- base URL
- model name
- context window
- API key
- reasoning effort

Provider Key 会保存在本地，并以加密形式落盘。

## 数据目录

```text
data/library/characters/                 源角色卡素材
data/library/worldbooks/                 源世界书素材
data/library/styles/                     源文风素材
data/stories/<storyId>/workspace/        故事本地工作副本
data/stories/<storyId>/messages.jsonl    聊天记录
data/stories/<storyId>/memory/records.jsonl
data/stories/<storyId>/memory/chunks.jsonl
data/stories/<storyId>/proposals/records.jsonl
data/stories/<storyId>/snapshots/context.jsonl
```

补充说明：

- 当前仓库的 `.gitignore` 会忽略 `data/stories/`
- 本地模型缓存目录也会被忽略
- 其他人在克隆仓库后，需要自己生成故事数据和本地 embedding 缓存

## 项目结构

```text
server.js                         后端入口与依赖装配
lib/api-router.js                 API 路由
lib/story-store.js                Story、Library、JSON、JSONL 存储工具
lib/workspace.js                  Story workspace 同步与加载
lib/context.js                    Prompt 上下文组装
lib/chat.js                       聊天编排、流式接口、重写与预览
lib/memory.js                     记忆系统编排
lib/memory-runtime.js             运行时 memory 规范化与旧 keyword 刷新
lib/retrieval-plan.js             memory / knowledge 联合路由与预算规划
lib/retrieval-fusion.js           跨来源最终重排
lib/knowledge-retrieval.js        Knowledge RAG 组合层
lib/proposals.js                  提案生成与审阅
public/                           静态浏览器 UI
test/smoke.js                     零依赖 smoke 测试
```

## 说明与限制

- Forgetfulness 指标是启发式风险提示，不代表模型一定真的遗忘了内容。
- Proposal review 的目标是让 canon 更新可审阅，而不是自动替你决定。
- Provider 层当前主要面向 chat-completions 兼容接口，不是完整的原生 Responses API 集成。

## License

本项目使用 `MIT` License。

详见 [LICENSE](./LICENSE)。
