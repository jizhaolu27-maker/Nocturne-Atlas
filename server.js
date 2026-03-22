const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const { execFileSync } = require("child_process");
const { URL } = require("url");
const { consolidateMemoryRecords } = require("./memory-consolidation");
const { extractKeywords, formatMemoryContext, selectRelevantMemoryRecords } = require("./memory-engine");

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const PUBLIC_DIR = path.join(ROOT, "public");
const CONFIG_DIR = path.join(DATA_DIR, "config");
const LIBRARY_DIR = path.join(DATA_DIR, "library");
const STORIES_DIR = path.join(DATA_DIR, "stories");

const DEFAULT_CONTEXT_BLOCKS = 30;
const DEFAULT_SUMMARY_INTERVAL = 8;
const MEMORY_SUMMARY_CHAR_LIMIT = 160;
const PROPOSAL_REASON_CHAR_LIMIT = 90;
const CHARACTER_ROLE_CHAR_LIMIT = 40;
const CHARACTER_TRAIT_CHAR_LIMIT = 24;
const CHARACTER_RELATIONSHIP_CHAR_LIMIT = 80;
const CHARACTER_ARC_CHAR_LIMIT = 140;
const CHARACTER_NOTES_CHAR_LIMIT = 120;
const DEFAULT_MAX_COMPLETION_TOKENS = 900;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function ensureFile(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, fallback);
  }
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function readJsonLines(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) {
    return [];
  }
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function appendJsonLine(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

function writeJsonLines(filePath, values) {
  ensureDir(path.dirname(filePath));
  const body = values.length ? `${values.map((item) => JSON.stringify(item)).join("\n")}\n` : "";
  fs.writeFileSync(filePath, body, "utf8");
}

function slugify(input) {
  return String(input || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50) || `story-${Date.now()}`;
}

function safeId(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
}

function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text || "").length / 4));
}

function summarizeText(text, maxLength = 180) {
  const cleaned = String(text || "").replace(/\s+/g, " ").trim();
  if (!cleaned) {
    return "";
  }
  if (cleaned.length <= maxLength) {
    return cleaned;
  }
  if (maxLength <= 3) {
    return cleaned.slice(0, maxLength);
  }
  const softLimit = maxLength - 3;
  const head = cleaned.slice(0, softLimit);
  const punctuationIndexes = ["。", "！", "？", "；", ".", "!", "?", ";", "，", ",", "、", "：", ":"]
    .map((mark) => head.lastIndexOf(mark))
    .filter((index) => index >= 0);
  const bestPunctuationIndex = punctuationIndexes.length ? Math.max(...punctuationIndexes) : -1;
  if (bestPunctuationIndex >= Math.floor(softLimit * 0.6)) {
    return `${head.slice(0, bestPunctuationIndex + 1).trim()}...`;
  }
  const lastSpaceIndex = head.lastIndexOf(" ");
  if (lastSpaceIndex >= Math.floor(softLimit * 0.6)) {
    return `${head.slice(0, lastSpaceIndex).trim()}...`;
  }
  return `${head.trim()}...`;
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 2_000_000) {
        reject(new Error("Payload too large"));
      }
    });
    req.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, status, data, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

function notFound(res) {
  sendJson(res, 404, { error: "Not found" });
}

function getAppSecret() {
  const filePath = path.join(CONFIG_DIR, "app-secret.json");
  const current = readJson(filePath);
  if (current?.secret) {
    return current.secret;
  }
  const secret = crypto.randomBytes(32).toString("hex");
  writeJson(filePath, { secret, createdAt: new Date().toISOString() });
  return secret;
}

function getEncryptionKey() {
  const seed = `${os.hostname()}|${os.userInfo().username}|${getAppSecret()}`;
  return crypto.createHash("sha256").update(seed).digest();
}

function runPowerShell(command, args = []) {
  return execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command, ...args],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }
  ).trim();
}

function encryptSecretDpapi(value) {
  const plainB64 = Buffer.from(String(value), "utf8").toString("base64");
  const blob = runPowerShell(
    "$plain=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($args[0])); " +
      "$secure=ConvertTo-SecureString $plain -AsPlainText -Force; " +
      "ConvertFrom-SecureString $secure",
    [plainB64]
  );
  return {
    scheme: "windows-dpapi-powershell",
    blob,
    createdAt: new Date().toISOString(),
  };
}

function decryptSecretDpapi(payload) {
  if (!payload?.blob) {
    return "";
  }
  try {
    const out = runPowerShell(
      "$secure=ConvertTo-SecureString $args[0]; " +
        "$plain=[System.Net.NetworkCredential]::new('', $secure).Password; " +
        "[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($plain))",
      [payload.blob]
    );
    return Buffer.from(out, "base64").toString("utf8");
  } catch {
    return "";
  }
}

function encryptSecretLegacy(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    scheme: "legacy-aes-gcm",
    iv: iv.toString("hex"),
    tag: tag.toString("hex"),
    data: encrypted.toString("hex"),
  };
}

function decryptSecretLegacy(payload) {
  if (!payload?.data || !payload?.iv || !payload?.tag) {
    return "";
  }
  try {
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      getEncryptionKey(),
      Buffer.from(payload.iv, "hex")
    );
    decipher.setAuthTag(Buffer.from(payload.tag, "hex"));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(payload.data, "hex")),
      decipher.final(),
    ]);
    return decrypted.toString("utf8");
  } catch {
    return "";
  }
}

function encryptSecret(value) {
  try {
    return encryptSecretDpapi(value);
  } catch {
    return encryptSecretLegacy(value);
  }
}

function decryptSecret(payload) {
  if (!payload) {
    return "";
  }
  if (payload.scheme === "windows-dpapi-powershell") {
    return decryptSecretDpapi(payload);
  }
  return decryptSecretLegacy(payload);
}

function canDecryptSecret(payload) {
  return Boolean(decryptSecret(payload));
}

function jsonResponse(status, data) {
  return { status, data };
}

function getProvidersFile() {
  return path.join(CONFIG_DIR, "providers.json");
}

function getAppConfigFile() {
  return path.join(CONFIG_DIR, "app.json");
}

function normalizeTheme(theme) {
  return theme === "light" ? "light" : "dark";
}

function getStoriesIndexFile() {
  return path.join(STORIES_DIR, "index.json");
}

function getLibraryTypeDir(type) {
  const map = {
    characters: path.join(LIBRARY_DIR, "characters"),
    worldbooks: path.join(LIBRARY_DIR, "worldbooks"),
    styles: path.join(LIBRARY_DIR, "styles"),
  };
  return map[type];
}

function isSupportedLibraryType(type) {
  return Boolean(getLibraryTypeDir(type));
}

function listJsonFiles(dir) {
  ensureDir(dir);
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => readJson(path.join(dir, entry.name)))
    .filter(Boolean)
    .sort((a, b) => String(a.name || a.title || "").localeCompare(String(b.name || b.title || "")));
}

function saveLibraryItem(type, item) {
  const dir = getLibraryTypeDir(type);
  if (!dir) {
    throw new Error(`Unsupported library type: ${type}`);
  }
  const payload = {
    ...item,
    id: item.id || safeId(type.slice(0, -1)),
    updatedAt: new Date().toISOString(),
  };
  if (!payload.createdAt) {
    payload.createdAt = payload.updatedAt;
  }
  const filePath = path.join(dir, `${payload.id}.json`);
  writeJson(filePath, payload);
  return payload;
}

function deleteLibraryItem(type, id) {
  const dir = getLibraryTypeDir(type);
  if (!dir) {
    throw new Error(`Unsupported library type: ${type}`);
  }
  const filePath = path.join(dir, `${id}.json`);
  if (!fs.existsSync(filePath)) {
    throw new Error("Library item not found");
  }
  fs.unlinkSync(filePath);
}

function decodePathSegment(value) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch {
    return String(value || "");
  }
}

function loadProviders() {
  return readJson(getProvidersFile(), []);
}

function saveProviders(providers) {
  writeJson(getProvidersFile(), providers);
}

function getStoryDir(storyId) {
  return path.join(STORIES_DIR, storyId);
}

function getStoryFile(storyId) {
  return path.join(getStoryDir(storyId), "story.json");
}

function getStoryMessagesFile(storyId) {
  return path.join(getStoryDir(storyId), "messages.jsonl");
}

function getStoryWorkspaceDir(storyId, kind) {
  return path.join(getStoryDir(storyId), "workspace", kind);
}

function getStoryMemoryFile(storyId) {
  return path.join(getStoryDir(storyId), "memory", "records.jsonl");
}

function getStoryProposalFile(storyId) {
  return path.join(getStoryDir(storyId), "proposals", "records.jsonl");
}

function getStorySnapshotFile(storyId) {
  return path.join(getStoryDir(storyId), "snapshots", "context.jsonl");
}

