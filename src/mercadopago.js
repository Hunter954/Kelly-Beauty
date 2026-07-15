const crypto = require('crypto');
const { query, updateUser } = require('./db');
const config = require('./config');

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`Variável obrigatória ausente: ${name}`);
  return value;
}

function moneyToNumber(value) {
  const normalized = String(value || '0').replace(/\./g, '').replace(',', '.');
  const number = Number(normalized);
  if (!Number.isFinite(number) || number <= 0) throw new Error('REIVILO_PRICE_BRL inválido.');
  return number;
}

async function mpRequest(path, options = {}) {
  const token = required('MERCADO_PAGO_ACCESS_TOKEN');
  const response = await fetch(`https://api.mercadopago.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Idempotency-Key': options.idempotencyKey || crypto.randomUUID(),
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Mercado Pago ${response.status}: ${JSON.stringify(data)}`);
  return data;
}

async function createCheckoutForUser(user) {
  const baseUrl = config.publicBaseUrl();
  if (!baseUrl) throw new Error('Domínio público do Railway ainda não foi detectado. Gere um domínio no serviço.');
  const price = moneyToNumber(await config.get('price_brl', '997,00'));
  const title = await config.get('product_name', 'Mentoria REIVILO');
  const body = {
    items: [{ id: 'reivilo-mentoria', title, quantity: 1, currency_id: 'BRL', unit_price: price }],
    external_reference: String(user.id),
    metadata: { user_id: user.id, whatsapp_jid: user.whatsapp_jid, product: 'reivilo_mentoria' },
    notification_url: `${baseUrl}/webhooks/mercadopago`,
    back_urls: {
      success: `${baseUrl}/pagamento/sucesso`,
      pending: `${baseUrl}/pagamento/pendente`,
      failure: `${baseUrl}/pagamento/falhou`
    },
    auto_return: 'approved',
    statement_descriptor: 'REIVILO'
  };
  const preference = await mpRequest('/checkout/preferences', {
    method: 'POST',
    body: JSON.stringify(body),
    idempotencyKey: `reivilo-user-${user.id}-${Date.now()}`
  });
  await query(
    `INSERT INTO payments (user_id, provider, provider_payment_id, amount_cents, status, purpose, metadata)
     VALUES ($1, 'mercadopago', $2, $3, 'checkout_created', 'reivilo_mentoria', $4)`,
    [user.id, `preference:${preference.id}`, Math.round(price * 100), { preference_id: preference.id }]
  );
  await updateUser(user.id, { payment_status: 'checkout_created', lead_status: 'checkout_sent' });
  return preference.init_point || preference.sandbox_init_point;
}

function validateWebhookSignature(req) {
  const secret = String(process.env.MERCADO_PAGO_WEBHOOK_SECRET || '').trim();
  if (!secret) return true;
  const signature = String(req.headers['x-signature'] || '');
  const requestId = String(req.headers['x-request-id'] || '');
  const paymentId = String(req.body?.data?.id || req.query?.['data.id'] || req.query?.id || '');
  const ts = signature.split(',').map(x => x.trim()).find(x => x.startsWith('ts='))?.slice(3) || '';
  const v1 = signature.split(',').map(x => x.trim()).find(x => x.startsWith('v1='))?.slice(3) || '';
  if (!ts || !v1 || !paymentId) return false;
  const manifest = `id:${paymentId};request-id:${requestId};ts:${ts};`;
  const expected = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(v1);
  return expectedBuffer.length === receivedBuffer.length && crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

async function processApprovedPayment(payment) {
  const { sendText, addParticipantToGroup } = require('./bot');
  const userId = Number(payment.external_reference || payment.metadata?.user_id);
  if (!userId) throw new Error('Pagamento sem user_id/external_reference.');
  const found = await query('SELECT * FROM users WHERE id = $1', [userId]);
  const user = found.rows[0];
  if (!user) throw new Error(`Usuário ${userId} não encontrado.`);

  await query(
    `INSERT INTO payments (user_id, provider, provider_payment_id, amount_cents, status, purpose, metadata, updated_at)
     VALUES ($1, 'mercadopago', $2, $3, $4, 'reivilo_mentoria', $5, NOW())
     ON CONFLICT (provider, provider_payment_id) WHERE provider_payment_id IS NOT NULL
     DO UPDATE SET status = EXCLUDED.status, amount_cents = EXCLUDED.amount_cents, metadata = EXCLUDED.metadata, updated_at = NOW()`,
    [user.id, String(payment.id), Math.round(Number(payment.transaction_amount || 0) * 100), payment.status, payment]
  );

  if (payment.status !== 'approved') return { approved: false };
  const alreadyPaid = user.payment_status === 'approved';
  await updateUser(user.id, { payment_status: 'approved', lead_status: 'customer', paid_at: user.paid_at || new Date() });

  if (!alreadyPaid) {
    await sendText(user.whatsapp_jid,
      `✅ *Pagamento aprovado!*\n\nSua participação na Mentoria REIVILO foi confirmada. Seja muito bem-vindo(a). Estamos preparando seu acesso ao grupo exclusivo.`
    );
  }

  let groupAdded = false;
  let groupError = null;
  const groupId = String(await config.get('group_jid', '') || '').trim();
  if (groupId && !user.group_added_at) {
    try {
      await addParticipantToGroup(groupId, user.whatsapp_jid, user.phone);
      await updateUser(user.id, { group_added_at: new Date() });
      await sendText(user.whatsapp_jid, '🎉 Você foi adicionado(a) ao grupo exclusivo da Mentoria REIVILO.');
      groupAdded = true;
    } catch (error) {
      groupError = error.message;
      const invite = String(await config.get('group_invite_link', '') || '').trim();
      if (invite) await sendText(user.whatsapp_jid, `Seu acesso está liberado. Entre no grupo exclusivo por este link:\n${invite}`);
    }
  }
  return { approved: true, groupAdded, groupError };
}

async function handlePaymentNotification(paymentId) {
  const payment = await mpRequest(`/v1/payments/${encodeURIComponent(paymentId)}`, { method: 'GET' });
  return processApprovedPayment(payment);
}

module.exports = { createCheckoutForUser, validateWebhookSignature, handlePaymentNotification };
