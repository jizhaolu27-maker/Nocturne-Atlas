# Development Log

按日期倒序记录实际完成的变更。使用 `Added`、`Changed`、`Fixed`、`Removed`、`Security`、`Docs`、`Tests` 或 `Known issues`；同一天直接追加，避免重复 README 和提交历史。

## 2026-07-31

### Docs

- 精简 `AGENTS.md`，保留新窗口需要的项目地图、核心不变量、验证与交付要求。
- 建立 `DEVLOG.md`，要求后续有意义的仓库改动同步记录。
- 允许 Git 跟踪 `AGENTS.md` 和 `DEVLOG.md`。

### Changed

- 移动端改为聊天优先的单屏工作流：新增 Stories/Chat/Knowledge/Controls 底部导航，侧栏和右侧面板在手机上以全屏抽屉呈现。
- 优化移动端安全区、顶部栏、触控目标、聊天输入框、消息排版、表单单列布局和认证卡片；桌面三栏布局保持不变。
- 修复移动端关闭抽屉仍露出窄边或面板文字的问题，关闭状态现在同时禁用可见性和点击命中。
- 进一步隔离移动端关闭面板的透明度与绘制区域，避免动画或浏览器合成造成边缘泄漏。
- 新增中英文界面切换按钮，登录页和工作区均可切换，语言偏好保存在浏览器本地。
- 修复手机聊天输入区可能被网格最小宽度压缩成窄条的问题，聊天主区和输入表单现在明确允许收缩并占满可用宽度。
- 将手机聊天输入区改为相对视口固定定位，避免主内容网格宽度异常时整个输入框被压缩。
- 修复手机右侧控制抽屉打开后无法滚动的问题，恢复面板的 Flex 高度分配并启用触摸纵向滚动。
- 将主界面的语言切换移到侧栏底部主题按钮旁，并改用地球图标与短语言标记。
- 静态 HTML/CSS/JS 响应增加 `no-store`，避免开发部署时手机继续使用旧的移动端资源缓存。
- 登录请求显式携带同源 Cookie、禁止 API 缓存，并在网络无响应时于 15 秒后显示超时错误，避免登录界面无限等待。
- 扩大敏感运行时文件忽略规则：整个 `data/config/`、环境变量文件、证书/私钥和本地会话文件均不进入 Git。
- 增加单用户认证层：密码以 scrypt 哈希保存在 ignored `data/config/auth.json`，API 使用 HttpOnly 会话 Cookie；静态登录页仍可访问。
- 默认监听端口改为高位端口 `18379`，支持 `HOST`、`PORT` 和 `AUTH_COOKIE_SECURE` 环境变量。
- `story-store` 的 JSON/JSONL 覆盖写入改为同目录临时文件加 rename，避免进程中断留下半写文件。
- JSONL append 会先隔离没有换行的损坏尾部，避免下一条有效记录与残片粘连。
- 同一 story 的 API 操作通过 keyed serial executor 串行执行；不同 story 仍可并行。
- Provider app-secret 改用 `path.join`，并自动导入旧版 POSIX 错误路径后清理旧副本。
- prewarm 失败路径统一返回 `activeProvider`、`activeModel` 和 `fallbackUsed` 元数据。

### Tests

- 运行态验证通过：未登录 API 返回 401，错误密码被拒绝，正确登录获得会话，带会话可读取 bootstrap；重启后认证配置可复用。
- 新增原子写入、JSONL 截断恢复、密钥路径迁移和 keyed executor 回归测试。
- 运行 `npm test`：全部 smoke 测试通过（75 项）。

### Known issues

- 当前认证会话默认通过明文 HTTP 传输；跨网络使用应配合 Tailscale/WireGuard 或 HTTPS 反向代理，不要直接做公网端口转发。
