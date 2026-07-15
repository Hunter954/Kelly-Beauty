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
