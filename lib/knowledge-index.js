const crypto = require("crypto");
const { normalizeLongText, normalizeStringList, normalizeText, unique } = require("./text-utils");

function splitLongText(text, options = {}) {
  const normalized = normalizeLongText(text);
  if (!normalized) {
    return [];
  }
  const maxChars = Math.max(120, Number(options.maxChars) || 320);
  const overlap = Math.max(0, Number(options.overlap) || 48);
  const paragraphs = normalized.split(/\n{2,}/).map((item) => item.trim()).filter(Boolean);
  const segments = [];
  for (const paragraph of paragraphs.length ? paragraphs : [normalized]) {
    if (paragraph.length <= maxChars) {
      segments.push(paragraph);
      continue;
    }
    let start = 0;
    while (start < paragraph.length) {
      let end = Math.min(paragraph.length, start + maxChars);
      if (end < paragraph.length) {
        const boundary = Math.max(
          paragraph.lastIndexOf(". ", end),
          paragraph.lastIndexOf("? ", end),
          paragraph.lastIndexOf("! ", end),
          paragraph.lastIndexOf("。", end),
          paragraph.lastIndexOf("！", end),
          paragraph.lastIndexOf("？", end),
          paragraph.lastIndexOf("; ", end),
          paragraph.lastIndexOf("\n", end),
          paragraph.lastIndexOf(", ", end)
        );
        if (boundary > start + Math.floor(maxChars * 0.55)) {
          end = boundary + 1;
        }
      }
      const slice = paragraph.slice(start, end).trim();
      if (slice) {
        segments.push(slice);
      }
      if (end >= paragraph.length) {
        break;
      }
      start = Math.max(start + 1, end - overlap);
    }
  }
  return segments.filter(Boolean);
}

function groupListItems(items, options = {}) {
  const normalized = normalizeStringList(items);
  if (!normalized.length) {
    return [];
  }
  const maxChars = Math.max(120, Number(options.maxChars) || 240);
  const maxItems = Math.max(1, Number(options.maxItems) || 4);
  const groups = [];
  let current = [];
  let currentLength = 0;
  for (const item of normalized) {
    const nextLength = currentLength + (current.length ? 2 : 0) + item.length;
    if (current.length && (current.length >= maxItems || nextLength > maxChars)) {
      groups.push(current);
      current = [item];
      currentLength = item.length;
      continue;
    }
    current.push(item);
    currentLength = nextLength;
  }
  if (current.length) {
    groups.push(current);
  }
  return groups;
}

function hashText(value) {
  return crypto.createHash("sha1").update(String(value || "")).digest("hex");
}

