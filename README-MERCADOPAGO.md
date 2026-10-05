# TRÍA ESTÚDIO — Mercado Pago

Esta versão mantém o catálogo e os valores atuais e adiciona a estrutura do Checkout Pro / Preferences.

## O que foi implementado
- Checkout criado dinamicamente para cada carrinho.
- Produtos e quantidades enviados a partir do carrinho.
- PIX usa o preço `price` de cada produto do catálogo.
- Cartão usa o preço descrito como `installment` de cada produto.
- Cartão limitado a 3 parcelas.
- Boleto (`ticket`) excluído.
- `external_reference` único por pedido.
- Redirecionamento para `init_point` do Mercado Pago.
- Endpoint de webhook preparado.
- Access Token somente no ambiente do servidor.

## Antes de receber pagamentos reais
1. Publique esta pasta em uma hospedagem que execute as funções `/api` (Vercel é compatível com esta estrutura).
2. Cadastre os Secrets/Environment Variables de PRODUÇÃO:
   - `MERCADOPAGO_ACCESS_TOKEN`
   - `MERCADOPAGO_WEBHOOK_SECRET`
   - `SITE_URL` (URL HTTPS pública do site)
3. No Mercado Pago > Suas integrações > Webhooks, configure o evento **Pagamentos** em modo produtivo para:
   `https://SEU-DOMINIO/api/webhook`
4. Teste primeiro com as credenciais/ambiente de teste. Só depois valide produção.

## Importante sobre "valor líquido"
Os preços do catálogo NÃO foram alterados. O checkout cobra o valor de PIX ou cartão cadastrado para cada produto. O valor líquido efetivamente recebido pode sofrer as tarifas do Mercado Pago; este pacote não altera preços para compensar tarifas automaticamente porque isso exigiria a tarifa efetiva da conta e uma regra de gross-up definida pela TRÍA.


## Parcelamento sem acréscimo

A integração foi atualizada para a Checkout Pro via Orders API. Para pagamentos com cartão, a order envia `installments_cost: seller`, máximo de 3 parcelas e parcelas sem acréscimo de 2x a 3x. Assim, o total cobrado da cliente permanece o preço de cartão do catálogo; o custo financeiro do parcelamento fica com a vendedora.

A documentação atual do Mercado Pago confirma que a Orders API permite configurar `installments_cost` como `seller` e `installments.interest_free` para o intervalo sem juros.
