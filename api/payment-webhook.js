import { db, Order, User, json, body, rawBody } from './_lib.js';
import { verifyPaymobHmac } from './_payments/paymob.js';
import { verifyStripeSignature } from './_payments/stripe.js';
import { verifyFawryCallback } from './_payments/fawry.js';

function addMonths(base, months) {
  const d = new Date(base && new Date(base) > new Date() ? base : new Date());
  d.setMonth(d.getMonth() + months);
  return d;
}

// Called only after a provider's signature has been verified. Idempotent: if the order
// is already "paid" (provider retried the webhook), this is a no-op — we never credit twice.
async function creditOrder(order, rawPayload) {
  if (order.status === 'paid') return;
  order.status = 'paid';
  order.paidAt = new Date();
  order.providerPayload = rawPayload;
  await order.save();

  let u = await User.findOne({ clerkId: order.ownerId });
  if (!u) u = await User.create({ clerkId: order.ownerId, email: order.email, plan: 'free' });
  u.plan = order.plan;
  u.unlimited = false;
  u.premiumExpiresAt = addMonths(u.premiumExpiresAt, order.months);
  await u.save();
}

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
  const provider = String(req.query?.provider || '');
  try {
    await db();

    if (provider === 'stripe') {
      const raw = await rawBody(req);
      const sig = req.headers['stripe-signature'];
      const event = verifyStripeSignature(raw, sig); // throws if invalid — request is rejected
      if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const ref = session.client_reference_id || session.metadata?.merchantOrderId;
        const order = await Order.findOne({ ref, provider: 'stripe' });
        if (order) await creditOrder(order, session);
      }
      return json(res, 200, { received: true });
    }

    if (provider === 'paymob') {
      const b = await body(req);
      const transaction = b.obj || b;
      const receivedHmac = String(req.query?.hmac || '');
      const valid = transaction.success && await verifyPaymobHmac(transaction, receivedHmac);
      if (!valid) return json(res, 400, { error: 'invalid signature' });
      const ref = transaction.order?.merchant_order_id;
      const order = await Order.findOne({ ref, provider: 'paymob' });
      if (order) await creditOrder(order, transaction);
      return json(res, 200, { received: true });
    }

    if (provider === 'fawry') {
      const params = req.method === 'GET' ? req.query : await body(req);
      const valid = await verifyFawryCallback(params);
      if (!valid) return json(res, 400, { error: 'invalid signature' });
      if (String(params.orderStatus) === 'PAID') {
        const ref = params.merchantRefNumber;
        const order = await Order.findOne({ ref, provider: 'fawry' });
        if (order) await creditOrder(order, params);
      }
      return json(res, 200, { received: true });
    }

    return json(res, 400, { error: 'Unknown provider' });
  } catch (e) {
    return json(res, e.status || 400, { error: e.message || 'webhook error' });
  }
}