function loadStoriesIndex() {
  return readJson(getStoriesIndexFile(), []);
}

function saveStoriesIndex(entries) {
  writeJson(getStoriesIndexFile(), entries);
}

function getStory(storyId) {
  return readJson(getStoryFile(storyId));
}

function saveStory(story) {
  writeJson(getStoryFile(story.id), story);
  const index = loadStoriesIndex();
  const next = [
    ...index.filter((entry) => entry.id !== story.id),
    {
      id: story.id,
      title: story.title,
      updatedAt: story.updatedAt,
      createdAt: story.createdAt,
    },
  ].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  saveStoriesIndex(next);
}

function deleteStory(storyId) {
  const storyDir = getStoryDir(storyId);
  if (fs.existsSync(storyDir)) {
    fs.rmSync(storyDir, { recursive: true, force: true });
  }
  const next = loadStoriesIndex().filter((entry) => entry.id !== storyId);
  saveStoriesIndex(next);
}

function createDefaultStory(payload = {}) {
  const storyId = `${slugify(payload.title || "new-story")}-${Date.now()}`;
  const now = new Date().toISOString();
  const story = {
    id: storyId,
    title: payload.title || "New Story",
    summary: payload.summary || "",
    providerId: payload.providerId || "",
    model: payload.model || "",
    promptConfig: {
      globalSystemPrompt:
        payload.globalSystemPrompt ||
        "You are a collaborative fiction engine. Continue the story with consistency, emotional continuity, and scene-level specificity.",
      storySystemPrompt:
        payload.storySystemPrompt ||
        "Stay inside the active story canon. Use enabled character cards, worldbook entries, and style profile as authoritative references. If a new recurring character with stable traits, relationships, or clear future story importance is introduced, treat that as a candidate for a story-local workspace character card proposal rather than leaving the character only implicit in prose.",
      userPromptTemplate:
        payload.userPromptTemplate ||
        "User request:\n{{user_input}}\n\nRespond with the next story turn and keep continuity with the supplied memory.",
    },
    settings: {
      contextBlocks: payload.contextBlocks ?? DEFAULT_CONTEXT_BLOCKS,
      summaryInterval: payload.summaryInterval ?? DEFAULT_SUMMARY_INTERVAL,
      maxCompletionTokens: payload.maxCompletionTokens ?? DEFAULT_MAX_COMPLETION_TOKENS,
      temperature: payload.temperature ?? 0.85,
      topP: payload.topP ?? 1,
    },
    enabled: {
      characters: payload.enabled?.characters || [],
      worldbooks: payload.enabled?.worldbooks || [],
      styles: payload.enabled?.styles || [],
    },
    contextStatus: {
      usedTokens: 0,
      maxTokens: 32000,
      usedBlocks: 0,
      maxBlocks: payload.contextBlocks ?? DEFAULT_CONTEXT_BLOCKS,
      pressureLevel: "low",
      forgetfulnessState: "normal",
      forgetfulnessReasons: [],
    },
    createdAt: now,
    updatedAt: now,
  };

  ensureDir(getStoryDir(storyId));
  ensureDir(path.join(getStoryDir(storyId), "memory"));
  ensureDir(path.join(getStoryDir(storyId), "proposals"));
  ensureDir(path.join(getStoryDir(storyId), "snapshots"));
  ensureDir(getStoryWorkspaceDir(storyId, "characters"));
  ensureDir(getStoryWorkspaceDir(storyId, "worldbooks"));
  ensureDir(getStoryWorkspaceDir(storyId, "styles"));
  saveStory(story);
  ensureFile(getStoryMessagesFile(storyId), "");
  ensureFile(getStoryMemoryFile(storyId), "");
  ensureFile(getStoryProposalFile(storyId), "");
  ensureFile(getStorySnapshotFile(storyId), "");
  syncStoryWorkspace(storyId);
  return story;
}

function copyLibraryItemToWorkspace(type, id, storyId) {
  const sourcePath = path.join(getLibraryTypeDir(type), `${id}.json`);
  if (!fs.existsSync(sourcePath)) {
    return;
  }
  const targetPath = path.join(getStoryWorkspaceDir(storyId, type), `${id}.json`);
  if (!fs.existsSync(targetPath)) {
    const source = readJson(sourcePath, {});
    writeJson(targetPath, {
      ...source,
      sourceId: source.id,
      sourceUpdatedAt: source.updatedAt || source.createdAt || null,
      workspaceUpdatedAt: new Date().toISOString(),
      changeLog: [],
    });
  }
}

function syncStoryWorkspace(storyId) {
  const story = getStory(storyId);
  if (!story) {
    return;
  }
  for (const type of ["characters", "worldbooks", "styles"]) {
    for (const id of story.enabled[type] || []) {
      copyLibraryItemToWorkspace(type, id, storyId);
    }
  }
}

function loadWorkspaceItems(storyId, type) {
  return listJsonFiles(getStoryWorkspaceDir(storyId, type));
}

function loadActiveWorkspaceItems(storyId, type, enabledIds = []) {
  const allowed = new Set(enabledIds || []);
  if (allowed.size === 0) {
    return [];
  }
  return loadWorkspaceItems(storyId, type).filter((item) => allowed.has(item.id));
}

function getProviderForStory(story) {
  const providers = loadProviders();
  return providers.find((item) => item.id === story.providerId) || null;
}

function getProviderContextWindow(story) {
  const provider = getProviderForStory(story);
  return provider?.contextWindow || 32000;
}

function buildHistoryTurnBlocks(messages, maxTurns = DEFAULT_CONTEXT_BLOCKS) {
  const turns = [];
  for (const message of messages) {
    if (message.role === "user") {
      turns.push({ user: message, assistant: null });
      continue;
    }
    if (message.role === "assistant" && turns.length > 0 && !turns[turns.length - 1].assistant) {
      turns[turns.length - 1].assistant = message;
      continue;
    }
    turns.push({ user: null, assistant: message });
  }
  const recentTurns = turns.slice(-Math.max(0, maxTurns));
  return recentTurns.map((turn, index) => ({
    label: `history_turn:${index}`,
    content: [turn.user ? `user: ${turn.user.content}` : "", turn.assistant ? `assistant: ${turn.assistant.content}` : ""]
      .filter(Boolean)
      .join("\n"),
    priority: 70 + index,
  }));
}

function buildContextBlocks(story, messages, memoryRecords, workspace, options = {}) {
  const blocks = [];
  const memorySelection = selectRelevantMemoryRecords(memoryRecords, {
    userMessage: options.currentUserInput || "",
    messages,
    workspace,
    maxItems: options.maxMemoryItems || 4,
  });
  const pushBlock = (label, content, priority) => {
    if (!content) {
      return;
    }
    blocks.push({
      label,
      priority,
      content,
      tokens: estimateTokens(content),
    });
  };

  pushBlock("system:global", story.promptConfig.globalSystemPrompt, 100);
  pushBlock("system:story", story.promptConfig.storySystemPrompt, 95);

  const styleText = workspace.styles
    .map(
      (item) =>
        `${item.name}: tone=${item.tone || ""}; voice=${item.voice || ""}; pacing=${item.pacing || ""}; dos=${(item.dos || []).join(", ")}; donts=${(item.donts || []).join(", ")}`
    )
    .join("\n");
  pushBlock("style", styleText, 82);

  const characterText = workspace.characters
    .map((item) =>
      [
        `Character: ${item.name}`,
        `Role: ${item.core?.role || ""}`,
        `Traits: ${(item.traits || []).join(", ")}`,
        `Arc: ${item.arcState?.current || ""}`,
        `Relationships: ${Object.entries(item.relationships || {})
          .map(([name, relation]) => `${name}=${relation}`)
          .join(", ")}`,
        `Notes: ${item.notes || ""}`,
      ]
        .filter(Boolean)
        .join("\n")
    )
    .join("\n\n");
  pushBlock("characters", characterText, 90);

  const worldbookText = workspace.worldbooks
    .map((item) =>
      [
        `World: ${item.title}`,
        `Category: ${item.category || ""}`,
        `Rules: ${(item.rules || []).join("; ")}`,
        `Content: ${item.content || ""}`,
        `Revealed: ${(item.revealedFacts || []).join("; ")}`,
        `Story State: ${item.storyState || ""}`,
      ]
        .filter(Boolean)
        .join("\n")
    )
    .join("\n\n");
  pushBlock("worldbook", worldbookText, 88);

  const memoryText = formatMemoryContext(memorySelection.selectedRecords);
  pushBlock("memory", memoryText, 84);

  const maxBlocks = story.settings.contextBlocks ?? DEFAULT_CONTEXT_BLOCKS;
  buildHistoryTurnBlocks(messages, maxBlocks).forEach((block) => {
    pushBlock(block.label, block.content, block.priority);
  });

  const maxTokens = getProviderContextWindow(story);
  const selected = [];
  let usedTokens = 0;
  let usedHistoryTurns = 0;
  const sorted = blocks.sort((a, b) => b.priority - a.priority);
  for (const block of sorted) {
    const isHistoryTurn = block.label.startsWith("history_turn:");
    if (isHistoryTurn && usedHistoryTurns >= maxBlocks) {
      continue;
    }
    if (usedTokens + block.tokens > Math.floor(maxTokens * 0.82) && selected.length > 4) {
      continue;
    }
    selected.push(block);
    usedTokens += block.tokens;
    if (isHistoryTurn) {
      usedHistoryTurns += 1;
    }
  }
  return {
    blocks: selected.sort((a, b) => a.priority - b.priority),
    usedTokens,
    maxTokens,
    usedBlocks: usedHistoryTurns,
    maxBlocks,
    selectedMemoryRecords: memorySelection.selectedRecords,
    selectedMemoryReasons: memorySelection.reasonsById,
  };
}

