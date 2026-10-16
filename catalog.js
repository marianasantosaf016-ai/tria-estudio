'use strict';
// O mesmo catálogo alimenta a vitrine e os valores cobrados pelo Mercado Pago.
const seed = require('../catalog-products.json');

function config() {
  const url = (process.env.URL_SUPABASE || process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url && !key) return null; // loja funciona com catálogo original até concluir a instalação
  if (!/^https:\/\/[\w.-]+\.supabase\.co$/.test(url) || !key) {
    throw new Error('SUPABASE_URL (ou URL_SUPABASE)/SUPABASE_SECRET_KEY incompletos ou inválidos.');
  }
  return { url, key, legacy:!process.env.SUPABASE_SECRET_KEY };
}
async function supabase(path, { method='GET', body, headers={} } = {}) {
  const conf = config();
  if (!conf) throw new Error('Banco de dados não configurado.');
  const response = await fetch(conf.url + path, {
    method,
    headers: {
      ...serviceHeaders(conf),
      ... (body !== undefined ? {'Content-Type':'application/json'} : {}),
      ...headers
    },
    ...(body !== undefined ? {body:JSON.stringify(body)} : {})
  });
  if (!response.ok) {
    console.error('Supabase API', response.status, path);
    throw new Error(`Erro ao consultar banco de dados (${response.status}).`);
  }
  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}
function serviceHeaders(conf) {
  // As chaves novas sb_secret_ vão apenas no cabeçalho apikey, nunca como JWT Bearer.
  // A chave JWT legada service_role mantém Authorization: Bearer para compatibilidade.
  return {apikey:conf.key,...(conf.legacy?{Authorization:`Bearer ${conf.key}`}:{})};
}
function normalize(p) {
  return {
    id: p.id, name:p.name, cat:p.cat, desc:p.desc||'', details:p.details||p.desc||'',
    price:Number(p.price), cardPrice:Number(p.cardPrice),
    installment:p.installment||'cartão em até 3x com juros',
    spec:Array.isArray(p.spec)?p.spec:[], image:p.image||'',
    gallery:Array.isArray(p.gallery) ? p.gallery : (p.image?[p.image]:[]),
    active:p.active !== false
  };
}
async function getCatalog({includeInactive=false}={}) {
  const map = new Map(seed.map(p=>[p.id,normalize(p)]));
  if (config()) {
    const changes = await supabase('/rest/v1/product_overrides?select=id,product,active');
    for (const row of changes) {
      const item=normalize({...row.product,id:row.id,active:row.active});
      map.set(row.id,item);
    }
  }
  return [...map.values()].filter(p=>includeInactive||p.active);
}
async function getPaymentCatalog() {
  const products=await getCatalog();
  return Object.fromEntries(products.map(p=>[p.id,{name:p.name,pix:p.price,card:p.cardPrice}]));
}
async function saveProduct(p,active=true) {
  if (!config()) throw new Error('Configure o Supabase antes de editar produtos.');
  const {id,...rest}=normalize(p);
  await supabase('/rest/v1/product_overrides?on_conflict=id', {
    method:'POST',
    headers:{'Prefer':'resolution=merge-duplicates,return=minimal'},
    body:{id,product:rest,active,updated_at:new Date().toISOString()}
  });
}
module.exports={config,serviceHeaders,supabase,getCatalog,getPaymentCatalog,saveProduct};
