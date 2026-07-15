ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD COLUMN IF NOT EXISTS lead_status TEXT NOT NULL DEFAULT 'new';
ALTER TABLE users ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'not_started';
ALTER TABLE users ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS group_added_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS support_requested_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_provider_payment_unique
ON payments(provider, provider_payment_id)
WHERE provider_payment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_users_payment_status ON users(payment_status);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
