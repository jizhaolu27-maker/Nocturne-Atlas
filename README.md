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
- Optional local hybrid retrieval, memory RAG, and local-RAG-style knowledge retrieval with no remote embedding API
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
- In memory-RAG mode, supporting evidence chunks are also written to `data/stories/<storyId>/memory/chunks.jsonl`.
- Retrieval can inject long-term, critical, and recent memory blocks back into the prompt.
- Memory-RAG mode can also inject retrieved evidence chunks alongside stable memory facts.

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

## Retrieval Modes And Local RAG

Nocturne Atlas separates **memory retrieval** from **knowledge retrieval**.

That means a story can keep memory retrieval conservative while making workspace knowledge more retrieval-driven.

### Available Retrieval Settings

- `lexical`
  Keyword and entity matching only
- `hybrid`
  Lexical matching plus optional local embedding help
- `rag`
  Retrieval-first memory mode that keeps stable memory facts and also recalls memory evidence chunks
- `inherit`
  Story setting follows the app-level default

### Local Embeddings

The app can run a fully local embedding path without a remote embedding API.

Current local embedding path:

- Backend: `@xenova/transformers`
- Default model: `Xenova/all-MiniLM-L6-v2`
- Optional mirror host: configurable in `Providers & Retrieval -> Local Embedding Mirror`
- Fallback: deterministic local `hash_v1` vectors when neural inference is unavailable

### Lexical Mode vs Hybrid Knowledge Mode

`lexical` knowledge retrieval keeps the classic prompt shape:

- asset anchors stay fuller
- retrieved knowledge stays lexical
- behavior is simpler and more conservative

`hybrid` knowledge retrieval pushes the app closer to local RAG:

- enabled character, worldbook, and style blocks become lighter anchors
- retrieved workspace chunks carry more factual detail
- local embeddings can rescue semantically related chunks even when wording overlaps less

In other words, hybrid mode does not remove anchors entirely. It keeps light anchors in the prompt and lets retrieved chunks do more of the detailed work.

### Enabling The Local-RAG-Style Path

After cloning:

1. Run `npm install`
2. Start the app with `npm start`
3. In `Providers & Retrieval`, set `Global Knowledge Retrieval` to `Hybrid`
4. Optionally set `Global Memory Retrieval` to `Hybrid` or `Memory RAG`
5. Set `Global Local Embeddings` to `On`
6. If Hugging Face is slow or blocked on your network, set `Local Embedding Mirror` to a reachable mirror such as `https://hf-mirror.com/`
7. Click `Prewarm Local Embedding Model` once

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
  Let one story use a different provider, retrieval mode, or embedding mode

This applies to:

- provider/model choice
- reasoning effort
- memory retrieval mode
- knowledge retrieval mode
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
lib/chat.js                       Chat context building, streaming, and revise helpers
lib/memory.js                     Memory orchestration and forgetfulness checks
lib/memory-engine.js              Lexical memory scoring and formatting helpers
lib/memory-retrieval.js           Hybrid and memory-RAG retrieval orchestration
lib/memory-vector.js              Local memory vector scoring helpers
lib/embeddings.js                 Local embedding generation helpers
lib/knowledge-retrieval.js        Workspace knowledge chunking and retrieval helpers
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
- Workspace knowledge and memory retrieval now have separate RAG-like paths.
- Memory retrieval can stay lexical even when knowledge retrieval uses hybrid mode, or switch to memory RAG without changing knowledge retrieval.
- The provider layer is aimed at chat-completions-compatible APIs, not a full raw Responses API integration.

## License

**Nocturne Atlas** is released under the `MIT` License.

See [LICENSE](./LICENSE).
