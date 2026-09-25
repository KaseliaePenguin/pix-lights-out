// Claude Code の会話記録 (~/.claude/projects/**/*.jsonl) を読み、このプロジェクトの利用状況を集計する
//
// 単体実行: node tools/claude-dashboard/collect.mjs  (集計結果の JSON を出力)

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECTS_ROOT = process.env.CLAUDE_PROJECTS_DIR ?? join(homedir(), '.claude', 'projects');
const ACTIVE_MS = 5 * 60 * 1000;

const slug = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');
const norm = (p) => p.replace(/\//g, '\\').toLowerCase();

function loadPricing() {
  return JSON.parse(readFileSync(join(HERE, 'pricing.json'), 'utf8'));
}

function priceFor(pricing, model) {
  if (pricing.models[model]) return pricing.models[model];
  // 日付付きなどの派生 ID は最長一致で探す
  const key = Object.keys(pricing.models)
    .filter((k) => model?.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  return key ? pricing.models[key] : null;
}

function emptyUsage() {
  return { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, cost: 0, requests: 0, unpriced: 0 };
}

function addUsage(target, u) {
  for (const k of Object.keys(target)) target[k] += u[k] ?? 0;
}

function usageOf(message, pricing) {
  const u = message.usage ?? {};
  const w1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const w5m = u.cache_creation?.ephemeral_5m_input_tokens ?? Math.max(0, (u.cache_creation_input_tokens ?? 0) - w1h);
  const out = {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cacheWrite5m: w5m,
    cacheWrite1h: w1h,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cost: 0,
    requests: 1,
    unpriced: 0,
  };
  const p = priceFor(pricing, message.model);
  if (!p) {
    out.unpriced = 1;
    return out;
  }
  const speed = u.speed === 'fast' ? (p.fastMultiplier ?? 1) : 1;
  out.cost =
    (speed *
      (out.input * p.input +
        out.output * p.output +
        out.cacheWrite5m * p.input * pricing.cacheWrite5mMultiplier +
        out.cacheWrite1h * p.input * pricing.cacheWrite1hMultiplier +
        out.cacheRead * p.cacheRead)) /
    1e6;
  return out;
}

function listJsonl(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'memory') files.push(...listJsonl(full));
    } else if (entry.name.endsWith('.jsonl')) {
      files.push(full);
    }
  }
  return files;
}

function readRecords(file) {
  const text = readFileSync(file, 'utf8');
  const records = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // 書き込み途中の行は無視する
    }
  }
  return { text, records };
}

