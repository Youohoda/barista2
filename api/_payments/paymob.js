// Paymob "Accept" standard redirect/iframe flow (Egypt): supports Visa/Mastercard,
// mobile wallets, and Fawry-network kiosk payment — all through ONE integration.
// Docs: https://docs.paymob.com/docs/accept-standard-redirect
//
// Required env vars:
//   PAYMOB_API_KEY          — from Paymob dashboard > Settings > Account Info
//   PAYMOB_INTEGRATION_ID   — the integration id of the payment method (card/wallet/kiosk)
//   PAYMOB_IFRAME_ID        — the iframe id you configured in the dashboard
//   PAYMOB_HMAC_SECRET      — HMAC secret from Settings > Payment Integrations, used to
//                              verify that a webhook call really came from Paymob.

const BASE = 'https://accept.paymob.com/api';

async function authToken() {
  const apiKey = process.env.PAYMOB_API_KEY;
  if (!apiKey) throw Object.assign(new Error('PAYMOB_API_KEY غير مضبوط'), { status: 503 });
  const r = await fetch(`${BASE}/auth/tokens`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey })
  });
  const d = await r.json();
  if (!r.ok || !d.token) throw new Error(d?.message || 'Paymob auth failed');
  return d.token;
}

async function registerOrder(token, amountCents, merchantOrderId) {
  const r = await fetch(`${BASE}/ecommerce/orders`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      auth_token: token, delivery_needed: false, amount_cents: amountCents,
      currency: 'EGP', merchant_order_id: merchantOrderId, items: []
    })
  });
  const d = await r.json();
  if (!r.ok || !d.id) throw new Error(d?.message || 'Paymob order registration failed');
  return d.id;
}

async function paymentKey(token, amountCents, orderId, billing) {
  const integrationId = Number(process.env.PAYMOB_INTEGRATION_ID);
  if (!integrationId) throw Object.assign(new Error('PAYMOB_INTEGRATION_ID غير مضبوط'), { status: 503 });
  const r = await fetch(`${BASE}/acceptance/payment_keys`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      auth_token: token, amount_cents: amountCents, expiration: 3600, order_id: orderId,
      currency: 'EGP', integration_id: integrationId,
      billing_data: {
        email: billing.email || 'na@na.com',
        first_name: billing.firstName || 'NA', last_name: billing.lastName || 'NA',
        phone_number: billing.phone || 'NA',
        apartment: 'NA', floor: 'NA', street: 'NA', building: 'NA',
        shipping_method: 'NA', postal_code: 'NA', city: 'NA', state: 'NA', country: 'EG'
      }
    })
  });
  const d = await r.json();
  if (!r.ok || !d.token) throw new Error(d?.message || 'Paymob payment key request failed');
  return d.token;
}

// amountEGP is a plain number like 99 (Egyptian pounds), Paymob wants integer piasters.
export async function createPaymobPayment({ amountEGP, merchantOrderId, billing }) {
  const token = await authToken();
  const amountCents = Math.round(amountEGP * 100);
  const orderId = await registerOrder(token, amountCents, merchantOrderId);
  const payKey = await paymentKey(token, amountCents, orderId, billing || {});
  const iframeId = process.env.PAYMOB_IFRAME_ID;
  if (!iframeId) throw Object.assign(new Error('PAYMOB_IFRAME_ID غير مضبوط'), { status: 503 });
  return {
    providerRef: String(orderId),
    checkoutUrl: `https://accept.paymob.com/api/acceptance/iframes/${iframeId}?payment_token=${payKey}`
  };
}

// Verifies the HMAC Paymob attaches to the "transaction processed" callback.
// Field order below is Paymob's documented concatenation order for the transaction object.
// ⚠️ Re-check this list against your dashboard's current webhook docs before relying on it in
// production — Paymob has changed it across account types in the past.
const HMAC_FIELDS = [
  'amount_cents', 'created_at', 'currency', 'error_occured', 'has_parent_transaction', 'id',
  'integration_id', 'is_3d_secure', 'is_auth', 'is_capture', 'is_refunded', 'is_standalone_payment',
  'is_voided', 'order.id', 'owner', 'pending', 'source_data.pan', 'source_data.sub_type',
  'source_data.type', 'success'
];

function get(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

export async function verifyPaymobHmac(transaction, receivedHmac) {
  const secret = process.env.PAYMOB_HMAC_SECRET;
  if (!secret) throw Object.assign(new Error('PAYMOB_HMAC_SECRET غير مضبوط'), { status: 503 });
  const { createHmac } = await import('node:crypto');
  const concatenated = HMAC_FIELDS.map(f => {
    const v = get(transaction, f);
    return v === null || v === undefined ? 'false' : String(v);
  }).join('');
  const computed = createHmac('sha512', secret).update(concatenated).digest('hex');
  return computed === receivedHmac;
}
