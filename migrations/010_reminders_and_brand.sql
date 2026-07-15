-- Lembretes de 30 e 10 minutos e ajustes da marca.
CREATE INDEX IF NOT EXISTS idx_reminder_jobs_due
  ON reminder_jobs(status, scheduled_for);

INSERT INTO reminder_jobs(appointment_id, reminder_key, scheduled_for)
SELECT a.id, x.reminder_key, a.starts_at - x.offset_value
FROM appointments a
CROSS JOIN (VALUES
  ('30_minutes'::text, INTERVAL '30 minutes'),
  ('10_minutes'::text, INTERVAL '10 minutes')
) x(reminder_key, offset_value)
WHERE a.status IN ('pending','confirmed','rescheduled')
  AND a.starts_at > NOW()
ON CONFLICT(appointment_id, reminder_key) DO NOTHING;

UPDATE app_settings
SET value = replace(value, 'seja bem-vinda', 'seja bem-vindo(a)')
WHERE key='welcome_message' AND value ILIKE '%seja bem-vinda%';
