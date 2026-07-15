const crypto = require('crypto');
const db = require('./db');

const defaults = {
  admin_user: 'admin',
  product_name: 'Mentoria REIVILO',
  price_brl: '997,00',
  site_url: 'https://www.reivilo.com.br',
  group_jid: '',
  group_invite_link: '',
  welcome_message: '',
  about_message: '',
  checkout_intro: '',
  support_message: ''
};

function envFallback(key) {
  const map = {
    admin_user: 'ADMIN_USER',
    product_name: 'REIVILO_PRODUCT_NAME',
    price_brl: 'REIVILO_PRICE_BRL',
    group_jid: 'REIVILO_GROUP_JID',
    group_invite_link: 'REIVILO_GROUP_INVITE_LINK'
  };
  return map[key] ? process.env[map[key]] : undefined;
}

async function get(key, fallback) {
  try {
    const result = await db.query('SELECT value FROM app_settings WHERE key=$1', [key]);
    if (result.rows[0] && result.rows[0].value !== null && result.rows[0].value !== '') return result.rows[0].value;
  } catch (error) {
    if (!/app_settings/i.test(error.message)) console.warn(`Config ${key}:`, error.message);
  }
  const env = envFallback(key);
  if (typeof env !== 'undefined' && env !== '') return env;
  return typeof fallback !== 'undefined' ? fallback : defaults[key];
}

async function getMany(keys) {
  const output = {};
  for (const key of keys) output[key] = await get(key);
  return output;
}

async function set(key, value, isSecret = false) {
  await db.query(
    `INSERT INTO app_settings(key,value,is_secret,updated_at) VALUES($1,$2,$3,NOW())
     ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,is_secret=EXCLUDED.is_secret,updated_at=NOW()`,
    [key, value == null ? '' : String(value), Boolean(isSecret)]
  );
}

async function setMany(values, secretKeys = []) {
  for (const [key, value] of Object.entries(values)) await set(key, value, secretKeys.includes(key));
}

async function isSetupComplete() {
  const hash = await get('admin_password_hash', '');
  return Boolean(hash);
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  try {
    const [salt, expected] = String(stored || '').split(':');
    if (!salt || !expected) return false;
    const actual = crypto.scryptSync(String(password), salt, 64);
    const expectedBuffer = Buffer.from(expected, 'hex');
    return actual.length === expectedBuffer.length && crypto.timingSafeEqual(actual, expectedBuffer);
  } catch (_) { return false; }
}

function publicBaseUrl() {
  const explicit = String(process.env.PUBLIC_BASE_URL || '').trim();
  if (explicit) return explicit.replace(/\/$/, '');
  const domain = String(process.env.RAILWAY_PUBLIC_DOMAIN || process.env.RAILWAY_STATIC_URL || '').trim();
  if (!domain) return '';
  return `${/^https?:\/\//i.test(domain) ? '' : 'https://'}${domain}`.replace(/\/$/, '');
}

module.exports = { defaults, get, getMany, set, setMany, isSetupComplete, hashPassword, verifyPassword, publicBaseUrl };
