const fs = require('fs');
const path = require('path');
const { Boom } = require('@hapi/boom');
const { handleIncomingMessage } = require('./flows');
const db = require('./db');
const storage = require('./storage');

let client = null;
let starting = false;
let backgroundPromise = null;
let baileysSocket = null;
let baileysSaveCreds = null;
const latestMessageByJid = new Map();
const systemSentMessageIds = new Set();

const state = {
  enabled: String(process.env.ENABLE_WHATSAPP || 'true') === 'true',
  sessionId: process.env.WA_SESSION_ID || 'kelly-beauty',
  engine: 'baileys',
  authStore: 'local-file',
  ready: false,
  qr: null,
  status: 'Aguardando início manual pelo painel',
  lastError: null,
  startedAt: null,
  connectedAt: null,
  launchAttempts: 0,
  lastQrAt: null,
  lastInboundAt: null,
  lastInboundFrom: null,
  lastInboundPreview: null,
  lastOutboundAt: null,
  lastOutboundTo: null,
  lastOutboundPreview: null,
  lastOutboundError: null
};

function boolEnv(name, fallback) {
  const value = process.env[name];
  if (typeof value === 'undefined') return fallback;
  return ['true', '1', 'yes', 'sim', 'on'].includes(String(value).toLowerCase());
}

function intEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function sessionBaseDir() {
  const custom = String(process.env.WA_SESSION_DATA_PATH || '').trim();
  if (custom) return path.resolve(custom);
  storage.ensureStorageDirectories();
  return storage.whatsapp;
}


async function removeIfExists(target) {
  try {
    if (fs.existsSync(target)) {
      await fs.promises.rm(target, { recursive: true, force: true });
    }
  } catch (error) {
    console.warn(`Não foi possível limpar ${target}:`, error.message);
  }
}

async function cleanSessionArtifacts() {
  const sessionId = state.sessionId;
  const baseDir = sessionBaseDir();
  await removeIfExists(path.join(baseDir, `baileys-${sessionId}`));
  await removeIfExists(path.join(process.cwd(), `baileys-${sessionId}`));

  try {
    await db.deleteWhatsAppAuthSession(sessionId);
  } catch (error) {
    console.warn('Não foi possível limpar a sessão Baileys no PostgreSQL:', error.message);
  }
}

function normalizeToBaileysJid(jid) {
  const value = String(jid || '').trim();
  if (!value) return value;

  // Importante: o WhatsApp/Baileys agora pode entregar mensagens com JID @lid.
  // Antes o código transformava 123@lid em 123@s.whatsapp.net, e a resposta
  // ficava presa ou ia para um destino inválido. Se já veio com @, mantenha
  // exatamente o JID original retornado pelo Baileys.
  if (value.includes('@')) return value;

  const phone = value.replace(/\D/g, '');
  return phone ? `${phone}@s.whatsapp.net` : value;
}


function normalizeWhatsAppText(text) {
  let value = String(text == null ? '' : text);

  // Textos vindos de migrations, variáveis ou formulários antigos podem ter
  // sido persistidos com os caracteres literais \n e \r\n. O WhatsApp não
  // interpreta essas sequências automaticamente, por isso normalizamos no
  // ponto central de envio para proteger todos os fluxos e campanhas.
  value = value
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\n')
    .replace(/\\t/g, ' ');

  // Evita blocos gigantes por excesso acidental de linhas em branco.
  return value.replace(/\n{4,}/g, '\n\n\n').trim();
}

function previewText(text, size = 100) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > size ? `${value.slice(0, size)}...` : value;
}

