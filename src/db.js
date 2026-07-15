const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

let pool = null;
let poolError = null;
let poolCandidateIndex = 0;
let activeConnectionSource = null;
let whatsappAuthTableReady = false;

function cleanValue(value) {
  const text = String(value || '').trim();
  if (!text || text.includes('${{')) return '';
  return text;
}

function buildConnectionStringFromVars(prefix, names) {
  const host = cleanValue(process.env[names.host]);
  const port = cleanValue(process.env[names.port]) || '5432';
  const user = cleanValue(process.env[names.user]);
  const password = cleanValue(process.env[names.password]);
  const database = cleanValue(process.env[names.database]);
  if (!host || !user || !database) return null;
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}`;
}

function connectionCandidates() {
  const candidates = [
    ['DATABASE_URL', cleanValue(process.env.DATABASE_URL)],
    ['DATABASE_PRIVATE_URL', cleanValue(process.env.DATABASE_PRIVATE_URL)],
    ['POSTGRES_URL', cleanValue(process.env.POSTGRES_URL)],
    ['POSTGRES_DATABASE_URL', cleanValue(process.env.POSTGRES_DATABASE_URL)],
    ['DATABASE_PUBLIC_URL', cleanValue(process.env.DATABASE_PUBLIC_URL)],
    ['PG*', buildConnectionStringFromVars('PG', { host:'PGHOST', port:'PGPORT', user:'PGUSER', password:'PGPASSWORD', database:'PGDATABASE' })],
    ['POSTGRES*', buildConnectionStringFromVars('POSTGRES', { host:'POSTGRES_HOST', port:'POSTGRES_PORT', user:'POSTGRES_USER', password:'POSTGRES_PASSWORD', database:'POSTGRES_DB' })]
  ].filter(([, value]) => value);
  const seen = new Set();
  return candidates.filter(([, value]) => seen.has(value) ? false : (seen.add(value), true));
}

function resolveConnectionString() {
  return connectionCandidates()[0]?.[1] || null;
}

function databaseMissingMessage() {
  return [
    'Banco PostgreSQL não configurado.',
    'No serviço da aplicação no Railway, crie a variável:',
    'DATABASE_URL=${{Postgres.DATABASE_URL}}',
    'Troque Postgres pelo nome exato do serviço PostgreSQL no seu projeto.'
  ].join('\n');
}

function sslConfig(connectionString) {
  const mode = String(process.env.PGSSLMODE || '').toLowerCase();
  const sslRequested = ['require', 'true', '1', 'no-verify'].includes(mode) || /sslmode=(require|no-verify)/i.test(connectionString || '');
  return sslRequested ? { rejectUnauthorized: false } : false;
}

function closeCurrentPool() {
  const current = pool;
  pool = null;
  if (current) current.end().catch(() => {});
}

function createPool(candidateIndex = 0) {
  const candidates = connectionCandidates();
  if (!candidates.length) throw new Error(databaseMissingMessage());
  poolCandidateIndex = Math.min(candidateIndex, candidates.length - 1);
  const [source, connectionString] = candidates[poolCandidateIndex];
  activeConnectionSource = source;
  const created = new Pool({
    connectionString,
    ssl: sslConfig(connectionString),
    max: Number(process.env.PG_POOL_MAX || 10),
    idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS || 30000),
    connectionTimeoutMillis: Number(process.env.PG_CONNECTION_TIMEOUT_MS || 10000)
  });
  created.on('error', (error) => {
    poolError = error;
    console.error('Erro inesperado no pool PostgreSQL:', error.message);
  });
  return created;
}

function getPool() {
  if (!pool) pool = createPool(poolCandidateIndex);
  return pool;
}

function getSessionPool() { return getPool(); }

function isRetryableConnectionError(error) {
  return ['28P01','3D000','ECONNREFUSED','ENOTFOUND','ETIMEDOUT','ECONNRESET'].includes(error?.code);
}

async function query(text, params = []) {
  const candidates = connectionCandidates();
  let lastError;
  for (let attempt = 0; attempt < Math.max(candidates.length, 1); attempt += 1) {
    try {
      const result = await getPool().query(text, params);
      poolError = null;
      return result;
    } catch (error) {
      lastError = error;
      poolError = error;
      const nextIndex = poolCandidateIndex + 1;
      if (!isRetryableConnectionError(error) || nextIndex >= candidates.length) throw error;
      console.warn(`Conexão PostgreSQL por ${activeConnectionSource} falhou. Tentando ${candidates[nextIndex][0]}.`);
      closeCurrentPool();
      poolCandidateIndex = nextIndex;
    }
  }
  throw lastError;
}

function safeDatabaseTarget() {
  try {
    const url = new URL(connectionCandidates()[poolCandidateIndex]?.[1] || resolveConnectionString());
    return `${url.hostname}:${url.port || '5432'}/${url.pathname.replace(/^\//, '')}`;
  } catch (_) { return null; }
}

