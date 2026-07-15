const { getPool, query, logMessage } = require('../db');
const { sendText, getBotState } = require('../bot');
const { dateBR, timeBR } = require('../utils/format');

let timer = null;
let running = false;

function reminderMessage(row) {
  const minutes = row.reminder_key === '10_minutes' ? 10 : 30;
  const urgency = minutes === 10
    ? 'Seu atendimento começa em aproximadamente *10 minutos*. ✨'
    : 'Passando para lembrar que seu atendimento começa em aproximadamente *30 minutos*. ✨';

  return `Olá, ${row.client_name || 'tudo bem'}! 💛\n\n${urgency}\n\n` +
    `✨ Serviço: ${row.service_name}\n` +
    `📅 Data: ${dateBR(row.starts_at)}\n` +
    `🕐 Horário: ${timeBR(row.starts_at)}\n` +
    `👩 Profissional: ${row.professional_name}\n` +
    `📍 ${row.business_address || 'Kelly Rodrigues Beauty Studio'}\n\n` +
    'Caso tenha algum imprevisto, responda esta mensagem ou envie *ATENDENTE*.';
}

async function ensureReminderJobs() {
  await query(`
    INSERT INTO reminder_jobs (appointment_id, reminder_key, scheduled_for)
    SELECT a.id, values_to_add.reminder_key, a.starts_at - values_to_add.offset_value
    FROM appointments a
    CROSS JOIN (VALUES
      ('30_minutes'::text, INTERVAL '30 minutes'),
      ('10_minutes'::text, INTERVAL '10 minutes')
    ) AS values_to_add(reminder_key, offset_value)
    WHERE a.status IN ('pending','confirmed','rescheduled')
      AND a.starts_at > NOW()
    ON CONFLICT (appointment_id, reminder_key) DO UPDATE
      SET scheduled_for = EXCLUDED.scheduled_for
      WHERE reminder_jobs.status = 'pending'
  `);
}

async function claimNextJob() {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(`
      SELECT r.id, r.reminder_key, r.attempts,
             a.id appointment_id, a.starts_at, a.status appointment_status,
             u.id client_id, u.name client_name, u.whatsapp_jid,
             s.name service_name, p.name professional_name,
             (SELECT value FROM app_settings WHERE key='business_address') business_address
      FROM reminder_jobs r
      JOIN appointments a ON a.id=r.appointment_id
      JOIN users u ON u.id=a.client_id
      JOIN services s ON s.id=a.service_id
      JOIN professionals p ON p.id=a.professional_id
      WHERE r.status='pending'
        AND r.scheduled_for <= NOW()
        AND a.starts_at > NOW() - INTERVAL '3 minutes'
        AND a.status IN ('pending','confirmed','rescheduled')
      ORDER BY r.scheduled_for
      FOR UPDATE OF r SKIP LOCKED
      LIMIT 1
    `);
    if (!result.rows[0]) {
      await client.query('COMMIT');
      return null;
    }
    const job = result.rows[0];
    await client.query(`UPDATE reminder_jobs SET status='processing',attempts=attempts+1,last_error=NULL WHERE id=$1`, [job.id]);
    await client.query('COMMIT');
    return job;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function processPendingReminders() {
  if (running) return;
  running = true;
  try {
    await ensureReminderJobs();
    if (!getBotState().ready) return;

    for (let count = 0; count < 20; count += 1) {
      const job = await claimNextJob();
      if (!job) break;
      try {
        if (!job.whatsapp_jid) throw new Error('Cliente sem WhatsApp válido.');
        const body = reminderMessage(job);
        await sendText(job.whatsapp_jid, body);
        await logMessage({ userId: job.client_id, whatsappJid: job.whatsapp_jid, direction: 'out', body });
        await query(`UPDATE reminder_jobs SET status='sent',sent_at=NOW(),last_error=NULL WHERE id=$1`, [job.id]);
      } catch (error) {
        await query(`
          UPDATE reminder_jobs
          SET status=CASE WHEN attempts>=3 THEN 'failed' ELSE 'pending' END,
              scheduled_for=CASE WHEN attempts>=3 THEN scheduled_for ELSE NOW()+INTERVAL '2 minutes' END,
              last_error=$2
          WHERE id=$1
        `, [job.id, String(error.message || error).slice(0, 800)]);
      }
    }
  } catch (error) {
    console.error('Falha no processador de lembretes:', error.message);
  } finally {
    running = false;
  }
}

function startReminderWorker() {
  if (timer) return;
  const intervalMs = Math.max(15000, Number(process.env.REMINDER_POLL_MS || 30000));
  setTimeout(processPendingReminders, 8000);
  timer = setInterval(processPendingReminders, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  console.log(`Processador de lembretes ativo a cada ${Math.round(intervalMs / 1000)}s.`);
}

module.exports = { startReminderWorker, processPendingReminders, ensureReminderJobs };
