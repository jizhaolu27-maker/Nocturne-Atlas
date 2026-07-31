# AGENTS.md

本文件适用于整个仓库。更深层目录若有自己的 `AGENTS.md`，以离目标文件最近的规则为准。

## 项目

Nocturne Atlas 是 Node.js 18+、CommonJS、原生 HTTP 和零构建浏览器前端组成的本地 AI 小说工作台。核心是故事隔离工作区、Memory/Knowledge RAG、proposal review 和 revise-last。详细产品说明见 `README.md` / `README.zh-CN.md`。

## 命令

```bash
npm install
npm start      # 默认 http://localhost:18379，可用 HOST/PORT 覆盖
npm test       # node test/smoke.js
```

生产服务器使用 `deploy/nocturne-atlas.service` 作为 systemd 后台服务，监听 `18379`；代码或服务配置更新后执行 `sudo systemctl restart nocturne-atlas`，查看状态使用 `sudo systemctl status nocturne-atlas`。

项目没有独立 lint、format、typecheck 或 CI 命令，不要声称这些检查通过。代码风格为双引号、分号、2 空格缩进。

## 代码地图

- `server.js`：依赖装配、初始化和服务启动；大型业务逻辑放入 `lib/`。
- `lib/auth.js`：单用户密码哈希、会话 Cookie 和登录 API。
- `lib/api-router.js`：API 路由。
- `lib/story-store.js`、`lib/workspace.js`：文件存储与故事工作副本。
- `lib/chat*.js`、`lib/context.js`：聊天、回滚和 prompt 上下文。
- `lib/memory*.js`、`lib/knowledge*.js`：RAG、索引、检索与诊断。
- `lib/embeddings.js`、`lib/providers.js`：本地 embedding 与模型 Provider。
- `lib/proposals.js`：canon 更新提案。
- `public/`：原生浏览器 UI；脚本顺序见 `public/index.html`。
- `test/smoke.js`：`node:assert/strict` 回归测试。
- `data/library/`：可提交的源素材；`data/stories/`：忽略的本地运行数据。

## 必须保持的不变量

1. 故事推进不得直接改写 `data/library/*`；只修改 `data/stories/<storyId>/workspace/*`。
2. 模型不得静默改变 canon；持续性设定通过 proposal 由用户审阅。
3. revise-last 必须回滚该轮消息、记忆和已接受提案；生成失败时恢复原状态。
4. JSON/JSONL 字段变更必须兼容旧故事，或提供懒迁移/重建路径。
5. embedding 索引记录真实 provider/model/signature；`hash_v1` fallback 不能标成 neural embedding。
6. Diagnostics 只把实际注入 prompt 的内容呈现为已采用证据。
7. 用户输入参与文件路径时必须使用现有 ID/path 校验，禁止目录穿越。
8. 不提交 API key、`data/config/`、`data/stories/`、故事正文或模型缓存。
9. 不把账号密码、会话 Cookie 或认证配置写入源码、测试 fixture、日志或 DEVLOG。

## 修改与验证

- 沿用现有工厂函数和依赖注入模式；存储逻辑复用 store helper。
- API 改动同步检查浏览器调用方以及流式/非流式路径。
- 前端保持零构建；写入 `innerHTML` 的用户或模型文本必须先安全转义。
- 测试使用临时目录和 mock Provider，不访问真实密钥、故事数据或外部服务。
- 检索改动覆盖当前请求优先级、中文关键词、冲突事实、证据去重和 fallback。
- 代码修改至少运行 `npm test`；服务/API/UI 改动还要启动应用验证目标流程。
- 认证改动至少验证未登录 401、错误密码、正确登录、会话访问和注销。
- prewarm 在未安装 `@xenova/transformers` 时会返回结构化的依赖缺失状态；测试应验证状态和元数据，不要绑定某个网络错误文案。

## 日志与完成

有意义的文档、代码、配置或测试改动都要更新根目录 `DEVLOG.md`：在最上方日期下简述实际变化、兼容性影响、验证结果和已知问题，不写计划或敏感数据。

交付前确认：范围内行为完成、旧数据不变量未破坏、测试已实际运行、用户操作变化已同步 README、DEVLOG 已更新，并明确报告残留问题。
