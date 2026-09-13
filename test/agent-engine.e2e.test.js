import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgentLoop, rollbackToCheckpoint } from '../api/_agent-engine.js';
import { LocalProcessSandboxProvider, NotConfiguredSandboxProvider } from '../api/providers/sandbox.js';

// ---- In-memory workspace adapter — same interface the Mongo-backed adapter in
// api/agent-run.js implements, so the engine code under test is identical to what
// production actually runs. ----------------------------------------------------
function inMemoryAdapter(initialFiles) {
  const store = new Map(initialFiles.map(f => [f.name, f.content]));
  return {
    async listFiles() { return [...store.keys()].map(name => ({ name })); },
    async readFile(name) { return store.has(name) ? store.get(name) : null; },
    async writeFile(name, content) { store.set(name, content); },
    async deleteFile(name) { return store.delete(name); },
    _store: store // test-only escape hatch to inspect final state directly
  };
}

// ---- Deterministic fixture project: a real, known bug ------------------------
// `add` is wrong on purpose (subtracts instead of adding); math.test.js is a real
// node:test file that actually fails against it. This is executed for real by
// LocalProcessSandboxProvider (real child_process, real `node --test`, real exit
// code) — nothing about the test execution itself is simulated.
function fixtureProject() {
  return [
    { name: 'package.json', content: JSON.stringify({ name: 'fixture', scripts: { test: 'node --test' } }) },
    { name: 'math.js', content: 'function add(a, b) {\n  return a - b; // bug: should be a + b\n}\nmodule.exports = { add };\n' },
    { name: 'math.test.js', content: "const test = require('node:test');\nconst assert = require('node:assert/strict');\nconst { add } = require('./math.js');\ntest('add sums two numbers', () => {\n  assert.equal(add(2, 3), 5);\n});\n" }
  ];
}

// ---- Test doubles for planner/fixer -------------------------------------------
// These stand in for real model calls (makeDefaultPlanner/makeDefaultFixer in
// _agent-engine.js, which call the real providerChat) — this test environment has
// no model API credentials, and the point of this test is to prove the
// ORCHESTRATION LOOP is real (checkpoint → implement → test → detect failure →
// fix → retest → pass), not to grade model output quality. The planner
// deliberately applies a WRONG fix first, so the test genuinely exercises the
// self-healing retry path rather than trivially passing on attempt one.
async function wrongFirstPlanner({ goal }) {
  return {
    steps: [`Understand: ${goal}`, 'Patch add() in math.js'],
    changes: [{ name: 'math.js', content: 'function add(a, b) {\n  return a * b; // still wrong on purpose\n}\nmodule.exports = { add };\n', reason: 'first attempt' }],
    risks: []
  };
}
async function correctFixer() {
  return {
    changes: [{ name: 'math.js', content: 'function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n', reason: 'correct the operator' }]
  };
}

test('agent engine: implement -> test fails -> self-heal -> retest passes (real local execution)', async () => {
  const adapter = inMemoryAdapter(fixtureProject());
  const sandboxProvider = new LocalProcessSandboxProvider();
  const events = [];

  const { report, checkpoint } = await runAgentLoop({
    goal: 'Fix the add() bug in math.js',
    adapter,
    sandboxProvider,
    planner: wrongFirstPlanner,
    fixer: correctFixer,
    maxFixAttempts: 3,
    onEvent: (e) => events.push(e.state)
  });

  // The state machine actually went through the real sequence, including a real
  // fix/retest cycle — not a shortcut straight to COMPLETED.
  assert.ok(events.includes('IMPLEMENTING'));
  assert.ok(events.includes('TESTING'));
  assert.ok(events.includes('FIXING'), 'must have entered the self-healing loop since the first attempt was wrong');
  assert.ok(events.includes('COMPLETED'));
  assert.equal(events.includes('FAILED'), false);

  // The REAL, final test run genuinely passed — this came from an actual `node
  // --test` child process, not a claimed/simulated result.
  assert.equal(report.testResult.status, 'PASSED');
  assert.equal(report.status, 'COMPLETED');

  // The retry loop is visible and bounded — exactly one fix attempt was needed here.
  assert.equal(report.attempts.length, 1);
  assert.equal(report.attempts[0].result.status, 'PASSED');

  // The workspace itself was actually modified (not just described in a chat reply).
  const finalMath = await adapter.readFile('math.js');
  assert.match(finalMath, /return a \+ b/);

  // A real diff was generated for every change, including the fix attempt.
  assert.ok(report.diffs.length >= 2);
  assert.ok(report.diffs.some(d => /fix attempt 1/.test(d.reason || '')));

  // Checkpoint captured the ORIGINAL buggy file before anything changed.
  const originalSnapshot = checkpoint.files.find(f => f.name === 'math.js');
  assert.match(originalSnapshot.content, /return a - b/);
});

