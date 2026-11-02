const {config}=require('../lib/catalog');
const {send,allowedEmails,fail}=require('../lib/admin');
module.exports=async function(req,res){
  if(req.method!=='POST')return send(res,405,{error:'Método não permitido.'});
  try{
    const email=String(req.body?.email||'').trim().toLowerCase();
    const password=String(req.body?.password||'');
    if(!allowedEmails().includes(email)||!password||password.length>300)return send(res,401,{error:'E-mail ou senha inválidos.'});
    const conf=config();
    if(!conf)return send(res,503,{error:'Configure o banco de dados para ativar o painel.'});
    const anon=process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY;
    if(!anon)return send(res,503,{error:'SUPABASE_PUBLISHABLE_KEY não configurada.'});
    const r=await fetch(conf.url+'/auth/v1/token?grant_type=password',{
      method:'POST',headers:{'Content-Type':'application/json','apikey':anon},
      body:JSON.stringify({email,password})
    });
    const data=await r.json().catch(()=>({}));
    if(!r.ok||!data.access_token||!data.user?.email_confirmed_at||!allowedEmails().includes(String(data.user?.email||'').toLowerCase()))return send(res,401,{error:'E-mail ou senha inválidos, ou e-mail não confirmado.'});
    return send(res,200,{accessToken:data.access_token,expiresIn:data.expires_in,email:data.user.email});
  }catch(e){return fail(res,e);}
};
