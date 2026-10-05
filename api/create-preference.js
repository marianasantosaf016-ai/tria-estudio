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
  const detail =
    data?.message ||
    data?.error ||
    data?.details ||
    (Array.isArray(cause) ? cause.map(x => x?.description || x?.code || JSON.stringify(x)).join(' | ') : cause) ||
    data?.raw ||
    `HTTP ${status}`;
  return typeof detail === 'string' ? detail : JSON.stringify(detail);
}

async function callMercadoPago(token, body) {
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
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch (_) {
    data = { raw };
  }

  return { response, data, raw };
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
    const isCard = paymentMethod === 'card';

    const checkoutItems = normalized.map(product => {
      const unitPrice = Number((isCard ? product.card : product.pix).toFixed(2));
      return {
        external_code: product.id,
        title: product.name,
        quantity: product.quantity,
        unit_measure: 'unit',
        currency_id: 'BRL',
        unit_price: unitPrice.toFixed(2),
        total_amount: (unitPrice * product.quantity).toFixed(2)
      };
    });

    const totalAmount = checkoutItems.reduce(
      (sum, item) => sum + Number(item.total_amount),
      0
    );

    if (isCard) {
      const body = {
        type: 'online',
        total_amount: totalAmount.toFixed(2),
        external_reference: orderId,
        processing_mode: 'manual',
        capture_mode: 'automatic',
        payer: customer?.email
          ? { email: String(customer.email).trim() }
          : undefined,
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

      const { response, data, raw } = await callMercadoPago(token, body);

      if (!response.ok || !data.checkout_url) {
        console.error('Mercado Pago CARD Orders API:', response.status, raw);
        return send(res, 502, {
          error: 'O Mercado Pago não conseguiu criar o pagamento no cartão.',
          details: mpError(data, raw, response.status)
        });
      }

      return send(res, 200, {
        orderId,
        orderType: 'card',
        orderIdMercadoPago: data.id,
        checkoutUrl: data.checkout_url,
        init_point: data.checkout_url
      });
    }

    // Para Pix, usamos o endpoint de pagamentos do Mercado Pago.
    // Ele é o fluxo documentado para gerar QR Code / Pix Copia e Cola
    // diretamente a partir do Access Token da conta de produção.
    const pixPaymentBody = {
      transaction_amount: Number(totalAmount.toFixed(2)),
      description: normalized.map(p => `${p.name} x${p.quantity}`).join(', '),
      payment_method_id: 'pix',
      payer: {
        email: String(customer?.email || '').trim(),
        identification: {
          type: 'CPF',
          number: String(customer?.cpf || '').replace(/\D/g, '')
        }
      },
      external_reference: orderId
    };

    if (!pixPaymentBody.payer.email) {
      return send(res, 400, {
        error: 'E-mail do comprador é obrigatório para gerar o Pix.'
      });
    }

    if (!pixPaymentBody.payer.identification.number || pixPaymentBody.payer.identification.number.length !== 11) {
      return send(res, 400, {
        error: 'CPF do comprador é obrigatório para gerar o Pix.'
      });
    }

    const pixResponse = await fetch('https://api.mercadopago.com/v1/payments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'X-Idempotency-Key': crypto.randomUUID()
      },
      body: JSON.stringify(pixPaymentBody)
    });

    const pixRaw = await pixResponse.text();
    let pixData = {};
    try {
      pixData = pixRaw ? JSON.parse(pixRaw) : {};
    } catch (_) {
      pixData = { raw: pixRaw };
    }

    const transactionData = pixData?.point_of_interaction?.transaction_data;

    if (!pixResponse.ok || !pixData?.id || !transactionData) {
      console.error('Mercado Pago PIX /v1/payments:', pixResponse.status, pixRaw);
      return send(res, 502, {
        error: 'O Mercado Pago não conseguiu gerar o Pix.',
        details: mpError(pixData, pixRaw, pixResponse.status)
      });
    }

    return send(res, 200, {
      orderId,
      orderType: 'pix',
      orderIdMercadoPago: pixData.id,
      paymentId: pixData.id,
      status: pixData.status,
      statusDetail: pixData.status_detail,
      qrCode: transactionData.qr_code || null,
      qrCodeBase64: transactionData.qr_code_base64 || null,
      ticketUrl: transactionData.ticket_url || null
    });
  } catch (error) {
    console.error('create-preference:', error);
    return send(res, 500, {
      error: 'Não foi possível criar o pagamento do Mercado Pago.',
      details: error?.message || String(error)
    });
  }
};
