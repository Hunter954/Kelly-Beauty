const crypto = require('crypto');
const { getPool, query } = require('../db');

const ACTIVE_STATUSES = "('pending','confirmed','rescheduled','in_progress')";
const DEFAULT_HOLD_MINUTES = 5;

function bookingError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function code() {
  return `KR-${crypto.randomInt(1000, 9999)}${crypto.randomBytes(1).toString('hex').toUpperCase()}`;
}

async function listCategories() {
  return (await query('SELECT * FROM service_categories WHERE active=TRUE ORDER BY display_order,name')).rows;
}

async function listServices(categoryId) {
  return (await query('SELECT * FROM services WHERE active=TRUE AND category_id=$1 ORDER BY display_order,name', [categoryId])).rows;
}

async function listProfessionals(serviceId) {
  return (await query(`SELECT p.* FROM professionals p
    JOIN professional_services ps ON ps.professional_id=p.id
    WHERE ps.service_id=$1 AND p.active=TRUE
    ORDER BY p.is_primary DESC,p.name`, [serviceId])).rows;
}

async function getService(id) {
  return (await query('SELECT * FROM services WHERE id=$1', [id])).rows[0];
}

function normalizeHoldMinutes(value) {
  const minutes = Number(value);
  return Number.isFinite(minutes) && minutes > 0 ? Math.min(minutes, 30) : DEFAULT_HOLD_MINUTES;
}

async function releaseHolds(clientId) {
  if (!clientId) return;
  await query('DELETE FROM appointment_holds WHERE client_id=$1', [clientId]);
}

async function nextDates(serviceId, professionalId, limit = 5) {
  const service = await getService(serviceId);
  if (!service?.duration_minutes) return [];

  const days = [];
  for (let offset = 0; offset < 60 && days.length < limit; offset += 1) {
    const date = new Date();
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() + offset);
    const isoDate = date.toISOString().slice(0, 10);
    const slots = await availableSlots(serviceId, professionalId, isoDate);
    if (slots.length) days.push({ date: isoDate, slots });
  }
  return days;
}

async function availableSlots(serviceId, professionalId, date, clientId = null) {
  const service = await getService(serviceId);
  if (!service?.duration_minutes) return [];

  await query('DELETE FROM appointment_holds WHERE expires_at<=NOW()');

  const weekday = new Date(`${date}T12:00:00-03:00`).getDay();
  const hours = (await query(`SELECT
      COALESCE(ph.open_time,bh.open_time) open_time,
      COALESCE(ph.close_time,bh.close_time) close_time,
      COALESCE(ph.break_start,bh.break_start) break_start,
      COALESCE(ph.break_end,bh.break_end) break_end,
      COALESCE(ph.is_open,bh.is_open) is_open
    FROM business_hours bh
    LEFT JOIN professional_hours ph ON ph.weekday=bh.weekday AND ph.professional_id=$1
    WHERE bh.weekday=$2`, [professionalId, weekday])).rows[0];

  if (!hours?.is_open || !hours.open_time) return [];

  const duration = service.duration_minutes + (service.buffer_minutes || 0);
  const slots = [];
  const [openHour, openMinute] = String(hours.open_time).split(':').map(Number);
  const [closeHour, closeMinute] = String(hours.close_time).split(':').map(Number);
  let cursor = new Date(`${date}T${String(openHour).padStart(2, '0')}:${String(openMinute).padStart(2, '0')}:00-03:00`);
  const close = new Date(`${date}T${String(closeHour).padStart(2, '0')}:${String(closeMinute).padStart(2, '0')}:00-03:00`);

  const breakStart = hours.break_start ? new Date(`${date}T${hours.break_start}-03:00`) : null;
  const breakEnd = hours.break_end ? new Date(`${date}T${hours.break_end}-03:00`) : null;

  while (cursor.getTime() + duration * 60000 <= close.getTime()) {
    const end = new Date(cursor.getTime() + duration * 60000);
    const conflict = (await query(`SELECT 1 FROM appointments
        WHERE professional_id=$1 AND status IN ${ACTIVE_STATUSES} AND starts_at<$3 AND ends_at>$2
      UNION ALL
      SELECT 1 FROM schedule_blocks
        WHERE (professional_id=$1 OR professional_id IS NULL) AND starts_at<$3 AND ends_at>$2
      UNION ALL
      SELECT 1 FROM appointment_holds
        WHERE professional_id=$1 AND expires_at>NOW() AND starts_at<$3 AND ends_at>$2
          AND ($4::INTEGER IS NULL OR client_id<>$4)
      LIMIT 1`, [professionalId, cursor, end, clientId])).rowCount > 0;

    const inBreak = breakStart && breakEnd && cursor < breakEnd && end > breakStart;
    if (!conflict && !inBreak && cursor > new Date(Date.now() + 120 * 60000)) {
      slots.push(cursor.toISOString());
    }
    cursor = new Date(cursor.getTime() + 30 * 60000);
  }

  return slots;
}

