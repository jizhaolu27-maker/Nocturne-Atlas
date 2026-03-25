# Nocturne Atlas

[简体中文 README](./README.zh-CN.md)

**Nocturne Atlas** is a local, zero-build AI fiction workspace for long-running stories.

It is built for writers who want more than a single chat box. Each story keeps its own isolated canon, editable workspace, memory trail, diagnostics, and proposal review flow.

## Highlights

- Per-story isolated workspaces for characters, worldbooks, and style profiles
- Immutable source library assets plus story-local working copies
- Streaming chat with stop control and last-turn revise
- Memory checkpoints stored as readable local JSONL
- Proposal-based canon updates instead of silent auto-merges
- Diagnostics for context pressure, retrieval behavior, prompt sources, and forgetfulness risk
- OpenAI-compatible chat-completions provider support with locally encrypted API keys
- Reasoning-effort support for compatible thinking models on chat-completions-style endpoints
- Always-on memory RAG and knowledge RAG with no remote embedding API
- Static browser UI with no frontend build step

## Quick Start

### Requirements

- Node.js 18+

### Install

```bash
npm install
```

### Run

```bash
npm start
```

Open:

```text
http://localhost:3000
```

### Test

```bash
npm test
```

## First-Run Workflow

1. Create or open a story.
2. Enable the characters, worldbooks, and style profile that story should use.
3. Configure an OpenAI-compatible provider and choose a model.
4. Chat in the browser UI.
5. Review memory records, proposal suggestions, and diagnostics as the story evolves.
6. Accept only the workspace updates that should become canon for that story.

## Core Concepts

### Source Library vs Story Workspace

- `data/library/*` stores reusable source assets.
- `data/stories/<storyId>/workspace/*` stores mutable story-local copies.
- Story progression never mutates the source library.
- Accepted proposals update only the active story workspace.

### Memory

- The app can summarize turns into compact memory records.
- Records are written to `data/stories/<storyId>/memory/records.jsonl`.
- Supporting evidence chunks are also written to `data/stories/<storyId>/memory/chunks.jsonl`.
- Retrieval can inject long-term, critical, and recent memory blocks back into the prompt.
- Memory retrieval always runs through Memory RAG, which can also inject retrieved evidence chunks alongside stable memory facts.

### Proposals

- The model can suggest structured workspace updates instead of silently rewriting canon.
- Proposal acceptance updates story-local cards only.
- Rejected proposals stay out of the active workspace.

### Diagnostics

The Diagnostics panel helps explain what the model actually saw.

Common labels:

- `Character anchors`, `Worldbook anchors`, `Style anchors`
  Stable prompt anchors derived from enabled assets
- `Retrieved knowledge chunks`
  On-demand knowledge snippets recalled from workspace assets
- `Critical memory`, `Recent memory`
  Memory blocks injected into the current prompt

## Retrieval And Local RAG

Nocturne Atlas separates **memory retrieval** from **knowledge retrieval**.

Memory retrieval now always uses **Memory RAG** with automatic lexical and embedding fallback.

Knowledge retrieval now also always uses **Knowledge RAG**. Semantic retrieval runs first, and lexical chunk recall only fills in when embeddings are unavailable or semantic matches are too weak.

### Memory RAG

Memory RAG keeps the stable summary-record layer while also recalling evidence chunks when they help.

- Stable memory facts still protect canon continuity
- Evidence chunks let retrieval re-introduce concrete scene facts
- When embeddings are unavailable, the same Memory-RAG path falls back to lexical recall instead of breaking

### Knowledge RAG

Knowledge RAG keeps character, worldbook, and style anchors intentionally light and lets retrieved knowledge chunks carry the detailed facts.

- Semantic chunk retrieval searches the whole workspace corpus
- Lexical chunk recall only fills the gaps when semantic retrieval is unavailable or too weak
- Local embeddings improve semantic reach, but the fallback path still keeps the app usable offline or on a cold machine

### Local Embeddings

The app can run a fully local embedding path without a remote embedding API.

Current local embedding path:

- Backend: `@xenova/transformers`
- Default model: `Xenova/all-MiniLM-L6-v2`
- Optional mirror host: configurable in `Providers & Retrieval -> Local Embedding Mirror`
- Fallback: deterministic local `hash_v1` vectors when neural inference is unavailable

### Enabling The Local-RAG-Style Path

After cloning:

1. Run `npm install`
2. Start the app with `npm start`
3. Set `Global Local Embeddings` to `On`
4. If Hugging Face is slow or blocked on your network, set `Local Embedding Mirror` to a reachable mirror such as `https://hf-mirror.com/`
5. Click `Prewarm Local Embedding Model` once

### What Prewarm Does

- It performs one real local embedding call.
- On a fresh machine, this is when the local model files are downloaded.
- It warms the local cache before the first real retrieval-heavy turn.
- It reports success only when a real neural embedding vector is produced.
- If neural loading fails, the app reports the failure instead of pretending the model is ready.

