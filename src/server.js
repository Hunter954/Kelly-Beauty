require('dotenv').config();
const http = require('http');
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const helmet = require('helmet');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const storage = require('./storage');
const { startReminderWorker } = require('./services/reminder-service');
storage.ensureStorageDirectories();
const { startBotInBackground, getBotState } = require('./bot');

const adminRoutes = require('./routes/admin');
const publicRoutes = require('./routes/public');
const webhookRoutes = require('./routes/webhooks');
const beautyAdminRoutes = require('./routes/beauty-admin');

const app = express();
const APP_VERSION = '3.0.0-kelly-beauty';

let migrationsReady = false;
let migrationsError = null;
let sessionStoreMode = 'memory';
let startupStarted = false;

function toBool(value, fallback = false) {
  if (typeof value === 'undefined') return fallback;
  return ['true', '1', 'yes', 'sim', 'on'].includes(String(value).toLowerCase());
}

function normalizePort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

function portsToListen() {
  const configured = normalizePort(process.env.PORT);
  return [configured || 3000];
}

function buildSessionConfig() {
  const config = {
    name: 'kelly_beauty_sid',
    secret: process.env.SESSION_SECRET || crypto.createHash('sha256').update(process.env.DATABASE_URL || process.env.POSTGRES_URL || 'kelly-beauty-local-session').digest('hex'),
    resave: false,
    saveUninitialized: false,
    proxy: true,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 8
    }
  };

  const wantsPgSession = toBool(process.env.USE_PG_SESSION, true) || String(process.env.SESSION_STORE || 'postgres').toLowerCase() === 'postgres';
  if (wantsPgSession) {
    try {
      config.store = new PgSession({
        pool: db.getSessionPool(),
        tableName: 'session',
        createTableIfMissing: true
      });
      sessionStoreMode = 'postgres';
    } catch (error) {
      sessionStoreMode = 'memory-fallback';
      console.warn('Sessão PostgreSQL indisponível. Usando sessão em memória para manter o app online:', error.message);
    }
  }

  return config;
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(helmet({ contentSecurityPolicy: false }));

// Rotas sem session e sem banco: precisam responder mesmo se tudo falhar.
app.get('/healthz', (req, res) => res.status(200).send('ok'));
app.get('/saude', (req, res) => {
  res.status(200).json({
    ok: true,
    service: 'Kelly Rodrigues Beauty Studio',
    version: APP_VERSION,
    whatsappEngine: getBotState().engine,
    whatsappStatus: getBotState().status,
    sessionStoreMode,
    database: db.getDatabaseStatus(),
    migrationsReady,
    migrationsError: migrationsError ? migrationsError.message : null,
    portEnv: process.env.PORT || null,
    listeningPorts: portsToListen(),
    time: new Date().toISOString()
  });
});

app.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    if (res.statusCode >= 400) {
      console.log(`${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - started}ms)`);
    }
  });
  next();
});

app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.json({ limit: '2mb' }));
app.use('/public', express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));
app.use('/uploads', express.static(storage.uploads, { maxAge: '1d', fallthrough: true }));

app.use(session(buildSessionConfig()));

app.use((req, res, next) => {
  res.locals.currentPath = req.path;
  res.locals.adminUser = req.session?.adminUser;
  res.locals.migrationsReady = migrationsReady;
  res.locals.migrationsError = migrationsError;
  res.locals.sessionStoreMode = sessionStoreMode;
  next();
});

app.use('/', publicRoutes);
app.use('/admin', beautyAdminRoutes);
app.use('/admin', adminRoutes);
app.use('/webhooks', webhookRoutes);

app.use((req, res) => {
  res.status(404).render('public/404');
});

app.use((error, req, res, next) => {
  console.error('Erro HTTP capturado:', error);
  res.status(500).send(process.env.NODE_ENV === 'production' ? 'Erro interno.' : `<pre>${error.stack}</pre>`);
});

async function runStartupTasks() {
  if (startupStarted) return;
  startupStarted = true;

  try {
    if (toBool(process.env.RUN_MIGRATIONS, true)) {
      await db.runMigrations();
    }
    migrationsReady = true;
    migrationsError = null;
    console.log('Migrations prontas.');
  } catch (error) {
    migrationsReady = false;
    migrationsError = error;
    console.error('Falha nas migrations, mas o servidor continuará online para evitar 502:', error.message);
  }

  startReminderWorker();

  const whatsappEnabled = toBool(process.env.ENABLE_WHATSAPP, true);
  const disableAutoStart = toBool(process.env.WA_DISABLE_AUTO_START, false);

  if (whatsappEnabled && !disableAutoStart) {
    const delayMs = Number(process.env.WA_BOOT_DELAY_MS || 3500);
    console.log(`WhatsApp será iniciado automaticamente em segundo plano em ${delayMs}ms.`);
    setTimeout(() => {
      try {
        startBotInBackground();
      } catch (error) {
        console.error('Falha ao iniciar WhatsApp em segundo plano:', error);
      }
    }, delayMs);
  } else {
    console.log('WhatsApp não iniciado automaticamente. Use /admin/qr para iniciar.');
  }
}

function listenOnPort(port, primary = false) {
  const server = http.createServer(app);
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.warn(`Porta ${port} já está em uso, ignorando listener extra.`);
      return;
    }
    console.error(`Erro ao abrir porta ${port}:`, error);
  });
  server.listen(port, '0.0.0.0', () => {
    console.log(`Kelly Beauty ouvindo em 0.0.0.0:${port}${primary ? ' (principal)' : ''}`);
    if (primary) {
      console.log('VERSÃO DO PROJETO: 3.0.0 KELLY BEAUTY');
      console.log(`Motor WhatsApp configurado: ${getBotState().engine}`);
      console.log(`Session store: ${sessionStoreMode}`);
      runStartupTasks();
    }
  });
  return server;
}

function bootstrap() {
  const ports = portsToListen();
  if (!ports.length) ports.push(3000);
  ports.forEach((port, index) => listenOnPort(port, index === 0));
}

process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection capturada:', error);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception capturada:', error);
});

bootstrap();