/** <task-notification> から task-id / tool-use-id ごとの最終状態を拾う */
function parseNotifications(text) {
  const byTaskId = new Map();
  const byToolUseId = new Map();
  const re = /<task-notification>([\s\S]*?)<\/task-notification>/g;
  const unescaped = text.replace(/\\n/g, '\n').replace(/\\"/g, '"');
  for (const m of unescaped.matchAll(re)) {
    const body = m[1];
    const status = body.match(/<status>(.*?)<\/status>/)?.[1];
    const summary = body.match(/<summary>([\s\S]*?)<\/summary>/)?.[1];
    const taskId = body.match(/<task-id>(.*?)<\/task-id>/)?.[1];
    const toolUseId = body.match(/<tool-use-id>(.*?)<\/tool-use-id>/)?.[1];
    const info = { status, summary };
    if (taskId) byTaskId.set(taskId, info);
    if (toolUseId) byToolUseId.set(toolUseId, info);
  }
  return { byTaskId, byToolUseId };
}

function readAgentDefinitions(projectPath) {
  const dir = join(projectPath, '.claude', 'agents');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const text = readFileSync(join(dir, f), 'utf8');
      const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? '';
      const field = (k) => fm.match(new RegExp(`^${k}:\\s*(.*)$`, 'm'))?.[1]?.trim();
      return {
        name: field('name') ?? basename(f, '.md'),
        description: field('description') ?? '',
        tools: field('tools') ?? '(すべて)',
        model: field('model') ?? '(継承)',
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function collect(projectPath = process.env.DASHBOARD_PROJECT ?? process.cwd()) {
  projectPath = resolve(projectPath);
  const pricing = loadPricing();
  const projectSlug = slug(projectPath);
  const projectNorm = norm(projectPath);
  const now = Date.now();

  // プロジェクト自身とその親ディレクトリで起動したセッションが候補 (親の場合は cwd がプロジェクト内のものだけ)
  const dirs = existsSync(PROJECTS_ROOT)
    ? readdirSync(PROJECTS_ROOT).filter((d) => projectSlug.startsWith(d) || d.startsWith(projectSlug))
    : [];

  const sessions = new Map();
  const subagentFiles = [];

  for (const d of dirs) {
    const isParentDir = !d.startsWith(projectSlug);
    for (const file of listJsonl(join(PROJECTS_ROOT, d))) {
      const { text, records } = readRecords(file);
      if (!records.length) continue;
      const touchesProject = records.some((r) => r.cwd && norm(r.cwd).startsWith(projectNorm));
      if (isParentDir && !touchesProject) continue;
      const isSubagent = file.split(/[\\/]/).includes('subagents') || records.every((r) => r.isSidechain !== false);
      if (isSubagent) subagentFiles.push({ file, text, records });
      else sessions.set(basename(file, '.jsonl'), { file, text, records });
    }
  }

  const total = emptyUsage();
  const byModel = {};
  const byDay = {};
  const sessionRows = [];
  const agentRuns = [];
  const backgroundTasks = [];
  const todos = [];
  const activeSessions = [];

  function accumulate(records, target, label) {
    const seen = new Map();
    for (const r of records) {
      if (r.type !== 'assistant' || !r.message?.usage) continue;
      seen.set(r.message.id ?? r.uuid, r);
    }
    for (const r of seen.values()) {
      const u = usageOf(r.message, pricing);
      addUsage(target, u);
      addUsage(total, u);
      const model = r.message.model ?? 'unknown';
      byModel[model] ??= emptyUsage();
      addUsage(byModel[model], u);
      const day = new Date(r.timestamp).toLocaleDateString('sv-SE');
      byDay[day] ??= { cost: 0, requests: 0, main: 0, subagent: 0 };
      byDay[day].cost += u.cost;
      byDay[day].requests += 1;
      byDay[day][label] += u.cost;
    }
  }

  for (const [id, { records, text }] of sessions) {
    const usage = emptyUsage();
    accumulate(records, usage, 'main');
    const times = records.map((r) => Date.parse(r.timestamp)).filter(Number.isFinite);
    const first = Math.min(...times);
    const last = Math.max(...times);
    const title = records.filter((r) => r.type === 'ai-title').at(-1)?.aiTitle ?? '(無題)';
    const lastPrompt = records.filter((r) => r.type === 'last-prompt').at(-1)?.lastPrompt ?? '';
    const tools = {};
    const notes = parseNotifications(text);
    const results = new Map();
    for (const r of records) {
      if (r.type !== 'user' || !Array.isArray(r.message?.content)) continue;
      for (const c of r.message.content) {
        if (c.type === 'tool_result') results.set(c.tool_use_id, { record: r, block: c });
      }
    }
    let latestTodos = null;
    const tasks = new Map();

    for (const r of records) {
      if (r.type !== 'assistant' || !Array.isArray(r.message?.content)) continue;
      for (const c of r.message.content) {
        if (c.type !== 'tool_use') continue;
        tools[c.name] = (tools[c.name] ?? 0) + 1;
        const result = results.get(c.id);
        const input = c.input ?? {};

        if (c.name === 'Agent' || c.name === 'Task') {
          const note = notes.byToolUseId.get(c.id);
          let status = 'running';
          if (note?.status) status = note.status;
          // 起動自体がエラーになった場合は完了通知が来ないため、結果のエラーで失敗と判定する
          else if (result?.block.is_error) status = 'failed';
          else if (result && !input.run_in_background) status = 'completed';
          agentRuns.push({
            session: id,
            toolUseId: c.id,
            agent: input.subagent_type ?? 'general-purpose',
            description: input.description ?? '',
            background: !!input.run_in_background,
            startedAt: r.timestamp,
            finishedAt: status === 'running' ? null : (result?.record.timestamp ?? null),
            status,
          });
        }

        if ((c.name === 'Bash' || c.name === 'PowerShell') && input.run_in_background) {
          const taskId = result?.record.toolUseResult?.backgroundTaskId;
          const note = taskId ? notes.byTaskId.get(taskId) : undefined;
          backgroundTasks.push({
            session: id,
            taskId: taskId ?? null,
            description: input.description ?? input.command?.slice(0, 80) ?? '',
            startedAt: r.timestamp,
            status: note?.status ?? (now - last > 12 * 3600 * 1000 ? 'unknown' : 'running'),
            summary: note?.summary ?? '',
          });
        }

        if (c.name === 'TodoWrite' && Array.isArray(input.todos)) latestTodos = input.todos;
        if (c.name === 'TaskCreate') {
          const tid = result?.record.toolUseResult?.task?.id ?? result?.record.toolUseResult?.id ?? c.id;
          tasks.set(String(tid), { content: input.subject ?? input.description ?? '', status: 'pending' });
        }
        if (c.name === 'TaskUpdate' && input.taskId && tasks.has(String(input.taskId))) {
          const t = tasks.get(String(input.taskId));
          if (input.status) t.status = input.status;
          if (input.subject) t.content = input.subject;
        }
      }
    }

    const sessionTodos = [...(latestTodos ?? []), ...tasks.values()].map((t) => ({
      session: id,
      content: t.content ?? '',
      status: t.status ?? 'pending',
    }));
    todos.push(...sessionTodos);

    const active = now - last < ACTIVE_MS;
    if (active) activeSessions.push({ id, title, lastPrompt, lastActivity: new Date(last).toISOString() });

    sessionRows.push({
      id,
      title,
      lastPrompt,
      startedAt: new Date(first).toISOString(),
      lastActivity: new Date(last).toISOString(),
      active,
      usage,
      tools,
      models: [...new Set(records.map((r) => r.message?.model).filter(Boolean))],
    });
  }

  // サブエージェントの記録: 親セッションとエージェント種別ごとに集計する
  const subagentUsage = {};
  for (const { file, records } of subagentFiles) {
    const usage = emptyUsage();
    accumulate(records, usage, 'subagent');
    const metaPath = file.replace(/\.jsonl$/, '.meta.json');
    const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : {};
    const agent =
      meta.agentType ?? meta.subagent_type ?? records.find((r) => r.agentType || r.subagentType)?.agentType ?? '(不明)';
    subagentUsage[agent] ??= { ...emptyUsage(), runs: 0 };
    subagentUsage[agent].runs += 1;
    addUsage(subagentUsage[agent], usage);
    const parent = records.find((r) => r.sessionId)?.sessionId;
    const row = sessionRows.find((s) => s.id === parent);
    if (row) {
      row.subagentUsage ??= emptyUsage();
      addUsage(row.subagentUsage, usage);
    }
  }

  const definitions = readAgentDefinitions(projectPath);
  const agents = definitions.map((def) => {
    const runs = agentRuns.filter((r) => r.agent === def.name);
    return {
      ...def,
      runs: runs.length,
      running: runs.filter((r) => r.status === 'running').length,
      lastRun: runs.map((r) => r.startedAt).sort().at(-1) ?? null,
      cost: subagentUsage[def.name]?.cost ?? 0,
    };
  });
  // 定義ファイルにない組み込みエージェント (Explore, general-purpose など) の実行も表示する
  for (const name of new Set(agentRuns.map((r) => r.agent))) {
    if (agents.some((a) => a.name === name)) continue;
    const runs = agentRuns.filter((r) => r.agent === name);
    agents.push({
      name,
      description: '(組み込み)',
      tools: '',
      model: '',
      builtin: true,
      runs: runs.length,
      running: runs.filter((r) => r.status === 'running').length,
      lastRun: runs.map((r) => r.startedAt).sort().at(-1) ?? null,
      cost: subagentUsage[name]?.cost ?? 0,
    });
  }

  sessionRows.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
  agentRuns.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  backgroundTasks.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const today = new Date().toLocaleDateString('sv-SE');

  return {
    generatedAt: new Date().toISOString(),
    projectPath,
    pricingNote: pricing._note,
    total,
    today: byDay[today]?.cost ?? 0,
    byModel,
    byDay: Object.entries(byDay)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, v]) => ({ day, ...v })),
    sessions: sessionRows,
    activeSessions,
    agents,
    agentRuns,
    subagentUsage,
    backgroundTasks,
    todos,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(collect(), null, 2));
}
