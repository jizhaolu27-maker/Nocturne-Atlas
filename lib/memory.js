const { consolidateMemoryRecords } = require("./memory-consolidation");
const { extractKeywords, formatMemoryContext, selectRelevantMemoryRecords } = require("./memory-engine");
const { createMemoryChunkTools } = require("./memory-chunks");
const { createMemoryForgetfulnessTools } = require("./memory-forgetfulness");
const { createMemorySummaryTools } = require("./memory-summary");

function createMemoryTools({
  DEFAULT_SUMMARY_INTERVAL,
  MEMORY_SUMMARY_CHAR_LIMIT,
  classifyPressure,
  summarizeText,
  safeId,
  getProviderForStory,
  decryptSecret,
  callOpenAICompatible,
  tryParseJsonObject,
  embedText,
  embedTextDetailed,
  buildMemoryEmbeddingText,
  resolveEmbeddingOptions,
}) {
  const forgetfulnessTools = createMemoryForgetfulnessTools({
    classifyPressure,
  });

  const summaryTools = createMemorySummaryTools({
    DEFAULT_SUMMARY_INTERVAL,
    MEMORY_SUMMARY_CHAR_LIMIT,
    classifyPressure,
    summarizeText,
    safeId,
    getProviderForStory,
    decryptSecret,
    callOpenAICompatible,
    tryParseJsonObject,
    embedText,
    embedTextDetailed,
    buildMemoryEmbeddingText,
    resolveEmbeddingOptions,
    buildWorkspaceEntityIndex: forgetfulnessTools.buildWorkspaceEntityIndex,
  });

  const chunkTools = createMemoryChunkTools({
    summarizeText,
    safeId,
    extractKeywords,
    embedText,
    embedTextDetailed,
    buildMemoryEmbeddingText,
    resolveEmbeddingOptions,
    stripLeadingDialogueMarker: summaryTools.stripLeadingDialogueMarker,
    isProbablyDialogueClause: summaryTools.isProbablyDialogueClause,
    looksLikeSummaryFact: summaryTools.looksLikeSummaryFact,
    looksLikeUserIntentClause: summaryTools.looksLikeUserIntentClause,
  });

  async function generateMemoryUpdate({ story, fullMessages, memoryRecords, memoryChunks = [], workspace, summaryTriggers }) {
    const summarySchedule = summaryTools.getSummarySchedule(story, fullMessages);
    const summaryRecords = [];
    const summaryChunks = [];
    const episodicChunks = [];
    const consolidatedMemoryRecords = [];
    const consolidatedMemorySourceIds = [];
    const supersededLongTermIds = [];
    const transientMemoryCandidate =
      (await summaryTools.buildEpisodicMemoryCandidate(story, fullMessages, workspace)) ||
      (await summaryTools.buildTransientMemoryCandidate(story, fullMessages, workspace)) ||
      null;
    let nextRecords = Array.isArray(memoryRecords) ? memoryRecords.slice() : [];

    if (transientMemoryCandidate) {
      episodicChunks.push(
        ...(await chunkTools.buildMemoryEvidenceChunks({
          story,
          messages: fullMessages,
          record: transientMemoryCandidate,
          messageLimit: 2,
          maxItems: 3,
          linkedRecordId: "",
          allowUnlinked: true,
          chunkType: "memory_episode",
        }))
      );
    }

    if (summaryTriggers.length > 0) {
      const summary =
        (await summaryTools.tryModelSummary(story, fullMessages, workspace)) ||
        (await summaryTools.buildMemoryCandidateFromMessages(story, fullMessages, workspace));
      summary.triggeredBy = summaryTriggers.slice();
      summary.triggeredAt = {
        messageCount: summarySchedule.currentMessageCount,
        round: summarySchedule.currentRounds,
      };
      summary.schedule = {
        configuredRounds: summarySchedule.configuredRounds,
        intervalMessages: summarySchedule.intervalMessages,
      };
      summaryRecords.push(summary);
      summaryChunks.push(
        ...(await chunkTools.buildMemoryEvidenceChunks({
          story,
          messages: fullMessages,
          record: summary,
        }))
      );

      const consolidation = consolidateMemoryRecords([...memoryRecords, ...summaryRecords], {
        now: new Date().toISOString(),
        makeId: safeId,
        shortTermThreshold: 8,
      });
      nextRecords = consolidation.records;
      if (consolidation.addedRecords.length > 0) {
        for (const item of consolidation.addedRecords) {
          item.triggeredBy = ["Memory consolidation threshold reached"];
          item.triggeredAt = {
            messageCount: summarySchedule.currentMessageCount,
            round: summarySchedule.currentRounds,
          };
          item.schedule = {
            configuredRounds: summarySchedule.configuredRounds,
            intervalMessages: summarySchedule.intervalMessages,
          };
        }
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
    }

    const chunkMerge = chunkTools.mergeMemoryChunks(memoryChunks, [...episodicChunks, ...summaryChunks]);
    const acceptedChunkIds = new Set(chunkMerge.addedChunks.map((item) => item.id));

    return {
      summarySchedule,
      summaryRecords,
      summaryChunks: summaryChunks.filter((item) => acceptedChunkIds.has(item.id)),
      episodicChunks: episodicChunks.filter((item) => acceptedChunkIds.has(item.id)),
      consolidatedMemoryRecords,
      consolidatedMemorySourceIds: Array.from(new Set(consolidatedMemorySourceIds)),
      supersededLongTermIds: Array.from(new Set(supersededLongTermIds)),
      records: nextRecords,
      chunks: chunkMerge.chunks,
      transientMemoryCandidate,
    };
  }

  return {
    extractKeywords,
    formatMemoryContext,
    selectRelevantMemoryRecords,
    detectForgetfulness: forgetfulnessTools.detectForgetfulness,
    getSummaryTriggers: summaryTools.getSummaryTriggers,
    getSummarySchedule: summaryTools.getSummarySchedule,
    tryModelSummary: summaryTools.tryModelSummary,
    buildTransientMemoryCandidate: summaryTools.buildTransientMemoryCandidate,
    generateMemoryUpdate,
  };
}

module.exports = {
  createMemoryTools,
};