function extractPhoneFromRawMessage(message, fallbackJid = '') {
  const directPhone = db.jidToPhone(fallbackJid);
  if (directPhone) return directPhone;

  // Em alguns aparelhos/versões o Baileys recebe o remetente como @lid,
  // mas mantém o número público em outro campo do payload. Fazemos uma busca
  // conservadora por JIDs reais do WhatsApp e ignoramos grupos/status/@lid.
  const seen = new WeakSet();
  const candidates = [];

  const scan = (value, depth = 0) => {
    if (depth > 7 || value == null) return;

    if (typeof value === 'string') {
      if (/(?:@s\.whatsapp\.net|@c\.us)/i.test(value)) {
        const parts = value.match(/[0-9]+@(?:s\.whatsapp\.net|c\.us)/ig) || [];
        for (const part of parts) {
          const phone = db.jidToPhone(part);
          if (phone) candidates.push(phone);
        }
      }
      return;
    }

    if (typeof value !== 'object') return;
    if (seen.has(value)) return;
    seen.add(value);

    for (const [key, child] of Object.entries(value)) {
      const keyName = key.toLowerCase();
      if (['rawdata', 'jpegthumbnail', 'thumbnail', 'fileencsha256', 'filesha256', 'mediaKey'.toLowerCase()].includes(keyName)) continue;
      scan(child, depth + 1);
    }
  };

  scan(message);
  return candidates[0] || null;
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function stopBot() {
  try {
    if (baileysSocket) {
      baileysSocket.ev.removeAllListeners('connection.update');
      baileysSocket.ev.removeAllListeners('creds.update');
      baileysSocket.ev.removeAllListeners('messages.upsert');
      if (baileysSocket.ws?.close) baileysSocket.ws.close();
      if (typeof baileysSocket.logout === 'function' && boolEnv('WA_LOGOUT_ON_STOP', false)) {
        await baileysSocket.logout();
      }
    }
  } catch (error) {
    console.warn('Erro ao encerrar Baileys:', error.message);
  } finally {
    client = null;
    baileysSocket = null;
    baileysSaveCreds = null;
    latestMessageByJid.clear();
    systemSentMessageIds.clear();
    starting = false;
    backgroundPromise = null;
    state.ready = false;
    state.qr = null;
    state.status = 'WhatsApp parado';
  }
}

function getBaileysAuthDir() {
  const baseDir = sessionBaseDir();
  return path.join(baseDir, `baileys-${state.sessionId}`);
}


function authStoreMode() {
  const mode = String(process.env.WA_AUTH_STORE || process.env.WA_SESSION_STORE || 'postgres').trim().toLowerCase();
  if (['file', 'files', 'local', 'local-file', 'filesystem'].includes(mode)) return 'file';
  return 'postgres';
}

async function usePostgresAuthState(baileys) {
  const { initAuthCreds, BufferJSON, proto } = baileys;
  const sessionId = state.sessionId;

  await db.ensureWhatsAppAuthTable();

  const serialize = (data) => JSON.parse(JSON.stringify(data, BufferJSON.replacer));
  const deserialize = (data) => {
    if (!data) return null;
    return JSON.parse(JSON.stringify(data), BufferJSON.reviver);
  };

  const readData = async (key) => deserialize(await db.readWhatsAppAuthRecord(sessionId, key));
  const writeData = async (key, data) => db.writeWhatsAppAuthRecord(sessionId, key, serialize(data));
  const removeData = async (key) => db.deleteWhatsAppAuthRecord(sessionId, key);

  const creds = (await readData('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(ids.map(async (id) => {
            let value = await readData(`${type}-${id}`);
            if (type === 'app-state-sync-key' && value && proto?.Message?.AppStateSyncKeyData) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            data[id] = value;
          }));
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category of Object.keys(data || {})) {
            for (const id of Object.keys(data[category] || {})) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              tasks.push(value ? writeData(key, value) : removeData(key));
            }
          }
          await Promise.all(tasks);
        }
      }
    },
    saveCreds: async () => writeData('creds', creds)
  };
}

async function resolveBaileysAuthState(baileys, authDir) {
  const { useMultiFileAuthState } = baileys;
  const mode = authStoreMode();

  if (mode === 'file') {
    state.authStore = `arquivo local: ${authDir}`;
    await fs.promises.mkdir(authDir, { recursive: true });
    return useMultiFileAuthState(authDir);
  }

  try {
    const auth = await usePostgresAuthState(baileys);
    state.authStore = 'PostgreSQL';
    return auth;
  } catch (error) {
    state.authStore = `arquivo local: ${authDir}`;
    console.warn('Sessão Baileys no PostgreSQL indisponível. Usando arquivo local como fallback:', error.message);
    await fs.promises.mkdir(authDir, { recursive: true });
    return useMultiFileAuthState(authDir);
  }
}

