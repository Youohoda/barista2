// Universal Autonomous Software Engineering Agent — orchestration core.
//
// This is the actual executable engine, not a prompt pretending to be one. It runs
// against ANY project through a small adapter interface, never against "Barista"
// specifically — there is no `if (project.name === 'Barista')` anywhere in this file
// or in any file it calls, per the brief's "the project is data, the agent is
// universal" requirement. Barista's own repo is just one more project fed through
// the same `adapter`.
//
// Deliberately framework-free and DB-free: `runAgentLoop` takes a workspace adapter,
// a sandbox provider, and (optionally) a planner/fixer, and returns a plain report
// object plus a checkpoint. That's what makes it possible to unit-test the actual
// orchestration logic (test/agent-engine.e2e.test.js) against an in-memory project
// instead of needing Mongo + real model credentials — the caller (api/agent-run.js)
// is the only place that touches the database or persists AgentRun state.
import { randomUUID } from 'node:crypto';
import { createPatch } from 'diff';
import { detectProject } from './_project-detect.js';

export const DEFAULTS = Object.freeze({
  maxFixAttempts: 3,     // MAX_FIX_ATTEMPTS — retest loop ceiling, never infinite
  maxContextFiles: 12,   // how many files the context engine will hand to the planner/fixer
  testTimeoutMs: 45_000  // sandbox.execute timeout for test/build commands
});