function getDatabaseStatus() {
  return {
    configured: connectionCandidates().length > 0,
    candidateCount: connectionCandidates().length,
    activeSource: activeConnectionSource || connectionCandidates()[0]?.[0] || null,
    target: safeDatabaseTarget(),
    poolCreated: Boolean(pool),
    lastError: poolError ? poolError.message : null,
    errorCode: poolError?.code || null
  };
}

function friendlyDatabaseError(error) {
  if (error?.code === '28P01') return 'O PostgreSQL recusou o usuário ou a senha. No Railway, remova DATABASE_URL preenchida manualmente e use a referência ${{Postgres.DATABASE_URL}}.';
  if (error?.code === '3D000') return 'O nome do banco PostgreSQL está incorreto. Use a variável DATABASE_URL fornecida pelo serviço PostgreSQL.';
  if (['ECONNREFUSED','ENOTFOUND','ETIMEDOUT'].includes(error?.code)) return 'Não foi possível alcançar o PostgreSQL. Confira se o serviço está ativo e se DATABASE_URL referencia o serviço correto.';
  if (/Banco PostgreSQL não configurado/i.test(error?.message || '')) return databaseMissingMessage();
  return 'Não foi possível acessar o PostgreSQL. Confira DATABASE_URL nas variáveis do serviço da aplicação.';
}