function extractCompactListEntityLabel(value) {
  const text = normalizeLongText(value);
  if (!text) {
    return "";
  }
  const compact = text
    .split(/[:：;；,，。.!?？!]/)[0]
    .trim()
    .replace(/^[\-*#>\s]+/, "");
  if (!compact || compact.length > 18) {
    return "";
  }
  return compact;
}

function compareByStableId(left, right) {
  return String(left.id || left.name || left.title || "").localeCompare(String(right.id || right.name || right.title || ""));
}

function buildKnowledgeWorkspaceSignature(workspace = {}) {
  return {
    characters: [...(workspace.characters || [])].sort(compareByStableId).map((item) => ({
      id: item.id || "",
      name: item.name || "",
      role: item.core?.role || "",
      background: item.core?.background || "",
      traits: normalizeStringList(item.traits),
      relationships: Object.entries(item.relationships || {})
        .map(([name, value]) => [String(name || ""), String(value || "")])
        .sort((a, b) => a[0].localeCompare(b[0])),
      arc: item.arcState?.current || "",
      notes: normalizeLongText(item.notes),
    })),
    worldbooks: [...(workspace.worldbooks || [])].sort(compareByStableId).map((item) => ({
      id: item.id || "",
      title: item.title || "",
      category: item.category || "",
      rules: normalizeStringList(item.rules),
      storyState: item.storyState || "",
      content: normalizeLongText(item.content),
      revealedFacts: normalizeStringList(item.revealedFacts),
    })),
    styles: [...(workspace.styles || [])].sort(compareByStableId).map((item) => ({
      id: item.id || "",
      name: item.name || "",
      tone: item.tone || "",
      voice: item.voice || "",
      pacing: item.pacing || "",
      dos: normalizeStringList(item.dos),
      donts: normalizeStringList(item.donts),
    })),
  };
}

function buildKnowledgeWorkspaceHash(workspace = {}) {
  return hashText(JSON.stringify(buildKnowledgeWorkspaceSignature(workspace)));
}

function createKnowledgeChunk({
  id,
  sourceType,
  sourceId,
  title,
  chunkType,
  text,
  extractKeywords,
  entities = [],
  sequence = 1,
  workspaceHash = "",
  updatedAt = "",
  indexVersion = 1,
}) {
  const normalizedText = normalizeLongText(text);
  const normalizedEntities = unique([title, sourceId, ...entities].map((item) => String(item || "").trim()).filter(Boolean));
  return {
    id,
    sourceType,
    sourceId,
    title,
    chunkType,
    sequence: Number(sequence) || 1,
    text: normalizedText,
    keywords: unique(extractKeywords(normalizedText)),
    entities: normalizedEntities,
    embedding: null,
    workspaceHash: String(workspaceHash || ""),
    textHash: hashText(normalizedText),
    updatedAt: String(updatedAt || new Date().toISOString()),
    indexVersion: Number(indexVersion) || 1,
  };
}

function normalizeStoredKnowledgeChunk(item, extractKeywords) {
  if (!item || typeof item !== "object") {
    return null;
  }
  const text = normalizeLongText(item.text);
  if (!text) {
    return null;
  }
  return {
    id: String(item.id || ""),
    sourceType: String(item.sourceType || "knowledge"),
    sourceId: String(item.sourceId || ""),
    title: String(item.title || item.sourceId || ""),
    chunkType: String(item.chunkType || "context"),
    sequence: Number(item.sequence) || 1,
    text,
    keywords: unique(
      (Array.isArray(item.keywords) && item.keywords.length ? item.keywords : extractKeywords(text))
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    ),
    entities: unique((item.entities || []).map((value) => String(value || "").trim()).filter(Boolean)),
    embedding: Array.isArray(item.embedding) ? item.embedding : null,
    workspaceHash: String(item.workspaceHash || ""),
    textHash: String(item.textHash || hashText(text)),
    updatedAt: String(item.updatedAt || ""),
    indexVersion: Number(item.indexVersion) || 1,
  };
}

function buildSegmentedTextChunks(config) {
  const {
    idBase,
    sourceType,
    sourceId,
    title,
    chunkType,
    label,
    text,
    extractKeywords,
    entities = [],
    workspaceHash = "",
    updatedAt = "",
    indexVersion = 1,
    maxChars = 320,
  } = config;
  const segments = splitLongText(text, { maxChars, overlap: 56 });
  const sourceLabel = sourceType === "worldbook" ? "World" : sourceType === "style" ? "Style" : "Character";
  return segments.map((segment, index) =>
    createKnowledgeChunk({
      id: segments.length > 1 ? `${idBase}_${index + 1}` : idBase,
      sourceType,
      sourceId,
      title,
      chunkType,
      sequence: index + 1,
      text: [
        `${sourceLabel}: ${title}`,
        segments.length > 1 ? `${label} (part ${index + 1}/${segments.length}): ${segment}` : `${label}: ${segment}`,
      ].join("\n"),
      extractKeywords,
      entities,
      workspaceHash,
      updatedAt,
      indexVersion,
    })
  );
}

function buildListChunks(config) {
  const {
    idBase,
    sourceType,
    sourceId,
    title,
    chunkType,
    label,
    items,
    extractKeywords,
    entities = [],
    workspaceHash = "",
    updatedAt = "",
    indexVersion = 1,
    maxChars = 240,
    maxItems = 4,
    deriveGroupEntities = null,
  } = config;
  const groups = groupListItems(items, { maxChars, maxItems });
  const sourceLabel = sourceType === "worldbook" ? "World" : sourceType === "style" ? "Style" : "Character";
  return groups.map((group, index) =>
    createKnowledgeChunk({
      id: groups.length > 1 ? `${idBase}_${index + 1}` : idBase,
      sourceType,
      sourceId,
      title,
      chunkType,
      sequence: index + 1,
      text: [
        `${sourceLabel}: ${title}`,
        groups.length > 1 ? `${label} (part ${index + 1}/${groups.length}): ${group.join("; ")}` : `${label}: ${group.join("; ")}`,
      ].join("\n"),
      extractKeywords,
      entities:
        typeof deriveGroupEntities === "function"
          ? deriveGroupEntities(group, index)
          : entities,
      workspaceHash,
      updatedAt,
      indexVersion,
    })
  );
}

function createKnowledgeIndexTools({ extractKeywords, loadKnowledgeChunkIndex, saveKnowledgeChunkIndex }) {
  const KNOWLEDGE_INDEX_VERSION = 3;

  function buildKnowledgeChunks(workspace = {}, options = {}) {
    const chunks = [];
    const workspaceHash = String(options.workspaceHash || buildKnowledgeWorkspaceHash(workspace));
    const updatedAt = String(options.updatedAt || new Date().toISOString());

    for (const item of workspace.characters || []) {
      const sourceId = item.id || item.name || `character_${chunks.length}`;
      const title = item.name || item.id || "Character";
      const traits = normalizeStringList(item.traits);
      const relationshipEntries = Object.entries(item.relationships || {});
      const relationshipNames = relationshipEntries.map(([name]) => name);

      chunks.push(
        createKnowledgeChunk({
          id: `knowledge_character_identity_${sourceId}`,
          sourceType: "character",
          sourceId,
          title,
          chunkType: "identity",
          text: [
            `Character: ${title}`,
            `Role: ${item.core?.role || ""}`,
            `Background: ${item.core?.background || ""}`,
          ]
            .filter(Boolean)
            .join("\n"),
          extractKeywords,
          entities: [title, ...traits],
          workspaceHash,
          updatedAt,
          indexVersion: KNOWLEDGE_INDEX_VERSION,
        })
      );

      if (traits.length) {
        chunks.push(
          ...buildListChunks({
            idBase: `knowledge_character_traits_${sourceId}`,
            sourceType: "character",
            sourceId,
            title,
            chunkType: "traits",
            label: "Traits",
            items: traits,
            extractKeywords,
            entities: [title, ...traits],
            deriveGroupEntities: (group) => [
              title,
              ...group.map(extractCompactListEntityLabel).filter(Boolean),
            ],
            workspaceHash,
            updatedAt,
            indexVersion: KNOWLEDGE_INDEX_VERSION,
            maxChars: 180,
            maxItems: 5,
          })
        );
      }

      if (item.arcState?.current) {
        chunks.push(
          createKnowledgeChunk({
            id: `knowledge_character_arc_${sourceId}`,
            sourceType: "character",
            sourceId,
            title,
            chunkType: "arc",
            text: [`Character: ${title}`, `Arc: ${item.arcState.current}`].join("\n"),
            extractKeywords,
            entities: [title],
            workspaceHash,
            updatedAt,
            indexVersion: KNOWLEDGE_INDEX_VERSION,
          })
        );
      }

      if (relationshipEntries.length) {
        chunks.push(
          ...buildListChunks({
            idBase: `knowledge_character_relationships_${sourceId}`,
            sourceType: "character",
            sourceId,
            title,
            chunkType: "relationships",
            label: "Relationships",
            items: relationshipEntries.map(([name, value]) => `${name}=${value}`),
            extractKeywords,
            entities: [title, ...relationshipNames],
            deriveGroupEntities: (group) => [
              title,
              ...group
                .map((entry) => String(entry || "").split("=")[0].trim())
                .filter(Boolean),
            ],
            workspaceHash,
            updatedAt,
            indexVersion: KNOWLEDGE_INDEX_VERSION,
            maxChars: 220,
            maxItems: 4,
          })
        );
      }

      if (item.notes) {
        chunks.push(
          ...buildSegmentedTextChunks({
            idBase: `knowledge_character_notes_${sourceId}`,
            sourceType: "character",
            sourceId,
            title,
            chunkType: "notes",
            label: "Notes",
            text: item.notes,
            extractKeywords,
            entities: [title],
            workspaceHash,
            updatedAt,
            indexVersion: KNOWLEDGE_INDEX_VERSION,
            maxChars: 320,
          })
        );
      }
    }

    for (const item of workspace.worldbooks || []) {
      const sourceId = item.id || item.title || `world_${chunks.length}`;
      const title = item.title || item.id || "Worldbook";
      const rules = normalizeStringList(item.rules);
      const revealedFacts = normalizeStringList(item.revealedFacts);

      chunks.push(
        createKnowledgeChunk({
          id: `knowledge_world_identity_${sourceId}`,
          sourceType: "worldbook",
          sourceId,
          title,
          chunkType: "identity",
          text: [`World: ${title}`, `Category: ${item.category || ""}`].filter(Boolean).join("\n"),
          extractKeywords,
          entities: [title, item.category].filter(Boolean),
          workspaceHash,
          updatedAt,
          indexVersion: KNOWLEDGE_INDEX_VERSION,
        })
      );

      if (rules.length) {
        chunks.push(
          ...buildListChunks({
            idBase: `knowledge_world_rules_${sourceId}`,
            sourceType: "worldbook",
            sourceId,
            title,
            chunkType: "rules",
            label: "Rules",
            items: rules,
            extractKeywords,
            entities: [title],
            workspaceHash,
            updatedAt,
            indexVersion: KNOWLEDGE_INDEX_VERSION,
            maxChars: 260,
            maxItems: 4,
          })
        );
      }

      if (item.storyState) {
        chunks.push(
          createKnowledgeChunk({
            id: `knowledge_world_state_${sourceId}`,
            sourceType: "worldbook",
            sourceId,
            title,
            chunkType: "story_state",
            text: [`World: ${title}`, `Story State: ${item.storyState}`].join("\n"),
            extractKeywords,
            entities: [title],
            workspaceHash,
            updatedAt,
            indexVersion: KNOWLEDGE_INDEX_VERSION,
          })
        );
      }

      if (item.content) {
        chunks.push(
          ...buildSegmentedTextChunks({
            idBase: `knowledge_world_content_${sourceId}`,
            sourceType: "worldbook",
            sourceId,
            title,
            chunkType: "content",
            label: "Content",
            text: item.content,
            extractKeywords,
            entities: [title],
            workspaceHash,
            updatedAt,
            indexVersion: KNOWLEDGE_INDEX_VERSION,
            maxChars: 340,
          })
        );
      }

      if (revealedFacts.length) {
        chunks.push(
          ...buildListChunks({
            idBase: `knowledge_world_revealed_${sourceId}`,
            sourceType: "worldbook",
            sourceId,
            title,
            chunkType: "revealed",
            label: "Revealed",
            items: revealedFacts,
            extractKeywords,
            entities: [title],
            workspaceHash,
            updatedAt,
            indexVersion: KNOWLEDGE_INDEX_VERSION,
            maxChars: 260,
            maxItems: 4,
          })
        );
      }
    }

    for (const item of workspace.styles || []) {
      const sourceId = item.id || item.name || `style_${chunks.length}`;
      const title = item.name || item.id || "Style";
      chunks.push(
        createKnowledgeChunk({
          id: `knowledge_style_profile_${sourceId}`,
          sourceType: "style",
          sourceId,
          title,
          chunkType: "style_profile",
          text: [
            `Style: ${title}`,
            `Tone: ${item.tone || ""}`,
            `Voice: ${item.voice || ""}`,
            `Pacing: ${item.pacing || ""}`,
          ]
            .filter(Boolean)
            .join("\n"),
          extractKeywords,
          entities: [title, item.tone, item.voice].filter(Boolean),
          workspaceHash,
          updatedAt,
          indexVersion: KNOWLEDGE_INDEX_VERSION,
        })
      );
      if (normalizeStringList(item.dos).length) {
        chunks.push(
          ...buildListChunks({
            idBase: `knowledge_style_dos_${sourceId}`,
            sourceType: "style",
            sourceId,
            title,
            chunkType: "dos",
            label: "Dos",
            items: item.dos,
            extractKeywords,
            entities: [title, item.tone, item.voice].filter(Boolean),
            workspaceHash,
            updatedAt,
            indexVersion: KNOWLEDGE_INDEX_VERSION,
            maxChars: 220,
            maxItems: 4,
          })
        );
      }
      if (normalizeStringList(item.donts).length) {
        chunks.push(
          ...buildListChunks({
            idBase: `knowledge_style_donts_${sourceId}`,
            sourceType: "style",
            sourceId,
            title,
            chunkType: "donts",
            label: "Donts",
            items: item.donts,
            extractKeywords,
            entities: [title, item.tone, item.voice].filter(Boolean),
            workspaceHash,
            updatedAt,
            indexVersion: KNOWLEDGE_INDEX_VERSION,
            maxChars: 220,
            maxItems: 4,
          })
        );
      }
    }

    return chunks.filter((item) => item && item.text);
  }

  function ensureKnowledgeChunkIndex({ story, workspace }) {
    const workspaceHash = buildKnowledgeWorkspaceHash(workspace);
    const storyId = story?.id ? String(story.id) : "";
    const buildFreshChunks = () =>
      buildKnowledgeChunks(workspace, {
        workspaceHash,
        updatedAt: new Date().toISOString(),
      });

    if (!storyId || typeof loadKnowledgeChunkIndex !== "function" || typeof saveKnowledgeChunkIndex !== "function") {
      return {
        chunks: buildFreshChunks(),
        workspaceHash,
        indexSource: "runtime",
        indexRefreshed: false,
        indexVersion: KNOWLEDGE_INDEX_VERSION,
      };
    }

    const storedChunks = (loadKnowledgeChunkIndex(storyId) || [])
      .map((item) => normalizeStoredKnowledgeChunk(item, extractKeywords))
      .filter(Boolean);
    const storedVersion = Number(storedChunks[0]?.indexVersion || 0);
    const storedHash = String(storedChunks[0]?.workspaceHash || "");
    const canReuse =
      storedChunks.length > 0 &&
      storedVersion === KNOWLEDGE_INDEX_VERSION &&
      storedHash === workspaceHash &&
      storedChunks.every(
        (item) =>
          String(item.workspaceHash || "") === workspaceHash &&
          Number(item.indexVersion || 0) === KNOWLEDGE_INDEX_VERSION
      );
    if (canReuse) {
      return {
        chunks: storedChunks,
        workspaceHash,
        indexSource: "persisted",
        indexRefreshed: false,
        indexVersion: KNOWLEDGE_INDEX_VERSION,
      };
    }

    const nextChunks = buildFreshChunks();
    saveKnowledgeChunkIndex(storyId, nextChunks);
    return {
      chunks: nextChunks,
      workspaceHash,
      indexSource: storedChunks.length ? "refreshed" : "created",
      indexRefreshed: true,
      indexVersion: KNOWLEDGE_INDEX_VERSION,
    };
  }

  return {
    buildKnowledgeChunks,
    buildKnowledgeWorkspaceHash,
    ensureKnowledgeChunkIndex,
    indexVersion: KNOWLEDGE_INDEX_VERSION,
  };
}

module.exports = {
  createKnowledgeIndexTools,
};
