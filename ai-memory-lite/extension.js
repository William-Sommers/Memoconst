/*
AI Memory Lite
Local-first MVP for importing Claude Code, Claude chat, and OpenAI Codex/ChatGPT history
into project memory + handoff files.
No network calls. No dependencies.
*/

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const childProcess = require('child_process');

const SOURCE_CLAUDE_CODE = 'claude';
const SOURCE_CLAUDE_CHAT = 'claude-chat';
const SOURCE_CODEX = 'codex';
const SOURCE_CHATGPT = 'chatgpt';

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('aiMemoryLite.runEverything', async () => {
      const root = getWorkspaceRoot();
      if (!root) return;
      const result = await syncNow(root);
      const file = generateOverview(root, result.items);
      vscode.window.showInformationMessage(
        `AI Memory Lite: synced ${result.count} items from ${result.sources.join(', ') || 'no sources'} and updated OVERVIEW.md.`
      );
      openFile(file);
    }),
    vscode.commands.registerCommand('aiMemoryLite.syncNow', async () => {
      const root = getWorkspaceRoot();
      if (!root) return;
      const result = await syncNow(root);
      vscode.window.showInformationMessage(
        `AI Memory Lite synced ${result.count} items from ${result.sources.join(', ') || 'no sources'}.`
      );
    }),
    vscode.commands.registerCommand('aiMemoryLite.generateContext', async () => {
      const root = getWorkspaceRoot();
      if (!root) return;
      const result = await syncNow(root);
      const file = generateOverview(root, result.items);
      vscode.window.showInformationMessage(`Updated OVERVIEW.md from ${result.count} items.`);
      openFile(file);
    }),
    vscode.commands.registerCommand('aiMemoryLite.openContext', async () => {
      const root = getWorkspaceRoot();
      if (!root) return;
      const file = path.join(root, '.ai-memory', 'OVERVIEW.md');
      if (!fs.existsSync(file)) {
        vscode.window.showWarningMessage('OVERVIEW.md does not exist yet. Run "AI Memory Lite: Run Everything" first.');
        return;
      }
      openFile(file);
    }),
    vscode.commands.registerCommand('aiMemoryLite.importClipboard', async () => {
      await importClipboardAs(SOURCE_CHATGPT, 'ChatGPT');
    }),
    vscode.commands.registerCommand('aiMemoryLite.importClaudeClipboard', async () => {
      await importClipboardAs(SOURCE_CLAUDE_CHAT, 'Claude');
    }),
    vscode.commands.registerCommand('aiMemoryLite.importTranscriptFile', async () => {
      await importTranscriptFiles();
    }),
    vscode.commands.registerCommand('aiMemoryLite.continueSession', async () => {
      await continueSession();
    })
  );

  // One-click buttons in the status bar.
  const saveItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  saveItem.text = '$(save) AI Memory';
  saveItem.tooltip = 'AI Memory Lite: Sync + update OVERVIEW.md';
  saveItem.command = 'aiMemoryLite.runEverything';
  saveItem.show();
  context.subscriptions.push(saveItem);

  const continueItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  continueItem.text = '$(debug-continue) Continue';
  continueItem.tooltip = 'AI Memory Lite: Continue a Saved Session';
  continueItem.command = 'aiMemoryLite.continueSession';
  continueItem.show();
  context.subscriptions.push(continueItem);
}

function deactivate() {}
module.exports = { activate, deactivate };

function getWorkspaceRoot() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    vscode.window.showErrorMessage('Open a project folder first. AI Memory Lite stores memory per workspace.');
    return null;
  }
  return folders[0].uri.fsPath;
}

function getConfig() {
  return vscode.workspace.getConfiguration('aiMemoryLite');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function safeReadFile(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function safeStat(file) {
  try { return fs.statSync(file); } catch { return null; }
}

function writeJsonl(file, items) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, items.map(x => JSON.stringify(x)).join('\n') + (items.length ? '\n' : ''), 'utf8');
}

function parseJsonl(file) {
  const text = safeReadFile(file);
  const lines = text.split(/\r?\n/).filter(Boolean);
  const out = [];
  for (const line of lines) {
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

function hash(input) {
  return crypto.createHash('sha256').update(String(input)).digest('hex').slice(0, 16);
}

function homePath(...parts) {
  return path.join(os.homedir(), ...parts);
}

function latestFilesRecursive(dir, predicate, maxFiles) {
  const found = [];
  if (!fs.existsSync(dir)) return found;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!['node_modules', '.git', 'Cache', 'GPUCache'].includes(entry.name)) stack.push(full);
      } else if (predicate(full)) {
        const stat = safeStat(full);
        if (stat) found.push({ file: full, mtimeMs: stat.mtimeMs, size: stat.size });
      }
    }
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return found.slice(0, maxFiles).map(x => x.file);
}

