CREATE TABLE IF NOT EXISTS whatsapp_auth (
  session_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (session_id, key)
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_auth_updated ON whatsapp_auth(updated_at DESC);

-- JIDs @lid são IDs privados do WhatsApp/Baileys, não telefones reais.
-- Não apaga telefone válido informado manualmente; apaga só valores inválidos
-- ou quando o telefone salvo é exatamente o número técnico antes do @lid.
UPDATE users
SET phone = NULL, updated_at = NOW()
WHERE phone IS NOT NULL
  AND (
    phone !~ '^[0-9]{8,15}$'
    OR phone ~ '^([0-9])\1+$'
    OR (
      whatsapp_jid ILIKE '%@lid'
      AND regexp_replace(phone, '\D', '', 'g') = regexp_replace(whatsapp_jid, '@.*$', '')
    )
  );