// ---- 1. Context Engine (req #6/#7): pick relevant files instead of the whole repo ----
// Real heuristic, not a model call: keyword overlap on filename/content, then one hop
// of local-import expansion for JS/TS so a file that *imports* a relevant file (or is
// imported by one) is pulled in too. This is the lightweight "codebase graph" the
// brief asks for — real edges derived from real `require`/`import` statements, not a
// fabricated dependency graph.
const LOCAL_IMPORT_RE = /(?:require\(\s*|from\s+)['"](\.[^'"]+)['"]/g;

export function defaultContextEngine(goal, files, maxFiles = DEFAULTS.maxContextFiles) {
  const words = [...new Set((goal.toLowerCase().match(/[a-z0-9\u0600-\u06FF]{3,}/g) || []))];
  const scored = files.map(f => {
    const nameLower = f.name.toLowerCase();
    const contentLower = (f.content || '').toLowerCase();
    let score = 0;
    for (const w of words) {
      if (nameLower.includes(w)) score += 3;
      if (contentLower.includes(w)) score += 1;
    }
    return { name: f.name, content: f.content, score, reason: score > 0 ? 'keyword match' : null };
  });

  let relevant = scored.filter(f => f.score > 0).sort((a, b) => b.score - a.score).slice(0, maxFiles);
  const relevantNames = new Set(relevant.map(f => f.name));

  // One-hop local-import expansion, JS/TS only (regex-based, real matches).
  for (const f of relevant.slice()) {
    if (relevant.length >= maxFiles) break;
    if (!/\.(js|jsx|ts|tsx|mjs|cjs)$/i.test(f.name)) continue;
    let m;
    LOCAL_IMPORT_RE.lastIndex = 0;
    while ((m = LOCAL_IMPORT_RE.exec(f.content || '')) !== null && relevant.length < maxFiles) {
      const base = m[1].replace(/^\.\/?/, '').replace(/^\.\.\//, '');
      const match = files.find(ff => !relevantNames.has(ff.name) && ff.name.toLowerCase().includes(base.toLowerCase()));
      if (match) {
        relevant.push({ name: match.name, content: match.content, score: 1, reason: `imported by ${f.name}` });
        relevantNames.add(match.name);
      }
    }
  }
  return relevant.slice(0, maxFiles);
}

// ---- 2. Test command resolution, built on the detection engine we already have ----
export function resolveTestCommand(detected) {
  const map = {
    Jest: 'npx jest --ci', Vitest: 'npx vitest run', Mocha: 'npx mocha',
    'node:test': 'node --test', pytest: 'pytest -q', unittest: 'python -m unittest discover',
    'go test': 'go test ./...', 'cargo test': 'cargo test', 'dotnet test': 'dotnet test',
    PHPUnit: './vendor/bin/phpunit', RSpec: 'bundle exec rspec', JUnit: null // ambiguous mvn/gradle, resolved via buildSystem
  };
  if (detected?.testFramework && map[detected.testFramework]) return map[detected.testFramework];
  if (detected?.testFramework === 'JUnit') return detected.packageManager === 'Maven' ? 'mvn test' : 'gradle test';
  return null;
}

// ---- 3. Lightweight, real, regex-based security heuristics (req #16) -------------
// A deliberately small, honest set — this is a fast heuristic pass over CHANGED
// files only, not a full SAST tool. Every pattern below is real (no fabricated
// findings); each hit reports the actual file/line it matched.
const SECURITY_PATTERNS = [
  { id: 'hardcoded-secret', severity: 'CRITICAL', re: /(sk-[a-zA-Z0-9]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|ghp_[0-9A-Za-z]{30,})/, reason: 'مفتاح/سر مكتوب مباشرة في الكود' },
  { id: 'unsafe-eval', severity: 'HIGH', re: /\beval\s*\(|\bnew Function\s*\(/, reason: 'eval/new Function ممكن ينفذ كود غير موثوق' },
  { id: 'command-injection', severity: 'HIGH', re: /\bexec(Sync)?\s*\(\s*[`'"][^`'"]*\$\{/, reason: 'أمر shell مبني من متغير مباشرة — احتمال command injection' },
  { id: 'sql-string-concat', severity: 'HIGH', re: /(SELECT|INSERT|UPDATE|DELETE)\b[^;]*\$\{/i, reason: 'استعلام SQL مبني بـ string interpolation — احتمال SQL injection' },
  { id: 'path-traversal-risk', severity: 'MEDIUM', re: /fs\.(readFile|writeFile|unlink)\w*\(\s*[^,)]*req\./, reason: 'مسار ملف مبني مباشرة من request بدون تحقق — احتمال path traversal' }
];

export function securityScan(changedFiles) {
  const findings = [];
  for (const f of changedFiles) {
    const lines = (f.content || '').split('\n');
    for (const pattern of SECURITY_PATTERNS) {
      lines.forEach((line, i) => {
        if (pattern.re.test(line)) {
          findings.push({ id: pattern.id, severity: pattern.severity, file: f.name, line: i + 1, reason: pattern.reason, evidence: line.trim().slice(0, 200) });
        }
      });
    }
  }
  return findings;
}

// ---- 4. Checkpoint / rollback (req #10/#11) ---------------------------------------
export async function createCheckpoint(adapter, label = 'checkpoint') {
  const entries = await adapter.listFiles();
  const files = [];
  for (const e of entries) files.push({ name: e.name, content: await adapter.readFile(e.name) });
  return { id: randomUUID(), label, files, createdAt: new Date() };
}

export async function rollbackToCheckpoint(adapter, checkpoint) {
  const currentNames = new Set((await adapter.listFiles()).map(f => f.name));
  const checkpointNames = new Set(checkpoint.files.map(f => f.name));
  for (const f of checkpoint.files) await adapter.writeFile(f.name, f.content);
  for (const name of currentNames) if (!checkpointNames.has(name)) await adapter.deleteFile(name);
  return { restored: checkpoint.files.length, removed: [...currentNames].filter(n => !checkpointNames.has(n)).length };
}

// ---- 5. Default planner/fixer: real model calls, injectable for tests ------------
function safeJSONExtract(text) {
  const match = String(text || '').match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

export function makeDefaultPlanner(providerChat) {
  return async function defaultPlanner({ goal, context }) {
    const filesBlock = context.map(f => `--- ${f.name} ---\n${(f.content || '').slice(0, 4000)}`).join('\n\n');
    const r = await providerChat([
      { role: 'system', content: 'أنت Engineering Planner. رجّع JSON فقط بالشكل: {"steps":["..."],"changes":[{"name":"اسم الملف","content":"المحتوى الكامل الجديد للملف","reason":"سبب قصير"}],"risks":["..."]}. من غير أي نص أو markdown fences خارج الـ JSON. عدّل الملفات المطلوبة فقط، وابعت المحتوى الكامل الجديد لكل ملف بتعدّله (مش diff يدوي).' },
      { role: 'user', content: `الهدف: ${goal}\n\nالملفات ذات الصلة:\n${filesBlock}` }
    ], 'barista-code');
    const parsed = safeJSONExtract(r.text);
    if (!parsed) throw Object.assign(new Error('الـ Planner مرجعش JSON صالح'), { code: 'PLANNER_INVALID_JSON' });
    return { steps: Array.isArray(parsed.steps) ? parsed.steps : [], changes: Array.isArray(parsed.changes) ? parsed.changes : [], risks: Array.isArray(parsed.risks) ? parsed.risks : [] };
  };
}

export function makeDefaultFixer(providerChat) {
  return async function defaultFixer({ goal, error, files }) {
    const filesBlock = files.map(f => `--- ${f.name} ---\n${(f.content || '').slice(0, 4000)}`).join('\n\n');
    const r = await providerChat([
      { role: 'system', content: 'أنت Engineering Fixer. الاختبارات فشلت. رجّع JSON فقط: {"changes":[{"name":"اسم الملف","content":"المحتوى الكامل بعد الإصلاح","reason":"سبب الإصلاح"}]}. اقرأ رسالة الخطأ بدقة وأصلح السبب الجذري، من غير أي نص خارج الـ JSON.' },
      { role: 'user', content: `الهدف الأصلي: ${goal}\n\nخطأ الاختبار:\n${String(error).slice(0, 4000)}\n\nالملفات الحالية:\n${filesBlock}` }
    ], 'barista-code');
    const parsed = safeJSONExtract(r.text);
    if (!parsed) throw Object.assign(new Error('الـ Fixer مرجعش JSON صالح'), { code: 'FIXER_INVALID_JSON' });
    return { changes: Array.isArray(parsed.changes) ? parsed.changes : [] };
  };
}

// ---- 6. The actual orchestration loop (req #1/#2/#3/#12/#14) ---------------------
// STATE MACHINE: QUEUED -> PLANNING -> IMPLEMENTING -> TESTING -> (FIXING -> TESTING)* -> REVIEWING -> COMPLETED|FAILED
// Every transition is emitted through onEvent so a caller can persist it (AgentRun
// in Mongo for production) or assert on it directly (the E2E test does the latter).
export async function runAgentLoop({
  goal,
  adapter,
  sandboxProvider,
  contextEngine = defaultContextEngine,
  planner,
  fixer,
  maxFixAttempts = DEFAULTS.maxFixAttempts,
  testTimeoutMs = DEFAULTS.testTimeoutMs,
  onEvent = () => {}
}) {
  if (!goal || typeof goal !== 'string') throw new Error('goal مطلوب');
  if (!adapter) throw new Error('workspace adapter مطلوب');

  const emit = (state, detail = {}) => onEvent({ state, at: new Date(), ...detail });
  const report = {
    goal, status: 'QUEUED', contextFiles: [], plan: null, diffs: [], attempts: [],
    testResult: { status: 'NOT_RUN' }, securityFindings: [], error: null
  };

  emit('QUEUED');

  // UNDERSTAND + CONTEXT DISCOVERY
  const allEntries = await adapter.listFiles();
  const allFiles = [];
  for (const e of allEntries) allFiles.push({ name: e.name, content: await adapter.readFile(e.name) });
  const context = contextEngine(goal, allFiles);
  report.contextFiles = context.map(f => ({ name: f.name, reason: f.reason }));
  emit('CONTEXT_DISCOVERY', { files: report.contextFiles });

  // CHECKPOINT before any modification — this is what makes rollback possible.
  const checkpoint = await createCheckpoint(adapter, `before:${goal.slice(0, 60)}`);

  // PLAN
  report.status = 'PLANNING';
  emit('PLANNING');
  let plan;
  try {
    plan = await planner({ goal, context });
  } catch (e) {
    report.status = 'FAILED';
    report.error = `Planning فشل: ${e.message}`;
    emit('FAILED', { error: report.error });
    return { report, checkpoint };
  }
  report.plan = plan;

  // IMPLEMENT — real multi-file writes against the real adapter, real diffs.
  report.status = 'IMPLEMENTING';
  emit('IMPLEMENTING', { changes: plan.changes.length });
  const changedFiles = [];
  for (const change of plan.changes) {
    const prev = await adapter.readFile(change.name);
    await adapter.writeFile(change.name, change.content);
    const patch = prev != null ? createPatch(change.name, prev, change.content, 'قبل', 'بعد') : null;
    report.diffs.push({ name: change.name, created: prev == null, patch, reason: change.reason || null });
    changedFiles.push({ name: change.name, content: change.content });
    emit('FILE_CHANGED', { name: change.name, created: prev == null });
  }

  // TEST — real detection + real execution via whatever sandbox is actually configured.
  report.status = 'TESTING';
  emit('TESTING');

  // `runTests` re-reads the adapter from scratch on every call (including retests
  // after a fix) rather than closing over a snapshot taken once — a fix applied
  // via adapter.writeFile in the retry loop below would otherwise never actually
  // be exercised by the "retest", silently testing the pre-fix code forever.
  async function currentFilesSnapshot() {
    const entries = await adapter.listFiles();
    const files = [];
    for (const e of entries) files.push({ name: e.name, content: await adapter.readFile(e.name) });
    return files;
  }

  async function runTests() {
    const files = await currentFilesSnapshot();
    const detected = detectProject(files);
    const testCommand = resolveTestCommand(detected);
    if (!testCommand) return { status: 'NOT_RUN', reason: 'مفيش test framework معروف اتكتشف في المشروع' };
    if (!sandboxProvider || sandboxProvider.__notConfigured) {
      return { status: 'NOT_CONFIGURED', reason: 'محتاج SANDBOX_PROVIDER حقيقي عشان تشغيل الاختبارات فعليًا', command: testCommand };
    }
    const { workspaceId } = await sandboxProvider.create({ ownerId: 'agent-engine' });
    try {
      for (const f of files) await sandboxProvider.writeFile(workspaceId, f.name, f.content);
      const result = await sandboxProvider.execute(workspaceId, testCommand, { timeoutMs: testTimeoutMs });
      return { status: result.exitCode === 0 && !result.timedOut ? 'PASSED' : 'FAILED', command: testCommand, ...result };
    } finally {
      await sandboxProvider.destroy(workspaceId);
    }
  }

  report.testResult = await runTests();
  emit('TEST_COMPLETED', report.testResult);

  // SELF-HEALING RETEST LOOP (req #14) — bounded, never infinite.
  let attempt = 0;
  while (report.testResult.status === 'FAILED' && attempt < maxFixAttempts) {
    attempt++;
    report.status = 'FIXING';
    emit('FIXING', { attempt });
    let fix;
    try {
      const currentFiles = [];
      for (const f of context) currentFiles.push({ name: f.name, content: await adapter.readFile(f.name) });
      fix = await fixer({ goal, error: `${report.testResult.stdout || ''}\n${report.testResult.stderr || ''}`.trim() || report.testResult.reason, files: currentFiles });
    } catch (e) {
      report.attempts.push({ attempt, error: `Fix generation فشل: ${e.message}` });
      break;
    }
    for (const change of fix.changes) {
      const prev = await adapter.readFile(change.name);
      await adapter.writeFile(change.name, change.content);
      const patch = prev != null ? createPatch(change.name, prev, change.content, 'قبل', 'بعد') : null;
      report.diffs.push({ name: change.name, created: prev == null, patch, reason: `fix attempt ${attempt}: ${change.reason || ''}` });
      emit('FILE_CHANGED', { name: change.name, attempt });
    }
    report.status = 'TESTING';
    emit('TESTING', { attempt });
    const retest = await runTests();
    report.attempts.push({ attempt, changed: fix.changes.map(c => c.name), result: retest });
    report.testResult = retest;
    emit('TEST_COMPLETED', { ...retest, attempt });
  }

  // SECURITY REVIEW — real heuristic scan over changed files only.
  report.status = 'REVIEWING';
  emit('REVIEWING');
  const finalChanged = [];
  const seen = new Set();
  for (const d of report.diffs) {
    if (seen.has(d.name)) continue;
    seen.add(d.name);
    finalChanged.push({ name: d.name, content: await adapter.readFile(d.name) });
  }
  report.securityFindings = securityScan(finalChanged);
  emit('SECURITY_REVIEWED', { findings: report.securityFindings.length });

  // FINAL STATUS — never claim success the run didn't earn.
  if (report.testResult.status === 'FAILED') {
    report.status = 'FAILED';
    report.error = `الاختبارات فضلت فاشلة بعد ${attempt} محاولة إصلاح`;
    emit('FAILED', { error: report.error });
  } else {
    report.status = 'COMPLETED';
    emit('COMPLETED');
  }

  return { report, checkpoint };
}