function unwrapMessageContent(content) {
  let current = content || {};
  for (let i = 0; i < 5; i += 1) {
    if (current.ephemeralMessage?.message) {
      current = current.ephemeralMessage.message;
      continue;
    }
    if (current.viewOnceMessage?.message) {
      current = current.viewOnceMessage.message;
      continue;
    }
    if (current.viewOnceMessageV2?.message) {
      current = current.viewOnceMessageV2.message;
      continue;
    }
    if (current.documentWithCaptionMessage?.message) {
      current = current.documentWithCaptionMessage.message;
      continue;
    }
    break;
  }
  return current;
}

function getMessageBody(message) {
  const content = unwrapMessageContent(message?.message || {});
  const buttonText = content.buttonsResponseMessage?.selectedButtonId ||
    content.buttonsResponseMessage?.selectedDisplayText ||
    content.templateButtonReplyMessage?.selectedId ||
    content.interactiveResponseMessage?.body?.text ||
    '';

  return (
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    content.documentMessage?.caption ||
    content.buttonsResponseMessage?.selectedButtonId ||
    buttonText ||
    content.listResponseMessage?.singleSelectReply?.selectedRowId ||
    content.listResponseMessage?.title ||
    content.templateButtonReplyMessage?.selectedId ||
    ''
  );
}


function phoneDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

async function findUserForAdminCommand(target) {
  const digits = phoneDigits(target);
  if (!digits) return null;
  const variants = [digits];
  if (digits.length >= 10 && !digits.startsWith('55')) variants.push(`55${digits}`);
  if (digits.startsWith('55')) variants.push(digits.slice(2));
  const result = await db.query(
    `SELECT * FROM users
     WHERE regexp_replace(COALESCE(phone,''), '\\D', '', 'g') = ANY($1::text[])
        OR regexp_replace(COALESCE(whatsapp_jid,''), '\\D', '', 'g') = ANY($1::text[])
     ORDER BY last_interaction_at DESC
     LIMIT 1`,
    [variants]
  );
  return result.rows[0] || null;
}

async function setSupportStateFromPhone(sock, command, selfJid) {
  const match = String(command || '').trim().match(/^\/(suporte|atender|encerrar|finalizar)\s+([^\s]+)(?:\s+([\s\S]+))?$/i);
  if (!match) return false;

  const action = match[1].toLowerCase();
  const target = match[2];
  const optionalMessage = String(match[3] || '').trim();
  const user = await findUserForAdminCommand(target);

  if (!user?.whatsapp_jid) {
    await sock.sendMessage(selfJid, { text: `Contato não encontrado para: ${target}. Use o número com DDD, por exemplo /suporte 45999999999.` });
    return true;
  }

  if (['suporte', 'atender'].includes(action)) {
    await db.updateUser(user.id, {
      support_status: 'open',
      support_opened_at: new Date(),
      support_closed_at: null,
      support_last_message_at: new Date(),
      support_unread_count: 0,
      onboarding_step: 'support',
      lead_status: 'support'
    });
    await setChatArchived(user.whatsapp_jid, false);
    await sock.sendMessage(selfJid, { text: `✅ Suporte humano ativado para ${user.name || user.phone || target}. O chat foi desarquivado e o bot está pausado para esse contato.` });
    return true;
  }

  if (optionalMessage) {
    await sendText(user.whatsapp_jid, optionalMessage);
    await db.logMessage({ userId: user.id, whatsappJid: user.whatsapp_jid, direction: 'out', body: optionalMessage });
  }
  await db.updateUser(user.id, {
    support_status: 'closed',
    support_closed_at: new Date(),
    support_unread_count: 0,
    onboarding_step: 'main_menu',
    lead_status: user.payment_status === 'approved' ? 'customer' : 'engaged'
  });
  await setChatArchived(user.whatsapp_jid, true);
  await sock.sendMessage(selfJid, { text: `✅ Atendimento encerrado para ${user.name || user.phone || target}. O chat voltou para os arquivados e o bot foi liberado.` });
  return true;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function setChatArchived(jid, archived, lastMessage = null, options = {}) {
  if (!baileysSocket) return false;
  const target = normalizeToBaileysJid(jid);
  if (!target || target.endsWith('@g.us') || target === 'status@broadcast') return false;

  const recent = lastMessage || latestMessageByJid.get(target);
  const attempts = Math.max(1, Number(options.attempts || (archived ? 3 : 1)));
  const retryDelayMs = Math.max(150, Number(options.retryDelayMs || 700));

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const activeSocket = baileysSocket;
    if (!activeSocket) return false;

    const modification = archived
      ? { archive: true, ...(recent ? { lastMessages: [recent] } : {}) }
      : { archive: false };

    try {
      await activeSocket.chatModify(modification, target);
      if (attempt < attempts) await sleep(retryDelayMs);
    } catch (error) {
      if (attempt === attempts) {
        // Algumas versões exigem a última mensagem para arquivar. Não derruba o bot
        // caso o WhatsApp ainda não tenha sincronizado esse chat na sessão atual.
        console.warn(`[WhatsApp] Não foi possível ${archived ? 'arquivar' : 'desarquivar'} ${target}: ${error.message}`);
        return false;
      }
      await sleep(retryDelayMs);
    }
  }

  return true;
}