function classifyPressure(usedTokens, maxTokens) {
  const ratio = maxTokens ? usedTokens / maxTokens : 0;
  if (ratio >= 0.82) {
    return "high";
  }
  if (ratio >= 0.6) {
    return "medium";
  }
  return "low";
}

function extractFacts(workspace, memoryRecords) {
  const facts = [];
  for (const item of workspace.characters) {
    if (item.name) {
      facts.push({
        kind: "character",
        label: item.name,
        keywords: [item.name, ...(item.traits || []).slice(0, 2)].filter(Boolean),
      });
    }
    if (item.arcState?.current) {
      facts.push({
        kind: "character_arc",
        label: `${item.name} ${item.arcState.current}`,
        keywords: [item.name, item.arcState.current].filter(Boolean),
      });
    }
  }
  for (const item of workspace.worldbooks) {
    if (item.title) {
      facts.push({
        kind: "world",
        label: item.title,
        keywords: [item.title, ...(item.rules || []).slice(0, 2)].filter(Boolean),
      });
    }
  }
  for (const record of memoryRecords.slice(-3)) {
    facts.push({
      kind: "memory",
      label: record.summary,
      keywords: (record.entities || []).slice(0, 3),
    });
  }
  return facts.filter((item) => item.keywords.length > 0);
}

function detectForgetfulness({ workspace, memoryRecords, assistantText, contextInfo }) {
  const reasons = [];
  const lower = String(assistantText || "").toLowerCase();
  const facts = extractFacts(workspace, memoryRecords).slice(0, 8);
  let missed = 0;
  for (const fact of facts) {
    const hit = fact.keywords.some((keyword) => lower.includes(String(keyword).toLowerCase()));
    if (!hit) {
      missed += 1;
    }
  }
  const ratio = facts.length ? missed / facts.length : 0;
  const pressure = classifyPressure(contextInfo.usedTokens, contextInfo.maxTokens);
  if (pressure === "high") {
    reasons.push("Context pressure is high");
  }
  if (ratio >= 0.7 && facts.length >= 4) {
    reasons.push("Assistant reply missed many active facts");
  } else if (ratio >= 0.45 && facts.length >= 4) {
    reasons.push("Assistant reply missed several active facts");
  }
  const content = String(assistantText || "");
  for (const item of workspace.worldbooks) {
    for (const rule of item.rules || []) {
      if (
        rule.toLowerCase().includes("never") &&
        content.toLowerCase().includes(rule.toLowerCase().replace("never", "").trim())
      ) {
        reasons.push(`Potential world rule conflict: ${rule}`);
        break;
      }
    }
  }
  let state = "normal";
  if (reasons.length >= 2 || (pressure === "high" && ratio >= 0.45)) {
    state = "risk";
  }
  if (reasons.length >= 3 || ratio >= 0.7) {
    state = "suspected_forgetfulness";
  }
  return {
    forgetfulnessState: state,
    forgetfulnessReasons: reasons,
    pressureLevel: pressure,
  };
}

function detectMajorEvent(messages) {
  const text = messages.map((item) => item.content).join("\n").toLowerCase();
  const keywords = [
    "confess",
    "betray",
    "reveal",
    "secret",
    "love",
    "hate",
    "kill",
    "death",
    "remember",
    "growth",
    "forgive",
    "alliance",
    "变强",
    "告白",
    "背叛",
    "秘密",
    "死亡",
    "原谅",
    "结盟",
  ];
  return keywords.some((item) => text.includes(item));
}

function needsSummary(story, messages, contextInfo) {
  const turns = messages.filter((item) => item.role !== "system").length;
  if (turns > 0 && turns % ((story.settings.summaryInterval || DEFAULT_SUMMARY_INTERVAL) * 2) === 0) {
    return true;
  }
  if (classifyPressure(contextInfo.usedTokens, contextInfo.maxTokens) === "high") {
    return true;
  }
  return detectMajorEvent(messages.slice(-4));
}

function getSummaryTriggers(story, messages, contextInfo) {
  const triggers = [];
  const turns = messages.filter((item) => item.role !== "system").length;
  const interval = (story.settings.summaryInterval || DEFAULT_SUMMARY_INTERVAL) * 2;
  if (turns > 0 && turns % interval === 0) {
    triggers.push(`Turn interval reached (${turns}/${interval})`);
  }
  if (classifyPressure(contextInfo.usedTokens, contextInfo.maxTokens) === "high") {
    triggers.push("Context pressure exceeded high threshold");
  }
  if (detectMajorEvent(messages.slice(-4))) {
    triggers.push("Major event keywords detected in recent turns");
  }
  return triggers;
}

function getHeuristicProposalTriggers(messages, assistantText = "") {
  const recentText = [...messages.slice(-4).map((item) => item.content), assistantText].join("\n").toLowerCase();
  const triggers = [];
  if (/(new recurring character|story-local character|新角色|新人物|角色卡|常驻角色)/i.test(recentText)) {
    triggers.push("New recurring character indicators detected");
  }
  if (/(relationship|alliance|betray|trust|mentor|lover|关系|同盟|信任|背叛|盟友)/i.test(recentText)) {
    triggers.push("Relationship change indicators detected");
  }
  if (/(world state|rule changed|setting changed|世界状态|规则改变|设定变化|局势变化)/i.test(recentText)) {
    triggers.push("World-state change indicators detected");
  }
  return triggers;
}

async function tryModelProposalTriggers(story, messages, workspace, assistantText) {
  const provider = getProviderForStory(story);
  if (!provider || !provider.encryptedApiKey || !story.model) {
    return getHeuristicProposalTriggers(messages, assistantText);
  }
  const apiKey = decryptSecret(provider.encryptedApiKey);
  if (!apiKey) {
    return getHeuristicProposalTriggers(messages, assistantText);
  }
  const prompt = [
    {
      role: "system",
      content:
        "Decide whether the latest story turn should trigger workspace proposal generation. Return compact JSON with keys: shouldGenerateProposal (boolean), triggers (string array). Trigger when the turn introduces a meaningful new recurring character, a durable relationship shift, a stable character-state update, a world-state change, or the user explicitly asks to remember or update story canon. Do not trigger for one-off flavor details.",
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          workspace: {
            characters: workspace.characters.map((item) => ({ id: item.id, name: item.name })),
            worldbooks: workspace.worldbooks.map((item) => ({ id: item.id, title: item.title })),
          },
          recentMessages: messages.slice(-6),
          assistantReply: assistantText,
        },
        null,
        2
      ),
    },
  ];
  try {
    const result = await callOpenAICompatible({
      baseUrl: provider.baseUrl,
      apiKey,
      model: story.model || provider.model,
      messages: prompt,
      temperature: 0.1,
      topP: 1,
      max_tokens: 160,
      responseFormat: { type: "json_object" },
    });
    const parsed = tryParseJsonObject(result.content);
    if (!parsed?.shouldGenerateProposal) {
      return [];
    }
    return Array.isArray(parsed.triggers) ? parsed.triggers.slice(0, 4).map((item) => String(item)) : ["AI proposal trigger approved"];
  } catch {
    return getHeuristicProposalTriggers(messages, assistantText);
  }
}

