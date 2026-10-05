const crypto = require('crypto');

const PRODUCTS = {
  'kit1': { name: 'KIT ORGÂNICO 01', pix: 130, card: 150 },
  'kit2': { name: 'KIT ORGÂNICO 02', pix: 130, card: 150 },
  'kit-circular-01': { name: 'Kit Circular 01', pix: 110, card: 130 },
  'bowl-g': { name: 'Bowl G', pix: 155, card: 170 },
  'bowl-m': { name: 'Bowl M', pix: 145, card: 160 },
  'bowl-p': { name: 'Bowl P', pix: 135, card: 150 },
  'kit-pinheiro-natal': { name: 'Kit Pinheiro de Natal', pix: 120, card: 135 },
  'kit-coador': { name: 'Kit Coador', pix: 110, card: 120 }
};

function send(res, status, body) {
  res.status(status).json(body);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Método não permitido.' });
  if (!process.env.MERCADOPAGO_ACCESS_TOKEN) {
    return send(res, 500, { error: 'MERCADOPAGO_ACCESS_TOKEN não configurado no ambiente.' });
  }

  try {
    const { items, paymentMethod, customer } = req.body || {};
    if (!Array.isArray(items) || !items.length) return send(res, 400, { error: 'Carrinho vazio.' });
    if (!['pix', 'card'].includes(paymentMethod)) return send(res, 400, { error: 'Forma de pagamento inválida.' });

    const normalized = items.map(item => {
      const p = PRODUCTS[item.id];
      const quantity = Number(item.quantity);
      if (!p || !Number.isInteger(quantity) || quantity < 1 || quantity > 50) throw new Error('Produto ou quantidade inválida.');
      return { ...p, id: item.id, quantity };
    });

    const orderId = `TRIA-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0,14)}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const forwardedHost = req.headers['x-forwarded-host'] || req.headers.host || '';
    const forwardedProto = req.headers['x-forwarded-proto'] || 'https';
    const fallbackSiteUrl = forwardedHost ? `${forwardedProto}://${forwardedHost}` : '';
    const siteUrl = (process.env.SITE_URL || fallbackSiteUrl).replace(/\/$/, '');
    if (!siteUrl || !/^https:\/\//i.test(siteUrl)) {
      return send(res, 500, { error: 'Não foi possível identificar a URL pública do site.' });
    }

    const total = normalized.reduce((sum, p) => {
      const unit = paymentMethod === 'card' ? p.card : p.pix;
      return sum + unit * p.quantity;
    }, 0);

    // Checkout Pro via Orders API. Unlike the old Preferences API flow,
    // Orders lets us explicitly define that the seller assumes installment cost.
    // This is the setting that makes 2x/3x remain at the same total price.
    const body = {
      type: 'online',
      processing_mode: 'manual',
      capture_mode: 'automatic_async',
      total_amount: total.toFixed(2),
      external_reference: orderId,
      expiration_time: 'P1D',
      payer: customer?.email ? { email: String(customer.email).trim() } : undefined,
      config: {
        online: {
          success_url: `${siteUrl}/#/pagamento/sucesso`,
          pending_url: `${siteUrl}/#/pagamento/pendente`,
          failure_url: `${siteUrl}/#/pagamento/falhou`,
          auto_return: 'approved'
        },
        payment_method: {
          max_installments: 3,
          not_allowed_types: ['ticket'],
          ...(paymentMethod === 'card' ? {
            default_type: 'credit_card',
            installments_cost: 'seller',
            installments: {
              interest_free: {
                type: 'range',
                values: [2, 3]
              }
            }
          } : {})
        }
      },
      items: normalized.map(p => {
        const unit = paymentMethod === 'card' ? p.card : p.pix;
        return {
          external_code: p.id,
          title: p.name,
          quantity: p.quantity,
          unit_price: unit.toFixed(2),
          total_amount: (unit * p.quantity).toFixed(2),
          currency_id: 'BRL'
        };
      })
    };

    const response = await fetch('https://api.mercadopago.com/v1/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.MERCADOPAGO_ACCESS_TOKEN}`,
        'X-Idempotency-Key': crypto.randomUUID()
      },
      body: JSON.stringify(body)
    });

    const data = await response.json();
    if (!response.ok || !data.checkout_url) {
      console.error('Mercado Pago Orders API:', response.status, JSON.stringify(data));
      return send(res, 502, { error: 'O Mercado Pago não conseguiu criar o checkout.', details: data?.message || data?.error || undefined });
    }

    return send(res, 200, {
      orderId,
      // Keep the frontend contract used by the existing site.
      preferenceId: data.id,
      init_point: data.checkout_url
    });
  } catch (error) {
    console.error('create-preference:', error);
    return send(res, 500, { error: 'Não foi possível criar o checkout do Mercado Pago.' });
  }
};
