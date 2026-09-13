// Stripe Checkout Session — international Visa/Mastercard/Amex, Apple Pay, Google Pay.
// Docs: https://docs.stripe.com/checkout/quickstart
//
// Required env vars:
//   STRIPE_SECRET_KEY       — sk_live_... (or sk_test_... while testing)
//   STRIPE_WEBHOOK_SECRET   — whsec_... from the Stripe Dashboard webhook endpoint config
//   BARISTA_APP_URL         — e.g. https://barista-ai.vercel.app (used for success/cancel redirects)

import Stripe from 'stripe';

let _stripe = null;
function stripe() {
  if (!process.env.STRIPE_SECRET_KEY) throw Object.assign(new Error('STRIPE_SECRET_KEY غير مضبوط'), { status: 503 });
  if (!_stripe) _stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  return _stripe;
}

export async function createStripePayment({ amountUSD, merchantOrderId, planName, email }) {
  const appUrl = process.env.BARISTA_APP_URL || 'https://barista-ai.vercel.app';
  const session = await stripe().checkout.sessions.create({
    mode: 'payment',
    customer_email: email || undefined,
    client_reference_id: merchantOrderId,
    line_items: [{
      price_data: {
        currency: 'usd',
        product_data: { name: `Barista AI — خطة ${planName}` },
        unit_amount: Math.round(amountUSD * 100)
      },
      quantity: 1
    }],
    success_url: `${appUrl}/?payment=success`,
    cancel_url: `${appUrl}/?payment=cancelled`,
    metadata: { merchantOrderId }
  });
  return { providerRef: session.id, checkoutUrl: session.url };
}

// Verifies the raw request body against Stripe's signature header.
// IMPORTANT: this must be called with the *raw* unparsed body, not a re-serialized JSON object,
// or the signature check will always fail.
export function verifyStripeSignature(rawBody, signatureHeader) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw Object.assign(new Error('STRIPE_WEBHOOK_SECRET غير مضبوط'), { status: 503 });
  return stripe().webhooks.constructEvent(rawBody, signatureHeader, secret);
}
