ALTER TABLE users ADD COLUMN IF NOT EXISTS support_status TEXT NOT NULL DEFAULT 'closed';
ALTER TABLE users ADD COLUMN IF NOT EXISTS support_opened_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS support_closed_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS support_last_message_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS support_unread_count INTEGER NOT NULL DEFAULT 0;

UPDATE users
SET support_status = 'open',
    support_opened_at = COALESCE(support_opened_at, support_requested_at),
    support_last_message_at = COALESCE(support_last_message_at, support_requested_at)
WHERE support_requested_at IS NOT NULL
  AND onboarding_step = 'support'
  AND support_status = 'closed';

CREATE INDEX IF NOT EXISTS idx_users_support_status ON users(support_status);
CREATE INDEX IF NOT EXISTS idx_users_support_last_message ON users(support_last_message_at DESC NULLS LAST);
