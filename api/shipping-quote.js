const crypto = require('crypto');

const PRODUCTS = {
  'kit1': { name: 'KIT ORGÂNICO 01', weight: 2014, length: 39.5, width: 24, height: 7 },
  'kit-organico-03': { name: 'KIT ORGÂNICO 03', weight: 1794, length: 40, width: 35, height: 7 },
  'kit2': { name: 'KIT ORGÂNICO 02', weight: 2412, length: 37.5, width: 30.5, height: 7 },
  'kit-circular-01': { name: 'Kit Circular 01', weight: 2273, length: 30, width: 30, height: 10 },
  'bowl-g': { name: 'Bowl G', weight: 4289, length: 25, width: 25, height: 15 },
  'bowl-m': { name: 'Bowl M', weight: 3066, length: 21, width: 21, height: 15 },
  'bowl-p': { name: 'Bowl P', weight: 2055, length: 17, width: 17, height: 15 },
  'kit-pinheiro-natal': { name: 'Kit Pinheiro de Natal', weight: 2339, length: 30, width: 30, height: 10 },
  'kit-coador': { name: 'Kit Coador', weight: 1669, length: 17, width: 17, height: 15 },
  'kit-manteigueira-francesa': { name: 'Kit Manteigueira Francesa', weight: 853, length: 20, width: 15, height: 15 },
  'kit-pizza-sanduba-hotdog': { name: 'Kit Pizza, Sanduba & Hotdog', weight: 1919, length: 30, width: 20, height: 15 },
  'kit-ossinhos': { name: 'Kit Ossinhos', weight: 1696, length: 40, width: 40, height: 15 },
  'prato-risoto': { name: 'Prato de Risoto', weight: 2548, length: 40, width: 40, height: 15 },
  'kit-copo-xicara-p': { name: 'Kit Copo Xícara P', weight: 420, length: 15, width: 15, height: 15 },
  'kit-copo-xicara-m': { name: 'Kit Copo Xícara M', weight: 524, length: 15, width: 15, height: 15 },
  'kit-copo-xicara-g': { name: 'Kit Copo Xícara G', weight: 710, length: 15, width: 15, height: 15 }
};

const ORIGIN_CEP = '78897070';
const SERVICES = [
  { code: '03298', name: 'PAC' },
  { code: '03220', name: 'SEDEX' }
];

function send(res, status, body) {
  return res.status(status).json(body);
}

