-- Garante que contatos antigos com JID público voltem a exibir telefone no painel.
-- Para @lid não existe número real confiável no próprio JID; esses usuários passam
-- a informar o telefone no próximo cadastro/atendimento.
UPDATE users
SET phone = regexp_replace(whatsapp_jid, '@.*$', ''), updated_at = NOW()
WHERE (phone IS NULL OR phone = '')
  AND whatsapp_jid ~ '^[0-9]+@(s\.whatsapp\.net|c\.us)$'
  AND regexp_replace(whatsapp_jid, '@.*$', '') ~ '^[0-9]{8,15}$'
  AND regexp_replace(whatsapp_jid, '@.*$', '') !~ '^([0-9])\1+$';
