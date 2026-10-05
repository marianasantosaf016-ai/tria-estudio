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
  return res.status(status).json(body);
}

function mpError(data, raw, status) {
  const cause = data?.cause;
  const errors = data?.errors;
  const detail =
    data?.message ||
    data?.error ||
    data?.details ||
    (Array.isArray(errors) ? errors.map(x => {
      if (typeof x === 'string') return x;
      return x?.message || x?.description || x?.code || JSON.stringify(x);
    }).join(' | ') : errors) ||
    (Array.isArray(cause) ? cause.map(x => x?.description || x?.message || x?.code || JSON.stringify(x)).join(' | ') : cause) ||
    data?.raw ||
    `HTTP ${status}`;
  return typeof detail === 'string' ? detail : JSON.stringify(detail);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return send(res, 405, { error: 'Método não permitido.' });
  }

  const token = process.env.MERCADOPAGO_ACCESS_TOKEN;
  if (!token) {
    return send(res, 500, { error: 'MERCADOPAGO_ACCESS_TOKEN não configurado no ambiente.' });
  }

  try {
    const { items, paymentMethod, customer } = req.body || {};

    if (!Array.isArray(items) || !items.length) {
      return send(res, 400, { error: 'Carrinho vazio.' });
    }

    if (!['pix', 'card'].includes(paymentMethod)) {
      return send(res, 400, { error: 'Forma de pagamento inválida.' });
    }

    const normalized = items.map(item => {
      const product = PRODUCTS[item.id];
      const quantity = Number(item.quantity);

      if (!product || !Number.isInteger(quantity) || quantity < 1 || quantity > 50) {
        throw new Error('Produto ou quantidade inválida.');
      }

      return {
        ...product,
        id: item.id,
        quantity
      };
    });

    const siteUrl = (process.env.SITE_URL || `https://${req.headers['x-forwarded-host'] || req.headers.host}`).replace(/\/$/, '');

    if (!/^https:\/\//i.test(siteUrl)) {
      return send(res, 500, { error: 'Não foi possível identificar a URL pública do site.' });
    }

    const orderId = `TRIA-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

    // Voltamos ao Checkout Pro clássico (Preferences API), que já funcionou
    // neste projeto. O Mercado Pago continua suportando esse fluxo para
    // integrações existentes e ele devolve o init_point para o checkout.
    const checkoutItems = normalized.map(p => ({
      id: p.id,
      title: p.name,
      quantity: p.quantity,
      currency_id: 'BRL',
      unit_price: Number((paymentMethod === 'card' ? p.card : p.pix).toFixed(2))
    }));

    const payer = customer?.email
      ? {
          email: String(customer.email).trim(),
          ...(customer?.cpf ? {
            identification: {
              type: 'CPF',
              number: String(customer.cpf).replace(/\D/g, '')
            }
          } : {})
        }
      : undefined;

    if (paymentMethod === 'pix') {
      const total = checkoutItems.reduce((sum, item) => sum + (item.unit_price * item.quantity), 0);
      const pixBody = {
        transaction_amount: Number(total.toFixed(2)),
        description: checkoutItems.map(item => item.title).join(' + ').slice(0, 250),
        payment_method_id: 'pix',
        external_reference: orderId,
        payer: {
          email: String(customer?.email || '').trim(),
          ...(customer?.cpf ? {
            identification: {
              type: 'CPF',
              number: String(customer.cpf).replace(/\D/g, '')
            }
          } : {})
        },
        notification_url: `${siteUrl}/api/webhook`
      };

      const pixResponse = await fetch('https://api.mercadopago.com/v1/payments', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'X-Idempotency-Key': crypto.randomUUID()
        },
        body: JSON.stringify(pixBody)
      });

      const pixRaw = await pixResponse.text();
      let pixData = {};
      try {
        pixData = pixRaw ? JSON.parse(pixRaw) : {};
      } catch (_) {
        pixData = { raw: pixRaw };
      }

      if (!pixResponse.ok || !pixData.id) {
        console.error('Mercado Pago Pix API:', pixResponse.status, pixRaw);
        return send(res, 502, {
          error: 'O Mercado Pago não conseguiu criar o Pix.',
          details: mpError(pixData, pixRaw, pixResponse.status)
        });
      }

      const pixMethod = pixData?.point_of_interaction?.transaction_data || {};
      return send(res, 200, {
        orderId,
        orderType: 'pix',
        paymentId: String(pixData.id),
        status: pixData.status,
        qrCode: pixMethod.qr_code || null,
        qrCodeBase64: pixMethod.qr_code_base64 || null,
        ticketUrl: pixMethod.ticket_url || null
      });
    }

    // Cartão: Checkout Pro via Orders API, com parcelamento sem juros
    // assumido pelo vendedor. O total_amount permanece exatamente igual
    // ao valor dos produtos; o cliente apenas divide esse mesmo total.
    const orderItems = checkoutItems.map(item => ({
      external_code: item.id,
      title: item.title,
      quantity: item.quantity,
      currency_id: 'BRL',
      unit_price: item.unit_price.toFixed(2)
    }));

    const totalAmount = orderItems.reduce(
      (sum, item) => sum + (Number(item.unit_price) * item.quantity),
      0
    );

    const orderBody = {
      type: 'online',
      total_amount: totalAmount.toFixed(2),
      external_reference: orderId,
      processing_mode: 'manual',
      capture_mode: 'automatic_async',
      payer,
      config: {
        online: {
          success_url: siteUrl + '/#/pagamento/sucesso',
          failure_url: siteUrl + '/#/pagamento/falhou',
          pending_url: siteUrl + '/#/pagamento/pendente',
          auto_return: 'approved'
        },
        payment_method: {
          max_installments: 3,
          installments_cost: 'seller',
          not_allowed_types: ['ticket'],
          installments: {
            interest_free: {
              type: 'range',
              values: [1, 3]
            },
            available: {
              type: 'all'
            }
          }
        }
      },
      items: orderItems
    };

    const orderResponse = await fetch('https://api.mercadopago.com/v1/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'X-Idempotency-Key': crypto.randomUUID()
      },
      body: JSON.stringify(orderBody)
    });

    const orderRaw = await orderResponse.text();
    let orderData = {};
    try {
      orderData = orderRaw ? JSON.parse(orderRaw) : {};
    } catch (_) {
      orderData = { raw: orderRaw };
    }

    if (!orderResponse.ok || !orderData.checkout_url) {
      console.error('Mercado Pago Orders API:', orderResponse.status, orderRaw);
      return send(res, 502, {
        error: 'O Mercado Pago não conseguiu criar o checkout do cartão.',
        details: mpError(orderData, orderRaw, orderResponse.status)
      });
    }

    return send(res, 200, {
      orderId,
      orderType: 'card',
      orderIdMercadoPago: orderData.id,
      checkoutUrl: orderData.checkout_url,
      init_point: orderData.checkout_url
    });
  } catch (error) {
    console.error('create-preference:', error);
    return send(res, 500, {
      error: 'Não foi possível criar o pagamento do Mercado Pago.',
      details: error?.message || String(error)
    });
  }
};
