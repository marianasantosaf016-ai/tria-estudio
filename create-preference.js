'use strict';
// Usa o mesmo catálogo validado no servidor que a vitrine apresenta.
// Preserva o Checkout Pro e o Pix que a TRÍA já utiliza.
const crypto=require('crypto');
const {getPaymentCatalog}=require('../lib/catalog');
const send=(res,status,body)=>res.status(status).json(body);
function mpError(data,status){
  const info=data?.message||data?.error||data?.details||data?.cause||data?.errors||`HTTP ${status}`;
  return typeof info==='string'?info:JSON.stringify(info);
}
module.exports=async function handler(req,res){
  if(req.method!=='POST')return send(res,405,{error:'Método não permitido.'});
  const token=process.env.MERCADOPAGO_ACCESS_TOKEN;
  if(!token)return send(res,500,{error:'MERCADOPAGO_ACCESS_TOKEN não configurado no ambiente.'});
  try{
    const {items,paymentMethod,customer}=req.body||{};
    if(!Array.isArray(items)||!items.length||items.length>50)return send(res,400,{error:'Carrinho vazio ou inválido.'});
    if(!['pix','card'].includes(paymentMethod))return send(res,400,{error:'Forma de pagamento inválida.'});
    const catalog=await getPaymentCatalog();
    const normalized=items.map(item=>{
      const p=catalog[item?.id]; const quantity=Number(item?.quantity);
      if(!p||!Number.isInteger(quantity)||quantity<1||quantity>50)throw Object.assign(new Error('Produto ou quantidade inválida.'),{status:400});
      return {...p,id:item.id,quantity};
    });
    const siteUrl=(process.env.SITE_URL||`https://${req.headers['x-forwarded-host']||req.headers.host}`).replace(/\/$/,'');
    if(!/^https:\/\//i.test(siteUrl))return send(res,500,{error:'Não foi possível identificar a URL pública do site.'});
    const orderId=`TRIA-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const checkoutItems=normalized.map(p=>({
      id:p.id,title:p.name,quantity:p.quantity,currency_id:'BRL',
      unit_price:Number((paymentMethod==='card'?p.card:p.pix).toFixed(2))
    }));
    const addr={
      street:String(customer?.address?.street||'').trim(),
      number:String(customer?.address?.number||'').trim(),
      complement:String(customer?.address?.complement||'').trim(),
      zipCode:String(customer?.address?.zipCode||'').replace(/\D/g,''),
      city:String(customer?.address?.city||'').trim(),
      state:String(customer?.address?.state||'').trim().toUpperCase()
    };
    if(!addr.street||!addr.number||addr.zipCode.length!==8||!addr.city||!addr.state)return send(res,400,{error:'Endereço de entrega incompleto.'});
    const payer=customer?.email?{
      email:String(customer.email).trim(),
      ...(customer?.cpf?{identification:{type:'CPF',number:String(customer.cpf).replace(/\D/g,'')}}:{}),
      address:{zip_code:addr.zipCode,street_name:addr.street,street_number:addr.number}
    }:undefined;
    if(paymentMethod==='pix'){
      if(!payer?.email)return send(res,400,{error:'Informe o e-mail do comprador.'});
      const sum=checkoutItems.reduce((t,i)=>t+i.unit_price*i.quantity,0);
      const body={
        transaction_amount:Number(sum.toFixed(2)),
        description:checkoutItems.map(x=>x.title).join(' + ').slice(0,250),
        payment_method_id:'pix',external_reference:orderId,
        payer,
        metadata:{shipping_address:JSON.stringify(addr)},
        notification_url:`${siteUrl}/api/webhook`
      };
      const r=await fetch('https://api.mercadopago.com/v1/payments',{
        method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${token}`,'X-Idempotency-Key':crypto.randomUUID()},
        body:JSON.stringify(body)
      });
      const raw=await r.text();let data={};try{data=JSON.parse(raw)}catch(_){data={raw}}
      if(!r.ok||!data.id){console.error('Mercado Pago Pix:',r.status,raw);return send(res,502,{error:'O Mercado Pago não conseguiu criar o Pix.',details:mpError(data,r.status)});}
      const pi=data.point_of_interaction?.transaction_data||{};
      return send(res,200,{
        orderId,orderType:'pix',paymentId:String(data.id),status:data.status,
        qrCode:pi.qr_code||null,qrCodeBase64:pi.qr_code_base64||null,ticketUrl:pi.ticket_url||null
      });
    }
    const body={
      items:checkoutItems,payer,
      payment_methods:{installments:3,excluded_payment_types:[{id:'ticket'}]},
      back_urls:{
        success:`${siteUrl}/#/pagamento/sucesso`,
        pending:`${siteUrl}/#/pagamento/pendente`,
        failure:`${siteUrl}/#/pagamento/falhou`
      },
      auto_return:'approved',notification_url:`${siteUrl}/api/webhook`,external_reference:orderId,
      shipments:{receiver_address:{
        zip_code:addr.zipCode,street_name:addr.street,street_number:addr.number,
        city_name:addr.city,state_name:addr.state,
        ...(addr.complement?{apartment:addr.complement}:{})
      }}
    };
    const r=await fetch('https://api.mercadopago.com/checkout/preferences',{
      method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${token}`},body:JSON.stringify(body)
    });
    const raw=await r.text();let data={};try{data=JSON.parse(raw)}catch(_){data={raw}}
    if(!r.ok||!data.init_point){console.error('Mercado Pago Checkout Pro:',r.status,raw);return send(res,502,{error:'O Mercado Pago não conseguiu criar o checkout.',details:mpError(data,r.status)});}
    return send(res,200,{orderId,orderType:'checkout',preferenceId:data.id,init_point:data.init_point,checkoutUrl:data.init_point});
  }catch(e){
    console.error('create-preference',e?.message);
    return send(res,e?.status||500,{error:e?.status?e.message:'Não foi possível criar o pagamento do Mercado Pago.'});
  }
};
