# ERP MarketLandia na Vercel

Estrutura:

- `public/index.html` é o sistema (o antigo projeto1.html)
- `api/db.js` lê e grava a base no banco (substitui o server.js)
- `api/health.js` mostra se o banco está conectado
- `lib/db.js` conexão e criação automática das tabelas
- `public/restaurar.html` traz os dados do Render para cá (apague depois de usar)

## Deploy

1. Suba esta pasta inteira para o GitHub (no lugar de server.js, package.json e projeto1.html antigos).
2. Na Vercel: Add New > Project > importe o repositório > Deploy.
3. No projeto da Vercel: aba Storage > Create Database > Neon (Postgres) > conecte ao projeto, marcando Production. Isso cria a variável DATABASE_URL sozinha.
4. Deployments > Redeploy (as variáveis só valem em um novo deploy).
5. Abra `https://SEU-PROJETO.vercel.app/api/health`. Deve aparecer `"banco":"conectado"`. As tabelas são criadas sozinhas.

## Trazer os dados do Render (opcional)

1. No Render, abra `https://SEU-APP.onrender.com/api/db` e salve o texto como `backup.json`.
2. Na Vercel, abra `/restaurar.html`, escolha o arquivo e clique em Restaurar.
3. Apague `public/restaurar.html` do projeto.

## Como os dados ficam

- Tabela `store`: a base completa (fonte da verdade que o sistema lê), com número de versão.
- Tabelas `usuarios`, `clientes`, `produtos`, `orcamentos`, `pedidos`: cópia em linhas, atualizada a cada gravação, para consultar no SQL Editor da Neon.
- Todos os usuários (admin, gerente e vendedor) leem e gravam a mesma base.
- Se duas pessoas gravarem ao mesmo tempo, a segunda recebe o aviso "Outra pessoa alterou os dados" e a página recarrega, em vez de apagar o trabalho da outra.
