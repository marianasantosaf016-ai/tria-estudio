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

function send(res, status, body) { return res.status(status).json(body); }

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Método não permitido.' });

  const token = process.env.MERCADOPAGO_ACCESS_TOKEN;
  if (!token) return send(res, 500, { error: 'MERCADOPAGO_ACCESS_TOKEN não configurado no ambiente.' });

  try {
    const { items, paymentMethod, customer } = req.body || {};
    if (!Array.isArray(items) || !items.length) return send(res, 400, { error: 'Carrinho vazio.' });
    if (!['pix', 'card'].includes(paymentMethod)) return send(res, 400, { error: 'Forma de pagamento inválida.' });

    const normalized = items.map(item => {
      const p = PRODUCTS[item.id];
      const quantity = Number(item.quantity);
      if (!p || !Number.isInteger(quantity) || quantity < 1 || quantity > 50) {
        throw new Error('Produto ou quantidade inválida.');
      }
      return { ...p, id: item.id, quantity };
    });

    const siteUrl = (process.env.SITE_URL || `https://${req.headers['x-forwarded-host'] || req.headers.host}`).replace(/\/$/, '');
    if (!/^https:\/\//i.test(siteUrl)) {
      return send(res, 500, { error: 'Não foi possível identificar a URL pública do site.' });
    }

    const orderId = `TRIA-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const checkoutItems = normalized.map(p => ({
      external_code: p.id,
      title: p.name,
      quantity: p.quantity,
      currency_id: 'BRL',
      unit_price: Number((paymentMethod === 'card' ? p.card : p.pix).toFixed(2)).toFixed(2)
    }));
    const totalAmount = checkoutItems.reduce((sum, item) => sum + item.unit_price * item.quantity, 0);

    if (paymentMethod === 'card') {
      const body = {
        type: 'online',
        total_amount: totalAmount.toFixed(2),
        external_reference: orderId,
        processing_mode: 'manual',
        capture_mode: 'automatic_async',
        payer: customer?.email ? { email: String(customer.email).trim() } : undefined,
        config: {
          online: {
            success_url: `${siteUrl}/#/pagamento/sucesso`,
            failure_url: `${siteUrl}/#/pagamento/falhou`,
            pending_url: `${siteUrl}/#/pagamento/pendente`,
            auto_return: 'approved'
          },
          payment_method: {
            max_installments: 3,
            default_type: 'credit_card',
            installments_cost: 'seller',
            installments: {
              interest_free: {
                type: 'range',
                values: [1, 3]
              },
              available: {
                type: 'all'
              }
            },
            not_allowed_types: ['ticket']
          }
        },
        items: checkoutItems
      };

      const response = await fetch('https://api.mercadopago.com/v1/orders', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'X-Idempotency-Key': crypto.randomUUID()
        },
        body: JSON.stringify(body)
      });

      const raw = await response.text();
      let data = {};
      try { data = raw ? JSON.parse(raw) : {}; } catch (_) { data = { raw }; }

      if (!response.ok || !data.checkout_url) {
        console.error('Mercado Pago Orders API:', response.status, raw);
        const detail = data?.message || data?.error || data?.cause || data?.details || data?.raw || `HTTP ${response.status}`;
        return send(res, 502, {
          error: 'O Mercado Pago não conseguiu criar o checkout.',
          details: typeof detail === 'string' ? detail : JSON.stringify(detail)
        });
      }

      return send(res, 200, {
        orderId,
        preferenceId: data.id,
        init_point: data.checkout_url
      });
    }

    if (paymentMethod === 'pix') {
      const body = {
        type: 'online',
        total_amount: totalAmount.toFixed(2),
        external_reference: orderId,
        processing_mode: 'automatic',
        transactions: {
          payments: [{
            amount: totalAmount.toFixed(2),
            payment_method: {
              id: 'pix',
              type: 'bank_transfer'
            },
            expiration_time: 'P1D'
          }]
        },
        payer: {
          email: String(customer?.email || '').trim()
        }
      };

      if (!body.payer.email) {
        return send(res, 400, { error: 'E-mail do comprador é obrigatório para gerar o Pix.' });
      }

      const response = await fetch('https://api.mercadopago.com/v1/orders', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'X-Idempotency-Key': crypto.randomUUID()
        },
        body: JSON.stringify(body)
      });

      const raw = await response.text();
      let data = {};
      try { data = raw ? JSON.parse(raw) : {}; } catch (_) { data = { raw }; }

      const payment = data?.transactions?.payments?.[0];
      const method = payment?.payment_method;

      if (!response.ok || !method?.qr_code || !method?.qr_code_base64) {
        console.error('Mercado Pago PIX Orders API:', response.status, raw);
        const detail = data?.message || data?.error || data?.cause || data?.details || data?.raw || `HTTP ${response.status}`;
        return send(res, 502, {
          error: 'O Mercado Pago não conseguiu gerar o Pix.',
          details: typeof detail === 'string' ? detail : JSON.stringify(detail)
        });
      }

      return send(res, 200, {
        orderId,
        orderType: 'pix',
        paymentId: payment.id,
        status: payment.status,
        qrCode: method.qr_code,
        qrCodeBase64: method.qr_code_base64,
        ticketUrl: method.ticket_url || null
      });
    }

    return send(res, 200, {
      orderId,
      preferenceId: data.id,
      init_point: data.init_point
    });
  } catch (error) {
    console.error('create-preference:', error);
    return send(res, 500, {
      error: 'Não foi possível criar o checkout do Mercado Pago.',
      details: error?.message || String(error)
    });
  }
};
