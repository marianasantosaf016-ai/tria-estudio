const crypto = require('crypto');

function parseSignature(value) {
  const out = {};
  for (const part of String(value || '').split(',')) {
    const [k, v] = part.split('=');
    if (k && v) out[k.trim()] = v.trim();
  }
  return out;
}

function validSignature(req) {
  const secret = process.env.MERCADOPAGO_WEBHOOK_SECRET;
  if (!secret) return true; // Configure this secret in production to enable HMAC verification.
  const xSignature = req.headers['x-signature'];
  const xRequestId = req.headers['x-request-id'];
  if (!xSignature || !xRequestId) return false;
  const sig = parseSignature(xSignature);
  const dataId = req.query?.['data.id'] || req.body?.data?.id || '';
  const manifest = `id:${String(dataId).toLowerCase()};request-id:${xRequestId};ts:${sig.ts};`;
  const expected = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig.v1 || '')); }
  catch { return false; }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false });
  if (!validSignature(req)) return res.status(401).json({ ok: false });

  // Supports both the legacy Payment topic and the current Checkout Pro Orders topic.
  // The definitive payment/order state must be queried server-side before fulfillment.
  console.log('Mercado Pago webhook:', JSON.stringify({ query: req.query, body: req.body }));
  return res.status(200).json({ ok: true });
};
