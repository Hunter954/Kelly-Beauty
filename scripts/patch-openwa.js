const fs = require('fs');
const path = require('path');

function patchFile(filePath, replacements) {
  if (!fs.existsSync(filePath)) {
    console.warn(`[patch-openwa] Arquivo não encontrado: ${filePath}`);
    return;
  }

  let content = fs.readFileSync(filePath, 'utf8');
  let changed = false;

  for (const [from, to] of replacements) {
    if (content.includes(to)) continue;
    if (content.includes(from)) {
      content = content.replace(from, to);
      changed = true;
    } else {
      console.warn(`[patch-openwa] Trecho não encontrado em ${filePath}: ${from.slice(0, 90)}...`);
    }
  }

  if (changed) {
    fs.writeFileSync(filePath, content);
    console.log(`[patch-openwa] Patch aplicado em ${filePath}`);
  } else {
    console.log(`[patch-openwa] Nenhuma alteração necessária em ${filePath}`);
  }
}

const initializer = path.join(process.cwd(), 'node_modules', '@open-wa', 'wa-automate', 'dist', 'controllers', 'initializer.js');

patchFile(initializer, [
  [
    "yield waPage.waitForFunction('window.Debug!=undefined && window.Debug.VERSION!=undefined && require');",
    "yield waPage.waitForFunction('window.Debug!=undefined && window.Debug.VERSION!=undefined && require', { timeout: Number(process.env.WA_DEBUG_WAIT_TIMEOUT_MS || 120000), polling: 250 });"
  ]
]);
