# AI Memory Lite

Personal v0.2: local-first handoff memory for Claude Code, Claude chat, ChatGPT, and Codex in VS Code.

It does **not** call any API. It reads local transcript files, normalizes them, and creates:

- `.ai-memory/index.jsonl`
- `.ai-memory/raw/*.jsonl` (always gitignored)
- `.ai-memory/handoff/HANDOFF.md`
- `.ai-memory/handoff/CURRENT_TASK.md`
- `.ai-memory/handoff/DECISIONS.md`
- `.ai-memory/handoff/BUGS.md`
- `.ai-memory/handoff/FILES_TOUCHED.md`
- `.ai-memory/handoff/LAST_SESSION.md`
- `.ai-memory/handoff/NEXT_PROMPT.md`
- `.ai-memory/restored-session/RESUME_PROMPT.md`
- `.ai-memory/restored-session/synthetic-chat.jsonl`
- `AI_CONTEXT.md`
- `CLAUDE.md` and `AGENTS.md` if they do not already exist

## What it supports in v0.2

### Claude Code

Scans:

```txt
~/.claude/projects/**/*.jsonl
```

or if set:

```txt
$CLAUDE_CONFIG_DIR/projects/**/*.jsonl
```

### ChatGPT / Codex

Scans:

```txt
~/.codex/history.jsonl
~/.codex/**/*.jsonl
```

or if set:

```txt
$CODEX_HOME/**/*.jsonl
```

### Claude chat history

Two import paths:

1. Copy transcript, then run:

```txt
AI Memory Lite: Import Clipboard as Claude Chat Transcript
```

2. Export or save Claude chat JSON / JSONL / Markdown / text, then run:

```txt
AI Memory Lite: Import Transcript File
```

Imported Claude chat history is normalized into `.ai-memory/index.jsonl` and the local Claude normalized JSONL under `.ai-memory/raw/`.

### ChatGPT web or third-party ChatGPT VS Code extensions

Import from clipboard:

```txt
AI Memory Lite: Import Clipboard as ChatGPT Transcript
```

Or import files:

```txt
AI Memory Lite: Import Transcript File
```

## Commands

```txt
AI Memory Lite: Sync Local History
AI Memory Lite: Generate AI_CONTEXT.md + Handoff
AI Memory Lite: Capture Handoff
AI Memory Lite: Open AI_CONTEXT.md
AI Memory Lite: Open HANDOFF.md
AI Memory Lite: Copy Resume Prompt
AI Memory Lite: Restore Session From Handoff
AI Memory Lite: Import Clipboard as ChatGPT Transcript
AI Memory Lite: Import Clipboard as Claude Chat Transcript
AI Memory Lite: Import Transcript File
```

## Install for local development

1. Unzip this folder.
2. Open the folder in VS Code.
3. Press `F5` to launch an Extension Development Host.
4. Open your real coding project in that new window.
5. Run the commands above from the Command Palette.

## Install as a local VSIX

Install VSCE:

```bash
npm install -g @vscode/vsce
```

Package:

```bash
cd ai-memory-lite
vsce package
```

Install:

```bash
code --install-extension ai-memory-lite-0.2.0.vsix
```

## Cross-device workflow

Recommended safe default:

```bash
git add AI_CONTEXT.md CLAUDE.md AGENTS.md .ai-memory/index.jsonl .ai-memory/handoff .gitignore
git commit -m "Update AI memory handoff"
git push
```

On another device:

```bash
git pull
```

Then tell Claude, Codex, or ChatGPT:

```txt
Read AI_CONTEXT.md and .ai-memory/handoff/HANDOFF.md, then continue from the latest task.
```

Or run:

```txt
AI Memory Lite: Restore Session From Handoff
```

That creates and opens:

```txt
.ai-memory/restored-session/RESUME_PROMPT.md
.ai-memory/restored-session/SESSION_CONTEXT.md
.ai-memory/restored-session/synthetic-chat.jsonl
```

The full resume prompt is also copied to your clipboard.

Raw transcripts are always gitignored:

```txt
.ai-memory/raw/
.ai-memory/imports/
```

The extension will keep raw transcripts out of Git automatically. You only need to push the handoff files.

## Product direction

The useful thing is not perfect transcript syncing. The useful thing is agent handoff:

- current task
- recent decisions
- active bugs
- files touched
- last session summary
- next resume prompt

That makes the memory usable across Claude, Codex, and ChatGPT even when native histories do not sync cleanly.



