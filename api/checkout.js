import { db, Order, json, body } from './_lib.js';
import { requireUser } from './auth.js';
import { PLANS, PAYABLE_PLAN_IDS } from './_plans.js';
import { createPaymobPayment } from './_payments/paymob.js';
import { createStripePayment } from './_payments/stripe.js';
import { createFawryPayment } from './_payments/fawry.js';

function newRef() {
  return 'bar_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
  try {
    const actor = await requireUser(req);
    const b = await body(req);
    const plan = String(b.plan || '');
    const provider = String(b.provider || '');
    const months = Math.max(1, Math.min(12, parseInt(b.months, 10) || 1));

    if (!PAYABLE_PLAN_IDS.includes(plan)) return json(res, 400, { error: 'خطة غير صالحة للشراء.' });
    if (!['paymob', 'stripe', 'fawry'].includes(provider)) return json(res, 400, { error: 'بوابة دفع غير مدعومة.' });

    const p = PLANS[plan];
    const isEGP = provider === 'paymob' || provider === 'fawry';
    const unitPrice = isEGP ? p.priceEGP : p.priceUSD;
    const amount = Math.round(unitPrice * months * 100) / 100;
    const currency = isEGP ? 'EGP' : 'USD';
    const ref = newRef();

    await db();
    const order = await Order.create({
      ref, ownerId: actor.id, email: actor.email, plan, months, provider, amount, currency, status: 'pending'
    });

    const billing = { email: actor.email, firstName: actor.firstName, lastName: actor.lastName };
    let result;
    if (provider === 'paymob') {
      result = await createPaymobPayment({ amountEGP: amount, merchantOrderId: ref, billing });
    } else if (provider === 'stripe') {
      result = await createStripePayment({ amountUSD: amount, merchantOrderId: ref, planName: p.name, email: actor.email });
    } else {
      result = await createFawryPayment({ amountEGP: amount, merchantOrderId: ref, billing });
    }

    order.providerRef = result.providerRef;
    await order.save();

    return json(res, 200, {
      ref, amount, currency, checkoutUrl: result.checkoutUrl || null, fawryRefNumber: result.fawryRefNumber || null
    });
  } catch (e) {
    return json(res, e.status || 502, { error: e.message || 'تعذر بدء عملية الدفع' });
  }
}
