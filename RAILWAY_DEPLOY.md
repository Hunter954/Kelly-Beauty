# Deploy simplificado no Railway

1. Conecte este repositório ao mesmo projeto onde já existe o PostgreSQL.
2. No serviço da aplicação, cadastre somente:

```env
DATABASE_URL=${{Postgres.DATABASE_URL}}
MERCADO_PAGO_ACCESS_TOKEN=APP_USR-SEU_TOKEN
```

3. Gere um domínio público no Railway.
4. Abra `https://seu-dominio/admin` e faça a configuração inicial.
5. Informe usuário, senha, preço, grupo e mensagens pelo painel.
6. Em **Conectar WhatsApp**, leia o QR Code uma única vez. A sessão fica salva no PostgreSQL.
7. No Mercado Pago, configure o webhook em `https://seu-dominio/webhooks/mercadopago`.

Se o serviço PostgreSQL tiver outro nome, substitua `Postgres` pelo nome exato na referência da variável.


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
