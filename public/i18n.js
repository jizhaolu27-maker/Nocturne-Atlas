(function () {
  const translations = {
    "Sign in to your story workspace.": "登录你的故事工作区。",
    Username: "用户名",
    Password: "密码",
    "Sign in": "登录",
    "Story Workspace": "故事工作区",
    "New Story": "新建故事",
    "Select a story": "请选择故事",
    "Open or create a story to start chatting.": "打开或创建故事后开始聊天。",
    "Sign out": "退出登录",
    "Export chat as TXT": "导出聊天为 TXT",
    Controls: "控制",
    Knowledge: "知识",
    Review: "审阅",
    Diagnostics: "诊断",
    "Story Configuration": "故事配置",
    "Core settings and prompt scaffolding.": "核心设置与提示词结构。",
    Basics: "基础",
    Title: "标题",
    Provider: "服务提供商",
    Summary: "摘要",
    Generation: "生成",
    "Context Turns": "上下文轮数",
    "Summary Interval": "摘要间隔",
    Temperature: "温度",
    Reasoning: "推理",
    "Use Model Default": "使用模型默认值",
    Minimal: "最小",
    Low: "低",
    Medium: "中",
    High: "高",
    "Max Tokens": "最大令牌数",
    "System Prompts": "系统提示词",
    "Global Prompt": "全局提示词",
    "Story Prompt": "故事提示词",
    "User Prompt": "用户提示词",
    "Context Status": "上下文状态",
    "Live pressure and memory risk.": "实时上下文压力与记忆风险。",
    Tokens: "令牌",
    Pressure: "压力",
    Forgetfulness: "遗忘风险",
    normal: "正常",
    "Diagnostics Log": "诊断日志",
    "Providers & Local Embeddings": "服务商与本地嵌入",
    "Provider endpoints, local embedding runtime, and model status.": "服务商端点、本地嵌入运行时与模型状态。",
    "Local Embeddings": "本地嵌入",
    "Global Local Embeddings": "全局本地嵌入",
    Off: "关闭",
    On: "开启",
    "Local Embedding Mirror": "本地嵌入镜像",
    "Prewarm Local Embedding Model": "预热本地嵌入模型",
    "Provider Setup": "服务商设置",
    "Current Provider": "当前服务商",
    Name: "名称",
    "Default Model": "默认模型",
    "Base URL": "基础 URL",
    "Context Window": "上下文窗口",
    "API Key": "API 密钥",
    Save: "保存",
    Test: "测试",
    New: "新建",
    "Activated Assets": "已启用资产",
    "Story Canon": "故事设定",
    "Story assets": "故事资产",
    "Library Sources": "素材库来源",
    "Choose assets": "选择资产",
    "Edit source": "编辑来源",
    "Runtime Memory": "运行时记忆",
    "Always include": "始终注入",
    "Keyword trigger": "关键词触发",
    Always: "始终",
    Keyword: "关键词",
    Injection: "注入方式",
    "Character Card": "角色卡",
    Worldbook: "世界书",
    Style: "文风",
    "Compress character card": "压缩角色卡",
    "Generating a review draft...": "正在生成审核草稿……",
    "Compression accepted.": "压缩结果已接受。",
    "Draft discarded.": "已放弃草稿。",
    "No current summary": "暂无当前摘要",
    "There are no fields to display.": "暂无可显示字段。",
    "Library sources active for the current story.": "当前故事启用的素材库来源。",
    Selections: "选择",
    Characters: "角色",
    Worldbooks: "世界书",
    Styles: "风格",
    "Workspace Memory": "工作区记忆",
    "Story-local copies and recent records.": "故事副本与最近记录。",
    "Workspace assets": "工作区资产",
    "Memory records": "记忆记录",
    "Library Editor": "素材库编辑器",
    "Edit reusable source entries.": "编辑可复用的来源条目。",
    "Source JSON": "来源 JSON",
    Type: "类型",
    Entry: "条目",
    "JSON Data": "JSON 数据",
    "AI Draft Description": "AI 草稿描述",
    "Describe the character, worldbook, or writing style you want...": "描述你想要的角色、世界书或文风……",
    "Generate AI Draft": "生成 AI 草稿",
    "New entry": "新建条目",
    Proposals: "提案",
    "Review AI-generated changes before applying.": "应用 AI 生成的变更前先进行审阅。",
    "Pending changes": "待处理变更",
    "Technical details": "技术细节",
    "What this turn used": "本轮使用内容",
    "Warnings and repairs": "警告与修复",
    "Context blocks": "上下文块",
    "Prompt preview": "提示词预览",
    Stories: "故事",
    Chat: "聊天",
    "AI received the request and is preparing the reply.": "AI 已收到请求，正在准备回复。",
    "Another signed-in device is generating this story.": "另一个已登录设备正在生成这个故事。",
    "Preparing the reply...": "正在准备回复……",
    "Current user input:": "当前用户输入：",
    "Write the next turn, instruction, or revision...": "写下下一轮内容、指令或修订意见……",
  };
  const reverse = Object.fromEntries(Object.entries(translations).map(([en, zh]) => [zh, en]));
  const original = new WeakMap();
  const key = "nocturne-atlas.language";
  let language = localStorage.getItem(key) === "zh" ? "zh" : "en";

  function translate(root = document) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!original.has(node)) original.set(node, node.nodeValue);
      const raw = original.get(node);
      const current = node.nodeValue;
      const source = language === "zh" ? raw : current;
      const trimmed = source.trim();
      if (!trimmed) continue;
      const translated = language === "zh" ? translations[trimmed] : reverse[trimmed];
      if (translated) node.nodeValue = source.replace(trimmed, translated);
    }
    for (const element of root.querySelectorAll?.("[placeholder], [title], [aria-label]") || []) {
      for (const attr of ["placeholder", "title", "aria-label"]) {
        const value = element.getAttribute(attr);
        if (!value) continue;
        const translated = language === "zh" ? translations[value] : reverse[value];
        if (translated) element.setAttribute(attr, translated);
      }
    }
    for (const button of document.querySelectorAll(".language-toggle")) {
      const code = button.querySelector(".language-code");
      if (code) code.textContent = language === "zh" ? "EN" : "中";
      button.title = language === "zh" ? "Switch to English" : "切换到中文";
      button.setAttribute("aria-label", button.title);
      button.setAttribute("aria-pressed", language === "zh" ? "true" : "false");
      button.classList.toggle("is-active", language === "zh");
    }
    document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
  }

  function toggle() {
    language = language === "zh" ? "en" : "zh";
    localStorage.setItem(key, language);
    translate();
  }
  window.NocturneI18n = { translate, toggle, getLanguage: () => language };
  document.addEventListener("click", (event) => {
    if (event.target.closest?.(".language-toggle")) toggle();
  });
  translate();
  new MutationObserver((mutations) => mutations.forEach(({ addedNodes }) => addedNodes.forEach((node) => {
    const target = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    if (target) translate(target);
  }))).observe(document.body, { childList: true, subtree: true });
})();
