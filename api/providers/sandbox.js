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

const registry = {
  // 'e2b': async () => (await import('./sandbox-e2b.js')).default,
};

export function getSandboxProvider() {
  const name = process.env.SANDBOX_PROVIDER;
  if (!name || !registry[name]) return new NotConfiguredSandboxProvider();
  return registry[name]();
}
