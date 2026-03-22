# Nocturne Atlas

[中文 README](./README.zh-CN.md)

**Nocturne Atlas** is a local, zero-build AI fiction workspace for long-running stories.

It is designed for writers who want more than a chat box: each story gets its own isolated workspace, its own mutable canon, its own memory trail, and its own reviewable update proposals.

## Why Nocturne Atlas

**Nocturne Atlas** is built around a simple idea:

AI story writing gets much better when story memory, canon updates, and diagnostics are first-class tools instead of hidden prompt glue.

What makes **Nocturne Atlas** different:

- Per-story isolated workspaces for characters, worldbooks, and style profiles
- Source library assets stay immutable while each story evolves its own working copy
- Memory summaries are stored locally as readable JSONL records
- Story-state changes can flow through proposal review instead of being silently merged
- Diagnostics expose context usage, prompt inputs, proposal triggers, and forgetfulness risk
- OpenAI-compatible provider support with local encrypted key storage
- Static browser UI with no frontend build step

## What It Does

With **Nocturne Atlas**, you can:

- create multiple stories and keep their canon separate
- chat with an OpenAI-compatible model through a local browser UI
- attach story-specific character cards, worldbooks, and style profiles
- generate memory checkpoints for longer-running story continuity
- review proposals for character, relationship, and world-state updates
- inspect context pressure and heuristic forgetfulness warnings
- stream replies and stop generation mid-turn

## Core Workflow

1. Create or open a story in **Nocturne Atlas**.
2. Enable the characters, worldbooks, and style profile that story should use.
3. Chat with the model.
4. Let **Nocturne Atlas** store compact memory records and surface reviewable canon proposals.
5. Accept only the updates that should become part of that story's working canon.

## Project Structure

```text
server.js                         API routes, provider calls, and high-level orchestration
lib/providers.js                  Provider encryption, connection tests, and OpenAI-compatible request helpers
lib/story-store.js                Story/library/config storage helpers and JSON/JSONL file access
lib/workspace.js                  Story workspace copy, sync, and active workspace loading helpers
lib/context.js                    Context block assembly, pressure classification, default context status helpers
lib/chat.js                       Chat context building, chat turn finalization, streaming, and revise-last helpers
lib/memory.js                     Memory orchestration, summary triggers, fallback summaries, forgetfulness checks
lib/memory-engine.js              Memory retrieval scoring and prompt formatting helpers
lib/memory-consolidation.js       Long-term memory consolidation helpers
lib/proposals.js                  Proposal triggers, proposal generation, pipeline state, application helpers
public/index.html                 Main browser UI
public/styles.css                 Styling and layout
public/app.js                     Frontend state, rendering, and actions
data/library/*                    Source library assets
data/stories/<storyId>/*          Per-story local workspace, messages, memory, proposals, snapshots
```

## Data Model

**Nocturne Atlas** keeps story data local and human-readable where possible.

- `data/library/characters`, `data/library/worldbooks`, `data/library/styles`
  Source library assets
- `data/stories/<storyId>/workspace/*`
  Mutable story-local copies
- `data/stories/<storyId>/messages.jsonl`
  Chat transcript
- `data/stories/<storyId>/memory/records.jsonl`
  Memory checkpoints
- `data/stories/<storyId>/proposals/records.jsonl`
  Proposal queue and review history
- `data/stories/<storyId>/snapshots/context.jsonl`
  Diagnostics snapshots

## Quick Start

### Requirements

- Node.js 18+ recommended

### Run

```bash
node server.js
```

Open:

```text
http://localhost:3000
```

### Test

Run the local smoke tests:

```bash
node test/smoke.js
```

Or use the package script:

```bash
npm test
```

The smoke script stays zero-dependency and covers the refactored story-store, workspace, context, memory, and proposal flows.

Current smoke coverage:

- `story-store`: story creation plus initial workspace sync for enabled library assets
- `workspace`: active workspace loading after story-local copies are created
- `context`: system/workspace/memory/history block assembly
- `memory`: summary schedule calculation and transcript-free fallback summary generation
- `proposals`: accepting a create-character proposal into workspace data and story enablement

## Provider Support

**Nocturne Atlas** currently targets OpenAI-compatible chat completion APIs.

You can configure:

- base URL
- model name
- context window
- API key

Provider keys are stored locally and encrypted at rest.

## Current Highlights

- Streaming chat with stop control
- Per-story workspace copies
- Proposal-based canon updates
- Compact memory generation and consolidation support
- Context diagnostics and prompt preview
- Forgetfulness risk heuristics for long-running story sessions
- Zero-build local UI

## How Memory Works

**Nocturne Atlas** uses a layered local memory system instead of a vector database.

The current memory flow is:

1. After selected turns, the app generates a compact memory summary from recent dialogue.
2. Each memory record is saved locally under `data/stories/<storyId>/memory/records.jsonl`.
3. Records are tagged with:
   - `kind` such as `relationship_update`, `world_state`, `character_update`, or `plot_checkpoint`
   - `importance`
   - `entities`
   - `keywords`
   - `tier` (`short_term` or `long_term`)
4. Before the next generation, **Nocturne Atlas** scores stored memories using:
   - keyword overlap
   - entity overlap
   - workspace-term overlap
   - recency
   - importance
   - memory tier
5. The highest-scoring memories are injected back into the active prompt as compact context blocks.
6. When enough short-term records accumulate, stable memory kinds can be consolidated into long-term records.
7. Older long-term records of the same kind can be superseded so retrieval stays cleaner over time.

This means **Nocturne Atlas** keeps memory explicit, inspectable, and local-first instead of hiding continuity inside opaque prompts.

The runtime memory flow is now centralized in `lib/memory.js`, while retrieval scoring and consolidation live beside it in `lib/memory-engine.js` and `lib/memory-consolidation.js`.

Proposal orchestration now lives in `lib/proposals.js`, so `server.js` mainly coordinates routes and high-level chat flow.

Storage and path helpers now live in `lib/story-store.js`, which keeps JSON and JSONL access details out of the route layer.

Provider encryption, connection tests, and chat-completion transport now live in `lib/providers.js`, which keeps provider-specific details out of `server.js`.

Workspace copy/sync/loading now lives in `lib/workspace.js`, which keeps story-local workspace handling out of the route layer.

Context block assembly and pressure/default-status helpers now live in `lib/context.js`, which keeps prompt-context shaping out of `server.js`.

Chat context construction, turn finalization, streaming chat flow, and revise-last handling now live in `lib/chat.js`, which keeps story-chat runtime logic out of `server.js`.

## Notes

- The forgetfulness indicator is a heuristic risk signal, not proof of actual model memory failure.
- Story proposals are meant to make canon updates reviewable, not automatic.
- This repository is intentionally local-first and optimized for single-user use.

## Roadmap Ideas

- Story duplication and archive workflows
- Better search and filtering for stories and library assets
- Richer proposal diff presentation
- Stronger retrieval scoring for memory selection

## License

**Nocturne Atlas** is released under the `MIT` License.

That means other people can generally use, modify, and redistribute the project, including for commercial use, as long as the original copyright and license notice stay with the software.

See [LICENSE](./LICENSE).