function topLevelFiles(dir, predicate) {
  if (!fs.existsSync(dir)) return [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter(x => x.isFile())
    .map(x => path.join(dir, x.name))
    .filter(predicate);
}

async function syncNow(root) {
  const cfg = getConfig();
  const maxFiles = cfg.get('maxFilesPerSource', 200);
  const memoryDir = path.join(root, '.ai-memory');
  ensureDir(memoryDir);
  ensureGitignore(root);

  const sources = [];

  const claudeCodeItems = scanClaudeCode(root, maxFiles);
  const claudeChatItems = scanImportedTranscripts(root, SOURCE_CLAUDE_CHAT, maxFiles);
  const claudeItems = [...claudeCodeItems, ...claudeChatItems];
  if (claudeCodeItems.length) sources.push(SOURCE_CLAUDE_CODE);
  if (claudeChatItems.length) sources.push(SOURCE_CLAUDE_CHAT);

  const codexItems = scanCodex(root, maxFiles);
  if (codexItems.length) sources.push(SOURCE_CODEX);

  const chatgptItems = scanImportedTranscripts(root, SOURCE_CHATGPT, maxFiles);
  if (chatgptItems.length) sources.push(SOURCE_CHATGPT);

  const unique = dedupe([...claudeItems, ...codexItems, ...chatgptItems])
    .sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')));

  writeJsonl(path.join(memoryDir, 'index.jsonl'), unique);

  return { count: unique.length, sources, items: unique };
}

function ensureGitignore(root) {
  const gi = path.join(root, '.gitignore');
  const text = safeReadFile(gi);
  const block = [
    '',
    '# AI Memory Lite: keep raw transcripts local',
    '.ai-memory/raw/',
    '.ai-memory/imports/',
    ''
  ].join('\n');
  if (!text.includes('.ai-memory/raw/') || !text.includes('.ai-memory/imports/')) {
    fs.appendFileSync(gi, block, 'utf8');
  }
}

function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const id = item.id || hash([item.source, item.timestamp, item.role, item.text, item.file].join('\n'));
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ ...item, id });
  }
  return out;
}

function scanClaudeCode(root, maxFiles) {
  const configDir = process.env.CLAUDE_CONFIG_DIR || homePath('.claude');
  const projectsDir = path.join(configDir, 'projects');
  const files = latestFilesRecursive(projectsDir, f => f.endsWith('.jsonl'), maxFiles);
  const basename = path.basename(root).toLowerCase();
  const out = [];

  for (const file of files) {
    const records = parseJsonl(file);
    const fileLooksRelevant = file.toLowerCase().includes(basename);
    for (const rec of records) {
      const raw = JSON.stringify(rec);
      const cwd = rec.cwd || rec.projectCwd || rec.workspace || rec.workspaceRoot || '';
      const relevant = fileLooksRelevant || cwd === root || raw.includes(root) || raw.toLowerCase().includes(basename);
      if (!relevant) continue;
      const normalized = normalizeGenericRecord(SOURCE_CLAUDE_CODE, rec, file, cwd || root);
      if (normalized.text) out.push(normalized);
    }
  }
  return out;
}

function scanCodex(root, maxFiles) {
  const codexHome = process.env.CODEX_HOME || homePath('.codex');
  const files = [];
  const history = path.join(codexHome, 'history.jsonl');
  if (fs.existsSync(history)) files.push(history);
  files.push(...latestFilesRecursive(codexHome, f => f.endsWith('.jsonl') && f !== history, maxFiles));

  const basename = path.basename(root).toLowerCase();
  const rootLc = root.toLowerCase();
  const titles = loadCodexTitles(codexHome);
  const out = [];
  for (const file of [...new Set(files)].slice(0, maxFiles + 1)) {
    const records = parseJsonl(file);
    // Codex "rollout" files carry the project directory in a session_meta line;
    // every message in the file belongs to that one project + session.
    const meta = records.find(r => r && (r.type === 'session_meta' || (r.payload && r.payload.cwd)));
    const sessionCwd = codexField(meta, 'cwd').toLowerCase();
    const fileLooksRelevant = file.toLowerCase().includes(basename);
    if (!(fileLooksRelevant || (sessionCwd && sessionCwd === rootLc))) continue;

    const sessionId = codexField(meta, 'session_id') || codexField(meta, 'id') || hash(file);
    const sessionTitle = titles.get(String(sessionId)) || '';
    for (const rec of records) {
      const normalized = normalizeCodexRecord(rec, file, root, sessionId);
      if (normalized && normalized.text) {
        normalized.title = sessionTitle;
        out.push(normalized);
      }
    }
  }
  return out;
}

