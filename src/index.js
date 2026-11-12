import { config, missingConfig } from './config.js';
import { load, flush } from './db.js';
import { createBot } from './bot.js';
import { createServer } from './server.js';
import { startScheduler } from './scheduler.js';
import { attachApi, resumePendingPayouts } from './game.js';
import { checkModel, aiLabel } from './ai.js';

const missing = missingConfig();
if (missing.length) {
  console.error(`\n❌ Missing settings in .env: ${missing.join(', ')}\n   Copy .env.example to .env and fill them in.\n`);
  process.exit(1);
}

load();
await checkModel();
const bot = createBot();
const me = await bot.api.getMe();
attachApi(bot.api, me.username);

await bot.api.setMyCommands([
  { command: 'demo', description: 'Try it now with Hydro the Water Bottle' },
  { command: 'link', description: 'Link your PayPal email for rewards' },
  { command: 'newbuddy', description: 'Create a buddy from a photo' },
  { command: 'buddies', description: 'List buddies and their wallets' },
  { command: 'topup', description: 'Add money to a buddy via PayPal' },
  { command: 'feednow', description: 'Owner: serve the next fixed meal early' },
  { command: 'leaderboard', description: 'Who earned the most' },
  { command: 'history', description: 'Recent payments' },
  { command: 'me', description: 'Your earnings' },
  { command: 'status', description: 'Check PayPal + AI connections' },
  { command: 'help', description: 'How Gullak works' },
]);

createServer().listen(config.port, () => {
  console.log(`🌐 Dashboard: ${config.publicUrl || `http://localhost:${config.port}`}`);
});
startScheduler();
const resumed = resumePendingPayouts();
if (resumed) console.log(`🔁 Re-checking ${resumed} pending PayPal payout(s)`);

const shutdown = () => {
  flush();
  bot.stop();
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

console.log(`🐷 Gullak is running as @${me.username} (PayPal: ${config.paypal.env}, AI: ${aiLabel()}, demo mode: ${config.demoMode})`);
bot.start({ drop_pending_updates: true, allowed_updates: ['message', 'callback_query'] });
