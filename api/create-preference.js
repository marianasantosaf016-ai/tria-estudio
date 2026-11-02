const crypto = require('crypto');

const { getPaymentCatalog } = require('../lib/catalog');

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

    if (!Array.isArray(items) || !items.length || items.length > 50) {
      return send(res, 400, { error: 'Carrinho vazio.' });
    }

    if (!['pix', 'card'].includes(paymentMethod)) {
      return send(res, 400, { error: 'Forma de pagamento inválida.' });
    }

    const paymentCatalog = await getPaymentCatalog();
    const normalized = items.map(item => {
      const product = paymentCatalog[item.id];
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

    const shipping = req.body?.shipping;
    if (!shipping?.quoteToken) {
      return send(res, 400, { error: 'Calcule e selecione o frete dos Correios antes de pagar.' });
    }
    const parts = String(shipping.quoteToken).split('.');
    if (parts.length !== 2) return send(res, 400, { error: 'Cotação de frete inválida. Calcule novamente.' });
    const quoteSecret = String(process.env.CORREIOS_API_CODE || '').trim();
    if (!quoteSecret) return send(res, 503, { error: 'A validação do frete ainda não está configurada.' });
    const expectedSignature = crypto.createHmac('sha256', quoteSecret).update(parts[0]).digest('base64url');
    const supplied = Buffer.from(parts[1]);
    const expected = Buffer.from(expectedSignature);
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
      return send(res, 400, { error: 'A cotação de frete não pôde ser validada. Calcule novamente.' });
    }
    let shippingQuote;
    try { shippingQuote = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); }
    catch (_) { return send(res, 400, { error: 'Cotação de frete inválida. Calcule novamente.' }); }
    const destinationCep = String(customer?.address?.zipCode || '').replace(/\D/g, '');
    const currentItems = items.map(item => ({ id: item.id, quantity: Number(item.quantity) }))
      .sort((a, b) => a.id.localeCompare(b.id));
    const quotedItems = Array.isArray(shippingQuote.items)
      ? shippingQuote.items.map(item => ({ id: item.id, quantity: Number(item.quantity) })).sort((a, b) => a.id.localeCompare(b.id))
      : [];
    if (!Number.isFinite(shippingQuote.price) || shippingQuote.price <= 0 ||
        !['PAC', 'SEDEX'].includes(shippingQuote.service) ||
        shippingQuote.expiresAt < Date.now() ||
        shippingQuote.destinationCep !== destinationCep ||
        JSON.stringify(currentItems) !== JSON.stringify(quotedItems)) {
      return send(res, 400, { error: 'A cotação expirou ou não corresponde ao pedido. Calcule o frete novamente.' });
    }

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

    const shippingAddress = {
      street: String(customer?.address?.street || '').trim(),
      number: String(customer?.address?.number || '').trim(),
      complement: String(customer?.address?.complement || '').trim(),
      zipCode: String(customer?.address?.zipCode || '').replace(/\D/g, ''),
      city: String(customer?.address?.city || '').trim(),
      state: String(customer?.address?.state || '').trim().toUpperCase()
    };

    if (!shippingAddress.street || !shippingAddress.number || !shippingAddress.zipCode ||
        !shippingAddress.city || !shippingAddress.state) {
      return send(res, 400, { error: 'Endereço de entrega incompleto.' });
    }

    const payer = customer?.email
      ? {
          email: String(customer.email).trim(),
          ...(customer?.cpf ? {
            identification: {
              type: 'CPF',
              number: String(customer.cpf).replace(/\D/g, '')
            }
          } : {}),
          address: {
            zip_code: shippingAddress.zipCode,
            street_name: shippingAddress.street,
            street_number: shippingAddress.number
          }
        }
      : undefined;

    if (paymentMethod === 'pix') {
      const total = checkoutItems.reduce((sum, item) => sum + (item.unit_price * item.quantity), 0) + shippingQuote.price;
      const pixBody = {
        transaction_amount: Number(total.toFixed(2)),
        description: (checkoutItems.map(item => item.title).join(' + ') + ' + Frete ' + shippingQuote.service).slice(0, 250),
        payment_method_id: 'pix',
        external_reference: orderId,
        payer: {
          email: String(customer?.email || '').trim(),
          ...(customer?.cpf ? {
            identification: {
              type: 'CPF',
              number: String(customer.cpf).replace(/\D/g, '')
            }
          } : {}),
          address: {
            zip_code: shippingAddress.zipCode,
            street_name: shippingAddress.street,
            street_number: shippingAddress.number
          }
        },
        metadata: {
          shipping_address: JSON.stringify(shippingAddress),
          shipping_service: shippingQuote.service,
          shipping_amount: String(shippingQuote.price)
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

    const body = {
      items: [...checkoutItems, {
        id: 'frete-correios-' + shippingQuote.service.toLowerCase(),
        title: 'Frete Correios ' + shippingQuote.service,
        quantity: 1,
        currency_id: 'BRL',
        unit_price: Number(shippingQuote.price.toFixed(2))
      }],
      payer,
      payment_methods: {
        installments: paymentMethod === 'card' ? 3 : 1,
        excluded_payment_types: [{ id: 'ticket' }]
      },
      back_urls: {
        success: `${siteUrl}/#/pagamento/sucesso`,
        pending: `${siteUrl}/#/pagamento/pendente`,
        failure: `${siteUrl}/#/pagamento/falhou`
      },
      auto_return: 'approved',
      notification_url: `${siteUrl}/api/webhook`,
      external_reference: orderId,
      shipments: {
        receiver_address: {
          zip_code: shippingAddress.zipCode,
          street_name: shippingAddress.street,
          street_number: shippingAddress.number,
          city_name: shippingAddress.city,
          state_name: shippingAddress.state,
          ...(shippingAddress.complement ? { apartment: shippingAddress.complement } : {})
        }
      }
    };

    const response = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
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

    if (!response.ok || !data.init_point) {
      console.error('Mercado Pago Preferences API:', response.status, raw);
      const detail = data?.message ||
        data?.error ||
        data?.details ||
        data?.errors ||
        data?.cause ||
        data?.raw ||
        `HTTP ${response.status}`;

      return send(res, 502, {
        error: 'O Mercado Pago não conseguiu criar o checkout.',
        details: typeof detail === 'string' ? detail : JSON.stringify(detail)
      });
    }

    return send(res, 200, {
      orderId,
      orderType: 'checkout',
      preferenceId: data.id,
      init_point: data.init_point,
      checkoutUrl: data.init_point
    });
  } catch (error) {
    console.error('create-preference:', error);
    return send(res, 500, {
      error: 'Não foi possível criar o pagamento do Mercado Pago.',
      details: error?.message || String(error)
    });
  }
};
