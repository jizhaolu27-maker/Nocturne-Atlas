# Nocturne Atlas

[简体中文 README](./README.zh-CN.md)

**Nocturne Atlas** is a local, zero-build AI fiction workspace for long-running stories.

It is built for writers who want more than a chat box: each story gets its own isolated canon, editable workspace, memory trail, diagnostics, and reviewable update proposals.

## Highlights

- Per-story isolated workspaces for characters, worldbooks, and style profiles
- Immutable source library assets with story-local working copies
- Local memory checkpoints stored as readable JSONL
- Proposal-based canon updates instead of silent auto-merges
- Diagnostics for context pressure, prompt inputs, retrieval behavior, and forgetfulness risk
- OpenAI-compatible provider support with locally encrypted API keys
- Reasoning-model support on chat-completions-compatible providers with configurable reasoning effort
- Optional local hybrid retrieval and local RAG groundwork
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

## What The App Does

With **Nocturne Atlas**, you can:

- create multiple stories and keep their canon separate
- attach story-specific characters, worldbooks, and style profiles
- chat with an OpenAI-compatible model in a local browser UI
- generate memory checkpoints for long-running continuity
- review proposals for character, relationship, and world-state updates
- inspect context diagnostics and retrieval results
- stream replies and stop generation mid-turn

## Core Workflow

1. Create or open a story.
2. Enable the characters, worldbooks, and style profile that story should use.
3. Configure a provider and start chatting.
4. Let the app record compact memory checkpoints and surface canon proposals.
5. Accept only the updates that should become part of that story's working canon.

## Local RAG And Embeddings

**Nocturne Atlas** can run a fully local embedding path without a remote embedding API.

Current setup:

- Default retrieval mode: `lexical`
- Default local embeddings mode: `off`
- Local neural embedding backend: `@xenova/transformers`
- Default local embedding model: `Xenova/all-MiniLM-L6-v2`
- Optional mirror host: configurable per app via `Local Embedding Mirror`
- Fallback path: deterministic local hash vectors when neural inference is unavailable

To enable the local RAG-style path after cloning:

1. Run `npm install`
2. Start the app with `npm start`
3. In the UI, set `Global Default: Memory Retrieval` to `Hybrid`
4. Set `Global Default: Local Embeddings` to `On`
5. If Hugging Face is slow or unreachable on your network, set `Local Embedding Mirror` to a reachable mirror such as `https://hf-mirror.com/`
6. Click `Prewarm Local Embedding Model` once

What the prewarm button does:

- It triggers one real local embedding call
- If the local model is not cached yet, this is when the model files are downloaded
- It fills the local cache ahead of the first real chat turn, so the first retrieval pass is smoother
- It now reports success only when a real neural embedding vector is produced
- If neural loading fails, the app reports the failure and keeps using local hash-vector fallback when allowed

## Configuration Model

There are two levels of retrieval settings:

- Global defaults
  These apply to all stories unless a story overrides them.
- Story overrides
  These let one story opt into different retrieval or embedding behavior.

Typical combinations:

- `Lexical Only` + `Off`
  Most stable and lightweight
- `Hybrid` + `On`
  Enables local vector-enhanced retrieval
- `Inherit App Default`
  Follows the current global defaults

## Data Layout

The app keeps data local and human-readable where possible.

```text
data/library/characters/                 Source character assets
data/library/worldbooks/                 Source worldbook assets
data/library/styles/                     Source style assets
data/stories/<storyId>/workspace/        Story-local working copies
data/stories/<storyId>/messages.jsonl    Chat transcript
data/stories/<storyId>/memory/records.jsonl
data/stories/<storyId>/proposals/records.jsonl
data/stories/<storyId>/snapshots/context.jsonl
```

Note:

- `data/stories/` is ignored by Git in this repository setup
- local model caches are also ignored by Git
- that means other users must build their own local story data and local embedding cache after cloning

## Project Structure

```text
server.js                         Backend composition root and startup
lib/http.js                       HTTP helpers and static file serving
lib/server-config.js              App config, story config, and embedding runtime helpers
lib/api-router.js                 API route matching and resource handlers
lib/providers.js                  Provider helpers and OpenAI-compatible transport
lib/story-store.js                Story, library, config, JSON, and JSONL storage helpers
lib/workspace.js                  Story workspace sync and loading helpers
lib/context.js                    Context block assembly and pressure helpers
lib/chat.js                       Chat context building, turn finalization, and streaming
lib/memory.js                     Memory orchestration and forgetfulness checks
lib/memory-engine.js              Lexical memory scoring and formatting helpers
lib/memory-retrieval.js           Hybrid retrieval orchestration
lib/memory-vector.js              Local vector scoring helpers
lib/embeddings.js                 Local embedding generation helpers
lib/knowledge-retrieval.js        Workspace knowledge chunking and retrieval helpers
lib/memory-consolidation.js       Long-term memory consolidation helpers
lib/proposals.js                  Proposal generation and review helpers
public/index.html                 Main browser UI
public/styles.css                 Styling and layout
public/app-chat.js                Chat actions
public/app-library.js             Library editing helpers
public/app-workspace.js           Workspace rendering helpers
public/app-review.js              Review, memory, and diagnostics rendering helpers
public/app-provider.js            Provider settings and local embedding helpers
public/app-shell.js               Theme, sidebar, and right-panel shell helpers
public/app.js                     Frontend bootstrapping and cross-module coordination
```

## How Memory Works

The memory system is explicit and local-first.

1. The app periodically summarizes recent dialogue into compact memory records.
2. Each record is written to `data/stories/<storyId>/memory/records.jsonl`.
3. Records include fields such as `kind`, `importance`, `entities`, `keywords`, and `tier`.
4. Before generation, stored memories are ranked using lexical overlap, structured fields, recency, importance, and optional vector similarity.
5. Relevant memories are injected back into the prompt as compact context blocks.
6. Stable short-term records can later be consolidated into cleaner long-term memory.

This keeps continuity inspectable instead of burying it inside a single opaque prompt.

## Providers

The app currently targets OpenAI-compatible chat completion APIs.

You can configure:

- base URL
- model name
- context window
- API key

Story generation settings can also opt into reasoning effort for compatible thinking models.

Provider keys are stored locally and encrypted at rest.

## Notes

- The forgetfulness indicator is a heuristic risk signal, not proof of actual model failure.
- Proposal review is meant to make canon updates inspectable, not automatic.
- This repository is intentionally local-first and optimized for single-user use.
- The local RAG path currently combines memory retrieval and workspace knowledge retrieval.

## License

**Nocturne Atlas** is released under the `MIT` License.

See [LICENSE](./LICENSE).
