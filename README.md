# Nocturne Atlas

[简体中文 README](./README.zh-CN.md)

**Nocturne Atlas** is a local, zero-build AI fiction workspace for long-running stories.

It is designed for writers who want more than a single chat box. Each story gets its own isolated workspace, retrieval context, memory trail, diagnostics history, and proposal review flow, so canon can evolve without silently mutating source material.

## What It Does

- Keeps every story in its own isolated workspace
- Separates immutable library assets from story-local working copies
- Uses Memory, Knowledge, and Story Map retrieval for long-form continuity
- Stores chats, memory, proposals, and diagnostics as local JSON or JSONL
- Supports proposal-based canon updates instead of silent auto-merges
- Streams replies in the browser with stop and revise-last support
- Keeps streaming replies visible across signed-in devices and pauses auto-follow when you scroll away
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
http://localhost:18379
```

The server listens on all interfaces by default so a trusted phone or tablet on the same network can use `http://<server-lan-ip>:18379`. Set `HOST=127.0.0.1` to restrict it to the local machine. Cross-network access should use Tailscale/WireGuard or an HTTPS reverse proxy; the app should not be exposed directly to the public internet.

### Authentication

Set `AUTH_USERNAME` and `AUTH_PASSWORD` on the first start to create the local single-user authentication file. The password is stored as a scrypt hash under ignored `data/config/auth.json`; it is not committed to the repository. After the file exists, the server can restart without those environment variables.

```bash
AUTH_USERNAME=your-user AUTH_PASSWORD=choose-a-password npm start
```

All API routes require the login session when authentication is configured. When using HTTPS, set `AUTH_COOKIE_SECURE=1` so the session cookie is only sent over TLS.

### Test

```bash
npm test
```

## First Run

1. Create a story.
2. Enable the characters, worldbooks, and style profiles that story should use.
3. Configure an OpenAI-compatible provider and choose a model.
4. Start writing in the browser UI.
5. Use Story Map to maintain the reviewed outline, plot threads, timeline, and relationship history.
6. Review memory, diagnostics, and proposals as the story grows.
7. Accept only the workspace changes that should become canon for that story.

If you want semantic retrieval, turn on `Global Local Embeddings` and prewarm the local embedding model once.

While a reply is streaming, other signed-in browsers connected to the same running server receive a transient snapshot of the user turn and partial assistant text. These snapshots are kept only in server memory and are replaced by persisted messages when finalization succeeds; restarting the server discards an unfinished snapshot.

## Core Model

### Source Library vs Story Workspace

- `data/library/*` stores reusable source assets.
- `data/stories/<storyId>/workspace/*` stores mutable story-local copies.
- Story progression never mutates the source library.
- Accepted proposals update only the active story workspace.

### Memory

- Memory records are stored in `data/stories/<storyId>/memory/records.jsonl`.
- Supporting evidence and episodic chunks are stored in `data/stories/<storyId>/memory/chunks.jsonl`.
- Memory retrieval injects stable facts, recent facts, and scene evidence; legacy keywords refresh lazily.

### Story Map

- Reviewed outline, plot, timeline, and relationship data is stored separately from memory.
- The active outline and plot goals are pinned as `Reviewed story direction`; planned events are not treated as facts.
- Character cards, worldbooks, and styles in `Always` mode are pinned and are not removed by normal context trimming; focused non-Always assets can still be trimmed under token pressure.
- Knowledge RAG retrieves only Keyword-mode character cards and worldbooks; Always sources are excluded to prevent duplicate injection, while styles remain fixed writing constraints.
- Runtime Memory compression creates a reviewed reconstruction; accepting it archives old records and replaces active `records.jsonl`, while chunks remain intact.
- Request-relevant Map entries are selectively injected through `story:map_retrieved`; the graph projects only `canon` relationships.
- Story Map edits are atomic, and model changes require proposal review.
- Open the expanded Story Map from `Map` in the chat header on desktop; on mobile, use the bottom navigation or the right-panel Map entry. Desktop uses a wider workspace panel and mobile uses a full-width panel. Reviewed changes from another device are picked up by lightweight polling.

Story configuration and asset selections auto-save. Provider and Library Editor retain their own manual Save buttons because they commit separate global provider or library records.

### Proposals

- The model can suggest structured workspace updates instead of silently editing canon.
- The model can also suggest `Story Map` updates: major events go to the timeline, current goals to plot/outline state, and durable relationship changes to relationship history; only lasting world rules belong in worldbooks.
- Proposal review lets you accept, reject, or revisit changes story by story.
- Accepted proposals only affect the active story's workspace copy.

### Diagnostics

The Diagnostics panel shows what the model actually used on a turn.

Common labels:

- `Character anchors`, `Worldbook anchors`, `Style anchors`: stable prompt anchors from enabled assets
- `Retrieved knowledge chunks`: on-demand workspace snippets recalled for the current turn
- `Critical memory`, `Recent memory`, `Memory evidence`: memory layers injected into the current prompt
- `Grounding Check`: post-response support analysis against retrieved memory and knowledge

## Retrieval and RAG

Three retrieval layers are available by default:

- **Memory RAG**: stable facts, recent facts, and episodic scene evidence.
- **Knowledge RAG**: on-demand Keyword-mode character cards and worldbooks; Always assets are pinned instead, and styles are always-on writing constraints.
- **Story Map retrieval**: query-matched outline, plot, timeline, and relationship entries; the active direction remains pinned.

Knowledge and Map indexes are story-local. Semantic retrieval runs when local embeddings are enabled, with lexical recall as fallback; indexes rebuild when their version changes.

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

In the Library Editor, choose Characters, Worldbooks, or Styles and use “Generate AI Draft” to turn a natural-language description into a reviewable JSON draft. The draft is not saved until you inspect it and click Save.

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
data/stories/<storyId>/story-state/state.json
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
lib/story-state.js                Outline, timeline, plot-thread, and relationship state
public/app-review.js              Shared chat and context-status UI
public/app-memory.js              Runtime memory list UI
public/app-proposals.js           Proposal review UI
public/app-diagnostics.js         Retrieval and prompt diagnostics UI
public/app-story-map.js           Story direction and relationship-map UI
public/story-map.css              Story Map layout and graph styling
test/smoke.js                     Zero-dependency test suite runner
test/suites/                      Domain-focused smoke test suites
```

## Notes And Limits

- The forgetfulness indicator is a heuristic risk signal, not proof of model failure.
- Proposal review is meant to keep canon updates inspectable, not automatic.
- The provider layer is aimed at chat-completions-compatible APIs, not a full Responses API integration.

## License

Released under the `MIT` License.

See [LICENSE](./LICENSE).
