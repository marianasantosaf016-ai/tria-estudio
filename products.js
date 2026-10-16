const {getCatalog}=require('../lib/catalog');
module.exports=async function(req,res){
  res.setHeader('Cache-Control','no-store');
  if(req.method!=='GET')return res.status(405).json({error:'Método não permitido.'});
  try{return res.status(200).json(await getCatalog());}
  catch(err){console.error('public products',err?.message);return res.status(503).json({error:'Catálogo temporariamente indisponível.'});}
};
