// BrowserProvider — real Browser Agent interface. Vercel serverless has no headless
// browser runtime available by default (Chromium binaries don't ship in this
// environment and cold-start cost/size makes bundling one impractical on this
// architecture) — so this file is the contract only, exactly like sandbox.js.
//
// To connect one: point at a real provider that runs actual headless Chromium
// (Browserless, Playwright-on-your-own-server, etc.), implement this interface,
// set BROWSER_PROVIDER=<name>.
//
// Interface every provider must implement:
//   launch({ ownerId }): Promise<{ sessionId }>
//   navigate(sessionId, url): Promise<{ title, url }>
//   readPage(sessionId): Promise<{ text, html }>
//   findElements(sessionId, selectorOrText): Promise<Array<{ selector, text }>>
//   click(sessionId, selector): Promise<void>
//   type(sessionId, selector, text): Promise<void>
//   screenshot(sessionId): Promise<{ dataUrl }>
//   close(sessionId): Promise<void>
//
// Safeguards any real implementation MUST enforce before this is production-grade:
// a domain allowlist/denylist, a per-session navigation timeout, and refusal to
// submit forms or click destructive-looking actions (checkout/delete/transfer)
// without an explicit `authorized: true` flag from the calling request.

class NotConfiguredBrowserProvider {
  async launch() { throw this._err(); }
  async navigate() { throw this._err(); }
  async readPage() { throw this._err(); }
  async findElements() { throw this._err(); }
  async click() { throw this._err(); }
  async type() { throw this._err(); }
  async screenshot() { throw this._err(); }
  async close() { throw this._err(); }
  _err() {
    return Object.assign(
      new Error('Browser Agent يحتاج BROWSER_PROVIDER متصل بـ headless browser حقيقي. مش متظبط دلوقتي.'),
      { status: 501, code: 'BROWSER_NOT_CONFIGURED' }
    );
  }
}

const registry = {};

export function getBrowserProvider() {
  const name = process.env.BROWSER_PROVIDER;
  if (!name || !registry[name]) return new NotConfiguredBrowserProvider();
  return registry[name]();
}
