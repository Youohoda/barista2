// FawryPay server-to-server "charge" API. Note: if you're already using Paymob above,
// its "Kiosk" payment method already routes through the Fawry network for cash-at-kiosk
// payments — so this direct integration is only needed if you specifically want Fawry's
// own hosted card/wallet/ValU/installment flow as a separate option.
// Docs: https://developer.fawrystaging.com/docs/server-apis/server-apis-overview
//
// Required env vars:
//   FAWRY_MERCHANT_CODE
//   FAWRY_SECURE_KEY
//   FAWRY_BASE_URL   — https://atfawry.fawrystaging.com (sandbox) or https://www.atfawry.com (live)

async function sha256Hex(str) {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(str).digest('hex');
}

// Single line-item signature per Fawry docs:
// merchantCode + merchantRefNumber + customerProfileId(if any) + itemId + quantity + price(2dp) + secureKey
async function chargeSignature({ merchantCode, merchantRefNumber, customerProfileId, itemId, quantity, price, secureKey }) {
  const priceStr = Number(price).toFixed(2);
  const str = merchantCode + merchantRefNumber + (customerProfileId || '') + itemId + quantity + priceStr + secureKey;
  return sha256Hex(str);
}

export async function createFawryPayment({ amountEGP, merchantOrderId, billing }) {
  const merchantCode = process.env.FAWRY_MERCHANT_CODE;
  const secureKey = process.env.FAWRY_SECURE_KEY;
  const baseUrl = process.env.FAWRY_BASE_URL || 'https://atfawry.fawrystaging.com';
  if (!merchantCode || !secureKey) throw Object.assign(new Error('FAWRY_MERCHANT_CODE / FAWRY_SECURE_KEY غير مضبوطين'), { status: 503 });

  const itemId = 'barista-plan';
  const quantity = 1;
  const signature = await chargeSignature({
    merchantCode, merchantRefNumber: merchantOrderId, itemId, quantity, price: amountEGP, secureKey
  });

  const payload = {
    merchantCode,
    merchantRefNum: merchantOrderId,
    customerMobile: billing?.phone || '01000000000',
    customerEmail: billing?.email || 'na@na.com',
    customerName: billing?.firstName || 'Barista User',
    paymentExpiry: Date.now() + 1000 * 60 * 60 * 6, // 6h to pay
    chargeItems: [{ itemId, description: 'Barista AI subscription', price: Number(amountEGP).toFixed(2), quantity }],
    paymentMethod: 'PAYATFAWRY',
    currencyCode: 'EGP',
    language: 'ar-eg',
    signature
  };

  const r = await fetch(`${baseUrl}/ECommerceWeb/Fawry/payments/charge`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  });
  const d = await r.json();
  if (!r.ok || d.statusCode !== 200) throw new Error(d?.statusDescription || 'Fawry charge request failed');

  // PAYATFAWRY returns a reference number the customer pays at any Fawry outlet — there's
  // no redirect URL, so the UI should show this code rather than opening a checkout page.
  return { providerRef: d.referenceNumber, fawryRefNumber: d.referenceNumber, checkoutUrl: null };
}

// Verifies the signature Fawry sends back on its server notification callback.
export async function verifyFawryCallback(params) {
  const secureKey = process.env.FAWRY_SECURE_KEY;
  if (!secureKey) throw Object.assign(new Error('FAWRY_SECURE_KEY غير مضبوط'), { status: 503 });
  const str = (params.fawryRefNumber || '') + (params.merchantRefNumber || '') +
    (params.paymentAmount || '') + (params.orderAmount || '') + (params.orderStatus || '') +
    (params.paymentMethod || '') + secureKey;
  const computed = await sha256Hex(str);
  return computed === params.messageSignature;
}
