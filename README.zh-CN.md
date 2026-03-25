# Nocturne Atlas

[English README](./README.md)

**Nocturne Atlas** 是一个本地运行、零前端构建的 AI 小说工作台，适合长篇、多轮、持续演化的故事创作。

它不只是一个聊天框。每个故事都会拥有自己独立的设定、副本工作区、记忆记录、诊断面板，以及可审阅的提案更新流程。

## 主要特性

- 每个故事拥有独立的角色卡、世界书、文风工作区
- `data/library/*` 中的源素材保持不可变，故事只使用自己的工作副本
- 支持流式输出、停止生成、重写上一轮
- 记忆检查点以本地 JSONL 形式保存，方便查看和排查
- 通过提案审阅更新设定，而不是静默改写 canon
- Diagnostics 可查看上下文压力、检索行为、提示词来源和遗忘风险
- 支持 OpenAI 兼容的 chat-completions Provider，并在本地加密保存 API Key
- 支持兼容思考模型的 `reasoning effort`
- 支持不依赖远程 embedding API 的 Memory RAG 与 Knowledge RAG
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

## 首次使用流程

1. 创建或打开一个故事。
2. 启用这个故事需要使用的角色卡、世界书和文风。
3. 配置一个 OpenAI 兼容 Provider，并选择模型。
4. 在浏览器里开始聊天创作。
5. 随着故事推进，查看记忆、提案和 Diagnostics。
6. 只接受那些你希望真正写入该故事 canon 的工作区更新。

## 核心概念

### 源素材库与故事工作区

- `data/library/*` 保存可复用的源素材。
- `data/stories/<storyId>/workspace/*` 保存故事自己的可变副本。
- 故事推进不会改动源素材库。
- 接受提案时，只会更新当前故事的工作区副本。

### 记忆系统

- 应用会在合适的时候把对话压缩成较短的记忆记录。
- 这些记录会写入 `data/stories/<storyId>/memory/records.jsonl`。
- 配套的证据片段也会写入 `data/stories/<storyId>/memory/chunks.jsonl`。
- 检索阶段会把长期记忆、关键记忆、近期记忆重新注入 prompt。
- Memory RAG 还会把召回到的记忆证据片段一起注入 prompt。

### 提案系统

- 模型可以提出结构化的工作区更新建议，而不是直接偷偷改设定。
- 接受提案时，只会影响当前故事的本地工作副本。
- 拒绝提案不会污染当前工作区。

### Diagnostics 面板

Diagnostics 用来解释“这一轮模型到底看到了什么”。

常见标签含义：

- `Character anchors`、`Worldbook anchors`、`Style anchors`
  指启用素材生成的稳定锚点上下文
- `Retrieved knowledge chunks`
  指从工作区素材中按需召回的知识片段
- `Critical memory`、`Recent memory`
  指本轮 prompt 中实际注入的记忆块

## 检索与本地 RAG

Nocturne Atlas 把 **记忆检索** 和 **知识检索** 分开配置。

现在的记忆检索始终走 **Memory RAG**，但内部会根据当轮情况自动选择 lexical 或 embedding 增强路径。

现在的知识检索也始终走 **Knowledge RAG**。系统会先尝试语义检索，再在 embedding 不可用或语义命中过弱时用 lexical chunk recall 兜底。

### Memory RAG

Memory RAG 保留了稳定的 summary record 层，同时也会在合适时把 evidence chunk 一起召回。

- 稳定记忆事实继续负责保护 canon 连续性
- evidence chunk 负责把更具体的场景事实重新带回 prompt
- 如果 embedding 暂时不可用，这条 Memory RAG 路径会自动回退到 lexical，而不是直接失效

### Knowledge RAG

Knowledge RAG 会把角色卡、世界书、文风 anchor 压得更轻，把更详细的事实尽量交给召回到的知识 chunk。

- 语义检索会面向整个工作区 chunk 语料运行
- lexical chunk recall 只在语义检索不可用或太弱时补位
- 本地 embedding 能提升语义召回范围，但 fallback 路径依然能保证冷启动或离线环境可用

### 本地 Embedding

项目可以在本地运行 embedding，不需要额外的远程 embedding API。

当前本地 embedding 路径：

- 后端：`@xenova/transformers`
- 默认模型：`Xenova/all-MiniLM-L6-v2`
- 镜像源：可在 `Providers & Retrieval -> Local Embedding Mirror` 中配置
- 回退路径：当神经推理不可用时，使用本地确定性的 `hash_v1`

### 如何开启更接近本地 RAG 的路径

克隆项目后：

1. 运行 `npm install`
2. 运行 `npm start`
3. 把 `Global Local Embeddings` 设为 `On`
4. 如果当前网络访问 Hugging Face 不稳定，可以把 `Local Embedding Mirror` 设成可用镜像，例如 `https://hf-mirror.com/`
5. 点击一次 `Prewarm Local Embedding Model`

