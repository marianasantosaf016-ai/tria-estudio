'use strict';
const {config}=require('./catalog');
function send(res,status,payload){res.setHeader('Cache-Control','no-store');return res.status(status).json(payload);}
function allowedEmails(){return (process.env.ADMIN_EMAILS||'').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);}
async function checkAdmin(req){
  const conf=config();
  if(!conf) throw Object.assign(new Error('Administração ainda não configurada.'),{status:503});
  const bearer=(req.headers.authorization||'').match(/^Bearer ([\w.-]+)$/);
  if(!bearer)throw Object.assign(new Error('Faça login para continuar.'),{status:401});
  const r=await fetch(conf.url+'/auth/v1/user', {headers:{
    apikey:process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || conf.key,
    Authorization:'Bearer '+bearer[1]
  }});
  if(!r.ok)throw Object.assign(new Error('Sua sessão expirou. Entre novamente.'),{status:401});
  const user=await r.json();
  if(!user.email || !user.email_confirmed_at || !allowedEmails().includes(user.email.toLowerCase())) {
    throw Object.assign(new Error('Acesso não autorizado.'),{status:403});
  }
  return user;
}
function fail(res,e){console.error('TRÍA admin:',e?.message);return send(res,e?.status||500,{error:e?.status?e.message:'Não foi possível concluir a operação.'});}
module.exports={send,allowedEmails,checkAdmin,fail};
