# Memoconst

Memoconst is a local-first memory and handoff layer for AI coding sessions. It turns scattered Claude Code, Claude chat, ChatGPT, and Codex history into project-scoped memory files that can be pushed with Git and restored on another machine or in another agent.

The first usable piece is **AI Memory Lite**, a VS Code extension in [`ai-memory-lite/`](ai-memory-lite/).

## Why

AI coding tools store session history differently. That makes context fragile when you switch devices, switch agents, or come back to a project later. Memoconst does not try to clone every vendor chat UI. It captures the useful working state:

- current task
- decisions
- bugs and risks
- files touched
- last session context
- a pasteable resume prompt

## Features

- Scan Claude Code local JSONL sessions.
- Scan Codex local JSONL history.
- Import Claude chat transcripts from clipboard or files.
- Import ChatGPT transcripts from clipboard or files.
- Generate `AI_CONTEXT.md`.
- Generate `.ai-memory/handoff/*.md`.
- Restore a session into `.ai-memory/restored-session/RESUME_PROMPT.md`.
- Keep raw transcripts local with automatic `.gitignore` rules.

## Install

From this repo:

```bash
cd ai-memory-lite
npx --yes @vscode/vsce package
code --install-extension ai-memory-lite-0.4.0.vsix --force
```

## Use

Open a project in VS Code, then run the one-shot command:

```txt
AI Memory Lite: Run Everything (Sync + Generate + Restore)
```

That syncs local history, generates `AI_CONTEXT.md` + handoff, builds the resume prompt, and copies it to your clipboard. Or run the steps individually:

```txt
AI Memory Lite: Sync Local History
AI Memory Lite: Generate AI_CONTEXT.md + Handoff
```

To import Claude chat:

```txt
AI Memory Lite: Import Clipboard as Claude Chat Transcript
AI Memory Lite: Import Transcript File
```

To restore continuity in another agent:

```txt
AI Memory Lite: Restore Session From Handoff
```

That creates and opens:

```txt
.ai-memory/restored-session/RESUME_PROMPT.md
```

Paste that prompt into Claude, Codex, or ChatGPT to continue with the saved project context.

## Git Sync

Commit the useful memory:

```bash
git add AI_CONTEXT.md CLAUDE.md AGENTS.md .ai-memory/index.jsonl .ai-memory/handoff .gitignore
git commit -m "Update AI memory handoff"
git push
```

Raw transcripts remain local:

```gitignore
.ai-memory/raw/
.ai-memory/imports/
```

## Roadmap

- Better per-tool transcript parsers.
- Built-in encrypted sync.
- MCP search over past sessions.
- Rich timeline view: prompt, diff, files, result.
- Adapters for Cursor, Cline/Roo, Continue, Aider, and Copilot.

## Status

Personal MVP. Useful for dogfooding the core idea: agent handoff, not raw chat backup.