async function runMigrations() {
  const dir = path.join(__dirname, '..', 'migrations');
  const migrationDir = fs.existsSync(dir) ? dir : path.join(process.cwd(), 'migrations');
  const files = fs.readdirSync(migrationDir).filter((file) => file.endsWith('.sql')).sort();

  await query(`CREATE TABLE IF NOT EXISTS app_migrations (
    id SERIAL PRIMARY KEY,
    filename TEXT UNIQUE NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  for (const file of files) {
    const already = await query('SELECT 1 FROM app_migrations WHERE filename = $1', [file]);
    if (already.rowCount > 0) continue;
    const sql = fs.readFileSync(path.join(migrationDir, file), 'utf8');
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO app_migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`Migration aplicada: ${file}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
}

function normalizePhone(value) {
  if (!value) return null;

  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return null;

  // Se a pessoa informou um celular/telefone brasileiro com DDD, salva com 55.
  // Ex.: (45) 99999-9999 => 5545999999999.
  const phone = (digits.length === 10 || digits.length === 11) ? `55${digits}` : digits;

  if (phone.length < 8 || phone.length > 15) return null;
  if (/^(\d)\1+$/.test(phone)) return null;

  // Evita salvar IDs técnicos @lid como se fossem telefone.
  if (String(value || '').toLowerCase().includes('@lid')) return null;

  return phone;
}

function jidToPhone(jid) {
  if (!jid) return null;
  const value = String(jid || '').trim();

  // JIDs @lid são IDs privados do WhatsApp/Baileys. Eles não são telefone real.
  // Só extraímos telefone quando o JID é o número público do WhatsApp.
  if (!/@(s\.whatsapp\.net|c\.us)$/i.test(value)) return null;

  return normalizePhone(value.replace(/@.+$/, ''));
}

function formatPhoneForAdmin(userOrPhone) {
  const raw = typeof userOrPhone === 'object' && userOrPhone !== null ? userOrPhone.phone : userOrPhone;
  const jid = typeof userOrPhone === 'object' && userOrPhone !== null ? String(userOrPhone.whatsapp_jid || '') : '';
  const phone = normalizePhone(raw);

  if (phone && phone.length >= 12 && phone.startsWith('55')) {
    const ddd = phone.slice(2, 4);
    const rest = phone.slice(4);
    if (rest.length === 9) return `+55 (${ddd}) ${rest.slice(0, 5)}-${rest.slice(5)}`;
    if (rest.length === 8) return `+55 (${ddd}) ${rest.slice(0, 4)}-${rest.slice(4)}`;
  }

  if (phone) return `+${phone}`;
  if (jid.includes('@lid')) return 'Número ainda não informado';
  return 'Não disponível';
}

async function getUserByJid(whatsappJid) {
  const result = await query('SELECT * FROM users WHERE whatsapp_jid = $1', [whatsappJid]);
  return result.rows[0] || null;
}

async function getOrCreateUser(whatsappJid) {
  const phone = jidToPhone(whatsappJid);
  const existing = await getUserByJid(whatsappJid);
  if (existing) {
    if (phone && !existing.phone) {
      const updated = await query(
        'UPDATE users SET phone = $2, last_interaction_at = NOW(), updated_at = NOW() WHERE id = $1 RETURNING *',
        [existing.id, phone]
      );
      return updated.rows[0];
    }

    await query('UPDATE users SET last_interaction_at = NOW(), updated_at = NOW() WHERE id = $1', [existing.id]);
    return existing;
  }

  const result = await query(
    `INSERT INTO users (whatsapp_jid, phone, onboarding_step)
     VALUES ($1, $2, 'role_selection')
     RETURNING *`,
    [whatsappJid, phone]
  );
  return result.rows[0];
}

async function updateUser(userId, fields) {
  const keys = Object.keys(fields).filter((key) => typeof fields[key] !== 'undefined');
  if (keys.length === 0) {
    const current = await query('SELECT * FROM users WHERE id = $1', [userId]);
    return current.rows[0];
  }

  const values = [];
  const sets = keys.map((key, index) => {
    values.push(fields[key]);
    return `${key} = $${index + 1}`;
  });
  values.push(userId);

  const result = await query(
    `UPDATE users SET ${sets.join(', ')}, updated_at = NOW(), last_interaction_at = NOW()
     WHERE id = $${values.length}
     RETURNING *`,
    values
  );
  return result.rows[0];
}

async function mergeUserData(user, patch) {
  const current = user.onboarding_data || {};
  return updateUser(user.id, { onboarding_data: { ...current, ...patch } });
}

async function clearUserFlow(userId, step) {
  return updateUser(userId, { onboarding_step: step, onboarding_data: {} });
}

async function createJob(data) {
  const result = await query(
    `INSERT INTO jobs (
      company_user_id, title, company_name, city, area, modality, salary,
      requirements, benefits, contact_info, status, published_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, CASE WHEN $11 = 'active' THEN NOW() ELSE NULL END)
    RETURNING *`,
    [
      data.company_user_id,
      data.title,
      data.company_name,
      data.city,
      data.area,
      data.modality,
      data.salary,
      data.requirements,
      data.benefits,
      data.contact_info,
      data.status || 'active'
    ]
  );
  return result.rows[0];
}

async function getJobById(id) {
  const result = await query('SELECT * FROM jobs WHERE id = $1', [id]);
  return result.rows[0] || null;
}

async function updateJobStatus(id, status) {
  const result = await query(
    `UPDATE jobs
     SET status = $2,
         published_at = CASE WHEN $2 = 'active' AND published_at IS NULL THEN NOW() ELSE published_at END,
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [id, status]
  );
  return result.rows[0] || null;
}

async function listCompanyJobs(companyUserId, includeDeleted = false) {
  const result = await query(
    `SELECT * FROM jobs
     WHERE company_user_id = $1 ${includeDeleted ? '' : "AND status <> 'deleted'"}
     ORDER BY created_at DESC
     LIMIT 50`,
    [companyUserId]
  );
  return result.rows;
}

async function countCompanyActiveJobs(companyUserId) {
  const result = await query(
    "SELECT COUNT(*)::int AS count FROM jobs WHERE company_user_id = $1 AND status IN ('active', 'paused')",
    [companyUserId]
  );
  return result.rows[0].count;
}

async function listRecentJobs(limit = 10) {
  const result = await query(
    `SELECT * FROM jobs
     WHERE status = 'active'
     ORDER BY published_at DESC NULLS LAST, created_at DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

async function listActiveJobsForMatching(limit = 100) {
  const result = await query(
    `SELECT * FROM jobs
     WHERE status = 'active'
     ORDER BY published_at DESC NULLS LAST, created_at DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

async function listCandidatesForAlerts(limit = 1000) {
  const result = await query(
    `SELECT * FROM users
     WHERE role = 'candidate'
       AND alerts_enabled = TRUE
       AND GREATEST(COALESCE(trial_until, '1970-01-01'::timestamptz), COALESCE(premium_until, '1970-01-01'::timestamptz)) >= NOW()
     ORDER BY last_interaction_at DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

async function createApplication(jobId, candidateUserId, message = null) {
  const result = await query(
    `INSERT INTO applications (job_id, candidate_user_id, message)
     VALUES ($1, $2, $3)
     ON CONFLICT (job_id, candidate_user_id)
     DO UPDATE SET message = COALESCE(EXCLUDED.message, applications.message)
     RETURNING *`,
    [jobId, candidateUserId, message]
  );
  return result.rows[0];
}

async function listApplicationsForJob(jobId) {
  const result = await query(
    `SELECT a.*, u.name, u.phone, u.city, u.experience, u.whatsapp_jid
     FROM applications a
     JOIN users u ON u.id = a.candidate_user_id
     WHERE a.job_id = $1
     ORDER BY a.created_at DESC`,
    [jobId]
  );
  return result.rows;
}

async function deleteUserAccount(userId) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');

    const current = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [userId]);
    const user = current.rows[0] || null;
    if (!user) {
      await client.query('ROLLBACK');
      return { user: null, deletedJobs: 0 };
    }

    let deletedJobs = 0;
    if (user.role === 'company') {
      const jobs = await client.query(
        `UPDATE jobs
         SET status = 'deleted', updated_at = NOW()
         WHERE company_user_id = $1 AND status <> 'deleted'`,
        [userId]
      );
      deletedJobs = jobs.rowCount || 0;
    }

    const deleted = await client.query('DELETE FROM users WHERE id = $1 RETURNING *', [userId]);
    await client.query('COMMIT');

    return { user: deleted.rows[0] || user, deletedJobs };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function logMessage({ userId, whatsappJid, direction, body, raw }) {
  try {
    await query(
      'INSERT INTO message_logs (user_id, whatsapp_jid, direction, body, raw) VALUES ($1,$2,$3,$4,$5)',
      [userId || null, whatsappJid, direction, body || null, raw || null]
    );
  } catch (error) {
    console.error('Erro ao gravar log de mensagem:', error.message);
  }
}

async function addAdminNote(userId, note) {
  const result = await query(
    `INSERT INTO admin_notes (user_id, note) VALUES ($1, $2) RETURNING *`,
    [userId, note]
  );
  return result.rows[0];
}

async function getDashboardStats() {
  const result = await query(`
    SELECT
      (SELECT COUNT(*)::int FROM users WHERE role = 'candidate') AS candidates,
      (SELECT COUNT(*)::int FROM users WHERE role = 'company') AS companies,
      (SELECT COUNT(*)::int FROM jobs WHERE status = 'active') AS active_jobs,
      (SELECT COUNT(*)::int FROM applications) AS applications,
      (SELECT COUNT(*)::int FROM users WHERE created_at >= NOW() - INTERVAL '7 days') AS new_users_7d
  `);
  return result.rows[0];
}


async function ensureWhatsAppAuthTable() {
  if (whatsappAuthTableReady) return;
  await query(`CREATE TABLE IF NOT EXISTS whatsapp_auth (
    session_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (session_id, key)
  )`);
  whatsappAuthTableReady = true;
}

async function readWhatsAppAuthRecord(sessionId, key) {
  await ensureWhatsAppAuthTable();
  const result = await query(
    'SELECT value FROM whatsapp_auth WHERE session_id = $1 AND key = $2',
    [sessionId, key]
  );
  return result.rows[0]?.value || null;
}

async function writeWhatsAppAuthRecord(sessionId, key, value) {
  await ensureWhatsAppAuthTable();
  await query(
    `INSERT INTO whatsapp_auth (session_id, key, value, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (session_id, key)
     DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [sessionId, key, value]
  );
}

async function deleteWhatsAppAuthRecord(sessionId, key) {
  await ensureWhatsAppAuthTable();
  await query('DELETE FROM whatsapp_auth WHERE session_id = $1 AND key = $2', [sessionId, key]);
}

async function deleteWhatsAppAuthSession(sessionId) {
  await ensureWhatsAppAuthTable();
  await query('DELETE FROM whatsapp_auth WHERE session_id = $1', [sessionId]);
}

async function closePool() {
  if (pool) await pool.end();
}

module.exports = {
  getPool,
  getSessionPool,
  getDatabaseStatus, friendlyDatabaseError,
  query,
  runMigrations,
  closePool,
  jidToPhone,
  normalizePhone,
  formatPhoneForAdmin,
  getUserByJid,
  getOrCreateUser,
  updateUser,
  mergeUserData,
  clearUserFlow,
  createJob,
  getJobById,
  updateJobStatus,
  listCompanyJobs,
  countCompanyActiveJobs,
  listRecentJobs,
  listActiveJobsForMatching,
  listCandidatesForAlerts,
  createApplication,
  listApplicationsForJob,
  deleteUserAccount,
  logMessage,
  addAdminNote,
  getDashboardStats,
  ensureWhatsAppAuthTable,
  readWhatsAppAuthRecord,
  writeWhatsAppAuthRecord,
  deleteWhatsAppAuthRecord,
  deleteWhatsAppAuthSession
};
