const crypto=require('crypto');
const {config,serviceHeaders}=require('../lib/catalog');
const {send,checkAdmin,fail}=require('../lib/admin');
module.exports=async function(req,res){
  if(req.method!=='POST')return send(res,405,{error:'Método não permitido.'});
  try{
    await checkAdmin(req);
    const mime=String(req.body?.mime||'');
    if(!['image/jpeg','image/png','image/webp'].includes(mime))return send(res,400,{error:'Formato inválido: use JPG, PNG ou WebP.'});
    const encoded=String(req.body?.base64||'');
    if(encoded.length>3000000||!/^[-A-Za-z0-9+/=]+$/.test(encoded))return send(res,400,{error:'Imagem inválida ou muito grande (máximo aproximado de 2 MB).'});
    const bytes=Buffer.from(encoded,'base64');
    if(bytes.length<100||bytes.length>2200000)return send(res,400,{error:'A imagem deve ter até 2 MB.'});
    const valid=mime==='image/jpeg'?bytes[0]===0xff&&bytes[1]===0xd8:
      mime==='image/png'?bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')):
      bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP';
    if(!valid)return send(res,400,{error:'Formato do arquivo não corresponde à imagem.'});
    const ext={'image/jpeg':'jpg','image/png':'png','image/webp':'webp'}[mime];
    const path=`moldes/${Date.now()}-${crypto.randomBytes(8).toString('hex')}.${ext}`;
    const conf=config();
    const url=conf.url+'/storage/v1/object/product-images/'+path;
    const r=await fetch(url,{method:'POST',headers:{'Content-Type':mime,...serviceHeaders(conf),'x-upsert':'false'},body:bytes});
    if(!r.ok){console.error('Supabase Storage:',r.status,await r.text().catch(()=>''));return send(res,502,{error:'Não foi possível salvar a imagem. Verifique se criou o bucket product-images.'});}
    return send(res,200,{url:conf.url+'/storage/v1/object/public/product-images/'+path});
  }catch(e){return fail(res,e);}
};
