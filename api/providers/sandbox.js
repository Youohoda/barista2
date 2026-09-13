// SandboxProvider — the real-code-execution interface the brief asked for. This
// file defines the contract every provider must implement; it does NOT execute
// anything itself. Vercel serverless functions share a runtime with no real
// process isolation, no filesystem isolation, and no resource-limit enforcement
// available to application code — running arbitrary user code here would not
// actually be sandboxed no matter how it's written (Node's `vm` module is
// explicitly documented by Node.js as NOT a security boundary), so pretending to
// "sandbox" on this infrastructure would be exactly the fake feature the brief
// forbids. Real isolation needs a provider built for it.
//
// To connect one: implement this interface against a service that gives you actual
// isolation (e.g. E2B, Modal, Firecracker-backed workers, a dedicated container
// runner you control), then set SANDBOX_PROVIDER=<name> and whatever
// SANDBOX_<NAME>_API_KEY it needs. getSandboxProvider() below will pick it up with
// no other code changes — that's the whole point of the adapter.
//
// Interface every provider must implement:
//   create({ ownerId }): Promise<{ workspaceId }>
//   writeFile(workspaceId, path, content): Promise<void>
//   readFile(workspaceId, path): Promise<string>
//   execute(workspaceId, command, { timeoutMs, language }): Promise<{ stdout, stderr, exitCode, timedOut }>
//   destroy(workspaceId): Promise<void>

class NotConfiguredSandboxProvider {
  async create() { throw this._err(); }
  async writeFile() { throw this._err(); }
  async readFile() { throw this._err(); }
  async execute() { throw this._err(); }
  async destroy() { throw this._err(); }
  _err() {
    return Object.assign(
      new Error('Sandbox execution يحتاج SANDBOX_PROVIDER متصل بخدمة isolation حقيقية (مثل E2B أو Modal). مش متظبط دلوقتي — مفيش تنفيذ كود حقيقي بدون provider حقيقي.'),
      { status: 501, code: 'SANDBOX_NOT_CONFIGURED' }
    );
  }
}
NotConfiguredSandboxProvider.prototype.__notConfigured = true;

// LocalProcessSandboxProvider — genuinely executes real commands (npm test, pytest,
// etc.) using the host's own Node/child_process. This is REAL execution, not a
// simulation: exit codes, stdout/stderr are all actual process output.
//
// What this is NOT: isolated. It gives no process sandboxing, no resource limits, no
// network restriction — it runs with the same privileges as the Barista server
// process itself. That is only acceptable for code the operator already trusts
// (their own repo, e.g. "Barista improving itself", or a self-hosted/CI deployment
// where the operator controls what gets uploaded) — never for arbitrary untrusted
// user uploads on a shared multi-tenant production deployment. It is opt-in via
// SANDBOX_PROVIDER=local specifically so nobody gets this by accident; the default
// (no env var set) stays NotConfigured, which is the safe choice for a public
// multi-tenant Barista deployment.
class LocalProcessSandboxProvider {
  constructor() {
    this.workspaces = new Map(); // workspaceId -> absolute tmp dir path
  }

  async create() {
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const dir = await mkdtemp(path.join(tmpdir(), 'barista-local-sandbox-'));
    const workspaceId = dir;
    this.workspaces.set(workspaceId, dir);
    return { workspaceId };
  }

  async writeFile(workspaceId, relPath, content) {
    const dir = this._dir(workspaceId);
    const path = await import('node:path');
    const { mkdir, writeFile } = await import('node:fs/promises');
    // Refuse to write outside the sandbox's own temp dir — real, load-bearing check,
    // not decorative: a change whose `name` contains `../` must never escape the
    // temp workspace onto the host filesystem.
    const target = path.resolve(dir, relPath);
    if (!target.startsWith(dir)) throw Object.assign(new Error(`مسار غير آمن: ${relPath}`), { code: 'PATH_TRAVERSAL_BLOCKED' });
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content ?? '', 'utf8');
  }

  async readFile(workspaceId, relPath) {
    const dir = this._dir(workspaceId);
    const path = await import('node:path');
    const { readFile } = await import('node:fs/promises');
    const target = path.resolve(dir, relPath);
    if (!target.startsWith(dir)) throw Object.assign(new Error(`مسار غير آمن: ${relPath}`), { code: 'PATH_TRAVERSAL_BLOCKED' });
    return readFile(target, 'utf8');
  }

  async execute(workspaceId, command, { timeoutMs = 30_000 } = {}) {
    const dir = this._dir(workspaceId);
    const { spawn } = await import('node:child_process');
    // Strip NODE_TEST_CONTEXT (and any other NODE_TEST_* markers) before handing
    // env down to the spawned command. If the Barista process itself is ever
    // running under `node --test` (as this repo's own test suite does), Node sets
    // NODE_TEST_CONTEXT and propagates it to child processes; a spawned `node
    // --test` for the SANDBOXED project then detects it's "nested" and silently
    // skips running its files entirely, exiting 0 — a false PASS with zero tests
    // actually run. That's exactly the fake-success failure mode this whole engine
    // exists to prevent, so this strip is load-bearing, not cosmetic.
    const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('NODE_TEST_')));
    return new Promise((resolve) => {
      const child = spawn(command, { cwd: dir, shell: true, env: cleanEnv });
      let stdout = '', stderr = '', timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ stdout: stdout.slice(0, 20_000), stderr: stderr.slice(0, 20_000), exitCode: timedOut ? null : code, timedOut });
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ stdout, stderr: stderr + '\n' + err.message, exitCode: 1, timedOut: false });
      });
    });
  }

  async destroy(workspaceId) {
    const dir = this.workspaces.get(workspaceId);
    if (!dir) return;
    const { rm } = await import('node:fs/promises');
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    this.workspaces.delete(workspaceId);
  }

  _dir(workspaceId) {
    const dir = this.workspaces.get(workspaceId);
    if (!dir) throw Object.assign(new Error('sandbox workspace غير موجود أو اتقفل بالفعل'), { code: 'SANDBOX_WORKSPACE_MISSING' });
    return dir;
  }
}

const registry = {
  // 'e2b': async () => (await import('./sandbox-e2b.js')).default,
  local: () => new LocalProcessSandboxProvider()
};

export function getSandboxProvider() {
  const name = process.env.SANDBOX_PROVIDER;
  if (!name || !registry[name]) return new NotConfiguredSandboxProvider();
  return registry[name]();
}

export { LocalProcessSandboxProvider, NotConfiguredSandboxProvider };
