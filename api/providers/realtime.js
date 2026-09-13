// RealtimeProvider — for live presence/sync in shared projects (collaborators
// seeing each other's cursor, live task updates, etc.). Vercel serverless functions
// don't hold long-lived connections, so real-time push needs an external pub/sub
// service (Pusher, Ably, a separate WebSocket server you run). Not connected here —
// the collaboration features that work today (members/roles/activity log, see
// api/collaboration.js) are pull-based (refetch), which is real and correct, just
// not instant.
//
// Interface every provider must implement:
//   publish(channel, event, payload): Promise<void>
//   subscribe(channel): returns provider-specific client-side subscribe token/config

class NotConfiguredRealtimeProvider {
  async publish() { throw this._err(); }
  subscribe() { throw this._err(); }
  _err() { return Object.assign(new Error('Realtime collaboration يحتاج REALTIME_PROVIDER حقيقي (زي Pusher/Ably). مش متظبط دلوقتي — التعاون الحالي pull-based فقط.'), { status: 501, code: 'REALTIME_NOT_CONFIGURED' }); }
}

const registry = {};

export function getRealtimeProvider() {
  const name = process.env.REALTIME_PROVIDER;
  if (!name || !registry[name]) return new NotConfiguredRealtimeProvider();
  return registry[name]();
}