// Codex keeps human-readable session titles in session_index.jsonl (thread_name).
function loadCodexTitles(codexHome) {
  const map = new Map();
  for (const rec of parseJsonl(path.join(codexHome, 'session_index.jsonl'))) {
    const id = rec && (rec.id || rec.session_id);
    const name = rec && (rec.thread_name || rec.title || rec.name);
    if (id && name) map.set(String(id), String(name));
  }
  return map;
}

function codexField(meta, key) {
  if (!meta || typeof meta !== 'object') return '';
  const src = meta.payload && typeof meta.payload === 'object' ? meta.payload : meta;
  return String(src[key] || meta[key] || '');
}

// Codex/IDE tools wrap the real prompt in injected context. Pull out the actual
// message (under "## My request…") and drop pure boilerplate content parts.
function extractCodexText(payload) {
  const parts = Array.isArray(payload.content) ? payload.content : [payload.content];
  const out = [];
  for (const part of parts) {
    let t = typeof part === 'string' ? part : String((part && part.text) || '');
    t = t.trim();
    if (!t) continue;
    const req = t.match(/##\s*My request(?: for Codex)?:\s*([\s\S]*)$/i);
    if (req) {
      const real = req[1].trim();
      if (real) out.push(real);
      continue;
    }
    if (isInjectedContext(t)) continue;
    out.push(t);
  }
  return out.join('\n').trim();
}

// Pure boilerplate blocks that carry no real conversation.
function isInjectedContext(text) {
  const t = String(text).trimStart();
  return /^<environment_context>/i.test(t)
    || /^<\/?user_instructions>/i.test(t)
    || /^#+\s*AGENTS\.md instructions/i.test(t)
    || /^#+\s*Context from my IDE setup/i.test(t)
    || /^#+\s*Files mentioned by the user/i.test(t);
}

// Codex records nest the chat under `payload`. Keep only real user/assistant
// messages; skip developer/system instructions, tool calls, and event noise.
function normalizeCodexRecord(rec, file, root, sessionId) {
  if (!rec || typeof rec !== 'object') return null;
  const payload = rec.payload && typeof rec.payload === 'object' ? rec.payload : rec;
  if (payload.type && payload.type !== 'message') return null;
  const role = String(payload.role || '').toLowerCase();
  if (role !== 'user' && role !== 'assistant') return null;

  const text = extractCodexText(payload) || (role === 'assistant' ? extractText(payload) : '');
  if (!text) return null;
  const timestamp = normalizeTimestamp(rec.timestamp || payload.timestamp || extractTimestamp(payload));
  return {
    source: SOURCE_CODEX,
    timestamp,
    role,
    text: clip(text, 20000),
    file,
    cwd: root,
    sessionId: String(sessionId),
    title: '',
    id: hash([SOURCE_CODEX, file, timestamp, role, text.slice(0, 200)].join('\n'))
  };
}

function scanImportedTranscripts(root, source, maxFiles) {
  const importsRoot = path.join(root, '.ai-memory', 'imports');
  const sourceDir = path.join(importsRoot, source === SOURCE_CLAUDE_CHAT ? 'claude' : 'chatgpt');
  const predicate = f => /\.(txt|md|json|jsonl)$/i.test(f);
  let files = latestFilesRecursive(sourceDir, predicate, maxFiles);

  if (source === SOURCE_CHATGPT) {
    // Backcompat: v0 stored ChatGPT clipboard files directly under .ai-memory/imports.
    files = files.concat(topLevelFiles(importsRoot, predicate));
  }

  const out = [];
  for (const file of [...new Set(files)].slice(0, maxFiles)) {
    out.push(...parseImportedFile(file, source, root));
  }
  return out;
}

function parseImportedFile(file, source, root) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.jsonl') {
    return parseJsonl(file).flatMap(rec => flattenConversationData(rec, source, file, root));
  }
  if (ext === '.json') {
    try {
      return flattenConversationData(JSON.parse(safeReadFile(file)), source, file, root);
    } catch {
      return [];
    }
  }

  const text = safeReadFile(file).trim();
  const stat = safeStat(file);
  if (!text) return [];

  const baseTs = stat ? new Date(stat.mtimeMs).toISOString() : new Date().toISOString();
  const sessionId = hash(file);
  const title = path.basename(file);

  // Pasted transcripts (ChatGPT "You said:"/"ChatGPT said:", or User:/Assistant:)
  // carry turn structure we should preserve instead of flattening to one blob.
  const turns = splitPlainTranscript(text);
  if (turns.length > 1) {
    return turns.map((turn, i) => ({
      source,
      timestamp: baseTs,
      role: turn.role,
      text: clip(turn.text, 30000),
      file,
      cwd: root,
      sessionId,
      title,
      id: hash([source, file, i, turn.role, turn.text.slice(0, 200)].join('\n'))
    }));
  }

  return [{
    source,
    timestamp: baseTs,
    role: 'transcript',
    text: clip(text, 30000),
    file,
    cwd: root,
    sessionId,
    title,
    id: hash([source, file, text.slice(0, 1000)].join('\n'))
  }];
}

