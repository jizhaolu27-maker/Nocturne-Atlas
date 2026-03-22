# Nocturne Atlas

[English README](./README.md)

**Nocturne Atlas** 是一个本地运行、零构建的 AI 互动小说工作台，专门为长线故事创作设计。

它不是单纯的聊天壳，而是把“故事记忆”“设定工作区”“提案审核”“上下文诊断”都做成了一等功能，让你能持续维护一个会成长、会分支、可审查的故事宇宙。

## 为什么是 Nocturne Atlas

**Nocturne Atlas** 的核心思路很简单：

长篇 AI 故事写作，不能只靠一次次聊天堆上下文，更需要一个可维护的故事工作台。

**Nocturne Atlas** 的特色在于：

- 每个故事都有独立工作区，角色卡、世界书、文风副本彼此隔离
- 源资料库保持不变，真正会演化的是每个故事自己的工作副本
- 记忆摘要以本地 JSONL 形式保存，便于追踪和检查
- 设定更新通过提案流进入工作区，而不是悄悄覆盖
- Diagnostics 可查看上下文占用、Prompt 预览、提案触发器、遗忘风险
- 支持 OpenAI-compatible Provider，本地保存并加密 API Key
- 静态前端，无需额外构建流程

## 它能做什么

用 **Nocturne Atlas**，你可以：

- 创建多个故事，并保持它们的设定彼此隔离
- 在本地浏览器 UI 中与 OpenAI-compatible 模型对话
- 为每个故事启用专属角色卡、世界书和文风
- 自动生成剧情记忆，支撑更长线的连续创作
- 审核角色、关系、世界状态等提案，再决定是否写入故事 canon
- 检查上下文压力和启发式“遗忘风险”
- 流式显示回复，并在中途停止生成

## 核心工作流

1. 在 **Nocturne Atlas** 中创建或打开一个故事。
2. 选择这个故事要启用的角色卡、世界书和文风。
3. 与模型对话推进剧情。
4. 让 **Nocturne Atlas** 保存简洁记忆，并产出可审核的设定提案。
5. 只接受那些真正应该进入该故事工作 canon 的更新。

## 项目结构

```text
server.js                         API 路由、Provider 调用与高层编排
lib/providers.js                  Provider 加密、连通性测试与 OpenAI-compatible 请求辅助
lib/story-store.js                故事/资料库/配置存储辅助，以及 JSON/JSONL 文件读写
lib/workspace.js                  故事工作区 copy、sync 与 active workspace 加载辅助
lib/context.js                    context block 组装、pressure 分级与默认 context 状态辅助
lib/chat.js                       聊天 context 构建、回合收尾、streaming 与 revise-last 辅助
lib/memory.js                     记忆编排、摘要触发、fallback 摘要与 forgetfulness 检查
lib/memory-engine.js              记忆召回评分与 prompt 格式化辅助
lib/memory-consolidation.js       长期记忆合并辅助
lib/proposals.js                  proposal 触发、生成、pipeline 状态与应用辅助
public/index.html                 主界面结构
public/styles.css                 样式与布局
public/app.js                     前端状态、渲染与交互
data/library/*                    源资料库资源
data/stories/<storyId>/*          每个故事的本地工作区、消息、记忆、提案与快照
```

## 数据结构

**Nocturne Atlas** 尽量让故事数据保持本地化、可读、可检查。

- `data/library/characters`, `data/library/worldbooks`, `data/library/styles`
  源资料库
- `data/stories/<storyId>/workspace/*`
  故事工作副本
- `data/stories/<storyId>/messages.jsonl`
  聊天记录
- `data/stories/<storyId>/memory/records.jsonl`
  剧情记忆
- `data/stories/<storyId>/proposals/records.jsonl`
  提案队列与审核历史
- `data/stories/<storyId>/snapshots/context.jsonl`
  Diagnostics 快照

## 快速开始

### 环境要求

- 推荐 Node.js 18+

### 运行

```bash
node server.js
```

打开：

```text
http://localhost:3000
```

### 测试

运行本地 smoke tests：

```bash
node test/smoke.js
```

也可以直接使用脚本：

```bash
npm test
```

这组 smoke tests 保持零依赖，主要覆盖拆分后的 story-store、workspace、context、memory 和 proposal 关键流程。

当前 smoke tests 主要覆盖：

- `story-store`：创建故事，以及已启用资料首次同步到 workspace
- `workspace`：故事本地副本生成后的 active workspace 加载
- `context`：system / workspace / memory / history block 组装
- `memory`：摘要计划计算，以及不回退成原始 transcript 的 fallback 摘要生成
- `proposals`：接受创建角色提案后，正确写入 workspace 并更新故事启用列表

## Provider 支持

**Nocturne Atlas** 当前面向 OpenAI-compatible 的 Chat Completions 接口。

可以配置：

- base URL
- model 名称
- context window
- API key

Provider key 会保存在本地，并进行静态加密存储。

## 当前亮点

- 流式聊天与停止生成
- 每故事独立工作区
- 提案式 canon 更新
- 简洁记忆生成与合并
- 上下文诊断与 Prompt 预览
- 面向长线故事的遗忘风险提示
- 零构建本地 UI

## 当前记忆机制

**Nocturne Atlas** 目前采用的是分层、本地化的记忆机制，而不是向量数据库。

当前流程大致是：

1. 在特定轮次后，系统会根据最近对话生成一条简洁记忆。
2. 记忆会保存到 `data/stories/<storyId>/memory/records.jsonl`。
3. 每条记忆会带上这些结构化信息：
   - `kind`，例如 `relationship_update`、`world_state`、`character_update`、`plot_checkpoint`
   - `importance`
   - `entities`
   - `keywords`
   - `tier`，即 `short_term` 或 `long_term`
4. 下一轮构建上下文时，**Nocturne Atlas** 会按以下因素给记忆打分：
   - 关键词命中
   - 实体命中
   - 与当前工作区术语的重合
   - 新近程度
   - 重要度
   - 记忆层级
5. 得分最高的几条记忆会被重新注入 prompt，作为可见的上下文块参与生成。
6. 当短期记忆累积到一定数量后，稳定类型的记忆会被合并成长期记忆。
7. 同类型的旧长期记忆还会被新的长期记忆 supersede，避免检索越来越脏。

这套设计的重点是：让 **Nocturne Atlas** 的记忆是显式的、可检查的、保存在本地的，而不是藏在不可见的 prompt 拼接里。

运行时的记忆主流程现在集中在 `lib/memory.js`，而召回评分与合并逻辑则继续放在 `lib/memory-engine.js` 和 `lib/memory-consolidation.js` 这样的 helper 模块里。

聊天 context 构建、回合收尾、streaming 聊天流程，以及 revise-last 处理现在集中在 `lib/chat.js`，这样 `server.js` 就更偏向入口层的启动、装配和 route 编排。

现在的全局系统提示词保存在 app config 里，所有故事共用；每个故事只保留自己的故事提示词和用户模板提示词。

## 说明

- “遗忘风险”是启发式信号，不代表模型真的发生了记忆故障。
- 提案机制的目标是让 canon 更新可审核，而不是自动覆盖。
- 这个项目目前是明显的 local-first、single-user 取向。

## 后续方向

- 故事复制与归档
- 更好的故事 / 资料搜索与筛选
- 更丰富的提案 diff 展示
- 更强的记忆检索评分

## License

**Nocturne Atlas** 当前采用 `MIT` License。

这意味着别人通常可以使用、修改、分发、甚至商用这个项目，只要保留原始版权声明与许可证文本即可。

详见 [LICENSE](./LICENSE)。