async function startBaileys() {
  const qrcode = require('qrcode');
  const baileys = require('@whiskeysockets/baileys');
  const {
    default: makeWASocket,
    DisconnectReason,
    fetchLatestBaileysVersion,
    useMultiFileAuthState
  } = baileys;

  const authDir = getBaileysAuthDir();
  const auth = await resolveBaileysAuthState(baileys, authDir);
  baileysSaveCreds = auth.saveCreds;

  const versionResult = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

  const sock = makeWASocket({
    version: versionResult.version,
    auth: auth.state,
    printQRInTerminal: false,
    browser: ['REIVILO Mentoria', 'Chrome', '1.0.0'],
    syncFullHistory: false,
    markOnlineOnConnect: boolEnv('WA_MARK_ONLINE', false),
    generateHighQualityLinkPreview: false,
    defaultQueryTimeoutMs: intEnv('WA_QUERY_TIMEOUT_MS', 120000),
    connectTimeoutMs: intEnv('WA_CONNECT_TIMEOUT_MS', 120000)
  });

  baileysSocket = sock;
  client = {
    engine: 'baileys',
    sendText: async (jid, text) => {
      const normalizedText = normalizeWhatsAppText(text);
      const target = normalizeToBaileysJid(jid);
      const timeoutMs = intEnv('WA_SEND_TIMEOUT_MS', 25000);

      try {
        const result = await withTimeout(
          sock.sendMessage(target, { text: normalizedText }),
          timeoutMs,
          `Timeout ao enviar resposta para ${target} depois de ${timeoutMs}ms`
        );

        latestMessageByJid.set(target, result);
        if (result?.key?.id) systemSentMessageIds.add(result.key.id);
        const user = await db.getUserByJid(target).catch(() => null);
        await setChatArchived(target, user?.support_status !== 'open', result);
        state.lastOutboundAt = new Date();
        state.lastOutboundTo = target;
        state.lastOutboundPreview = previewText(normalizedText);
        state.lastOutboundError = null;
        console.log(`[WhatsApp] Resposta enviada para ${target}: ${state.lastOutboundPreview}`);
        return result;
      } catch (error) {
        state.lastOutboundError = `${target}: ${error.message}`;
        console.error(`[WhatsApp] Falha ao enviar resposta para ${target}:`, error);
        throw error;
      }
    },
    setChatArchived: async (jid, archived, lastMessage) => setChatArchived(jid, archived, lastMessage),
    addParticipantToGroup: async (groupJid, participantJid) => {
      const group = String(groupJid || '').trim();
      if (!group.endsWith('@g.us')) throw new Error('REIVILO_GROUP_JID inválido. Ele deve terminar com @g.us.');
      const participant = normalizeToBaileysJid(participantJid);
      return withTimeout(
        sock.groupParticipantsUpdate(group, [participant], 'add'),
        intEnv('WA_SEND_TIMEOUT_MS', 25000),
        'Timeout ao adicionar participante ao grupo'
      );
    }
  };

  sock.ev.on('creds.update', baileysSaveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      state.qr = await qrcode.toDataURL(qr, { margin: 1, scale: 8 });
      state.lastQrAt = new Date();
      state.ready = false;
      state.status = 'Aguardando leitura do QR Code';
      state.lastError = null;
      console.log('[WhatsApp] QR Code gerado. Abra /admin/qr para escanear.');
    }

    if (connection === 'connecting') {
      state.status = state.qr ? 'Aguardando leitura do QR Code' : 'Conectando ao WhatsApp';
    }

    if (connection === 'open') {
      state.ready = true;
      state.qr = null;
      state.status = 'Conectado via Baileys';
      state.connectedAt = new Date();
      state.lastError = null;
      console.log('[WhatsApp] Conectado via Baileys. Bot pronto para responder.');
    }

    if (connection === 'close') {
      state.ready = false;
      const reason = lastDisconnect?.error ? new Boom(lastDisconnect.error)?.output?.statusCode : undefined;
      const shouldReconnect = reason !== DisconnectReason.loggedOut && boolEnv('WA_AUTO_RECONNECT', true);
      state.status = shouldReconnect ? 'Conexão caiu, tentando reconectar' : 'WhatsApp desconectado';
      state.lastError = lastDisconnect?.error?.message || null;
      console.warn('[WhatsApp] Conexão fechada:', state.lastError || reason || 'sem detalhe');
      baileysSocket = null;
      client = null;
      if (shouldReconnect) {
        setTimeout(() => startBotInBackground(), intEnv('WA_RECONNECT_DELAY_MS', 5000));
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    for (const msg of messages || []) {
      try {
        const from = msg.key?.remoteJid;
        const body = getMessageBody(msg);
        const fromMe = Boolean(msg.key?.fromMe);
        const phone = extractPhoneFromRawMessage(msg, from);
        const isGroup = String(from || '').endsWith('@g.us');
        const isStatus = String(from || '') === 'status@broadcast';

        if (!from || isGroup || isStatus) continue;
        latestMessageByJid.set(normalizeToBaileysJid(from), msg);

        if (fromMe) {
          const sentId = msg.key?.id;
          if (sentId && systemSentMessageIds.delete(sentId)) continue;

          const { jidNormalizedUser, areJidsSameUser } = baileys;
          const selfJid = jidNormalizedUser(sock.user?.id || '');
          const remote = jidNormalizedUser(from);
          const isSelfChat = Boolean(selfJid && remote && areJidsSameUser(selfJid, remote));

          if (isSelfChat && body) {
            const handled = await setSupportStateFromPhone(sock, body, remote);
            if (handled) continue;
          }

          // Mensagem digitada manualmente no celular para um cliente em suporte:
          // registra no painel e mantém o chat desarquivado, sem acionar o bot.
          const manualUser = await db.getUserByJid(from);
          if (manualUser?.support_status === 'open' && body) {
            await db.logMessage({ userId: manualUser.id, whatsappJid: from, direction: 'out', body, raw: msg });
            await db.updateUser(manualUser.id, { support_last_message_at: new Date(), support_unread_count: 0 });
            await setChatArchived(from, false, msg);
          }
          continue;
        }

        state.lastInboundAt = new Date();
        state.lastInboundFrom = from;
        state.lastInboundPreview = body ? String(body).slice(0, 80) : '[mensagem sem texto]';
        console.log(`[WhatsApp] Mensagem recebida (${type || 'sem tipo'}) de ${from}: ${state.lastInboundPreview}`);

        // O WhatsApp normalmente desarquiva um chat assim que chega uma mensagem.
        // Para as conversas automáticas, revertemos isso imediatamente, antes mesmo
        // de executar o fluxo do bot. Chats em suporte humano permanecem visíveis.
        const userBeforeFlow = await db.getUserByJid(from).catch(() => null);
        const supportWasOpen = userBeforeFlow?.support_status === 'open';
        await setChatArchived(from, !supportWasOpen, msg, {
          attempts: supportWasOpen ? 1 : 2,
          retryDelayMs: 350
        });

        const normalizedMessage = {
          from,
          phone,
          body,
          caption: body,
          isGroupMsg: false,
          fromMe: false,
          raw: msg
        };
        await handleIncomingMessage(client, normalizedMessage);

        // Reconsulta porque o próprio fluxo pode abrir o suporte humano. Se não
        // abriu, reforça o arquivamento após as respostas para vencer a atualização
        // tardia do aplicativo que costuma trazer o chat de volta à lista principal.
        const currentUser = await db.getUserByJid(from);
        const keepArchived = currentUser?.support_status !== 'open';
        await setChatArchived(from, keepArchived, msg, {
          attempts: keepArchived ? 3 : 1,
          retryDelayMs: 800
        });
      } catch (error) {
        console.error('Erro no fluxo do bot:', error);
      }
    }
  });

  state.status = 'Conectando ao WhatsApp';
  return client;
}