test('agent engine: rollback restores the pre-run checkpoint exactly, undoing a bad autonomous run', async () => {
  const adapter = inMemoryAdapter(fixtureProject());
  const sandboxProvider = new LocalProcessSandboxProvider();

  const { checkpoint } = await runAgentLoop({
    goal: 'Fix the add() bug in math.js',
    adapter, sandboxProvider,
    planner: wrongFirstPlanner, fixer: correctFixer,
    onEvent: () => {}
  });

  // Confirm the run actually changed the file before we roll back.
  assert.match(await adapter.readFile('math.js'), /return a \+ b/);

  await rollbackToCheckpoint(adapter, checkpoint);

  // File is back to the exact original buggy content — real restoration, not a
  // cosmetic status flag.
  assert.match(await adapter.readFile('math.js'), /return a - b/);
});

test('agent engine: an unconfigured sandbox is reported honestly, never as a fake pass', async () => {
  const adapter = inMemoryAdapter(fixtureProject());
  const sandboxProvider = new NotConfiguredSandboxProvider();

  const { report } = await runAgentLoop({
    goal: 'Fix the add() bug in math.js',
    adapter, sandboxProvider,
    planner: wrongFirstPlanner, // deliberately still buggy — there's no way to know without running tests
    fixer: correctFixer,
    onEvent: () => {}
  });

  // Never claims PASSED when nothing actually ran.
  assert.equal(report.testResult.status, 'NOT_CONFIGURED');
  assert.notEqual(report.testResult.status, 'PASSED');
  // The fix loop never fires on a status it can't distinguish from a real failure.
  assert.equal(report.attempts.length, 0);
});

test('local sandbox provider blocks a path-traversal file name instead of writing outside its temp dir', async () => {
  const provider = new LocalProcessSandboxProvider();
  const { workspaceId } = await provider.create();
  try {
    await assert.rejects(
      () => provider.writeFile(workspaceId, '../../etc/evil.txt', 'x'),
      /مسار غير آمن|PATH_TRAVERSAL_BLOCKED/
    );
  } finally {
    await provider.destroy(workspaceId);
  }
});

// Regression test for a real bug found while building this: when the Barista
// process itself runs under `node --test` (exactly like this test suite does),
// Node sets NODE_TEST_CONTEXT and it was leaking into the spawned sandbox
// process's env, making a nested `node --test` silently skip its own test file
// and exit 0 — the sandbox reported PASSED with zero tests actually executed.
test('local sandbox execution is isolated from an outer NODE_TEST_CONTEXT and actually runs the tests', async () => {
  assert.ok(process.env.NODE_TEST_CONTEXT, 'sanity check: this test itself must be running under `node --test`');
  const provider = new LocalProcessSandboxProvider();
  const { workspaceId } = await provider.create();
  try {
    await provider.writeFile(workspaceId, 'package.json', JSON.stringify({ scripts: { test: 'node --test' } }));
    await provider.writeFile(workspaceId, 'x.test.js', "const test=require('node:test');const assert=require('node:assert/strict');test('t',()=>{assert.equal(1,2);});");
    const result = await provider.execute(workspaceId, 'node --test', { timeoutMs: 15_000 });
    // Must genuinely run the (failing) test and report FAILED — not skip and report 0.
    assert.equal(result.exitCode, 1);
    assert.match(result.stdout, /not ok/);
    assert.doesNotMatch(result.stderr, /being called recursively/);
  } finally {
    await provider.destroy(workspaceId);
  }
});
