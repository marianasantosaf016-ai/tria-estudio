const crypto=require('crypto');
const {getCatalog,saveProduct,config}=require('../lib/catalog');
const {send,checkAdmin,fail}=require('../lib/admin');
const cats=['TIGELAS','CANECAS & COPOS','VASOS','PRATOS & BANDEJAS','AUTORAIS','KIDS'];
const toText=(v,n)=>String(v||'').trim().slice(0,n);
function cleanString(value,max,required=false){
  const s=toText(value,max);
  if((required&&!s)||/[<>"`]/.test(s))throw Object.assign(new Error('Revise os textos: não use tags HTML ou aspas duplas.'),{status:400});
  return s;
}
function checkImage(url){
  if(!url)return '';
  if(typeof url!=='string'||url.length>500)throw Object.assign(new Error('Imagem inválida.'),{status:400});
  if(/^assets\/[\w./-]+\.(?:jpg|jpeg|png|webp)$/i.test(url))return url;
  const conf=config();
  if(conf && url.startsWith(conf.url+'/storage/v1/object/public/product-images/') && !/[<>"'`]/.test(url)) return url;
  throw Object.assign(new Error('Envie imagens pelo botão de upload do painel.'),{status:400});
}
function validProduct(data,id){
  if(!data||typeof data!=='object')throw Object.assign(new Error('Produto inválido.'),{status:400});
  const price=Number(data.price), cardPrice=Number(data.cardPrice);
  if(!Number.isFinite(price)||!Number.isFinite(cardPrice)||price<=0||cardPrice<=0||price>100000||cardPrice>100000||cardPrice<price) {
    throw Object.assign(new Error('Preços inválidos: informe valores positivos e cartão maior ou igual ao Pix.'),{status:400});
  }
  if(!cats.includes(data.cat))throw Object.assign(new Error('Categoria inválida.'),{status:400});
  const name=cleanString(data.name,100,true), desc=cleanString(data.desc,1200,true);
  if(!Array.isArray(data.spec)||data.spec.length>20)throw Object.assign(new Error('Medidas inválidas.'),{status:400});
  const image=checkImage(data.image);
  const gallery=Array.isArray(data.gallery)?data.gallery.map(checkImage).filter(Boolean):[];
  if(gallery.length>8)throw Object.assign(new Error('Envie até 8 fotografias.'),{status:400});
  if(!image&&!gallery[0])throw Object.assign(new Error('Adicione uma fotografia do produto.'),{status:400});
  return {
    id,name,cat:data.cat,desc,details:cleanString(data.details||desc,2000),
    price:Math.round(price*100)/100,cardPrice:Math.round(cardPrice*100)/100,
    installment:'cartão em até 3x com juros',
    spec:data.spec.map(s=>cleanString(s,160)).filter(Boolean),
    image:image||gallery[0],gallery:gallery.length?gallery:[image],active:data.active!==false
  };
}
module.exports=async function(req,res){
  if(!['GET','POST','PUT','DELETE'].includes(req.method))return send(res,405,{error:'Método não permitido.'});
  try{
    await checkAdmin(req);
    const all=await getCatalog({includeInactive:true});
    if(req.method==='GET')return send(res,200,all);
    if(req.method==='DELETE'){
      const id=String(req.body?.id||'');
      const old=all.find(p=>p.id===id);
      if(!old)return send(res,404,{error:'Produto não encontrado.'});
      await saveProduct(old,false);
      return send(res,200,{ok:true});
    }
    const edit=req.method==='PUT';
    const id=edit?String(req.body?.id||''):'novo-'+crypto.randomBytes(7).toString('hex');
    if(!/^[a-z0-9-]{3,80}$/.test(id))return send(res,400,{error:'Identificador inválido.'});
    if(edit&&!all.some(p=>p.id===id))return send(res,404,{error:'Produto não encontrado.'});
    const product=validProduct(req.body?.product,id);
    await saveProduct(product,product.active);
    return send(res,200,{ok:true,product});
  }catch(e){return fail(res,e);}
};