### Prewarm 的作用

- 它会执行一次真实的本地 embedding 调用。
- 对第一次运行的机器来说，这一步通常就是下载本地模型文件的时候。
- 它会在第一次重检索对话前先把模型缓存热起来。
- 只有真正拿到神经向量时，界面才会报告成功。
- 如果神经模型加载失败，界面会如实报告失败，而不会假装模型已经准备好。

## 配置层级

配置分为两层：

- 全局默认值
  对所有故事生效，除非某个故事显式覆盖
- 故事级覆盖
  允许单个故事使用不同的 provider 或 embedding 模式

当前可独立控制的项目包括：

- provider / model
- reasoning effort
- local embedding mode

## Provider

当前项目主要面向 OpenAI 兼容的 **chat completions** 接口。

可配置内容包括：

- base URL
- model name
- context window
- API key
- 兼容思考模型时的 reasoning effort

Provider Key 会保存在本地，并以加密形式落盘。

## 数据目录

项目尽量保持本地数据可读、可检查。

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
- 所以克隆仓库后，需要自己生成故事数据和本地 embedding 缓存

## 项目结构

```text
server.js                         后端组合入口与启动脚本
lib/http.js                       HTTP 工具与静态文件服务
lib/server-config.js              全局配置、故事配置与 embedding runtime 工具
lib/api-router.js                 API 路由匹配与资源处理
lib/providers.js                  Provider 工具与 OpenAI 兼容传输
lib/story-store.js                Story、Library、JSON、JSONL 存储工具
lib/workspace.js                  Story workspace 同步与加载
lib/context.js                    上下文块组装与 prompt 结构控制
lib/chat.js                       聊天编排、流式接口、revise 流程与预览组装
lib/chat-context.js               Prompt 解析、workspace 加载与聊天上下文组装
lib/chat-grounding.js             Grounding 输入整理与保守重写修复
lib/chat-revise.js                revise 回滚、proposal 撤销与 workspace 恢复
lib/chat-turn.js                  聊天回合落盘、diagnostics snapshot 与持久化流程
lib/memory.js                     记忆编排与记忆模块组合入口
lib/memory-summary.js             Summary 触发、候选提取与模型/回退总结
lib/memory-chunks.js              Episodic/evidence chunk 生成与去重合并
lib/memory-forgetfulness.js       遗忘信号与 workspace 冲突检测
lib/memory-query.js               记忆检索查询构造、关键词提取与实体聚焦工具
lib/memory-lexical.js             lexical 记忆召回、打分与格式化工具
lib/memory-engine.js              记忆查询与 lexical 工具的兼容导出层
lib/memory-retrieval.js           Memory-RAG 编排与分层预算合并
lib/memory-retrieval-helpers.js   检索排序、多样性与预算分配共享工具
lib/memory-retrieval-records.js   canon/近期事实选择与 contested memory 工具
lib/memory-retrieval-evidence.js  episodic/support 证据片段选择工具
lib/memory-vector.js              本地记忆向量打分工具
lib/retrieval-plan.js             memory 与 knowledge 联合路由和检索预算工具
lib/retrieval-fusion.js           跨源检索重排与最终 prompt 选择工具
lib/embeddings.js                 本地 embedding 生成工具
lib/knowledge-query.js            知识检索查询聚焦、实体匹配与 anchor hint 工具
lib/knowledge-index.js            知识 chunk 构建与持久化索引工具
lib/knowledge-select.js           知识语义/lexical 选择与 embedding cache 工具
lib/knowledge-retrieval.js        Knowledge-RAG 的索引、查询、选择与格式化组合层
lib/memory-consolidation.js       长期记忆整合工具
lib/proposals.js                  提案生成与审阅工具
public/index.html                 主界面结构
public/styles.css                 样式与布局
public/app-chat.js                聊天交互
public/app-library.js             Library 编辑相关交互
public/app-workspace.js           工作区渲染与查看
public/app-review.js              Review、Memory、Proposal、Diagnostics 渲染
public/app-provider.js            Provider 设置与本地 embedding 交互
public/app-shell.js               主题、侧栏与右侧面板壳层交互
public/app.js                     前端启动、状态与跨模块协调
test/smoke.js                     零依赖 smoke 测试
```

## 说明与限制

- Forgetfulness 指标是启发式风险提示，不代表模型一定真的遗忘了。
- Proposal review 的目标是让 canon 更新可审阅，不是自动化替你决定。
- 现在工作区知识检索和记忆检索都可以分别走更接近 RAG 的路径。
- 即使知识检索使用 hybrid，记忆检索仍然可以保持 lexical，或者单独切到 memory RAG。
- Provider 层当前以 chat-completions 兼容接口为主，并不是完整的原生 Responses API 集成。

## License

**Nocturne Atlas** 使用 `MIT` License。

详见 [LICENSE](./LICENSE)。