async function startBot(options = {}) {
  if (!state.enabled) {
    state.status = 'Desativado por ENABLE_WHATSAPP=false';
    return null;
  }
  if (client || baileysSocket) return client;
  if (starting && backgroundPromise) return backgroundPromise;

  starting = true;
  state.startedAt = new Date();
  state.launchAttempts += 1;
  state.engine = 'baileys';
  console.log('Motor WhatsApp selecionado: baileys-puro-sem-openwa');
  state.status = 'Iniciando WhatsApp (Baileys puro)';
  state.lastError = null;

  if (options.cleanSession || boolEnv('WA_CLEAN_SESSION_ON_START', false)) {
    await cleanSessionArtifacts();
  }

  backgroundPromise = (async () => {
    try {
      return await startBaileys();
    } catch (error) {
      state.ready = false;
      state.status = 'Erro ao iniciar WhatsApp';
      state.lastError = error.message;
      client = null;
      baileysSocket = null;
      console.error('Erro ao iniciar WhatsApp/Baileys:', error);

      if (boolEnv('WA_RETRY_CLEAN_SESSION', false) && state.launchAttempts < intEnv('WA_MAX_LAUNCH_ATTEMPTS', 2)) {
        state.status = 'Tentando novamente com sessão limpa';
        await cleanSessionArtifacts();
        starting = false;
        backgroundPromise = null;
        return startBot();
      }

      return null;
    } finally {
      starting = false;
      backgroundPromise = null;
    }
  })();

  return backgroundPromise;
}

