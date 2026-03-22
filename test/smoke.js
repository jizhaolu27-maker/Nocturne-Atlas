const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createStoryStore } = require("../lib/story-store");
const { createWorkspaceTools } = require("../lib/workspace");
const { createContextTools } = require("../lib/context");
const { createMemoryTools } = require("../lib/memory");
const { createProposalTools } = require("../lib/proposals");

const DEFAULT_CONTEXT_BLOCKS = 6;
const DEFAULT_SUMMARY_INTERVAL = 4;
const DEFAULT_MAX_COMPLETION_TOKENS = 900;

function summarizeText(value, maxLength) {
  const text = String(value || "").trim();
  if (!maxLength || text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 1))}...`;
}

function slugify(input) {
  return String(input || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50) || `story-${Date.now()}`;
}

let idCounter = 0;
function safeId(prefix) {
  idCounter += 1;
  return `${prefix}_${idCounter}`;
}

function createTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nocturne-atlas-test-"));
}

function createStoreHarness(rootDir) {
  const DATA_DIR = path.join(rootDir, "data");
  const CONFIG_DIR = path.join(DATA_DIR, "config");
  const LIBRARY_DIR = path.join(DATA_DIR, "library");
  const STORIES_DIR = path.join(DATA_DIR, "stories");

  let workspaceTools = null;
  const storyStore = createStoryStore({
    DATA_DIR,
    CONFIG_DIR,
    LIBRARY_DIR,
    STORIES_DIR,
    DEFAULT_CONTEXT_BLOCKS,
    DEFAULT_SUMMARY_INTERVAL,
    DEFAULT_MAX_COMPLETION_TOKENS,
    safeId,
    slugify,
    getSyncStoryWorkspace: () => workspaceTools,
  });

  workspaceTools = createWorkspaceTools({
    getLibraryTypeDir: storyStore.getLibraryTypeDir,
    getStoryWorkspaceDir: storyStore.getStoryWorkspaceDir,
    getStory: storyStore.getStory,
    readJson: storyStore.readJson,
    writeJson: storyStore.writeJson,
    listJsonFiles: storyStore.listJsonFiles,
  });

  return {
    ...storyStore,
    workspaceTools,
  };
}

function buildMemoryTools() {
  return createMemoryTools({
    DEFAULT_SUMMARY_INTERVAL,
    MEMORY_SUMMARY_CHAR_LIMIT: 160,
    classifyPressure: (usedTokens, maxTokens) => {
      const ratio = maxTokens ? usedTokens / maxTokens : 0;
      if (ratio >= 0.82) {
        return "high";
      }
      if (ratio >= 0.6) {
        return "medium";
      }
      return "low";
    },
    summarizeText,
    safeId,
    getProviderForStory: () => null,
    decryptSecret: () => "",
    callOpenAICompatible: async () => {
      throw new Error("Provider should not be called in smoke tests");
    },
    tryParseJsonObject: (value) => {
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    },
  });
}

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  }
}

async function main() {
  await runTest("story-store creates a story and syncs enabled library items", () => {
    const rootDir = createTempRoot();
    try {
      const harness = createStoreHarness(rootDir);
      harness.saveLibraryItem("characters", {
        id: "char_hero",
        name: "Hero",
        traits: ["brave"],
        updatedAt: "2026-03-23T00:00:00.000Z",
        createdAt: "2026-03-23T00:00:00.000Z",
      });

      const story = harness.createDefaultStory({
        title: "Smoke Story",
        enabled: { characters: ["char_hero"], worldbooks: [], styles: [] },
      });

      const workspaceCharacter = harness.readJson(
        path.join(harness.getStoryWorkspaceDir(story.id, "characters"), "char_hero.json")
      );

      assert.equal(story.title, "Smoke Story");
      assert.equal(workspaceCharacter.name, "Hero");
      assert.equal(workspaceCharacter.sourceId, "char_hero");
      assert.deepEqual(
        harness.workspaceTools.loadActiveWorkspaceItems(story.id, "characters", story.enabled.characters).map((item) => item.id),
        ["char_hero"]
      );
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  await runTest("context tools assemble system, workspace, memory, and history blocks", () => {
    const contextTools = createContextTools({
      DEFAULT_CONTEXT_BLOCKS,
      estimateTokens: (value) => Math.max(1, Math.ceil(String(value || "").length / 4)),
      selectRelevantMemoryRecords: (memoryRecords) => ({
        selectedRecords: memoryRecords.slice(0, 1),
        reasonsById: memoryRecords[0] ? { [memoryRecords[0].id]: ["keyword match"] } : {},
      }),
      formatMemoryContext: (records) => records.map((item) => item.summary).join("\n"),
      getProviderContextWindow: () => 2000,
    });

    const story = {
      promptConfig: {
        globalSystemPrompt: "Global prompt",
        storySystemPrompt: "Story prompt",
      },
      settings: { contextBlocks: 3 },
    };
    const workspace = {
      characters: [{ name: "Hero", core: { role: "lead" }, traits: ["brave"], arcState: { current: "chooses duty" }, relationships: { Mira: "ally" }, notes: "Carries a silver compass." }],
      worldbooks: [{ title: "Nocturne City", category: "city", rules: ["Never cross the red bridge"], content: "A rain-soaked city.", revealedFacts: ["The archive sleeps"], storyState: "Unrest is rising" }],
      styles: [{ name: "Velvet Gothic", tone: "lush", voice: "close third", pacing: "measured", dos: ["Use concrete imagery"], donts: ["Break canon"] }],
    };
    const messages = [
      { role: "user", content: "Continue the story." },
      { role: "assistant", content: "Hero finds the archive key." },
    ];
    const memoryRecords = [{ id: "mem_1", summary: "Hero learned Mira guards the archive." }];

    const result = contextTools.buildContextBlocks(story, messages, memoryRecords, workspace);
    const labels = result.blocks.map((item) => item.label);

    assert.ok(labels.includes("system:global"));
    assert.ok(labels.includes("system:story"));
    assert.ok(labels.includes("characters"));
    assert.ok(labels.includes("worldbook"));
    assert.ok(labels.includes("style"));
    assert.ok(labels.includes("memory"));
    assert.ok(labels.some((label) => label.startsWith("history_turn:")));
    assert.equal(result.selectedMemoryRecords[0].id, "mem_1");
  });

  await runTest("memory tools compute schedules and create a non-transcript fallback summary", async () => {
    const memoryTools = buildMemoryTools();
    const story = {
      settings: { summaryInterval: 3 },
      providerId: "",
      model: "",
    };
    const fullMessages = [
      { role: "user", content: "Continue the story." },
      { role: "assistant", content: "Mira reveals she once mentored Ava, and their alliance begins to recover." },
      { role: "user", content: "What changes next?" },
      { role: "assistant", content: "Ava accepts the truth and the two decide to protect the archive together." },
    ];

    const schedule = memoryTools.getSummarySchedule(story, fullMessages);
    const update = await memoryTools.generateMemoryUpdate({
      story,
      fullMessages,
      memoryRecords: [],
      workspace: { characters: [], worldbooks: [], styles: [] },
      summaryTriggers: ["Manual smoke trigger"],
    });

    assert.equal(schedule.configuredRounds, 3);
    assert.equal(schedule.intervalMessages, 6);
    assert.equal(schedule.currentMessageCount, 4);
    assert.equal(update.summaryRecords.length, 1);
    assert.ok(update.summaryRecords[0].summary);
    assert.ok(!update.summaryRecords[0].summary.includes("user:"));
    assert.ok(!update.summaryRecords[0].summary.includes("assistant:"));
    assert.deepEqual(update.summaryRecords[0].triggeredBy, ["Manual smoke trigger"]);
  });

  await runTest("proposal review accepts a create proposal into workspace and story enablement", () => {
    const rootDir = createTempRoot();
    try {
      const harness = createStoreHarness(rootDir);
      const proposalTools = createProposalTools({
        PROPOSAL_REASON_CHAR_LIMIT: 90,
        CHARACTER_ROLE_CHAR_LIMIT: 40,
        CHARACTER_TRAIT_CHAR_LIMIT: 24,
        CHARACTER_RELATIONSHIP_CHAR_LIMIT: 80,
        CHARACTER_ARC_CHAR_LIMIT: 140,
        CHARACTER_NOTES_CHAR_LIMIT: 120,
        safeId,
        slugify,
        summarizeText,
        getProviderForStory: () => null,
        decryptSecret: () => "",
        callOpenAICompatible: async () => {
          throw new Error("Provider should not be called in smoke tests");
        },
        tryParseJsonObject: (value) => {
          try {
            return JSON.parse(value);
          } catch {
            return null;
          }
        },
        readJson: harness.readJson,
        writeJson: harness.writeJson,
        readJsonLines: harness.readJsonLines,
        writeJsonLines: harness.writeJsonLines,
        getStory: harness.getStory,
        saveStory: harness.saveStory,
        getStoryProposalFile: harness.getStoryProposalFile,
        getStoryWorkspaceDir: harness.getStoryWorkspaceDir,
      });

      const story = harness.createDefaultStory({ title: "Proposal Smoke" });
      harness.writeJsonLines(harness.getStoryProposalFile(story.id), [
        {
          id: "proposal_1",
          action: "create",
          targetType: "character",
          targetId: "char_shade",
          reason: "New recurring character is now canon.",
          diff: {
            name: "Shade",
            core: { role: "dream guide" },
            traits: ["calm", "secretive"],
            relationships: { Ava: "mentor" },
            arcState: { current: "Steps out of rumor into reality." },
            notes: "Keeps appearing at the archive stairs.",
          },
          status: "pending",
          createdAt: "2026-03-23T00:00:00.000Z",
        },
      ]);

      const reviewed = proposalTools.reviewProposal(story.id, "proposal_1", "accept", "smoke");
      const updatedStory = harness.getStory(story.id);
      const workspaceCharacter = harness.readJson(
        path.join(harness.getStoryWorkspaceDir(story.id, "characters"), "char_shade.json")
      );
      const storedProposal = harness.readJsonLines(harness.getStoryProposalFile(story.id))[0];

      assert.equal(reviewed.status, "accepted");
      assert.equal(workspaceCharacter.name, "Shade");
      assert.ok(updatedStory.enabled.characters.includes("char_shade"));
      assert.equal(storedProposal.reviewNote, "smoke");
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  if (!process.exitCode) {
    console.log("Smoke tests completed successfully.");
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