async function postJson(url, token, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
     Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify(body)
  });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : {}; } catch (_) { data = { message: raw }; }
  if (!response.ok) {
    const messages = Array.isArray(data?.msgs)
      ? data.msgs.map(x => x.mensagem || x.codigo).filter(Boolean).join('; ')
      : '';
const error = new Error(`${url} — ${messages || data?.message || data?.mensagem || `HTTP ${response.status}`}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

// Token cache for warm serverless instances. The token endpoint itself also controls token reuse/renewal.
let cachedCorreiosToken = '';
let cachedCorreiosTokenExpiresAt = 0;

function tokenExpiry(token) {
  try {
    const part = token.split('.')[1];
    const payload = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return Number(payload.exp || 0) * 1000;
  } catch (_) {
    return 0;
  }
}

async function getCorreiosToken() {
  const now = Date.now();
  if (cachedCorreiosToken && cachedCorreiosTokenExpiresAt > now + 5 * 60 * 1000) {
    return cachedCorreiosToken;
  }

  const id = String(process.env.CORREIOS_ID || '').trim();
  const apiCode = String(process.env.CORREIOS_API_CODE || '').trim();
  const card = String(process.env.CORREIOS_CARTAO_POSTAGEM || '').trim();
  const contract = String(process.env.CORREIOS_CONTRACT || process.env.CORREIOS_CONTRATO || '').trim();
  const dr = String(process.env.CORREIOS_DR || '').trim();

  if (!id || !apiCode || !card || !contract || !/^\\d+$/.test(dr)) {
    const error = new Error('Faltam variáveis seguras na Vercel: CORREIOS_ID, CORREIOS_API_CODE, CORREIOS_CARTAO_POSTAGEM, CORREIOS_CONTRACT e CORREIOS_DR.');
    error.status = 503;
    throw error;
  }

  const auth = Buffer.from(id + ':' + apiCode).toString('base64');
  const response = await fetch('https://api.correios.com.br/token/v1/autentica/cartaopostagem', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + auth,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({
      numero: card,
      contrato: contract,
      dr: Number(dr)
    })
  });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : {}; } catch (_) { data = { message: raw }; }
  if (!response.ok) {
    const messages = Array.isArray(data?.msgs)
      ? data.msgs.map(x => x.mensagem || x.codigo).filter(Boolean).join('; ')
      : '';
    const error = new Error('Falha ao gerar token dos Correios: ' + (messages || data?.message || data?.mensagem || ('HTTP ' + response.status)));
    error.status = response.status;
    throw error;
  }

  const token = String(data?.token || data?.access_token || data?.accessToken || '').trim();
  if (!token) {
    const error = new Error('A API Token dos Correios respondeu sem o campo token esperado.');
    error.status = 502;
    throw error;
  }

  cachedCorreiosToken = token;
  cachedCorreiosTokenExpiresAt = tokenExpiry(token) || (now + 23 * 60 * 60 * 1000);
  return token;
}

function rowsFrom(data, possibleKeys) {
  if (Array.isArray(data)) return data;
  for (const key of possibleKeys) {
    if (Array.isArray(data?.[key])) return data[key];
  }
  return [];
}

function parseMoney(value) {
  if (typeof value === 'number') return value;
  const text = String(value ?? '').trim();
  if (!text) return NaN;
  // Correios may return Brazilian decimal commas.
  return Number(text.includes(',') ? text.replace(/\./g, '').replace(',', '.') : text);
}

async function postInChunks(url, token, key, entries, batchSize, prefix) {
  const output = [];
  for (let offset = 0; offset < entries.length; offset += batchSize) {
    const chunk = entries.slice(offset, offset + batchSize);
    const data = await postJson(url, token, {
      idLote: `${prefix}-${Math.floor(offset / batchSize) + 1}`,
      [key]: chunk
    });
    output.push(...rowsFrom(data, key === 'parametrosProduto'
      ? ['precos', 'resultado', 'precostock']
      : ['prazos', 'resultado']));
  }
  return output;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Método não permitido.' });

 const contract = String(process.env.CORREIOS_CONTRACT || process.env.CORREIOS_CONTRATO || '').trim();
 const dr = String(process.env.CORREIOS_DR || '').trim();

 console.info('Correios config:', {
   hasId: Boolean(process.env.CORREIOS_ID),
   hasApiCode: Boolean(process.env.CORREIOS_API_CODE),
   hasCard: Boolean(process.env.CORREIOS_CARTAO_POSTAGEM),
   hasContract: Boolean(contract),
   hasDr: Boolean(dr),
   drNumeric: /^\d+$/.test(dr)
 });
  if (!token) return send(res, 503, { error: 'Frete dos Correios ainda não configurado: falta CORREIOS_TOKEN na Vercel.' });
  if (!contract || !dr || !/^\d+$/.test(String(dr))) {
    return send(res, 503, { error: 'Frete dos Correios ainda não configurado: confira CORREIOS_CONTRACT e CORREIOS_DR na Vercel.' });
  }

  try {
    const cep = String(req.body?.cepDestino || '').replace(/\D/g, '');
    const items = req.body?.items;
    if (!/^\d{8}$/.test(cep)) return send(res, 400, { error: 'Informe um CEP de destino válido com 8 números.' });
    if (!Array.isArray(items) || items.length < 1 || items.length > 50) {
      return send(res, 400, { error: 'Informe os produtos do carrinho para calcular o frete.' });
    }

    const parcels = [];
    for (const item of items) {
      const product = PRODUCTS[item?.id];
      const quantity = Number(item?.quantity);
      if (!product || !Number.isInteger(quantity) || quantity < 1 || quantity > 50) {
        return send(res, 400, { error: 'Há um produto ou quantidade inválida no carrinho.' });
      }
      for (let i = 0; i < quantity; i++) parcels.push(product);
      if (parcels.length > 50) return send(res, 400, { error: 'O limite de cotação é de 50 caixas por pedido.' });
    }

    const priceQueries = [];
    const deadlineQueries = [];
    parcels.forEach(parcel => {
      SERVICES.forEach(service => {
        const sequence = priceQueries.length + 1;
        priceQueries.push({
          coProduto: service.code,
          nuRequisicao: String(sequence).padStart(4, '0'),
          nuContrato: contract,
          nuDR: Number(dr),
          cepOrigem: ORIGIN_CEP,
          cepDestino: cep,
          psObjeto: String(parcel.weight),
          tpObjeto: '2',
          comprimento: String(parcel.length),
          largura: String(parcel.width),
          altura: String(parcel.height),
          nuUnidade: ''
        });
        deadlineQueries.push({
          coProduto: service.code,
          nuRequisicao: String(sequence).padStart(4, '0'),
          cepOrigem: ORIGIN_CEP,
          cepDestino: cep
        });
      });
    });

    const token = await getCorreiosToken();
    const [priceRows, deadlineRows] = await Promise.all([
      postInChunks('https://api.correios.com.br/preco/v1/nacional', token, 'parametrosProduto', priceQueries, 100, 'TRIA-PRECO'),
      postInChunks('https://api.correios.com.br/prazo/v3/v1/nacional', token, 'parametrosPrazo', deadlineQueries, 20, 'TRIA-PRAZO')
    ]);

    const quotes = SERVICES.map(service => {
      let total = 0;
      const days = [];
      let missing = false;
      for (let parcelIndex = 0; parcelIndex < parcels.length; parcelIndex++) {
        const idx = parcelIndex * SERVICES.length + SERVICES.findIndex(s => s.code === service.code);
        const price = priceRows.find(row => row?.nuRequisicao === String(idx + 1).padStart(4, '0') && row?.coProduto === service.code) || priceRows[idx];
        const deadline = deadlineRows.find(row => row?.nuRequisicao === String(idx + 1).padStart(4, '0') && row?.coProduto === service.code) || deadlineRows[idx];
        const amount = parseMoney(price?.pcFinal ?? price?.vlPreco ?? price?.valor ?? price?.preco);
        if (!Number.isFinite(amount) || amount <= 0 || price?.txErro || price?.msgErro) {
          missing = true;
        } else {
          total += amount;
        }
        const dayValue = Number(deadline?.prazoEntrega ?? deadline?.prazo ?? deadline?.nuPrazo);
        if (Number.isFinite(dayValue) && dayValue > 0 && !deadline?.txErro) days.push(dayValue);
        else missing = true;
      }
      return {
        service: service.name,
        available: !missing && days.length === parcels.length,
        price: !missing ? Number(total.toFixed(2)) : null,
        deliveryDays: days.length === parcels.length ? Math.max(...days) : null
      };
    }).filter(q => q.available);

    if (!quotes.length) return send(res, 422, {
      error: 'Os Correios não retornaram cotação válida para esse destino. Confira a liberação do contrato, o código DR e os serviços PAC/SEDEX.'
    });
    const quoteSecret = token;
    const signedQuotes = quotes.map(quote => {
      const payload = {
        service: quote.service,
        price: quote.price,
        deliveryDays: quote.deliveryDays,
        destinationCep: cep,
        items: items.map(item => ({ id: item.id, quantity: Number(item.quantity) })),
        expiresAt: Date.now() + 15 * 60 * 1000
      };
      const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const signature = crypto.createHmac('sha256', quoteSecret).update(encoded).digest('base64url');
      return { ...quote, quoteToken: `${encoded}.${signature}` };
    });
    return send(res, 200, { originCep: ORIGIN_CEP, destinationCep: cep, quotes: signedQuotes });
  } catch (error) {
    console.error('Correios shipping quote:', error);
    return send(res, error.status === 400 ? 400 : 502, {
      error: 'Não foi possível consultar preço e prazo nos Correios.',
      details: error.message
    });
  }
};
