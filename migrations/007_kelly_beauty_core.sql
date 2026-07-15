ALTER TABLE users ADD COLUMN IF NOT EXISTS birth_date DATE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS instagram TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS client_status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE users ADD COLUMN IF NOT EXISTS marketing_consent BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS presence_confirmed_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS service_categories (
 id SERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE, display_order INTEGER NOT NULL DEFAULT 0,
 active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS services (
 id SERIAL PRIMARY KEY, category_id INTEGER REFERENCES service_categories(id), name TEXT NOT NULL,
 description TEXT, duration_minutes INTEGER, buffer_minutes INTEGER NOT NULL DEFAULT 0,
 price_cents INTEGER, price_type TEXT NOT NULL DEFAULT 'hidden' CHECK(price_type IN ('exact','from','consult','hidden')),
 promotional_price_cents INTEGER, active BOOLEAN NOT NULL DEFAULT TRUE, pre_instructions TEXT, post_instructions TEXT,
 calendar_color TEXT, display_order INTEGER NOT NULL DEFAULT 0, min_notice_minutes INTEGER, max_future_days INTEGER,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(category_id,name)
);
CREATE TABLE IF NOT EXISTS professionals (
 id SERIAL PRIMARY KEY, name TEXT NOT NULL, phone TEXT, role_title TEXT, photo_url TEXT, active BOOLEAN NOT NULL DEFAULT TRUE,
 is_primary BOOLEAN NOT NULL DEFAULT FALSE, calendar_color TEXT, notes TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS professional_services (
 professional_id INTEGER NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
 service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE, PRIMARY KEY(professional_id,service_id)
);
CREATE TABLE IF NOT EXISTS business_hours (
 id SERIAL PRIMARY KEY, weekday INTEGER NOT NULL CHECK(weekday BETWEEN 0 AND 6), open_time TIME, close_time TIME,
 break_start TIME, break_end TIME, is_open BOOLEAN NOT NULL DEFAULT FALSE, UNIQUE(weekday)
);
CREATE TABLE IF NOT EXISTS professional_hours (
 id SERIAL PRIMARY KEY, professional_id INTEGER NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
 weekday INTEGER NOT NULL CHECK(weekday BETWEEN 0 AND 6), open_time TIME, close_time TIME, break_start TIME, break_end TIME,
 is_open BOOLEAN NOT NULL DEFAULT TRUE, UNIQUE(professional_id,weekday)
);
CREATE TABLE IF NOT EXISTS schedule_blocks (
 id SERIAL PRIMARY KEY, professional_id INTEGER REFERENCES professionals(id) ON DELETE CASCADE, starts_at TIMESTAMPTZ NOT NULL,
 ends_at TIMESTAMPTZ NOT NULL, reason TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), CHECK(ends_at>starts_at)
);
CREATE TABLE IF NOT EXISTS appointments (
 id BIGSERIAL PRIMARY KEY, public_code TEXT NOT NULL UNIQUE, client_id INTEGER NOT NULL REFERENCES users(id),
 service_id INTEGER NOT NULL REFERENCES services(id), professional_id INTEGER NOT NULL REFERENCES professionals(id),
 starts_at TIMESTAMPTZ NOT NULL, ends_at TIMESTAMPTZ NOT NULL, duration_minutes INTEGER NOT NULL, buffer_minutes INTEGER NOT NULL DEFAULT 0,
 status TEXT NOT NULL DEFAULT 'confirmed' CHECK(status IN ('pending','confirmed','rescheduled','in_progress','completed','cancelled_by_client','cancelled_by_business','no_show','expired','blocked')),
 original_price_cents INTEGER, discount_cents INTEGER NOT NULL DEFAULT 0, final_price_cents INTEGER, paid_cents INTEGER NOT NULL DEFAULT 0,
 payment_status TEXT NOT NULL DEFAULT 'not_informed' CHECK(payment_status IN ('not_informed','pending','partial','paid','refunded','cancelled','courtesy')),
 origin TEXT NOT NULL DEFAULT 'whatsapp', client_notes TEXT, internal_notes TEXT, presence_confirmed_at TIMESTAMPTZ,
 cancelled_at TIMESTAMPTZ, completed_at TIMESTAMPTZ, created_by TEXT, last_changed_by TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), CHECK(ends_at>starts_at)
);
CREATE INDEX IF NOT EXISTS idx_appointments_start ON appointments(starts_at);
CREATE INDEX IF NOT EXISTS idx_appointments_client ON appointments(client_id,status);
CREATE INDEX IF NOT EXISTS idx_appointments_professional ON appointments(professional_id,starts_at,ends_at);
CREATE TABLE IF NOT EXISTS appointment_history (
 id BIGSERIAL PRIMARY KEY, appointment_id BIGINT NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
 action TEXT NOT NULL, previous_data JSONB, new_data JSONB, actor_type TEXT NOT NULL DEFAULT 'system', actor_id TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS appointment_holds (
 id BIGSERIAL PRIMARY KEY, client_id INTEGER NOT NULL REFERENCES users(id), service_id INTEGER NOT NULL REFERENCES services(id),
 professional_id INTEGER NOT NULL REFERENCES professionals(id), starts_at TIMESTAMPTZ NOT NULL, ends_at TIMESTAMPTZ NOT NULL,
 expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_holds_active ON appointment_holds(professional_id,starts_at,ends_at,expires_at);
CREATE TABLE IF NOT EXISTS payment_records (
 id BIGSERIAL PRIMARY KEY, appointment_id BIGINT NOT NULL REFERENCES appointments(id), amount_cents INTEGER NOT NULL,
 method TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'paid', notes TEXT, recorded_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS reminder_jobs (
 id BIGSERIAL PRIMARY KEY, appointment_id BIGINT NOT NULL REFERENCES appointments(id) ON DELETE CASCADE, reminder_key TEXT NOT NULL,
 scheduled_for TIMESTAMPTZ NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
 sent_at TIMESTAMPTZ, last_error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(appointment_id,reminder_key)
);
CREATE TABLE IF NOT EXISTS waitlist (
 id BIGSERIAL PRIMARY KEY, client_id INTEGER NOT NULL REFERENCES users(id), service_id INTEGER NOT NULL REFERENCES services(id),
 professional_id INTEGER REFERENCES professionals(id), preferred_dates JSONB NOT NULL DEFAULT '[]', preferred_period TEXT,
 notes TEXT, status TEXT NOT NULL DEFAULT 'waiting', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS audit_logs (
 id BIGSERIAL PRIMARY KEY, admin_user TEXT, action TEXT NOT NULL, entity TEXT NOT NULL, entity_id TEXT,
 previous_data JSONB, new_data JSONB, ip TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO service_categories(name,display_order) VALUES
 ('Cabelo e sobrancelhas',1),('Unhas',2),('Cílios',3),('Depilação e spa',4),('Massagens e estética corporal',5)
ON CONFLICT(name) DO NOTHING;
INSERT INTO services(category_id,name,display_order,price_type) SELECT id,'Cabeleireira',1,'hidden' FROM service_categories WHERE name='Cabelo e sobrancelhas' ON CONFLICT DO NOTHING;
INSERT INTO services(category_id,name,display_order,price_type) SELECT id,'Design de sobrancelhas',2,'hidden' FROM service_categories WHERE name='Cabelo e sobrancelhas' ON CONFLICT DO NOTHING;
INSERT INTO services(category_id,name,display_order,price_type) SELECT id,'Manicure',1,'hidden' FROM service_categories WHERE name='Unhas' ON CONFLICT DO NOTHING;
INSERT INTO services(category_id,name,display_order,price_type) SELECT id,'Pedicure',2,'hidden' FROM service_categories WHERE name='Unhas' ON CONFLICT DO NOTHING;
INSERT INTO services(category_id,name,display_order,price_type) SELECT id,'Extensão de cílios',1,'hidden' FROM service_categories WHERE name='Cílios' ON CONFLICT DO NOTHING;
INSERT INTO services(category_id,name,display_order,price_type) SELECT id,'Depilação',1,'hidden' FROM service_categories WHERE name='Depilação e spa' ON CONFLICT DO NOTHING;
INSERT INTO services(category_id,name,display_order,price_type) SELECT id,'Spa dos pés',2,'hidden' FROM service_categories WHERE name='Depilação e spa' ON CONFLICT DO NOTHING;
INSERT INTO services(category_id,name,display_order,price_type) SELECT id,'Massagem estética',1,'hidden' FROM service_categories WHERE name='Massagens e estética corporal' ON CONFLICT DO NOTHING;
INSERT INTO services(category_id,name,display_order,price_type) SELECT id,'Modelagem corporal',2,'hidden' FROM service_categories WHERE name='Massagens e estética corporal' ON CONFLICT DO NOTHING;
INSERT INTO services(category_id,name,display_order,price_type) SELECT id,'Massagem relaxante',3,'hidden' FROM service_categories WHERE name='Massagens e estética corporal' ON CONFLICT DO NOTHING;
INSERT INTO professionals(name,role_title,is_primary) SELECT 'Kelly Rodrigues','Proprietária e profissional',TRUE WHERE NOT EXISTS(SELECT 1 FROM professionals);
INSERT INTO professional_services(professional_id,service_id) SELECT p.id,s.id FROM professionals p CROSS JOIN services s WHERE p.is_primary=TRUE ON CONFLICT DO NOTHING;
INSERT INTO business_hours(weekday,is_open,open_time,close_time,break_start,break_end) VALUES
 (0,FALSE,NULL,NULL,NULL,NULL),(1,FALSE,NULL,NULL,NULL,NULL),(2,TRUE,'09:00','18:00','12:00','13:00'),
 (3,TRUE,'09:00','18:00','12:00','13:00'),(4,TRUE,'09:00','19:00','12:00','13:00'),
 (5,TRUE,'09:00','19:00','12:00','13:00'),(6,TRUE,'08:00','16:00','12:00','13:00') ON CONFLICT(weekday) DO NOTHING;
INSERT INTO app_settings(key,value,is_secret) VALUES
 ('business_name','Kelly Rodrigues Beauty Studio',FALSE),('business_phone','45 99846-7053',FALSE),
 ('business_instagram','@kellylingerie_store',FALSE),('business_address','Av. Brasil, 665 — Galeria Edine — Sala 24',FALSE),
 ('timezone','America/Sao_Paulo',FALSE),('hold_minutes','5',FALSE),('max_future_days','60',FALSE),('min_notice_minutes','120',FALSE),
 ('welcome_message','Olá, seja bem-vinda à Kelly Rodrigues Beauty Studio! ✨\n\nComo podemos cuidar de você hoje?\n\n1️⃣ Agendar um serviço\n2️⃣ Ver nossos serviços\n3️⃣ Consultar meu agendamento\n4️⃣ Reagendar ou cancelar\n5️⃣ Endereço e contato\n6️⃣ Falar com uma atendente\n\nDigite o número da opção desejada.',FALSE)
ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value;