## Configuration Model

There are two levels of settings:

- Global defaults
  Apply to all stories unless a story overrides them
- Story overrides
  Let one story use a different provider or embedding mode

This applies to:

- provider/model choice
- reasoning effort
- local embedding mode

## Providers

The app currently targets OpenAI-compatible **chat completions** APIs.

You can configure:

- base URL
- model name
- context window
- API key
- reasoning effort for compatible thinking models

Provider keys are stored locally and encrypted at rest.

## Data Layout

The app keeps data local and human-readable where possible.

```text
data/library/characters/                 Source character assets
data/library/worldbooks/                 Source worldbook assets
data/library/styles/                     Source style assets
data/stories/<storyId>/workspace/        Story-local working copies
data/stories/<storyId>/messages.jsonl    Chat transcript
data/stories/<storyId>/memory/records.jsonl
data/stories/<storyId>/memory/chunks.jsonl
data/stories/<storyId>/proposals/records.jsonl
data/stories/<storyId>/snapshots/context.jsonl
```

Notes:

- `data/stories/` is ignored by Git in this repository setup
- local model caches are also ignored by Git
- other users need to build their own local story data and local embedding cache after cloning

## Project Structure

```text
server.js                         Backend composition root and startup
lib/http.js                       HTTP helpers and static file serving
lib/server-config.js              App config, story config, and embedding runtime helpers
lib/api-router.js                 API route matching and resource handlers
lib/providers.js                  Provider helpers and OpenAI-compatible transport
lib/story-store.js                Story, library, config, JSON, and JSONL storage helpers
lib/workspace.js                  Story workspace sync and loading helpers
lib/context.js                    Context block assembly and prompt-shaping helpers
lib/chat.js                       Chat orchestration, streaming endpoints, revise flow, and story preview helpers
lib/chat-context.js               Prompt resolution, workspace loading, and chat context assembly
lib/chat-grounding.js             Grounding input shaping and conservative auto-repair helpers
lib/chat-revise.js                Revise rollback, proposal undo, and workspace restore helpers
lib/chat-turn.js                  Chat turn finalization, diagnostics snapshots, and persistence helpers
lib/memory.js                     Memory orchestration and memory module composition
lib/memory-summary.js             Summary triggers, candidate extraction, and model/fallback summaries
lib/memory-chunks.js              Episodic/evidence chunk generation and chunk dedupe helpers
lib/memory-forgetfulness.js       Forgetfulness signals and workspace conflict detection helpers
lib/memory-query.js               Memory retrieval query construction, keyword extraction, and entity-focus helpers
lib/memory-lexical.js             Lexical memory recall, scoring, and prompt formatting helpers
lib/memory-engine.js              Compatibility export layer for memory query and lexical helpers
lib/memory-retrieval.js           Memory-RAG orchestration and layered budget merging
lib/memory-retrieval-helpers.js   Shared retrieval ranking, novelty, and layer-budget helpers
lib/memory-retrieval-records.js   Canon/recent fact selection and contested-memory helpers
lib/memory-retrieval-evidence.js  Episodic/support evidence selection helpers
lib/memory-vector.js              Local memory vector scoring helpers
lib/retrieval-plan.js             Joint memory-vs-knowledge routing and retrieval budget helpers
lib/retrieval-fusion.js           Cross-source retrieval reranking and final prompt-selection helpers
lib/embeddings.js                 Local embedding generation helpers
lib/knowledge-query.js            Knowledge query focus, entity matching, and anchor-hint helpers
lib/knowledge-index.js            Knowledge chunk building and persisted chunk-index helpers
lib/knowledge-select.js           Knowledge semantic/lexical selection and embedding-cache helpers
lib/knowledge-retrieval.js        Knowledge-RAG composition layer for index, query, selection, and formatting
lib/memory-consolidation.js       Long-term memory consolidation helpers
lib/proposals.js                  Proposal generation and review helpers
public/index.html                 Main browser UI
public/styles.css                 Styling and layout
public/app-chat.js                Chat actions
public/app-library.js             Library editing helpers
public/app-workspace.js           Workspace rendering helpers
public/app-review.js              Review, memory, proposal, and diagnostics rendering
public/app-provider.js            Provider settings and local embedding helpers
public/app-shell.js               Theme, sidebar, and right-panel shell helpers
public/app.js                     Frontend bootstrapping and cross-module coordination
test/smoke.js                     Zero-dependency smoke tests
```

## Notes And Limits

- The forgetfulness indicator is a heuristic risk signal, not proof of actual model failure.
- Proposal review is meant to make canon updates inspectable, not automatic.
- Workspace knowledge and memory retrieval now have separate retrieval paths.
- Memory retrieval always uses Memory RAG, and knowledge retrieval always uses Knowledge RAG.
- The provider layer is aimed at chat-completions-compatible APIs, not a full raw Responses API integration.

## License

**Nocturne Atlas** is released under the `MIT` License.

See [LICENSE](./LICENSE).
