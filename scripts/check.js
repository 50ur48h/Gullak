// `npm run check`: verifies your .env keys work before you start the bot.
import { config, missingConfig } from '../src/config.js';
import * as paypal from '../src/paypal.js';
import * as ai from '../src/ai.js';

const missing = missingConfig();
let ok = missing.length === 0;
if (missing.length) console.log(`❌ Missing in .env: ${missing.join(', ')}\n`);

const step = async (label, fn) => {
  const needs = { Telegram: 'TELEGRAM_BOT_TOKEN', PayPal: 'PAYPAL_CLIENT_ID', AI: 'META_API_KEY' };
  const key = Object.keys(needs).find((k) => label.startsWith(k));
  if (key && missing.some((m) => m.startsWith(needs[key].split('_')[0]))) {
    console.log(`⏭️  ${label}: skipped (key missing)`);
    return;
  }
  try {
    const detail = await fn();
    console.log(`✅ ${label}${detail ? `: ${detail}` : ''}`);
  } catch (err) {
    ok = false;
    console.log(`❌ ${label}: ${err.message}`);
  }
};

await step('Telegram bot token', async () => {
  const res = await fetch(`https://api.telegram.org/bot${config.telegramToken}/getMe`);
  const body = await res.json();
  if (!body.ok) throw new Error(body.description);
  return `@${body.result.username}`;
});
await step(`PayPal ${config.paypal.env} credentials`, async () => {
  await paypal.ping();
  return 'token received';
});
await ai.checkModel();
await step(`AI: ${ai.aiLabel()}`, async () => `replied "${(await ai.ping()).trim().slice(0, 30)}"`);

console.log(ok ? '\nAll good! Run: npm start' : '\nFix the ❌ items above, then run npm run check again.');
process.exit(ok ? 0 : 1);