function startBotInBackground(options = {}) {
  startBot(options).catch((error) => {
    state.ready = false;
    state.status = 'Erro ao iniciar WhatsApp';
    state.lastError = error.message;
    console.error('Falha ao iniciar bot em segundo plano:', error);
  });
}

function getBotClient() {
  return client;
}

function getBotState() {
  return {
    ...state,
    engine: 'baileys',
    authStore: state.authStore,
    starting,
    qrAvailable: Boolean(state.qr),
    uptimeSeconds: state.startedAt ? Math.round((Date.now() - new Date(state.startedAt).getTime()) / 1000) : 0
  };
}

async function sendText(to, text) {
  if (!client) throw new Error('Bot ainda não conectado. Abra /admin/qr e conecte o WhatsApp primeiro.');
  return client.sendText(normalizeToBaileysJid(to), text);
}

async function addParticipantToGroup(groupJid, whatsappJid, phone) {
  if (!client?.addParticipantToGroup) throw new Error('WhatsApp ainda não está conectado.');
  const target = phone ? `${String(phone).replace(/\D/g, '')}@s.whatsapp.net` : normalizeToBaileysJid(whatsappJid);
  if (!target || target.includes('@lid')) throw new Error('Número público do participante não está disponível para inclusão automática.');
  return client.addParticipantToGroup(groupJid, target);
}

module.exports = {
  startBot,
  startBotInBackground,
  stopBot,
  cleanSessionArtifacts,
  getBotClient,
  getBotState,
  sendText,
  setChatArchived,
  addParticipantToGroup
};
