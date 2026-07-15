const fs = require('fs');
const path = require('path');

function resolveStorageRoot() {
  const configured = String(process.env.STORAGE_PATH || process.env.RAILWAY_VOLUME_MOUNT_PATH || '').trim();
  return configured ? path.resolve(configured) : path.join(process.cwd(), 'storage');
}

const root = resolveStorageRoot();
const uploads = path.join(root, 'uploads');
const whatsapp = path.join(root, 'whatsapp');

function ensureStorageDirectories() {
  for (const directory of [root, uploads, whatsapp]) fs.mkdirSync(directory, { recursive: true });
  return { root, uploads, whatsapp };
}

module.exports = { root, uploads, whatsapp, ensureStorageDirectories };
