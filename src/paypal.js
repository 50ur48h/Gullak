// PayPal REST client (sandbox by default): OAuth, Payouts, Orders, webhook verification.
import crypto from 'node:crypto';
import { config } from './config.js';

let cachedToken = null;
let tokenExpiresAt = 0;

async function accessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt - 60_000) return cachedToken;
  const basic = Buffer.from(`${config.paypal.clientId}:${config.paypal.clientSecret}`).toString('base64');
  const res = await fetch(`${config.paypal.apiBase}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`PayPal auth failed (${res.status}): ${body.error_description || JSON.stringify(body)}`);
  cachedToken = body.access_token;
  tokenExpiresAt = Date.now() + body.expires_in * 1000;
  return cachedToken;
}

async function call(method, path, body, { requestId } = {}) {
  const token = await accessToken();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  if (requestId) headers['PayPal-Request-Id'] = requestId;
  const res = await fetch(`${config.paypal.apiBase}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const detail = data.details?.map((d) => `${d.issue}: ${d.description}`).join('; ') || data.message || text;
    const err = new Error(`PayPal ${method} ${path} failed (${res.status}): ${detail}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

const dollars = (cents) => (cents / 100).toFixed(2);

/** Send money from the House Bank (your sandbox business account) to a person's PayPal email. */
export async function sendPayout({ email, cents, note, itemId }) {
  const batchId = `gullak_${itemId}_${Date.now()}`.slice(0, 127);
  const data = await call(
    'POST',
    '/v1/payments/payouts',
    {
      sender_batch_header: {
        sender_batch_id: batchId,
        email_subject: 'You got paid by a Gullak buddy!',
        email_message: note,
      },
      items: [
        {
          recipient_type: 'EMAIL',
          amount: { value: dollars(cents), currency: 'USD' },
          receiver: email,
          note,
          sender_item_id: itemId,
        },
      ],
    },
    { requestId: batchId },
  );
  return { batchId: data.batch_header?.payout_batch_id, status: data.batch_header?.batch_status };
}

export async function getPayout(batchId) {
  const data = await call('GET', `/v1/payments/payouts/${batchId}`);
  const item = data.items?.[0];
  return {
    batchStatus: data.batch_header?.batch_status,
    itemStatus: item?.transaction_status,
    transactionId: item?.transaction_id,
  };
}

/** Create a checkout order so an owner can top up a buddy's wallet. */
export async function createTopupOrder({ cents, buddyName, buddyId, returnUrl, cancelUrl }) {
  const data = await call(
    'POST',
    '/v2/checkout/orders',
    {
      intent: 'CAPTURE',
      purchase_units: [
        {
          reference_id: buddyId,
          custom_id: buddyId,
          description: `Top up ${buddyName}'s Gullak wallet`.slice(0, 127),
          amount: { currency_code: 'USD', value: dollars(cents) },
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: 'Gullak',
            user_action: 'PAY_NOW',
            shipping_preference: 'NO_SHIPPING',
            return_url: returnUrl,
            cancel_url: cancelUrl,
          },
        },
      },
    },
    { requestId: crypto.randomUUID() },
  );
  const approve = data.links?.find((l) => l.rel === 'payer-action' || l.rel === 'approve');
  return { orderId: data.id, status: data.status, approveUrl: approve?.href };
}

export const getOrder = (orderId) => call('GET', `/v2/checkout/orders/${orderId}`);

export async function captureOrder(orderId) {
  const data = await call('POST', `/v2/checkout/orders/${orderId}/capture`, undefined, { requestId: `cap_${orderId}` });
  const capture = data.purchase_units?.[0]?.payments?.captures?.[0];
  return { status: data.status, captureId: capture?.id };
}

/** Verify a webhook really came from PayPal (only if PAYPAL_WEBHOOK_ID is set). */
export async function verifyWebhook(headers, event) {
  if (!config.paypal.webhookId) return true;
  const data = await call('POST', '/v1/notifications/verify-webhook-signature', {
    auth_algo: headers['paypal-auth-algo'],
    cert_url: headers['paypal-cert-url'],
    transmission_id: headers['paypal-transmission-id'],
    transmission_sig: headers['paypal-transmission-sig'],
    transmission_time: headers['paypal-transmission-time'],
    webhook_id: config.paypal.webhookId,
    webhook_event: event,
  });
  return data.verification_status === 'SUCCESS';
}

export async function ping() {
  await accessToken();
  return true;
}
