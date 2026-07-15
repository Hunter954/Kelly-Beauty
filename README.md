# Kelly Rodrigues Beauty Studio — WhatsApp e Agenda

Sistema de atendimento por WhatsApp, agendamento e gestão administrativa baseado em Node.js, Express, EJS, PostgreSQL e Baileys.

## Funcionalidades implementadas

- Cadastro automático de clientes pelo WhatsApp.
- Catálogo por categorias e serviços.
- Escolha de profissional, data e horário disponível.
- Confirmação imediata sem sinal, PIX antecipado ou link de pagamento.
- Proteção transacional contra conflito de horários.
- Consulta dos próximos agendamentos pelo WhatsApp.
- Atendimento humano com pausa completa do bot.
- Painel com visão geral, agenda diária, agendamentos, clientes, serviços, profissionais, campanhas, configurações e conexão do WhatsApp.
- Serviços iniciais e dados comerciais da Kelly Rodrigues Beauty Studio.
- Registro administrativo de pagamentos preparado no banco, sem interferir na reserva.

## Configuração

Copie as variáveis para o ambiente:

```env
DATABASE_URL=postgresql://...
SESSION_SECRET=troque-por-uma-chave-forte
NODE_ENV=production
RUN_MIGRATIONS=true
ENABLE_WHATSAPP=true
WA_SESSION_ID=kelly-beauty
ADMIN_USER=admin
ADMIN_PASSWORD=troque-esta-senha
```

O projeto também aceita as variáveis PostgreSQL individuais (`PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`).

## Execução local

```bash
npm install
npm run db:init
npm start
```

Acesse `/admin/setup` no primeiro uso, caso ainda não exista uma senha administrativa configurada. Depois, use `/admin/login`.

## Railway

1. Crie um serviço PostgreSQL.
2. Configure `DATABASE_URL=${{Postgres.DATABASE_URL}}`.
3. Configure `SESSION_SECRET`, `NODE_ENV=production`, `RUN_MIGRATIONS=true` e `ENABLE_WHATSAPP=true`.
4. Faça o deploy com o Dockerfile ou pelo comando `npm start`.
5. Entre no painel, abra **WhatsApp** e leia o QR Code.

As migrations são aplicadas automaticamente e não apagam migrations antigas.

## Configuração obrigatória antes de liberar agendamentos

No painel **Serviços**, preencha duração, intervalo e preço dos serviços. Serviços sem duração não oferecem horários no WhatsApp. Ajuste os horários comerciais diretamente no banco nesta versão ou amplie a tela de configurações.

## Limitações conhecidas desta entrega

A primeira versão prioriza o fluxo confiável de agendamento, agenda diária, cadastro de clientes, serviços e atendimento humano. Reagendamento e cancelamento pelo WhatsApp são encaminhados ao atendimento humano; lembretes, lista de espera, relatórios avançados, fidelidade e edição visual completa de horários possuem estrutura de banco preparada, mas exigem a camada operacional adicional.


## PostgreSQL e volume persistente (correção 3.0.1)

No serviço da aplicação, não digite manualmente usuário e senha do PostgreSQL. Crie a referência:

```env
DATABASE_URL=${{Postgres.DATABASE_URL}}
SESSION_SECRET=troque-por-uma-chave-longa-e-aleatoria
STORAGE_PATH=/data
WA_SESSION_DATA_PATH=/data/whatsapp
```

Substitua `Postgres` pelo nome exato do serviço de banco no canvas do Railway.
Remova variáveis `DATABASE_URL`, `PGUSER` ou `PGPASSWORD` antigas que tenham credenciais digitadas manualmente e estejam incorretas.

Crie um Volume no serviço da aplicação e monte em `/data`. Ele será usado para logomarcas, outros uploads e fallback local da sessão do WhatsApp. O banco PostgreSQL continua sendo a fonte principal dos dados.
