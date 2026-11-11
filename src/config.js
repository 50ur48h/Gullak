import fs from 'node:fs';
import path from 'node:path';

// Load .env without extra dependencies. Existing environment variables win.
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined || process.env[key] === '') process.env[key] = value;
  }
}
loadEnvFile(path.resolve(process.cwd(), '.env'));

// Accept a few common spellings so an existing .env "just works".
function pick(...names) {
  for (const n of names) {
    const v = process.env[n];
    if (v !== undefined && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

const bool = (v, d = false) => (v === '' ? d : /^(1|true|yes|on)$/i.test(v));

export const config = {
  telegramToken: pick('TELEGRAM_BOT_TOKEN', 'TELEGRAM_TOKEN', 'BOT_TOKEN', 'TG_BOT_TOKEN'),
  paypal: {
    clientId: pick('PAYPAL_CLIENT_ID', 'PAYPAL_CLIENTID', 'PAYPAL_ID', 'CLIENT_ID'),
    clientSecret: pick('PAYPAL_CLIENT_SECRET', 'PAYPAL_SECRET', 'PAYPAL_SECRET_KEY', 'CLIENT_SECRET', 'SECRET'),
    env: (pick('PAYPAL_ENV', 'PAYPAL_MODE') || 'sandbox').toLowerCase(),
    webhookId: pick('PAYPAL_WEBHOOK_ID'),
  },
  meta: {
    apiKey: pick('META_API_KEY', 'MODEL_API_KEY', 'META_MODEL_API_KEY', 'MUSE_API_KEY', 'META_KEY'),
    baseURL: pick('META_BASE_URL') || 'https://api.meta.ai/v1',
    model: pick('META_MODEL') || 'muse-spark-1.3',
  },
  publicUrl: pick('PUBLIC_URL', 'RENDER_EXTERNAL_URL').replace(/\/$/, ''),
  timezone: pick('TZ', 'TIMEZONE') || 'Asia/Singapore',
  demoMode: bool(pick('DEMO_MODE'), true),
  port: Number(pick('PORT') || 3000),
  dataFile: pick('DATA_FILE') || path.resolve(process.cwd(), 'data', 'db.json'),

  // Game rules
  claimMinutes: 15, // how long a claimed bounty stays reserved
  maxAttempts: 3, // proof attempts before the owner is asked to decide
  approveThreshold: 0.75, // AI confidence needed to pay automatically
  followUpThreshold: 0.4, // below this it's a rejection, between = follow-up question
};

config.paypal.apiBase = config.paypal.env === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';

export function missingConfig() {
  const missing = [];
  if (!config.telegramToken) missing.push('TELEGRAM_BOT_TOKEN');
  if (!config.paypal.clientId) missing.push('PAYPAL_CLIENT_ID');
  if (!config.paypal.clientSecret) missing.push('PAYPAL_CLIENT_SECRET');
  if (!config.meta.apiKey) missing.push('META_API_KEY');
  return missing;
}
