-- Cole e execute no SQL Editor do Supabase (projeto exclusivo da TRÍA).
CREATE TABLE IF NOT EXISTS public.product_overrides (
  id text PRIMARY KEY,
  product jsonb NOT NULL,
  active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.product_overrides ENABLE ROW LEVEL SECURITY;
-- Sem policies de escrita pública: somente nossas funções na Vercel,
-- autenticadas e usando a chave de serviço no SERVIDOR, podem alterar dados.
INSERT INTO storage.buckets (id,name,public,file_size_limit,allowed_mime_types)
VALUES ('product-images','product-images',true,2200000,ARRAY['image/jpeg','image/png','image/webp'])
ON CONFLICT (id) DO NOTHING;
-- Não crie policies de INSERT para anon/public no Storage.
