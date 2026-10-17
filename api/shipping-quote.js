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
  'kit-copo-xicara-g': { name: 'Kit Copo Xícara G', weight: 710, length: 15, width: 15, height: 15 },
  'kit-meia-lua': { name: 'Kit Meia Lua', weight: 5054, length: 45, width: 45, height: 7 }
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
    const message = data?.msgs?.map(x => x.mensagem || x.codigo).filter(Boolean).join('; ')
      || data?.message || data?.mensagem || `HTTP ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return data;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Método não permitido.' });

  const token = process.env.CORREIOS_TOKEN;
  const contract = process.env.CORREIOS_CONTRACT;
  const dr = process.env.CORREIOS_DR;
  if (!token) return send(res, 503, { error: 'Frete dos Correios ainda não configurado: falta CORREIOS_TOKEN na Vercel.' });
  if (!contract || !dr) return send(res, 503, { error: 'Frete dos Correios ainda não configurado: confira CORREIOS_CONTRACT e CORREIOS_DR na Vercel.' });

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
      // Cada unidade é enviada em sua própria caixa, conforme as regras da loja.
      for (let i = 0; i < quantity; i++) parcels.push(product);
      if (parcels.length > 50) return send(res, 400, { error: 'O limite de cotação é de 50 caixas por pedido.' });
    }

    const priceQueries = [];
    const deadlineQueries = [];
    parcels.forEach((parcel, index) => {
      SERVICES.forEach(service => {
        priceQueries.push({
          coProduto: service.code,
          nuRequisicao: String(priceQueries.length + 1).padStart(4, '0'),
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
          nuRequisicao: String(deadlineQueries.length + 1).padStart(4, '0'),
          nuContrato: contract,
          nuDR: Number(dr),
          cepOrigem: ORIGIN_CEP,
          cepDestino: cep
        });
      });
    });

    const [priceData, deadlineData] = await Promise.all([
      postJson('https://api.correios.com.br/preco/v3/v1/nacional', token, {
        idLote: 'TRIA-FRETE',
        parametrosProduto: priceQueries
      }),
      postJson('https://api.correios.com.br/prazo/v3/v1/nacional', token, {
        idLote: 'TRIA-PRAZO',
        parametrosPrazo: deadlineQueries
      })
    ]);

    const priceRows = Array.isArray(priceData) ? priceData : (priceData?.precostock || priceData?.precos || priceData?.resultado || []);
    const deadlineRows = Array.isArray(deadlineData) ? deadlineData : (deadlineData?.prazos || deadlineData?.resultado || []);
    const quotes = SERVICES.map((service, serviceIndex) => {
      let total = 0;
      const days = [];
      let missing = false;
      parcels.forEach((_, parcelIndex) => {
        const idx = parcelIndex * SERVICES.length + serviceIndex;
        const price = priceRows[idx];
        const deadline = deadlineRows[idx];
        const rawPrice = price?.pcFinal ?? price?.vlPreco ?? price?.valor ?? price?.preco;
        const amount = Number(String(rawPrice ?? '').replace(',', '.'));
        if (!Number.isFinite(amount) || amount <= 0 || price?.txErro || price?.msgErro) missing = true;
        else total += amount;
        const dayValue = Number(deadline?.prazoEntrega ?? deadline?.prazo ?? deadline?.nuPrazo);
        if (Number.isFinite(dayValue) && dayValue > 0) days.push(dayValue);
      });
      return {
        service: service.name,
        available: !missing && days.length === parcels.length,
        price: !missing ? Number(total.toFixed(2)) : null,
        deliveryDays: days.length === parcels.length ? Math.max(...days) : null
      };
    }).filter(q => q.available);

    if (!quotes.length) return send(res, 422, {
      error: 'Os Correios não retornaram cotação válida para esse destino. Confira a liberação do contrato e os códigos de serviço.'
    });
    return send(res, 200, { originCep: ORIGIN_CEP, destinationCep: cep, quotes });
  } catch (error) {
    console.error('Correios shipping quote:', error);
    return send(res, error.status === 400 ? 400 : 502, {
      error: 'Não foi possível consultar preço e prazo nos Correios.',
      details: error.message
    });
  }
};