async function holdSlot(data) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const service = (await client.query('SELECT * FROM services WHERE id=$1 FOR SHARE', [data.serviceId])).rows[0];
    if (!service?.duration_minutes) throw new Error('Serviço sem duração configurada.');

    const start = new Date(data.startsAt);
    if (Number.isNaN(start.getTime())) throw new Error('Horário inválido.');
    const end = new Date(start.getTime() + (service.duration_minutes + (service.buffer_minutes || 0)) * 60000);

    await client.query('SELECT pg_advisory_xact_lock($1)', [Number(data.professionalId)]);
    await client.query('DELETE FROM appointment_holds WHERE expires_at<=NOW() OR client_id=$1', [data.clientId]);

    const conflict = await client.query(`SELECT 1 FROM appointments
        WHERE professional_id=$1 AND status IN ${ACTIVE_STATUSES} AND starts_at<$3 AND ends_at>$2
      UNION ALL
      SELECT 1 FROM schedule_blocks
        WHERE (professional_id=$1 OR professional_id IS NULL) AND starts_at<$3 AND ends_at>$2
      UNION ALL
      SELECT 1 FROM appointment_holds
        WHERE professional_id=$1 AND expires_at>NOW() AND starts_at<$3 AND ends_at>$2 AND client_id<>$4
      LIMIT 1`, [data.professionalId, start, end, data.clientId]);

    if (conflict.rowCount) throw bookingError('Horário indisponível.', 'SLOT_UNAVAILABLE');

    const setting = (await client.query("SELECT value FROM app_settings WHERE key='hold_minutes' LIMIT 1")).rows[0];
    const holdMinutes = normalizeHoldMinutes(setting?.value);
    const hold = (await client.query(`INSERT INTO appointment_holds
      (client_id,service_id,professional_id,starts_at,ends_at,expires_at)
      VALUES($1,$2,$3,$4,$5,NOW()+($6::TEXT || ' minutes')::INTERVAL)
      RETURNING *`, [data.clientId, data.serviceId, data.professionalId, start, end, holdMinutes])).rows[0];

    await client.query('COMMIT');
    return hold;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function createAppointment(data) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const service = (await client.query('SELECT * FROM services WHERE id=$1 FOR SHARE', [data.serviceId])).rows[0];
    if (!service?.duration_minutes) throw new Error('Serviço sem duração configurada.');

    const start = new Date(data.startsAt);
    if (Number.isNaN(start.getTime())) throw new Error('Horário inválido.');
    const end = new Date(start.getTime() + (service.duration_minutes + (service.buffer_minutes || 0)) * 60000);

    await client.query('SELECT pg_advisory_xact_lock($1)', [Number(data.professionalId)]);
    await client.query('DELETE FROM appointment_holds WHERE expires_at<=NOW()');

    const conflict = await client.query(`SELECT 1 FROM appointments
        WHERE professional_id=$1 AND status IN ${ACTIVE_STATUSES} AND starts_at<$3 AND ends_at>$2
      UNION ALL
      SELECT 1 FROM schedule_blocks
        WHERE (professional_id=$1 OR professional_id IS NULL) AND starts_at<$3 AND ends_at>$2
      UNION ALL
      SELECT 1 FROM appointment_holds
        WHERE professional_id=$1 AND expires_at>NOW() AND starts_at<$3 AND ends_at>$2 AND client_id<>$4
      LIMIT 1`, [data.professionalId, start, end, data.clientId]);
    if (conflict.rowCount) throw bookingError('Horário indisponível.', 'SLOT_UNAVAILABLE');

    // O hold melhora a experiência enquanto o cliente confirma, mas não pode ser
    // uma condição obrigatória: ele pode expirar ou sofrer diferença de precisão
    // entre a sessão e o PostgreSQL. A trava por profissional + a consulta acima
    // são a garantia real e atômica contra agendamentos duplicados.
    const publicCode = code();
    const result = await client.query(`INSERT INTO appointments
      (public_code,client_id,service_id,professional_id,starts_at,ends_at,duration_minutes,buffer_minutes,status,original_price_cents,final_price_cents,origin,created_by,last_changed_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'confirmed',$9,$9,$10,$11,$11)
      RETURNING *`, [
      publicCode, data.clientId, data.serviceId, data.professionalId, start, end,
      service.duration_minutes, service.buffer_minutes || 0,
      service.promotional_price_cents || service.price_cents,
      data.origin || 'whatsapp', data.actor || 'client'
    ]);

    await client.query(`INSERT INTO appointment_history
      (appointment_id,action,new_data,actor_type,actor_id)
      VALUES($1,'created',$2,$3,$4)`, [result.rows[0].id, JSON.stringify(result.rows[0]), data.origin || 'whatsapp', data.actor || 'client']);

    await client.query(`INSERT INTO reminder_jobs(appointment_id,reminder_key,scheduled_for)
      VALUES($1,'30_minutes',$2-INTERVAL '30 minutes'),($1,'10_minutes',$2-INTERVAL '10 minutes')
      ON CONFLICT(appointment_id,reminder_key) DO UPDATE
      SET scheduled_for=EXCLUDED.scheduled_for,status='pending',sent_at=NULL,last_error=NULL`, [result.rows[0].id, start]);

    await client.query('DELETE FROM appointment_holds WHERE client_id=$1', [data.clientId]);
    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function upcoming(clientId) {
  return (await query(`SELECT a.*,s.name service_name,p.name professional_name
    FROM appointments a
    JOIN services s ON s.id=a.service_id
    JOIN professionals p ON p.id=a.professional_id
    WHERE a.client_id=$1 AND a.starts_at>=NOW() AND a.status IN ('pending','confirmed','rescheduled')
    ORDER BY a.starts_at`, [clientId])).rows;
}

module.exports = {
  listCategories,
  listServices,
  listProfessionals,
  getService,
  nextDates,
  availableSlots,
  holdSlot,
  releaseHolds,
  createAppointment,
  upcoming
};
