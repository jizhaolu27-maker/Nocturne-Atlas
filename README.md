# Nocturne Atlas

[简体中文 README](./README.zh-CN.md)

**Nocturne Atlas** is a local, zero-build AI fiction workspace for long-running stories.

It is designed for writers who want more than a single chat box. Each story gets its own isolated workspace, retrieval context, memory trail, diagnostics history, and proposal review flow, so canon can evolve without silently mutating source material.

## What It Does

- Keeps every story in its own isolated workspace
- Separates immutable library assets from story-local working copies
- Uses always-on Memory RAG and Knowledge RAG for continuity
- Stores chats, memory, proposals, and diagnostics as local JSON or JSONL
- Supports proposal-based canon updates instead of silent auto-merges
- Streams replies in the browser with stop and revise-last support
- Works with OpenAI-compatible chat-completions providers
- Supports fully local embeddings with lexical fallback
- Runs as a static browser UI with no frontend build step

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

## First Run

1. Create a story.
2. Enable the characters, worldbooks, and style profiles that story should use.
3. Configure an OpenAI-compatible provider and choose a model.
4. Start writing in the browser UI.
5. Review memory, diagnostics, and proposals as the story grows.
6. Accept only the workspace changes that should become canon for that story.

If you want semantic retrieval, turn on `Global Local Embeddings` and prewarm the local embedding model once.

## Core Model

### Source Library vs Story Workspace

- `data/library/*` stores reusable source assets.
- `data/stories/<storyId>/workspace/*` stores mutable story-local copies.
- Story progression never mutates the source library.
- Accepted proposals update only the active story workspace.

### Memory

- Memory records are stored in `data/stories/<storyId>/memory/records.jsonl`.
- Supporting evidence and episodic chunks are stored in `data/stories/<storyId>/memory/chunks.jsonl`.
- Retrieval can inject stable facts, recent facts, and scene evidence back into the prompt.
- Old memory keywords are refreshed lazily at runtime so legacy stories benefit from newer retrieval logic.

### Proposals

- The model can suggest structured workspace updates instead of silently editing canon.
- Proposal review lets you accept, reject, or revisit changes story by story.
- Accepted proposals only affect the active story's workspace copy.

### Diagnostics

The Diagnostics panel shows what the model actually used on a turn.

Common labels:

- `Character anchors`, `Worldbook anchors`, `Style anchors`: stable prompt anchors from enabled assets
- `Retrieved knowledge chunks`: on-demand workspace snippets recalled for the current turn
- `Critical memory`, `Recent memory`, `Memory evidence`: memory layers injected into the current prompt
- `Grounding Check`: post-response support analysis against retrieved memory and knowledge

## Retrieval

Nocturne Atlas uses two retrieval layers:

- **Memory RAG** for story continuity, canon facts, and recent scene evidence
- **Knowledge RAG** for character cards, worldbooks, and style material

Both are always on. Lexical recall still exists, but only as an internal fallback when semantic retrieval is unavailable or too weak.

### Memory RAG

- Stable memory facts protect continuity
- Recent memory facts keep short-term developments alive
- Episodic evidence helps with scene detail and chronology
- Retrieval can combine facts and evidence in the same turn

### Knowledge RAG

- Workspace assets are chunked and indexed per story
- Semantic retrieval runs first when local embeddings are enabled
- Lexical chunk recall fills gaps when semantic recall is unavailable or weak
- Story-local knowledge indexes are rebuilt automatically when the index version changes

## Local Embeddings

The app can run semantic retrieval without a remote embedding API.

Current local path:

- Backend: `@xenova/transformers`
- Default model: `Xenova/all-MiniLM-L6-v2`
- Optional mirror host: `Providers & Retrieval -> Local Embedding Mirror`
- Fallback: deterministic local `hash_v1` vectors when neural inference is unavailable

Recommended setup:

1. Run `npm install`
2. Start the app with `npm start`
3. Set `Global Local Embeddings` to `On`
4. If Hugging Face is slow or blocked, set `Local Embedding Mirror` to a reachable mirror such as `https://hf-mirror.com/`
5. Click `Prewarm Local Embedding Model` once

Prewarm performs one real embedding call so the local model is downloaded and cached before your first retrieval-heavy turn.

## Configuration

Story-level settings include:

- provider and model
- reasoning effort
- temperature
- max completion tokens

App-level retrieval settings include:

- global local embeddings
- local embedding mirror host

## Providers

The provider layer targets OpenAI-compatible **chat completions** APIs.

You can configure:

- base URL
- model name
- context window
- API key
- reasoning effort for compatible thinking models

Provider keys are stored locally and encrypted at rest.

## Data Layout

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
- Local model caches are also ignored by Git
- Other users need to generate their own story data and local embedding cache after cloning

## Project Structure

```text
server.js                         Backend entry point and dependency wiring
lib/api-router.js                 API routing
lib/story-store.js                Story, library, JSON, and JSONL storage helpers
lib/workspace.js                  Story workspace sync and loading helpers
lib/context.js                    Prompt context assembly
lib/chat.js                       Chat orchestration, streaming, revise, and preview helpers
lib/memory.js                     Memory orchestration
lib/memory-runtime.js             Runtime memory normalization and legacy keyword refresh
lib/retrieval-plan.js             Memory-vs-knowledge routing and budget planning
lib/retrieval-fusion.js           Cross-source final reranking
lib/knowledge-retrieval.js        Knowledge RAG composition layer
lib/proposals.js                  Proposal generation and review helpers
public/                           Static browser UI
test/smoke.js                     Zero-dependency smoke tests
```

## Notes And Limits

- The forgetfulness indicator is a heuristic risk signal, not proof of model failure.
- Proposal review is meant to keep canon updates inspectable, not automatic.
- The provider layer is aimed at chat-completions-compatible APIs, not a full Responses API integration.

## License

Released under the `MIT` License.

See [LICENSE](./LICENSE).