function inferMemoryKindFromSummary(summary, entities = []) {
  const text = String(summary || "").toLowerCase();
  const entityCount = Array.isArray(entities) ? entities.length : 0;
  const relationshipHints = [
    "relationship",
    "bond",
    "alliance",
    "rival",
    "trust",
    "mentor",
    "friend",
    "lover",
    "betray",
    "conflict",
    "关系",
    "同盟",
    "信任",
    "背叛",
    "敌对",
    "盟友",
  ];
  const worldHints = [
    "world",
    "city",
    "kingdom",
    "archive",
    "storm",
    "law",
    "rule",
    "setting",
    "commonwealth",
    "世界",
    "城市",
    "规则",
    "局势",
    "状态",
    "制度",
  ];
  const characterHints = [
    "realize",
    "decide",
    "growth",
    "fear",
    "resolve",
    "hesitate",
    "remember",
    "choose",
    "character",
    "角色",
    "成长",
    "决定",
    "犹豫",
    "记起",
    "心境",
  ];
  if (relationshipHints.some((item) => text.includes(item))) {
    return "relationship_update";
  }
  if (worldHints.some((item) => text.includes(item))) {
    return "world_state";
  }
  if (characterHints.some((item) => text.includes(item)) || entityCount > 0) {
    return "character_update";
  }
  return "plot_checkpoint";
}

function trimText(value, maxLength) {
  return summarizeText(String(value || "").trim(), maxLength);
}

function trimStringArray(values, itemLimit, maxItems) {
  if (!Array.isArray(values)) {
    return [];
  }
  return values
    .map((item) => trimText(item, itemLimit))
    .filter(Boolean)
    .slice(0, maxItems);
}

function trimStringMapValues(value, maxLength, maxItems = 12) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, maxItems)
      .map(([key, item]) => [String(key), trimText(item, maxLength)])
      .filter(([, item]) => item)
  );
}

function makeFallbackSummary(messages) {
  const recent = messages.slice(-8);
  const summary = recent
    .map((item) => `${item.role}: ${summarizeText(item.content, 90)}`)
    .join(" | ");
  const entities = Array.from(
    new Set(
      recent
        .flatMap((item) => String(item.content).match(/[A-Za-z][A-Za-z0-9_-]{2,}|[\u4e00-\u9fff]{2,4}/g) || [])
        .slice(0, 10)
    )
  );
  return {
    id: safeId("memory"),
    type: "checkpoint",
    tier: "short_term",
    kind: inferMemoryKindFromSummary(summary, entities),
    summary: summarizeText(summary, MEMORY_SUMMARY_CHAR_LIMIT),
    entities,
    keywords: extractKeywords(summary).slice(0, 12),
    importance: detectMajorEvent(recent) ? "high" : "medium",
    sourceMessageRange: [Math.max(1, messages.length - 7), messages.length],
    createdAt: new Date().toISOString(),
  };
}

function tryParseJsonObject(raw) {
  if (!raw) {
    return null;
  }
  const text = String(raw).trim();
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      return null;
    }
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

async function callOpenAICompatible({
  baseUrl,
  apiKey,
  model,
  messages,
  temperature,
  topP,
  max_tokens,
  responseFormat,
}) {
  const url = buildEndpointUrl(baseUrl, "chat/completions");
  const payload = {
    model,
    messages,
    temperature,
    top_p: topP,
    max_tokens,
    stream: false,
  };
  if (responseFormat) {
    payload.response_format = responseFormat;
  }
  const startedAt = Date.now();
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(json?.error?.message || `Provider error ${response.status}`);
  }
  const content = json?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("Provider returned empty content");
  }
  return {
    content,
    raw: json,
    meta: {
      endpoint: url,
      latencyMs: Date.now() - startedAt,
      status: response.status,
      promptMessages: messages.length,
    },
  };
}

async function streamOpenAICompatible({
  baseUrl,
  apiKey,
  model,
  messages,
  temperature,
  topP,
  max_tokens,
  signal,
}) {
  const url = buildEndpointUrl(baseUrl, "chat/completions");
  const payload = {
    model,
    messages,
    temperature,
    top_p: topP,
    max_tokens,
    stream: true,
  };
  const startedAt = Date.now();
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
    signal,
  });
  if (!response.ok) {
    const json = await response.json().catch(() => ({}));
    throw new Error(json?.error?.message || `Provider error ${response.status}`);
  }
  if (!response.body) {
    throw new Error("Provider streaming body is unavailable");
  }
  return {
    endpoint: url,
    startedAt,
    stream: response.body,
  };
}

function buildEndpointUrl(baseUrl, suffix) {
  const trimmedBase = String(baseUrl || "").trim();
  if (!trimmedBase) {
    throw new Error("Provider base URL is required");
  }
  const normalizedBase = trimmedBase.replace(/\/+$/, "");
  const normalizedSuffix = String(suffix || "").replace(/^\/+/, "");
  if (/(\/chat\/completions|\/messages|\/responses)$/i.test(normalizedBase)) {
    return normalizedBase;
  }
  return `${normalizedBase}/${normalizedSuffix}`;
}

async function testProviderConnection(provider, overrideModel) {
  const apiKey = decryptSecret(provider.encryptedApiKey);
  if (!apiKey) {
    return {
      ok: false,
      stage: "local",
      error: "Stored API key cannot be decrypted on this machine. Re-enter and save the key.",
    };
  }
  try {
    const result = await callOpenAICompatible({
      baseUrl: provider.baseUrl,
      apiKey,
      model: overrideModel || provider.model,
      messages: [
        { role: "system", content: "Reply with exactly: OK" },
        { role: "user", content: "connection test" },
      ],
      temperature: 0,
      topP: 1,
      max_tokens: 16,
    });
    return {
      ok: true,
      stage: "remote",
      replyPreview: summarizeText(result.content, 80),
      endpoint: result.meta.endpoint,
      latencyMs: result.meta.latencyMs,
    };
  } catch (error) {
    return {
      ok: false,
      stage: "remote",
      error: error.message || "Provider request failed",
    };
  }
}