// Split a pasted chat transcript into role-tagged turns.
// Returns [] when no speaker markers are found so the caller keeps the raw blob.
function splitPlainTranscript(text) {
  const lines = String(text).split(/\r?\n/);
  // Marker at line start: optional markdown emphasis, a known speaker label,
  // optional emphasis, then a colon. Content may follow inline.
  const markerRe = /^\s*[*_>#\s]*(you said|chatgpt said|assistant|chatgpt|user|human|you|me)[*_\s]*[:：](.*)$/i;

  const turns = [];
  let cur = null;
  let sawMarker = false;

  for (const line of lines) {
    const m = line.match(markerRe);
    const role = m ? roleFromLabel(m[1]) : null;
    if (m && role) {
      sawMarker = true;
      if (cur) turns.push(cur);
      cur = { role, lines: [] };
      const inline = stripEmphasis(m[2]);
      if (inline) cur.lines.push(inline);
    } else if (cur) {
      cur.lines.push(line);
    } else {
      // Preamble before the first speaker marker.
      cur = { role: 'transcript', lines: [line] };
    }
  }
  if (cur) turns.push(cur);
  if (!sawMarker) return [];

  return turns
    .map(t => ({ role: t.role, text: t.lines.join('\n').trim() }))
    .filter(t => t.text);
}

function roleFromLabel(label) {
  const l = String(label).toLowerCase().replace(/\s+said$/, '').trim();
  if (['you', 'user', 'me', 'human'].includes(l)) return 'user';
  if (['chatgpt', 'assistant', 'gpt', 'ai', 'bot'].includes(l)) return 'assistant';
  return null;
}

function stripEmphasis(s) {
  return String(s || '').replace(/^[*_\s]+/, '').replace(/[*_\s]+$/, '').trim();
}

function flattenConversationData(data, source, file, root, parent = {}) {
  if (Array.isArray(data)) {
    return data.flatMap(item => flattenConversationData(item, source, file, root, parent));
  }
  if (!data || typeof data !== 'object') return [];

  const conversationId = String(
    parent.conversationId ||
    data.conversation_id ||
    data.conversationId ||
    data.uuid ||
    data.id ||
    data.thread_id ||
    ''
  );
  const title = String(parent.title || data.title || data.name || data.summary || '');
  const nextParent = { conversationId, title };

  if (data.mapping && typeof data.mapping === 'object') {
    return Object.values(data.mapping)
      .map(node => node && node.message ? node.message : null)
      .filter(Boolean)
      .sort((a, b) => Number(a.create_time || 0) - Number(b.create_time || 0))
      .map(msg => normalizeGenericRecord(source, msg, file, root, nextParent))
      .filter(x => x.text);
  }

  const messageArrays = ['messages', 'chat_messages', 'conversation', 'items'];
  for (const key of messageArrays) {
    if (Array.isArray(data[key])) {
      const rows = data[key].flatMap(item => flattenConversationData(item, source, file, root, nextParent));
      if (rows.length) return rows;
    }
  }

  const normalized = normalizeGenericRecord(source, data, file, root, nextParent);
  return normalized.text ? [normalized] : [];
}

async function importClipboardAs(source, label) {
  const root = getWorkspaceRoot();
  if (!root) return;
  const text = await vscode.env.clipboard.readText();
  if (!text.trim()) {
    vscode.window.showWarningMessage(`Clipboard is empty. Copy a ${label} transcript first.`);
    return;
  }
  const imported = importClipboardTranscript(root, text, source);
  const result = await syncNow(root);
  generateOverview(root, result.items);
  vscode.window.showInformationMessage(`Imported ${label} clipboard transcript to ${path.relative(root, imported)}. Use ▶ Continue to resume it.`);
}

async function importTranscriptFiles() {
  const root = getWorkspaceRoot();
  if (!root) return;
  const picked = await vscode.window.showQuickPick(
    [
      { label: 'Claude Chat', source: SOURCE_CLAUDE_CHAT },
      { label: 'ChatGPT', source: SOURCE_CHATGPT }
    ],
    { placeHolder: 'Which transcript source are these files from?' }
  );
  if (!picked) return;

  const uris = await vscode.window.showOpenDialog({
    canSelectMany: true,
    filters: { Transcripts: ['json', 'jsonl', 'md', 'txt'] },
    title: `Import ${picked.label} transcript files`
  });
  if (!uris || !uris.length) return;

  const imported = [];
  for (const uri of uris) {
    imported.push(importTranscriptFile(root, uri.fsPath, picked.source));
  }
  const result = await syncNow(root);
  generateOverview(root, result.items);
  vscode.window.showInformationMessage(`Imported ${imported.length} ${picked.label} transcript file(s). Use ▶ Continue to resume.`);
}

function importClipboardTranscript(root, text, source) {
  const folder = source === SOURCE_CLAUDE_CHAT ? 'claude' : 'chatgpt';
  const dir = path.join(root, '.ai-memory', 'imports', folder);
  ensureDir(dir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const prefix = source === SOURCE_CLAUDE_CHAT ? 'claude' : 'chatgpt';
  const file = path.join(dir, `${prefix}-clipboard-${stamp}.md`);
  fs.writeFileSync(file, text, 'utf8');
  return file;
}

function importTranscriptFile(root, sourceFile, source) {
  const folder = source === SOURCE_CLAUDE_CHAT ? 'claude' : 'chatgpt';
  const dir = path.join(root, '.ai-memory', 'imports', folder);
  ensureDir(dir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const ext = path.extname(sourceFile) || '.txt';
  const base = path.basename(sourceFile, ext).replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 80);
  const target = path.join(dir, `${base}-${stamp}${ext}`);
  fs.copyFileSync(sourceFile, target);
  return target;
}

function normalizeGenericRecord(source, rec, file, cwd, parent = {}) {
  const timestamp = extractTimestamp(rec);
  const role = extractRole(rec);
  const text = extractText(rec);
  const sessionId = String(
    parent.conversationId ||
    rec.sessionId ||
    rec.session_id ||
    rec.conversation_id ||
    rec.conversationId ||
    rec.thread_id ||
    rec.uuid ||
    rec.id ||
    ''
  );
  const title = String(parent.title || rec.title || rec.name || '');
  return {
    source,
    timestamp: normalizeTimestamp(timestamp),
    role,
    text: clip(text, source === SOURCE_CLAUDE_CHAT ? 30000 : 20000),
    file,
    cwd,
    sessionId,
    title,
    id: hash([source, file, timestamp, role, sessionId, text.slice(0, 1000)].join('\n'))
  };
}

function extractTimestamp(obj) {
  if (!obj || typeof obj !== 'object') return new Date().toISOString();
  return (
    obj.timestamp ||
    obj.created_at ||
    obj.createdAt ||
    obj.create_time ||
    obj.created ||
    obj.time ||
    obj.ts ||
    obj.updated_at ||
    obj.updatedAt ||
    obj.message?.create_time ||
    obj.message?.created_at ||
    new Date().toISOString()
  );
}

function normalizeTimestamp(t) {
  if (typeof t === 'number') {
    const ms = t < 10000000000 ? t * 1000 : t;
    return new Date(ms).toISOString();
  }
  const d = new Date(t);
  if (!Number.isNaN(d.getTime())) return d.toISOString();
  return new Date().toISOString();
}

function extractRole(obj) {
  if (!obj || typeof obj !== 'object') return 'unknown';
  return String(
    obj.role ||
    obj.sender ||
    obj.from ||
    obj.author?.role ||
    obj.message?.role ||
    obj.message?.author?.role ||
    obj.message?.sender ||
    obj.item?.role ||
    obj.event?.role ||
    obj.kind ||
    obj.type ||
    'unknown'
  );
}

function extractText(obj) {
  const candidates = [];
  collectText(obj, candidates, 0);
  const joined = candidates
    .map(s => String(s).trim())
    .filter(Boolean)
    .filter(s => !looksLikePathOnly(s))
    .join('\n');
  return joined.trim();
}

function collectText(value, out, depth) {
  if (depth > 7 || out.join('').length > 80000) return;
  if (typeof value === 'string') {
    if (value.trim().length > 0 && !isProbablyId(value)) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectText(v, out, depth + 1);
    return;
  }
  if (!value || typeof value !== 'object') return;

  const preferredKeys = [
    'text',
    'content',
    'parts',
    'input',
    'output',
    'prompt',
    'response',
    'message',
    'command',
    'summary'
  ];
  for (const key of preferredKeys) {
    if (Object.prototype.hasOwnProperty.call(value, key)) collectText(value[key], out, depth + 1);
  }
}

function isProbablyId(s) {
  if (/^[a-f0-9-]{24,}$/i.test(s)) return true;
  if (/^[A-Za-z0-9_-]{32,}$/.test(s) && !s.includes(' ')) return true;
  return false;
}

function looksLikePathOnly(s) {
  const trimmed = s.trim();
  return trimmed.length < 260 && (/^[A-Za-z]:\\/.test(trimmed) || trimmed.startsWith('/')) && !trimmed.includes('\n');
}

function clip(text, max) {
  if (!text) return '';
  return text.length > max ? text.slice(0, max) + '\n...[clipped]' : text;
}

// Single lean memory file: what sessions exist to resume, git status, and the
// most recent activity. No lossy mining — the reliable path is ▶ Continue.
function generateOverview(root, items) {
  ensureDir(path.join(root, '.ai-memory'));
  const recent = recentItems(items, 10);
  const git = getGitSnapshot(root);
  const sessions = listSessions(root).slice(0, 15);

  const lines = [];
  lines.push('# Project Memory — Overview');
  lines.push('');
  lines.push(`_Generated by AI Memory Lite · ${new Date().toISOString()}_`);
  lines.push(`Workspace: ${root}`);
  lines.push('');
  lines.push('## Sessions you can continue');
  lines.push('Run **AI Memory Lite: Continue a Saved Session** (▶ Continue) to reopen any of these:');
  lines.push('');
  if (sessions.length) {
    for (const s of sessions) {
      const title = s.title.length > 80 ? s.title.slice(0, 80).trim() + '…' : s.title;
      lines.push(`- **${title}** — ${s.source} · ${s.date} · ${s.items.length} msg`);
    }
  } else {
    lines.push('- None yet. Import a transcript or sync to populate this.');
  }
  lines.push('');
  lines.push('## Git snapshot');
  lines.push('');
  lines.push('```text');
  lines.push(git.status || 'Clean working tree / no git.');
  lines.push('```');
  lines.push('');
  lines.push('## Most recent activity');
  lines.push('');
  for (const item of recent) {
    lines.push(`### ${item.source}/${item.role} · ${item.timestamp}`);
    if (item.title) lines.push(`_${item.title}_`);
    lines.push('');
    lines.push('```text');
    lines.push(clip(String(item.text).replace(/```/g, "'''"), 1200));
    lines.push('```');
    lines.push('');
  }

  const file = path.join(root, '.ai-memory', 'OVERVIEW.md');
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  maybeCreateAgentFiles(root);
  return file;
}

function recentItems(items, maxItems) {
  return [...items]
    .filter(x => x.text && x.text.trim())
    .sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')))
    .slice(0, maxItems)
    .reverse();
}

// Classify transcript sentences into decisions / bugs / next-steps.
// Each sentence lands in at most one bucket (priority: next > decision > bug)
// and is globally deduped, so the handoff carries signal instead of every
// keyword-matching sentence three times over.

function getGitSnapshot(root) {
  const status = runGit(root, ['status', '--short']);
  const diffNames = runGit(root, ['diff', '--name-only'])
    .split(/\r?\n/)
    .map(x => x.trim())
    .filter(Boolean);
  const stagedNames = runGit(root, ['diff', '--cached', '--name-only'])
    .split(/\r?\n/)
    .map(x => x.trim())
    .filter(Boolean);
  const statusFiles = status
    .split(/\r?\n/)
    .map(line => line.slice(3).trim())
    .filter(Boolean)
    .map(line => line.replace(/^"|"$/g, '').split(' -> ').pop());
  return {
    status,
    files: [...new Set([...statusFiles, ...diffNames, ...stagedNames])].filter(Boolean)
  };
}

function runGit(root, args) {
  try {
    return childProcess.execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true
    }).trim();
  } catch {
    return '';
  }
}

// Menu-driven continuation: pick a saved session, write it out as a clean,
// correctly-named .jsonl, and open it. No copy/paste.
async function continueSession() {
  const root = getWorkspaceRoot();
  if (!root) return;
  await syncNow(root); // refresh index so freshly imported chats show up
  const sessions = listSessions(root);
  if (!sessions.length) {
    vscode.window.showWarningMessage('No saved sessions found yet. Import a transcript or use "Run Everything" first.');
    return;
  }
  const pick = await vscode.window.showQuickPick(
    sessions.map(s => ({
      label: s.label,
      description: s.description,
      detail: s.detail,
      session: s
    })),
    { placeHolder: 'Pick a session to continue', matchOnDescription: true, matchOnDetail: true }
  );
  if (!pick) return;

  const fmtPick = await vscode.window.showQuickPick(
    CONTINUE_FORMATS.map(f => ({ label: f.label, detail: f.detail, fmt: f })),
    { placeHolder: `Continue "${clip(pick.session.title, 50)}" as which format?` }
  );
  if (!fmtPick) return;

  const file = writeSessionFile(root, pick.session, fmtPick.fmt);
  const native = fmtPick.fmt.id.endsWith('-native');
  if (native) {
    const tool = fmtPick.fmt.id.startsWith('claude') ? 'Claude Code' : 'Codex';
    vscode.window.showInformationMessage(`Added "${pick.session.title}" to ${tool}'s resume list. Open ${tool} and resume it — no paste needed.`);
  } else {
    openFile(file);
    vscode.window.showInformationMessage(`Wrote ${path.basename(file)} (${fmtPick.fmt.label}). Open it in your AI tool to continue.`);
  }
}

// Output targets offered when continuing a session. The "native" targets write
// into each tool's own session store so the tool lists and resumes it directly.
const CONTINUE_FORMATS = [
  { id: 'claude-native', ext: 'jsonl', label: 'Claude Code — resume natively', detail: 'writes into ~/.claude so it appears in Claude Code’s resume list' },
  { id: 'codex-native', ext: 'jsonl', label: 'Codex — resume natively', detail: 'writes into ~/.codex (+ session index) so Codex lists it' },
  { id: 'generic', ext: 'jsonl', label: 'Generic chat (.jsonl) in project', detail: 'role/content lines — context for any tool' },
  { id: 'markdown', ext: 'md', label: 'Markdown (.md) in project', detail: 'human-readable transcript' }
];

const CONTINUE_SYSTEM = 'You are continuing a prior AI coding session. The following messages are the previous conversation for this project. Continue from where it left off without asking the user to repeat context.';

// Group normalized index items into sessions, newest first, with menu metadata.
function listSessions(root) {
  const items = parseJsonl(path.join(root, '.ai-memory', 'index.jsonl')).filter(x => x && x.text);
  const groups = new Map();
  for (const it of items) {
    const key = it.sessionId || `nofile-${it.source}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }

  const sessions = [];
  for (const [sessionId, group] of groups) {
    group.sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')));
    const first = group[0];
    const last = group[group.length - 1];
    const title = (group.find(x => x.title && x.title.trim()) || {}).title || firstLine(first.text);
    const date = String(last.timestamp || '').slice(0, 10) || 'undated';
    sessions.push({
      sessionId,
      source: first.source || 'unknown',
      title,
      date,
      items: group,
      label: `$(comment-discussion) ${clip(title, 70)}`,
      description: `${first.source || 'unknown'} · ${group.length} msg`,
      detail: `${date}  ·  ${sessionId}`
    });
  }
  sessions.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return sessions;
}

// Write one session in the chosen format/target. Native targets write into the
// tool's own session store; the others write into .ai-memory/sessions/.
function writeSessionFile(root, session, fmt) {
  const format = fmt || CONTINUE_FORMATS[0];
  if (format.id === 'claude-native') return writeClaudeNative(root, session);
  if (format.id === 'codex-native') return writeCodexNative(root, session);

  const dir = path.join(root, '.ai-memory', 'sessions');
  ensureDir(dir);
  const safeTitle = safeTitleSlug(session.title);
  const file = path.join(dir, `${session.source}-to-${format.id}-${safeTitle}-${session.date}-${hash(session.sessionId).slice(0, 6)}.${format.ext}`);
  const content = format.id === 'markdown' ? toMarkdownTranscript(session) : toGenericChat(session);
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

function safeTitleSlug(title) {
  return String(title || 'session')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'session';
}

function claudeConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR || homePath('.claude');
}

// Write the session into Claude Code's project store so `claude --resume`
// (and the VS Code history) lists it for this project.
function writeClaudeNative(root, session) {
  const encoded = root.replace(/[^a-zA-Z0-9]/g, '-');
  const dir = path.join(claudeConfigDir(), 'projects', encoded);
  ensureDir(dir);
  const newSid = uuidFrom(session.sessionId, 'claude-native', session.title);
  const file = path.join(dir, `${newSid}.jsonl`);

  const lines = [];
  let parentUuid = null;
  session.items.forEach((it, i) => {
    const role = normalizeChatRole(it.role);
    if (role === 'system') return;
    const uuid = uuidFrom(newSid, i, it.text);
    const base = {
      parentUuid,
      isSidechain: false,
      userType: 'external',
      cwd: root,
      sessionId: newSid,
      version: '2.1.201',
      timestamp: it.timestamp,
      uuid
    };
    if (role === 'assistant') {
      lines.push(JSON.stringify({
        ...base,
        type: 'assistant',
        message: { role: 'assistant', type: 'message', model: 'imported', content: [{ type: 'text', text: it.text }], stop_reason: 'end_turn' }
      }));
    } else {
      lines.push(JSON.stringify({
        ...base,
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: it.text }] }
      }));
    }
    parentUuid = uuid;
  });

  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  return file;
}

// Write the session into Codex's session store + index so Codex lists it.
function writeCodexNative(root, session) {
  const codexHome = process.env.CODEX_HOME || homePath('.codex');
  const newSid = uuidFrom(session.sessionId, 'codex-native', session.title);
  const ts = (session.items[0] && session.items[0].timestamp) || `${session.date}T00:00:00.000Z`;
  const [y, m, d] = String(session.date || '').split('-');
  const dir = path.join(codexHome, 'sessions', y || '2026', m || '01', d || '01');
  ensureDir(dir);
  const stamp = String(ts).slice(0, 19).replace(/:/g, '-');
  const file = path.join(dir, `rollout-${stamp}-${newSid}.jsonl`);

  const lines = [JSON.stringify({
    timestamp: ts,
    type: 'session_meta',
    payload: { session_id: newSid, id: newSid, timestamp: ts, cwd: root, originator: 'ai-memory-lite', cli_version: '0.0.0', source: 'ai-memory-lite', thread_source: 'user' }
  })];
  for (const it of session.items) {
    const role = normalizeChatRole(it.role);
    if (role === 'system') continue;
    lines.push(JSON.stringify({
      timestamp: it.timestamp,
      type: 'response_item',
      payload: { type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: it.text }] }
    }));
  }
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');

  // Register a human-readable title so it shows named in Codex's session list.
  const idxFile = path.join(codexHome, 'session_index.jsonl');
  const existing = safeReadFile(idxFile);
  const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
  const idxLine = JSON.stringify({ id: newSid, thread_name: `${session.title} (imported)`, updated_at: ts });
  fs.appendFileSync(idxFile, prefix + idxLine + '\n', 'utf8');
  return file;
}

function toGenericChat(session) {
  const lines = [{ role: 'system', content: CONTINUE_SYSTEM }];
  for (const it of session.items) lines.push({ role: normalizeChatRole(it.role), content: it.text });
  return lines.map(x => JSON.stringify(x)).join('\n') + '\n';
}

function toMarkdownTranscript(session) {
  const out = [`# ${session.title}`, '', `_${session.source} · ${session.date} · ${session.items.length} messages_`, '', `> ${CONTINUE_SYSTEM}`, ''];
  for (const it of session.items) {
    const role = normalizeChatRole(it.role);
    out.push(`## ${role}`, '', it.text, '');
  }
  return out.join('\n');
}

// Deterministic uuid-shaped id (no randomness, stable across runs).
function uuidFrom(sessionId, index, text) {
  const h = hash([sessionId, index, String(text).slice(0, 80)].join('|')) + hash([index, sessionId].join('|'));
  const hex = (h + '0'.repeat(32)).slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function normalizeChatRole(role) {
  const r = String(role || '').toLowerCase();
  if (r.includes('assistant') || r === 'ai' || r === 'bot' || r === 'gpt') return 'assistant';
  if (r.includes('system')) return 'system';
  return 'user'; // user / human / me / transcript / unknown
}

function firstLine(text) {
  return String(text || '').split(/\r?\n/).map(s => s.trim()).find(Boolean) || 'session';
}

function maybeCreateAgentFiles(root) {
  const claude = path.join(root, 'CLAUDE.md');
  const agents = path.join(root, 'AGENTS.md');
  const note = [
    'Before coding, read `.ai-memory/OVERVIEW.md` for project memory.',
    'To resume a specific past chat, run "AI Memory Lite: Continue a Saved Session".',
    'Keep OVERVIEW.md updated after major sessions (▶ AI Memory button).',
    ''
  ].join('\n');
  if (!fs.existsSync(claude)) fs.writeFileSync(claude, '# CLAUDE.md\n\n' + note, 'utf8');
  if (!fs.existsSync(agents)) fs.writeFileSync(agents, '# AGENTS.md\n\n' + note, 'utf8');
}

function openFile(file) {
  vscode.workspace.openTextDocument(vscode.Uri.file(file)).then(doc => vscode.window.showTextDocument(doc));
}
