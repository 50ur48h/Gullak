// Small web server: live "house economy" dashboard, PayPal return pages and webhook receiver.
import express from 'express';
import { config } from './config.js';
import { db, money, save } from './db.js';
import * as game from './game.js';
import * as paypal from './paypal.js';

const { esc } = game;

const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta http-equiv="refresh" content="15">
<style>
:root{--bg:#fbf7f2;--card:#fff;--ink:#1d1a16;--muted:#7a7066;--accent:#e2725b;--ok:#2f8f5b;--line:#eee4d8}
@media (prefers-color-scheme:dark){:root{--bg:#16130f;--card:#211d18;--ink:#f3ece3;--muted:#a69a8c;--line:#352f28}}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;background:var(--bg);color:var(--ink)}
main{max-width:980px;margin:0 auto;padding:24px 16px}h1{font-size:28px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 10px}
.muted{color:var(--muted)}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px}.big{font-size:26px;font-weight:700}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:14px;overflow:hidden}
td,th{padding:8px 10px;border-bottom:1px solid var(--line);text-align:left;font-size:14px}th{color:var(--muted);font-weight:600}
.pill{display:inline-block;padding:1px 8px;border-radius:99px;font-size:12px;background:var(--line)}.ok{color:var(--ok)}
.wrap{overflow-x:auto}
</style></head><body><main>${body}</main></body></html>`;

export function createServer() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => res.json({ ok: true }));

  app.get('/', (_req, res) => {
    const d = db();
    const buddies = Object.values(d.buddies);
    const rewards = d.transactions.filter((t) => t.type === 'reward');
    const paidOut = rewards.reduce((s, t) => s + t.cents, 0);
    const toppedUp = d.transactions.filter((t) => t.type === 'topup').reduce((s, t) => s + t.cents, 0);
    const people = Object.values(d.users).filter((u) => u.chores).sort((a, b) => b.earnedCents - a.earnedCents);

    const buddyCards = buddies
      .map(
        (b) => `<div class="card"><div class="big">${esc(b.emoji)} ${esc(b.name)}</div><div class="muted">${esc(b.kind)}${b.paused ? ' · paused' : ''}</div>
      <div style="margin-top:8px">Gullak: <b>${money(b.walletCents)}</b></div><div class="muted">Pays ${money(b.rewardCents)} to “${esc(b.task)}”</div>
      <div class="muted">Last done: ${b.lastDoneAt ? new Date(b.lastDoneAt).toLocaleString('en-GB', { timeZone: config.timezone }) : 'never'}</div></div>`,
      )
      .join('');

    const txRows = d.transactions
      .slice(-25)
      .reverse()
      .map((t) => {
        const b = d.buddies[t.buddyId];
        const u = d.users[t.userId];
        const flow = t.type === 'reward' ? `${esc(b?.emoji)} ${esc(b?.name)} → ${esc(u?.name)}` : t.type === 'topup' ? `${esc(u?.name)} → ${esc(b?.emoji)} ${esc(b?.name)}` : `House Bank → ${esc(b?.name)}`;
        return `<tr><td>${new Date(t.at).toLocaleString('en-GB', { timeZone: config.timezone })}</td><td><span class="pill">${esc(t.type)}</span></td><td>${flow}</td>
        <td><b>${money(t.cents)}</b></td><td class="${t.paypalStatus === 'SUCCESS' || t.paypalStatus === 'COMPLETED' ? 'ok' : ''}">${esc(t.paypalStatus || '')}</td>
        <td class="muted">${esc(t.reason || '')}${t.confidence != null ? ` (${Math.round(t.confidence * 100)}%)` : ''}</td></tr>`;
      })
      .join('');

    res.send(
      page(
        'Gullak',
        `<h1>🐷 Gullak</h1><div class="muted">Plants, pets and things with PayPal wallets, paying humans to look after them. Auto-refreshes.</div>
      <h2>House economy</h2><div class="grid">
        <div class="card"><div class="muted">Paid to humans</div><div class="big">${money(paidOut)}</div><div class="muted">${rewards.length} verified chores</div></div>
        <div class="card"><div class="muted">Topped up by owners</div><div class="big">${money(toppedUp)}</div></div>
        <div class="card"><div class="muted">Buddies</div><div class="big">${buddies.length}</div></div>
        <div class="card"><div class="muted">Top earner</div><div class="big">${people[0] ? esc(people[0].name) : '—'}</div><div class="muted">${people[0] ? money(people[0].earnedCents) : ''}</div></div>
      </div>
      <h2>Buddies</h2><div class="grid">${buddyCards || '<div class="muted">None yet: send /demo or /newbuddy to the bot.</div>'}</div>
      <h2>PayPal ledger</h2><div class="wrap"><table><tr><th>When</th><th>Type</th><th>Flow</th><th>Amount</th><th>PayPal</th><th>AI evidence</th></tr>${txRows || '<tr><td colspan="6" class="muted">No transactions yet</td></tr>'}</table></div>`,
      ),
    );
  });

  // PayPal redirects here after the payer approves (only when PUBLIC_URL is set).
  app.get('/paypal/return', async (req, res) => {
    const orderId = String(req.query.token || '');
    let msg = 'Payment approved. You can go back to Telegram.';
    try {
      if (db().topups[orderId]) msg = (await game.completeTopup(orderId)).message;
    } catch (err) {
      msg = `Something went wrong: ${err.message}`;
    }
    res.send(page('Gullak · PayPal', `<h1>🐷 ${esc(msg)}</h1><p><a href="https://t.me/${esc(game.getBotUsername())}">Back to Telegram</a></p>`));
  });
  app.get('/paypal/cancel', (_req, res) => res.send(page('Gullak', '<h1>Payment cancelled</h1><p>No money moved.</p>')));

  // PayPal webhooks: order approved / capture completed / payout item updates.
  app.post('/paypal/webhook', async (req, res) => {
    const event = req.body || {};
    try {
      const valid = await paypal.verifyWebhook(req.headers, event);
      if (!valid) return res.status(400).send('invalid signature');
      const type = event.event_type || '';
      if (type === 'CHECKOUT.ORDER.APPROVED') {
        const orderId = event.resource?.id;
        if (orderId && db().topups[orderId]) await game.completeTopup(orderId);
      } else if (type.startsWith('PAYMENT.PAYOUTS-ITEM.')) {
        const batchId = event.resource?.payout_batch_id;
        const tx = db().transactions.find((t) => t.paypalRef === batchId);
        if (tx) {
          tx.paypalStatus = event.resource?.transaction_status || type.split('.').pop();
          save();
        }
      }
      res.sendStatus(200);
    } catch (err) {
      console.error('[webhook]', err);
      res.sendStatus(500);
    }
  });

  return app;
}