async function tryModelSummary(story, messages) {
  const provider = getProviderForStory(story);
  if (!provider || !provider.encryptedApiKey || !story.model) {
    return null;
  }
  const apiKey = decryptSecret(provider.encryptedApiKey);
  if (!apiKey) {
    return null;
  }
  const prompt = [
    {
      role: "system",
      content:
        "Summarize recent story developments into compact JSON with keys: summary, entities, importance, kind. kind must be one of relationship_update, world_state, character_update, plot_checkpoint. Write summary as one terse factual sentence, ideally 30-90 Chinese characters or under 25 English words. Keep only the most durable change, avoid scene prose, avoid metaphors, avoid dialogue fragments, and avoid hedging. Keep entities as a short string array of at most 4 items.",
    },
    {
      role: "user",
      content: messages
        .slice(-8)
        .map((item) => `${item.role}: ${item.content}`)
        .join("\n"),
    },
  ];
  try {
    const result = await callOpenAICompatible({
      baseUrl: provider.baseUrl,
      apiKey,
      model: story.model || provider.model,
      messages: prompt,
      temperature: 0.2,
      topP: 1,
      max_tokens: 300,
      responseFormat: { type: "json_object" },
    });
    const parsed = tryParseJsonObject(result.content);
    if (!parsed?.summary) {
      return null;
    }
    return {
      id: safeId("memory"),
      type: "checkpoint",
      tier: "short_term",
      kind: ["relationship_update", "world_state", "character_update", "plot_checkpoint"].includes(parsed.kind)
        ? parsed.kind
        : inferMemoryKindFromSummary(parsed.summary, parsed.entities),
      summary: summarizeText(parsed.summary, MEMORY_SUMMARY_CHAR_LIMIT),
      entities: Array.isArray(parsed.entities) ? parsed.entities.slice(0, 4).map((item) => trimText(item, 24)).filter(Boolean) : [],
      keywords: extractKeywords(parsed.summary).slice(0, 12),
      importance: parsed.importance || "medium",
      sourceMessageRange: [Math.max(1, messages.length - 7), messages.length],
      createdAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

async function tryGenerateProposals(story, messages, workspace) {
  const provider = getProviderForStory(story);
  if (!provider || !provider.encryptedApiKey || !story.model) {
    return [];
  }
  const apiKey = decryptSecret(provider.encryptedApiKey);
  if (!apiKey) {
    return [];
  }
  const prompt = [
    {
      role: "system",
      content:
        "Review recent fictional story messages. Return JSON: { proposals: [{ action, targetType, targetId, reason, patch }] }. action must be update or create. Use update when an existing workspace item changed in a meaningful way. Only allow create for targetType=character when the story clearly introduces a meaningful new recurring character with stable traits, relationships, or future plot importance who should live only inside this story workspace. Do not create one-off extras. Keep every field compact and retrieval-friendly, not literary. reason must be one short sentence, ideally 20-60 Chinese characters or under 18 English words. For create character patches, include name, core, traits, relationships, arcState, and notes, but keep them terse: role short phrase, traits short keywords, relationships short labels, arcState.current one compact sentence, notes one compact sentence.",
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          workspace: {
            characters: workspace.characters.map((item) => ({
              id: item.id,
              name: item.name,
              arcState: item.arcState,
              relationships: item.relationships,
            })),
            worldbooks: workspace.worldbooks.map((item) => ({
              id: item.id,
              title: item.title,
              storyState: item.storyState,
              revealedFacts: item.revealedFacts,
            })),
          },
          recentMessages: messages.slice(-6),
        },
        null,
        2
      ),
    },
  ];
  try {
    const result = await callOpenAICompatible({
      baseUrl: provider.baseUrl,
      apiKey,
      model: story.model || provider.model,
      messages: prompt,
      temperature: 0.3,
      topP: 1,
      max_tokens: 500,
      responseFormat: { type: "json_object" },
    });
    const parsed = tryParseJsonObject(result.content);
    if (!Array.isArray(parsed?.proposals)) {
      return [];
    }
    const allowedTypes = new Set(["character", "worldbook", "style"]);
    return parsed.proposals
      .filter(
        (item) =>
          ["update", "create"].includes(item?.action || "update") &&
          allowedTypes.has(item?.targetType) &&
          item?.patch &&
          typeof item.patch === "object" &&
          !Array.isArray(item.patch) &&
          ((item?.action || "update") === "create"
            ? item.targetType === "character" && typeof item.patch?.name === "string"
            : typeof item?.targetId === "string")
      )
      .slice(0, 5)
      .map((item) => ({
        id: safeId("proposal"),
        action: item.action || "update",
        targetType: item.targetType,
        targetId:
          item.action === "create"
            ? item.targetId || slugify(item.patch?.name || "story-character")
            : item.targetId,
        reason: summarizeText(item.reason, PROPOSAL_REASON_CHAR_LIMIT),
        diff: item.patch,
        sourceRefs: messages.slice(-4).map((message) => message.id),
        status: "pending",
        createdAt: new Date().toISOString(),
      }));
  } catch {
    return [];
  }
}

function normalizeCreatedCharacter(targetId, patch) {
  const name = String(patch?.name || "").trim();
  if (!name) {
    throw new Error("Created character must have a name");
  }
  return {
    id: targetId || safeId("char"),
    name,
    core:
      patch?.core && typeof patch.core === "object" && !Array.isArray(patch.core)
        ? { ...patch.core, role: trimText(patch.core.role, CHARACTER_ROLE_CHAR_LIMIT) }
        : { role: "" },
    traits: trimStringArray(patch?.traits, CHARACTER_TRAIT_CHAR_LIMIT, 8),
    relationships: trimStringMapValues(patch?.relationships, CHARACTER_RELATIONSHIP_CHAR_LIMIT, 8),
    arcState:
      patch?.arcState && typeof patch.arcState === "object" && !Array.isArray(patch.arcState)
        ? { current: trimText(patch.arcState.current, CHARACTER_ARC_CHAR_LIMIT) }
        : { current: "" },
    notes: trimText(patch?.notes, CHARACTER_NOTES_CHAR_LIMIT),
    sourceId: null,
    sourceUpdatedAt: null,
    workspaceUpdatedAt: new Date().toISOString(),
    changeLog: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function validateProposalPayload(action, targetType, targetId, patch) {
  const allowedActions = new Set(["update", "create"]);
  if (!allowedActions.has(action || "update")) {
    throw new Error("Unsupported proposal action type");
  }
  const allowedTypes = new Set(["character", "worldbook", "style"]);
  if (!allowedTypes.has(targetType)) {
    throw new Error("Unsupported proposal target type");
  }
  if (!targetId || typeof targetId !== "string") {
    throw new Error("Proposal target id is required");
  }
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new Error("Proposal patch must be an object");
  }
  if ((action || "update") === "create" && targetType !== "character") {
    throw new Error("Only character creation proposals are supported");
  }
}

function updateWorkspaceItem(storyId, targetType, targetId, patch, reason) {
  validateProposalPayload("update", targetType, targetId, patch);
  const filePath = path.join(getStoryWorkspaceDir(storyId, `${targetType}s`), `${targetId}.json`);
  const current = readJson(filePath);
  if (!current) {
    throw new Error("Workspace item not found");
  }
  const updated = {
    ...current,
    ...patch,
    workspaceUpdatedAt: new Date().toISOString(),
    changeLog: [
      ...(current.changeLog || []),
      {
        at: new Date().toISOString(),
        reason,
        patch,
      },
    ],
  };
  writeJson(filePath, updated);
  return updated;
}

function createWorkspaceItem(storyId, targetType, targetId, patch, reason) {
  validateProposalPayload("create", targetType, targetId, patch);
  const story = getStory(storyId);
  if (!story) {
    throw new Error("Story not found");
  }
  if (targetType !== "character") {
    throw new Error("Only character creation proposals are supported");
  }
  const payload = normalizeCreatedCharacter(targetId, patch);
  payload.changeLog.push({
    at: new Date().toISOString(),
    reason,
    patch,
    action: "create",
  });
  const filePath = path.join(getStoryWorkspaceDir(storyId, "characters"), `${payload.id}.json`);
  if (fs.existsSync(filePath)) {
    throw new Error("Workspace item already exists");
  }
  writeJson(filePath, payload);
  const enabledCharacters = new Set(story.enabled?.characters || []);
  enabledCharacters.add(payload.id);
  saveStory({
    ...story,
    enabled: {
      ...story.enabled,
      characters: Array.from(enabledCharacters),
    },
    updatedAt: new Date().toISOString(),
  });
  return payload;
}

function initializeData() {
  ensureDir(DATA_DIR);
  ensureDir(CONFIG_DIR);
  ensureDir(LIBRARY_DIR);
  ensureDir(STORIES_DIR);
  ensureDir(path.join(LIBRARY_DIR, "characters"));
  ensureDir(path.join(LIBRARY_DIR, "worldbooks"));
  ensureDir(path.join(LIBRARY_DIR, "styles"));

  ensureFile(getProvidersFile(), "[]");
  ensureFile(getAppConfigFile(), JSON.stringify({ theme: "dark", lastOpenedStoryId: "" }, null, 2));
  ensureFile(getStoriesIndexFile(), "[]");

  const seedCharacter = path.join(LIBRARY_DIR, "characters", "hero_lyra.json");
  const seedWorld = path.join(LIBRARY_DIR, "worldbooks", "world_skyrail.json");
  const seedStyle = path.join(LIBRARY_DIR, "styles", "style_luminous.json");

  if (!fs.existsSync(seedCharacter)) {
    writeJson(seedCharacter, {
      id: "hero_lyra",
      name: "Lyra Wen",
      version: 1,
      core: { role: "Protagonist courier mage", age: 19, background: "Raised in the rain markets under the Skyrail." },
      traits: ["curious", "reckless", "soft-hearted"],
      relationships: { "Master Qiao": "mentor", "Jun Ash": "rival-ally" },
      arcState: { current: "Still doubts whether she deserves the map-key inheritance." },
      notes: "A silver compass warms when lost memories surface.",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  if (!fs.existsSync(seedWorld)) {
    writeJson(seedWorld, {
      id: "world_skyrail",
      title: "Skyrail Commonwealth",
      category: "setting",
      rules: ["Memory can be distilled into amber", "Never cross an unlicensed sky-bridge during red storm alerts"],
      content: "A chain of market-cities hanging from ancient rails above a drowned continent.",
      revealedFacts: ["The drowned continent still sends up radio signals at night."],
      storyState: "Peace is brittle after the Archive Fire.",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  if (!fs.existsSync(seedStyle)) {
    writeJson(seedStyle, {
      id: "style_luminous",
      name: "Luminous Adventure",
      tone: "wistful yet vivid",
      voice: "close third person with sensory detail",
      pacing: "scene-forward with emotional pauses",
      dos: ["Use concrete imagery", "Keep dialogue emotionally loaded"],
      donts: ["Avoid meta commentary", "Do not flatten tension too early"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }
}

function getStaticFile(filePath) {
  const fullPath = path.normalize(path.join(PUBLIC_DIR, filePath));
  if (!fullPath.startsWith(PUBLIC_DIR)) {
    return null;
  }
  if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
    return fullPath;
  }
  return null;
}

function serveStatic(req, res) {
  let pathname = new URL(req.url, "http://localhost").pathname;
  if (pathname === "/") {
    pathname = "/index.html";
  }
  const filePath = getStaticFile(pathname);
  if (!filePath) {
    return false;
  }
  const ext = path.extname(filePath).toLowerCase();
  const contentTypeMap = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
  };
  sendText(res, 200, fs.readFileSync(filePath, "utf8"), contentTypeMap[ext] || "text/plain; charset=utf-8");
  return true;
}

function replaceTemplate(template, userInput) {
  return String(template || "").replace(/\{\{user_input\}\}/g, userInput);
}

function getDefaultContextStatus(story) {
  return {
    usedTokens: 0,
    maxTokens: getProviderContextWindow(story),
    usedBlocks: 0,
    maxBlocks: story.settings?.contextBlocks ?? DEFAULT_CONTEXT_BLOCKS,
    pressureLevel: "low",
    forgetfulnessState: "normal",
    forgetfulnessReasons: [],
  };
}

function buildProposalPipelineStatus({
  stage = "idle",
  triggerCount = 0,
  generatedCount = 0,
  triggers = [],
  error = "",
} = {}) {
  return {
    stage,
    triggerCount,
    generatedCount,
    triggers,
    error,
    updatedAt: new Date().toISOString(),
  };
}

function reviseLastExchange(storyId, replacementMessage) {
  const story = getStory(storyId);
  if (!story) {
    throw new Error("Story not found");
  }

  const nextUserContent = String(replacementMessage || "").trim();
  if (!nextUserContent) {
    throw new Error("Message is required");
  }

  const messages = readJsonLines(getStoryMessagesFile(storyId));
  if (messages.length < 2) {
    throw new Error("No recent exchange to revise");
  }
  const lastAssistant = messages[messages.length - 1];
  const lastUser = messages[messages.length - 2];
  if (lastAssistant.role !== "assistant" || lastUser.role !== "user") {
    throw new Error("Only the latest user input can be revised");
  }

  writeJsonLines(getStoryMessagesFile(storyId), messages.slice(0, -2));

  const snapshots = readJsonLines(getStorySnapshotFile(storyId));
  const latestSnapshot = snapshots[snapshots.length - 1] || null;
  if (latestSnapshot) {
    writeJsonLines(getStorySnapshotFile(storyId), snapshots.slice(0, -1));

    const summaryIds = new Set(latestSnapshot.generatedSummaryIds || []);
    if (summaryIds.size > 0) {
      const consolidatedSourceIds = new Set(latestSnapshot.consolidatedMemorySourceIds || []);
      const supersededLongTermIds = new Set(latestSnapshot.supersededLongTermIds || []);
      const memory = readJsonLines(getStoryMemoryFile(storyId))
        .filter((item) => !summaryIds.has(item.id))
        .map((item) => {
          const next = { ...item };
          if (consolidatedSourceIds.has(item.id)) {
            delete next.mergedInto;
            delete next.mergedAt;
          }
          if (supersededLongTermIds.has(item.id)) {
            delete next.supersededBy;
            delete next.supersededAt;
          }
          return next;
        });
      writeJsonLines(getStoryMemoryFile(storyId), memory);
    }

    const proposalIds = new Set(latestSnapshot.generatedProposalIds || []);
    if (proposalIds.size > 0) {
      const proposals = readJsonLines(getStoryProposalFile(storyId)).filter((item) => !proposalIds.has(item.id));
      writeJsonLines(getStoryProposalFile(storyId), proposals);
    }
  }

  const remainingSnapshots = readJsonLines(getStorySnapshotFile(storyId));
  const previousSnapshot = remainingSnapshots[remainingSnapshots.length - 1] || null;
  saveStory({
    ...story,
    updatedAt: new Date().toISOString(),
    contextStatus: previousSnapshot?.contextStatus || getDefaultContextStatus(story),
  });

  return handleChat(storyId, { message: nextUserContent });
}

function buildChatContext(storyId, body) {
  const story = getStory(storyId);
  if (!story) {
    throw new Error("Story not found");
  }
  const provider = getProviderForStory(story);
  if (!provider) {
    throw new Error("No provider configured for this story");
  }
  const apiKey = decryptSecret(provider.encryptedApiKey);
  if (!apiKey) {
    throw new Error("Provider API key is unavailable");
  }

  syncStoryWorkspace(storyId);
  const workspace = {
    characters: loadActiveWorkspaceItems(storyId, "characters", story.enabled?.characters),
    worldbooks: loadActiveWorkspaceItems(storyId, "worldbooks", story.enabled?.worldbooks),
    styles: loadActiveWorkspaceItems(storyId, "styles", story.enabled?.styles),
  };
  const messages = readJsonLines(getStoryMessagesFile(storyId));
  const memoryRecords = readJsonLines(getStoryMemoryFile(storyId));
  const userMessage = {
    id: safeId("msg"),
    role: "user",
    content: String(body.message || "").trim(),
    createdAt: new Date().toISOString(),
  };
  if (!userMessage.content) {
    throw new Error("Message is required");
  }
  const nextMessages = [...messages, userMessage];
  const contextInfo = buildContextBlocks(story, nextMessages, memoryRecords, workspace, {
    currentUserInput: userMessage.content,
  });
  const summaryTriggers = getSummaryTriggers(story, nextMessages, contextInfo);
  const promptMessages = [
    ...contextInfo.blocks
      .filter((block) => block.label.startsWith("system"))
      .map((block) => ({ role: "system", content: block.content })),
    {
      role: "user",
      content: [
        "Active context:",
        ...contextInfo.blocks
          .filter((block) => !block.label.startsWith("system"))
          .map((block) => `[${block.label}]\n${block.content}`),
        "",
        replaceTemplate(story.promptConfig.userPromptTemplate, userMessage.content),
      ].join("\n\n"),
    },
  ];

  return {
    story,
    provider,
    apiKey,
    workspace,
    messages,
    memoryRecords,
    userMessage,
    nextMessages,
    contextInfo,
    summaryTriggers,
    promptMessages,
  };
}

async function finalizeChatTurn({
  storyId,
  story,
  provider,
  workspace,
  memoryRecords,
  nextMessages,
  userMessage,
  contextInfo,
  summaryTriggers,
  promptMessages,
  assistantText,
  completionMeta,
}) {
  appendJsonLine(getStoryMessagesFile(storyId), userMessage);
  const assistantMessage = {
    id: safeId("msg"),
    role: "assistant",
    content: assistantText,
    createdAt: new Date().toISOString(),
  };
  appendJsonLine(getStoryMessagesFile(storyId), assistantMessage);
  const fullMessages = [...nextMessages, assistantMessage];

  const summaryRecords = [];
  const proposalRecords = [];
  const proposalTriggers = await tryModelProposalTriggers(story, fullMessages, workspace, assistantText);
  let proposalPipeline = proposalTriggers.length
    ? buildProposalPipelineStatus({
        stage: "triggered",
        triggerCount: proposalTriggers.length,
        triggers: proposalTriggers,
      })
    : buildProposalPipelineStatus({
        stage: "not_triggered",
        triggerCount: 0,
        triggers: [],
      });
  const consolidatedMemoryRecords = [];
  const consolidatedMemorySourceIds = [];
  const supersededLongTermIds = [];
  if (summaryTriggers.length > 0) {
    const summary = (await tryModelSummary(story, fullMessages)) || makeFallbackSummary(fullMessages);
    summaryRecords.push(summary);

    const consolidation = consolidateMemoryRecords([...memoryRecords, ...summaryRecords], {
      now: new Date().toISOString(),
      makeId: safeId,
      shortTermThreshold: 8,
    });
    if (consolidation.addedRecords.length > 0) {
      consolidatedMemoryRecords.push(...consolidation.addedRecords);
      for (const item of consolidation.records) {
        if (item.mergedInto && consolidation.addedRecords.some((added) => added.id === item.mergedInto)) {
          consolidatedMemorySourceIds.push(item.id);
        }
        if (item.supersededBy && consolidation.addedRecords.some((added) => added.id === item.supersededBy)) {
          supersededLongTermIds.push(item.id);
        }
      }
    }
    writeJsonLines(getStoryMemoryFile(storyId), consolidation.records);

  }

  if (proposalTriggers.length > 0) {
    proposalPipeline = buildProposalPipelineStatus({
      stage: "generating",
      triggerCount: proposalTriggers.length,
      triggers: proposalTriggers,
    });
    try {
      const proposals = await tryGenerateProposals(story, fullMessages, workspace);
      for (const proposal of proposals) {
        appendJsonLine(getStoryProposalFile(storyId), proposal);
        proposalRecords.push(proposal);
      }
      proposalPipeline = buildProposalPipelineStatus({
        stage: proposals.length > 0 ? "queued" : "empty",
        triggerCount: proposalTriggers.length,
        generatedCount: proposals.length,
        triggers: proposalTriggers,
      });
    } catch (error) {
      proposalPipeline = buildProposalPipelineStatus({
        stage: "failed",
        triggerCount: proposalTriggers.length,
        generatedCount: 0,
        triggers: proposalTriggers,
        error: error.message || "Proposal generation failed",
      });
    }
  }

  const finalMemoryRecords = readJsonLines(getStoryMemoryFile(storyId));
  const forgetfulness = detectForgetfulness({
    workspace,
    memoryRecords: finalMemoryRecords,
    assistantText,
    contextInfo,
  });
  const updatedStory = {
    ...story,
    updatedAt: new Date().toISOString(),
    contextStatus: {
      usedTokens: contextInfo.usedTokens,
      maxTokens: contextInfo.maxTokens,
      usedBlocks: contextInfo.usedBlocks,
      maxBlocks: contextInfo.maxBlocks,
      pressureLevel: forgetfulness.pressureLevel,
      forgetfulnessState: forgetfulness.forgetfulnessState,
      forgetfulnessReasons: forgetfulness.forgetfulnessReasons,
    },
  };
  saveStory(updatedStory);

  const snapshot = {
    at: new Date().toISOString(),
    provider: {
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      model: story.model || provider.model,
    },
    requestMeta: {
      endpoint: completionMeta?.endpoint || buildEndpointUrl(provider.baseUrl, "chat/completions"),
      latencyMs: completionMeta?.latencyMs || null,
      promptMessages: completionMeta?.promptMessages || promptMessages.length,
      completionChars: assistantText.length,
    },
    contextStatus: updatedStory.contextStatus,
    summaryTriggers,
    proposalTriggers,
    proposalPipeline,
    usedLabels: contextInfo.blocks.map((block) => block.label),
    contextBlocks: contextInfo.blocks.map((block) => ({
      label: block.label,
      tokens: block.tokens,
      preview: summarizeText(block.content, 220),
    })),
    promptMessages,
    generatedSummaryIds: [...summaryRecords, ...consolidatedMemoryRecords].map((item) => item.id),
    consolidatedMemorySourceIds: Array.from(new Set(consolidatedMemorySourceIds)),
    supersededLongTermIds: Array.from(new Set(supersededLongTermIds)),
    generatedProposalIds: proposalRecords.map((item) => item.id),
    generatedSummaryCount: summaryRecords.length + consolidatedMemoryRecords.length,
    generatedProposalCount: proposalRecords.length,
  };
  appendJsonLine(getStorySnapshotFile(storyId), snapshot);

  return {
    message: assistantMessage,
    memoryRecords: [...summaryRecords, ...consolidatedMemoryRecords],
    proposals: proposalRecords,
    contextStatus: updatedStory.contextStatus,
    diagnostics: {
      latestSnapshot: snapshot,
      snapshotCount: readJsonLines(getStorySnapshotFile(storyId)).length,
      requestMeta: snapshot.requestMeta,
      summaryTriggers,
      proposalTriggers,
      proposalPipeline,
      usedLabels: snapshot.usedLabels,
      contextBlocks: snapshot.contextBlocks,
      generatedSummaryCount: summaryRecords.length,
      generatedProposalCount: proposalRecords.length,
    },
  };
}

async function handleChat(storyId, body) {
  let chat;
  try {
    chat = buildChatContext(storyId, body);
  } catch (error) {
    const status = error.message === "Story not found" ? 404 : 400;
    return jsonResponse(status, { error: error.message });
  }
  let assistantText;
  let completionMeta = null;
  try {
    const completion = await callOpenAICompatible({
      baseUrl: chat.provider.baseUrl,
      apiKey: chat.apiKey,
      model: chat.story.model || chat.provider.model,
      messages: chat.promptMessages,
      temperature: chat.story.settings.temperature,
      topP: chat.story.settings.topP,
      max_tokens: chat.story.settings.maxCompletionTokens,
    });
    assistantText = completion.content;
    completionMeta = completion.meta;
  } catch (error) {
    return jsonResponse(502, { error: error.message || "Chat request failed" });
  }
  const payload = await finalizeChatTurn({
    storyId,
    story: chat.story,
    provider: chat.provider,
    workspace: chat.workspace,
    memoryRecords: chat.memoryRecords,
    nextMessages: chat.nextMessages,
    userMessage: chat.userMessage,
    contextInfo: chat.contextInfo,
    summaryTriggers: chat.summaryTriggers,
    promptMessages: chat.promptMessages,
    assistantText,
    completionMeta,
  });
  return jsonResponse(200, payload);
}

async function handleChatStream(req, res, storyId, body) {
  let chat;
  try {
    chat = buildChatContext(storyId, body);
  } catch (error) {
    return sendJson(res, error.message === "Story not found" ? 404 : 400, { error: error.message });
  }

  const abortController = new AbortController();
  let clientClosed = false;
  req.on("close", () => {
    clientClosed = true;
    abortController.abort();
  });

  const sendEvent = (payload) => {
    if (!res.writableEnded) {
      res.write(`${JSON.stringify(payload)}\n`);
    }
  };

  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  sendEvent({
    type: "start",
    contextStatus: {
      usedTokens: chat.contextInfo.usedTokens,
      maxTokens: chat.contextInfo.maxTokens,
      usedBlocks: chat.contextInfo.usedBlocks,
      maxBlocks: chat.contextInfo.maxBlocks,
    },
  });

  let assistantText = "";
  let providerMeta = null;
  try {
    providerMeta = await streamOpenAICompatible({
      baseUrl: chat.provider.baseUrl,
      apiKey: chat.apiKey,
      model: chat.story.model || chat.provider.model,
      messages: chat.promptMessages,
      temperature: chat.story.settings.temperature,
      topP: chat.story.settings.topP,
      max_tokens: chat.story.settings.maxCompletionTokens,
      signal: abortController.signal,
    });

    const reader = providerMeta.stream.getReader();
    const decoder = new TextDecoder("utf8");
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith("data:")) {
          continue;
        }
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") {
          continue;
        }
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }
        const delta = parsed?.choices?.[0]?.delta?.content;
        const text = Array.isArray(delta) ? delta.map((part) => part?.text || "").join("") : delta;
        if (text) {
          assistantText += text;
          sendEvent({ type: "delta", text });
        }
      }
    }
  } catch (error) {
    if (abortController.signal.aborted || clientClosed) {
      sendEvent({ type: "aborted" });
      res.end();
      return;
    }
    sendEvent({ type: "error", error: error.message || "Streaming request failed" });
    res.end();
    return;
  }

  if (!assistantText.trim()) {
    sendEvent({ type: "error", error: "Provider returned empty content" });
    res.end();
    return;
  }

  try {
    const payload = await finalizeChatTurn({
      storyId,
      story: chat.story,
      provider: chat.provider,
      workspace: chat.workspace,
      memoryRecords: chat.memoryRecords,
      nextMessages: chat.nextMessages,
      userMessage: chat.userMessage,
      contextInfo: chat.contextInfo,
      summaryTriggers: chat.summaryTriggers,
      promptMessages: chat.promptMessages,
      assistantText,
      completionMeta: {
        endpoint: providerMeta.endpoint,
        latencyMs: Date.now() - providerMeta.startedAt,
        promptMessages: chat.promptMessages.length,
      },
    });
    sendEvent({ type: "done", payload });
  } catch (error) {
    sendEvent({ type: "error", error: error.message || "Failed to finalize chat turn" });
  }
  res.end();
}

async function routeApi(req, res) {
  const url = new URL(req.url, "http://localhost");
  const segments = url.pathname
    .split("/")
    .filter(Boolean)
    .map((segment, index) => (index === 0 ? segment : decodePathSegment(segment)));
  if (segments[0] !== "api") {
    return false;
  }

  try {
    if (req.method === "GET" && segments[1] === "bootstrap") {
      const stories = loadStoriesIndex().map((entry) => getStory(entry.id)).filter(Boolean);
      const providers = loadProviders().map((provider) => ({
        ...provider,
        encryptedApiKey: provider.encryptedApiKey ? { masked: true, decryptable: canDecryptSecret(provider.encryptedApiKey) } : null,
      }));
      const libraries = {
        characters: listJsonFiles(getLibraryTypeDir("characters")),
        worldbooks: listJsonFiles(getLibraryTypeDir("worldbooks")),
        styles: listJsonFiles(getLibraryTypeDir("styles")),
      };
      return sendJson(res, 200, {
        appConfig: readJson(getAppConfigFile(), {}),
        providers,
        stories,
        libraries,
      });
    }

    if (req.method === "POST" && segments[1] === "app-config") {
      const body = await parseBody(req);
      const current = readJson(getAppConfigFile(), {});
      const next = {
        ...current,
        ...body,
        theme: normalizeTheme(body.theme ?? current.theme),
      };
      writeJson(getAppConfigFile(), next);
      return sendJson(res, 200, next);
    }

    if (segments[1] === "providers") {
      if (req.method === "GET") {
        const providers = loadProviders().map((provider) => ({
          ...provider,
          encryptedApiKey: provider.encryptedApiKey ? { masked: true, decryptable: canDecryptSecret(provider.encryptedApiKey) } : null,
        }));
        return sendJson(res, 200, providers);
      }
      if (req.method === "POST" && segments[2] === "test") {
        const body = await parseBody(req);
        const providers = loadProviders();
        const provider = providers.find((item) => item.id === body.id);
        if (!provider) {
          return notFound(res);
        }
        const result = await testProviderConnection(provider, body.model);
        return sendJson(res, result.ok ? 200 : 400, result);
      }
      if (req.method === "POST") {
        const body = await parseBody(req);
        const providers = loadProviders();
        const existing = providers.find((item) => item.id === body.id);
        const payload = {
          id: body.id || safeId("provider"),
          name: body.name || "Custom Provider",
          baseUrl: body.baseUrl || "",
          model: body.model || "",
          contextWindow: Number.isFinite(Number(body.contextWindow)) ? Number(body.contextWindow) : 32000,
          params: {
            temperature: body.params?.temperature ?? 0.85,
            topP: body.params?.topP ?? 1,
            maxCompletionTokens: body.params?.maxCompletionTokens ?? DEFAULT_MAX_COMPLETION_TOKENS,
          },
          encryptedApiKey: body.apiKey ? encryptSecret(body.apiKey) : existing?.encryptedApiKey || null,
          updatedAt: new Date().toISOString(),
          createdAt: existing?.createdAt || new Date().toISOString(),
        };
        const next = [...providers.filter((item) => item.id !== payload.id), payload];
        saveProviders(next);
        return sendJson(res, 200, {
          ...payload,
          encryptedApiKey: payload.encryptedApiKey
            ? { masked: true, decryptable: canDecryptSecret(payload.encryptedApiKey) }
            : null,
        });
      }
    }

    if (segments[1] === "library" && segments[2]) {
      const type = segments[2];
      if (!isSupportedLibraryType(type)) {
        return sendJson(res, 400, { error: "Unsupported library type" });
      }
      if (req.method === "GET") {
        return sendJson(res, 200, listJsonFiles(getLibraryTypeDir(type)));
      }
      if (req.method === "POST") {
        const body = await parseBody(req);
        const item = saveLibraryItem(type, body);
        return sendJson(res, 200, item);
      }
      if (req.method === "DELETE" && segments[3]) {
        try {
          deleteLibraryItem(type, segments[3]);
        } catch (error) {
          if (error.message === "Library item not found") {
            return notFound(res);
          }
          throw error;
        }
        return sendJson(res, 200, { ok: true });
      }
    }

    if (segments[1] === "stories") {
      if (req.method === "GET" && segments.length === 2) {
        const stories = loadStoriesIndex().map((entry) => getStory(entry.id)).filter(Boolean);
        return sendJson(res, 200, stories);
      }
      if (req.method === "POST" && segments.length === 2) {
        const body = await parseBody(req);
        const story = createDefaultStory(body);
        return sendJson(res, 200, story);
      }
      if (segments[2]) {
        const storyId = segments[2];
        if (req.method === "DELETE" && segments.length === 3) {
          const story = getStory(storyId);
          if (!story) {
            return notFound(res);
          }
          deleteStory(storyId);
          return sendJson(res, 200, { ok: true, deletedId: storyId });
        }
        if (req.method === "GET" && segments.length === 3) {
          const story = getStory(storyId);
          if (!story) {
            return notFound(res);
          }
          syncStoryWorkspace(storyId);
          const workspace = {
            characters: loadActiveWorkspaceItems(storyId, "characters", story.enabled?.characters),
            worldbooks: loadActiveWorkspaceItems(storyId, "worldbooks", story.enabled?.worldbooks),
            styles: loadActiveWorkspaceItems(storyId, "styles", story.enabled?.styles),
          };
          const messages = readJsonLines(getStoryMessagesFile(storyId));
          const memoryRecords = readJsonLines(getStoryMemoryFile(storyId));
          const currentContextInfo = buildContextBlocks(story, messages, memoryRecords, workspace);
          const currentPromptMessages = [
            ...currentContextInfo.blocks
              .filter((block) => block.label.startsWith("system"))
              .map((block) => ({ role: "system", content: block.content })),
            {
              role: "user",
              content: [
                "Active context:",
                ...currentContextInfo.blocks
                  .filter((block) => !block.label.startsWith("system"))
                  .map((block) => `[${block.label}]\n${block.content}`),
                "",
                replaceTemplate(story.promptConfig?.userPromptTemplate || "", "[\u5f53\u524d\u7528\u6237\u8f93\u5165\u5c06\u63d2\u5165\u8fd9\u91cc]"),
              ].join("\n\n"),
            },
          ];
          const snapshots = readJsonLines(getStorySnapshotFile(storyId));
          return sendJson(res, 200, {
            story,
            messages,
            memoryRecords,
            proposals: readJsonLines(getStoryProposalFile(storyId)),
            diagnostics: {
              latestSnapshot: snapshots[snapshots.length - 1] || null,
              snapshotCount: snapshots.length,
              proposalPipeline: (snapshots[snapshots.length - 1] || null)?.proposalPipeline || null,
              currentContextPreview: {
                contextStatus: {
                  ...getDefaultContextStatus(story),
                  usedTokens: currentContextInfo.usedTokens,
                  maxTokens: currentContextInfo.maxTokens,
                  usedBlocks: currentContextInfo.usedBlocks,
                  maxBlocks: currentContextInfo.maxBlocks,
                  pressureLevel: classifyPressure(currentContextInfo.usedTokens, currentContextInfo.maxTokens),
                },
                contextBlocks: currentContextInfo.blocks.map((block) => ({
                  label: block.label,
                  tokens: block.tokens,
                  preview: summarizeText(block.content, 220),
                })),
                selectedMemoryRecords: currentContextInfo.selectedMemoryRecords.map((item) => ({
                  id: item.id,
                  tier: item.tier || "short_term",
                  kind: item.kind || "plot_checkpoint",
                  summary: item.summary,
                  importance: item.importance || "medium",
                  reasons: currentContextInfo.selectedMemoryReasons[item.id] || [],
                })),
                promptMessages: currentPromptMessages,
              },
            },
            workspace,
          });
        }
        if (req.method === "POST" && segments[3] === "config") {
          const body = await parseBody(req);
          const story = getStory(storyId);
          if (!story) {
            return notFound(res);
          }
          const next = {
            ...story,
            ...body,
            promptConfig: { ...story.promptConfig, ...(body.promptConfig || {}) },
            settings: { ...story.settings, ...(body.settings || {}) },
            enabled: { ...story.enabled, ...(body.enabled || {}) },
            updatedAt: new Date().toISOString(),
          };
          saveStory(next);
          syncStoryWorkspace(storyId);
          return sendJson(res, 200, next);
        }
        if (req.method === "POST" && segments[3] === "chat" && segments[4] === "revise-last") {
          const result = await reviseLastExchange(storyId, (await parseBody(req)).message);
          return sendJson(res, result.status, result.data);
        }
        if (req.method === "POST" && segments[3] === "chat" && segments[4] === "stream") {
          await handleChatStream(req, res, storyId, await parseBody(req));
          return true;
        }
        if (req.method === "POST" && segments[3] === "chat" && segments.length === 4) {
          const result = await handleChat(storyId, await parseBody(req));
          return sendJson(res, result.status, result.data);
        }
        if (req.method === "POST" && segments[3] === "proposals" && segments[4]) {
          const body = await parseBody(req);
          const proposalId = segments[4];
          const proposals = readJsonLines(getStoryProposalFile(storyId));
          const proposal = proposals.find((item) => item.id === proposalId);
          if (!proposal) {
            return notFound(res);
          }
          if (!["accept", "reject"].includes(body.action)) {
            return sendJson(res, 400, { error: "Unsupported proposal action" });
          }
          if (proposal.status && proposal.status !== "pending") {
            return sendJson(res, 409, { error: "Proposal has already been reviewed" });
          }
          if (body.action === "accept") {
            if ((proposal.action || "update") === "create") {
              createWorkspaceItem(storyId, proposal.targetType, proposal.targetId, proposal.diff, proposal.reason);
            } else {
              updateWorkspaceItem(storyId, proposal.targetType, proposal.targetId, proposal.diff, proposal.reason);
            }
          }
          proposal.status = body.action === "accept" ? "accepted" : "rejected";
          proposal.reviewedAt = new Date().toISOString();
          proposal.reviewNote = body.note || "";
          const filePath = getStoryProposalFile(storyId);
          fs.writeFileSync(filePath, `${proposals.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
          return sendJson(res, 200, { ok: true });
        }
      }
    }

    return notFound(res);
  } catch (error) {
    return sendJson(res, 500, { error: error.message || "Internal server error" });
  }
}

initializeData();

const server = http.createServer(async (req, res) => {
  const handledApi = await routeApi(req, res);
  if (handledApi !== false) {
    return;
  }
  if (serveStatic(req, res)) {
    return;
  }
  notFound(res);
});

const port = Number(process.env.PORT) || 3000;
server.listen(port, () => {
  console.log(`Story generator running at http://localhost:${port}`);
});
