// Telegram bot: commands, buttons and media handling.
import { Bot, InlineKeyboard } from 'grammy';
import { config } from './config.js';
import { db, save, upsertUser, buddiesInChat, findBuddy, openBountyFor, money, addTransaction } from './db.js';
import * as game from './game.js';
import * as ai from './ai.js';
import * as paypal from './paypal.js';

const HTML = { parse_mode: 'HTML' };
const { esc } = game;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const HELP = `🐷 <b>Gullak</b>: your plants, pets and things get a PayPal wallet and pay humans to look after them.

<b>Get paid</b>
/link <i>email</i> · link the PayPal account that receives rewards
/me · your earnings
Tap <b>🙋 I’ll do it!</b> on a bounty, do the job, then send a <b>round video message</b> (or photo) doing the hand gesture it asks for.

<b>Buddies</b>
/newbuddy · create a buddy from a photo + description (AI designs it)
/buddies · list buddies here
/topup <i>name amount</i> · add money to a buddy’s wallet with PayPal
/bounty <i>name</i> · (owner) post a bounty right now
/feednow <i>name</i> · (owner) serve the next fixed meal early
/pause <i>name</i> · /resume <i>name</i>

<b>House</b>
/leaderboard · who earned the most
/history · recent payments
/demo · try it now with Hydro the Water Bottle 💧
/status · check PayPal + AI connections`;

export function createBot() {
  const bot = new Bot(config.telegramToken);

  // Keep a user record for everyone we see.
  bot.use(async (ctx, next) => {
    if (ctx.from && !ctx.from.is_bot) ctx.user = upsertUser(ctx.from);
    await next();
  });

  bot.command(['start', 'help'], async (ctx) => {
    await ctx.reply(HELP, HTML);
    if (ctx.chat.type === 'private' && !ctx.user.paypalEmail) {
      await ctx.reply('First step: link the PayPal account where rewards should go:\n<code>/link you@example.com</code>\n(For testing, use a PayPal <b>sandbox personal</b> account email.)', HTML);
    }
  });

  bot.command('link', async (ctx) => {
    const email = ctx.match.trim();
    if (!EMAIL_RE.test(email)) return ctx.reply('Usage: <code>/link you@example.com</code>', HTML);
    ctx.user.paypalEmail = email;
    save();
    if (ctx.chat.type !== 'private') await ctx.deleteMessage().catch(() => {}); // hide the email in groups if we can
    await ctx.reply(`✅ ${esc(ctx.user.name)}, rewards will be sent to your PayPal (${esc(email.replace(/(.{2}).*(@.*)/, '$1•••$2'))}).`, HTML);
  });

  bot.command('me', async (ctx) => {
    const u = ctx.user;
    await ctx.reply(
      `👤 <b>${esc(u.name)}</b>\nPayPal: ${u.paypalEmail ? esc(u.paypalEmail) : 'not linked (/link)'}\nChores: ${u.chores || 0}\nEarned: <b>${money(u.earnedCents || 0)}</b>`,
      HTML,
    );
  });

  // ---------------------------------------------------------------- buddy creation
  bot.command('newbuddy', async (ctx) => {
    db().pending[ctx.user.id] = { type: 'newbuddy', chatId: String(ctx.chat.id) };
    save();
    await ctx.reply(
      '📸 Send me a <b>photo</b> of your plant / pet / thing, with a caption describing it.\n\n' +
        'Example: <i>“Fernanda, my dramatic fern. Needs water every 3 days. $0.50 per watering.”</i>\n' +
        'Or <i>“Mochi the cat, sassy, feed her at 8am and 7pm, $1”</i>',
      HTML,
    );
  });

  bot.command('addphoto', async (ctx) => {
    const buddy = findBuddy(ctx.chat.id, ctx.match.trim());
    if (!buddy) return ctx.reply('Usage: /addphoto <i>buddy name</i>', HTML);
    if (buddy.ownerId !== ctx.user.id) return ctx.reply('Only the owner can add reference photos.');
    db().pending[ctx.user.id] = { type: 'addphoto', buddyId: buddy.id, chatId: String(ctx.chat.id) };
    save();
    await ctx.reply(`Send another clear photo of ${esc(buddy.name)} from a different angle. It helps the AI catch fakes.`, HTML);
  });

  bot.command('demo', async (ctx) => {
    let hydro = buddiesInChat(ctx.chat.id).find((b) => b.kind === 'water bottle' && b.demo);
    if (!hydro) {
      hydro = game.createBuddy({
        chatId: ctx.chat.id,
        ownerId: ctx.user.id,
        walletCents: 500,
        design: {
          name: 'Hydro',
          kind: 'water bottle',
          emoji: '💧',
          personality: 'an over-caffeinated hydration coach who is personally offended when humans forget to drink water',
          task: 'drink a glass of water',
          proof: 'the human actually drinking water from a glass, cup or bottle on camera',
          rewardCents: 25,
          cooldownHours: 0.05,
          awakeStart: 0,
          awakeEnd: 24,
          appearance: 'any water bottle, glass or cup of water (Hydro is a spirit that lives in all of them)',
        },
      });
      hydro.demo = true;
      addTransaction({ type: 'sponsor', chatId: hydro.chatId, buddyId: hydro.id, userId: ctx.user.id, cents: 500, reason: 'Demo credit from the Gullak House Bank' });
      save();
      await ctx.reply('💧 Meet <b>Hydro the Water Bottle</b>. It has $5.00 of demo money from the Gullak House Bank and pays $0.25 every time you drink water on camera.', HTML);
    }
    if (!ctx.user.paypalEmail) await ctx.reply('Before claiming, link your PayPal sandbox email: <code>/link you@example.com</code>', HTML);
    const r = await game.postBounty(hydro, { force: true });
    if (r === 'already-open') {
      const open = openBountyFor(hydro.id);
      const minsLeft = open?.claimExpiresAt ? Math.max(1, Math.ceil((new Date(open.claimExpiresAt) - Date.now()) / 60000)) : null;
      if (open?.status === 'claimed' && open.claimedBy === ctx.user.id) {
        await ctx.reply(`💧 You already claimed Hydro’s bounty. Send your proof now (${minsLeft} min left).`);
      } else if (open?.status === 'claimed') {
        await ctx.reply(`💧 ${db().users[open.claimedBy]?.name || 'Someone'} is on Hydro’s bounty (${minsLeft} min left). If they don’t finish, it reopens.`);
      } else {
        await ctx.reply('Hydro already has an open bounty above ☝️ Claim it!');
      }
    }
  });

  bot.command('buddies', async (ctx) => {
    const list = buddiesInChat(ctx.chat.id);
    if (!list.length) return ctx.reply('No buddies here yet. Create one with /newbuddy or try /demo.');
    const lines = list.map((b) => {
      const open = openBountyFor(b.id);
      const cd = game.cooldownLeftMs(b);
      let state;
      if (b.paused) state = '⏸ paused';
      else if (open) state = `🔔 bounty ${open.status}`;
      else if (game.hasMeals(b)) state = `🍽 next meal ~${game.nextMeal(b)?.time || '?'}`;
      else state = cd > 0 ? `😴 content for ${Math.ceil(cd / 60000)} min` : '👀 might ask for help soon';
      const mealsLine = game.hasMeals(b) ? `\n   Meals: ${b.mealTimes.join(', ')} (±15 min)` : '';
      return `${b.emoji} <b>${esc(b.name)}</b> (${esc(b.kind)})\n   Gullak: <b>${money(b.walletCents)}</b> · pays ${money(b.rewardCents)} to “${esc(b.task)}” · ${state}${mealsLine}`;
    });
    await ctx.reply(lines.join('\n\n'), HTML);
  });
  bot.command('wallet', async (ctx) => {
    const list = buddiesInChat(ctx.chat.id);
    if (!list.length) return ctx.reply('No buddies here yet.');
    await ctx.reply(list.map((b) => `${b.emoji} ${esc(b.name)}: <b>${money(b.walletCents)}</b>`).join('\n'), HTML);
  });

  bot.command('bounty', async (ctx) => {
    const buddy = findBuddy(ctx.chat.id, ctx.match.trim());
    if (!buddy) return ctx.reply('Which buddy? <code>/bounty name</code>', HTML);
    if (buddy.ownerId !== ctx.user.id && !buddy.demo) return ctx.reply(`Only ${esc(buddy.name)}’s owner can summon a bounty.`, HTML);
    const r = await game.postBounty(buddy, { force: true });
    if (r === 'already-open') await ctx.reply(`${esc(buddy.name)} already has an open bounty.`, HTML);
  });

  bot.command('feednow', async (ctx) => {
    const buddy = findBuddy(ctx.chat.id, ctx.match.trim());
    if (!buddy) return ctx.reply('Which buddy? <code>/feednow name</code>', HTML);
    if (buddy.ownerId !== ctx.user.id) return ctx.reply(`Only ${esc(buddy.name)}’s owner can serve a meal early.`, HTML);
    if (!game.hasMeals(buddy)) return ctx.reply(`${esc(buddy.name)} has no fixed meal times. Use /bounty ${esc(buddy.name)} instead.`, HTML);
    const { result } = await game.feedNow(buddy);
    if (result === 'already-open') return ctx.reply(`${esc(buddy.name)} already has an open bounty.`, HTML);
    // On success the bounty itself is the reply; 'broke' already posted a top-up notice.
  });

  for (const [cmd, paused] of [['pause', true], ['resume', false]]) {
    bot.command(cmd, async (ctx) => {
      const buddy = findBuddy(ctx.chat.id, ctx.match.trim());
      if (!buddy) return ctx.reply(`Usage: /${cmd} <i>name</i>`, HTML);
      if (buddy.ownerId !== ctx.user.id) return ctx.reply('Only the owner can do that.');
      buddy.paused = paused;
      save();
      await ctx.reply(`${buddy.emoji} ${esc(buddy.name)} is ${paused ? 'paused ⏸ (no bounties)' : 'back on duty ▶️'}`, HTML);
    });
  }

  bot.command('topup', async (ctx) => {
    const parts = ctx.match.trim().split(/\s+/).filter(Boolean);
    let amount = parts.length && /^\$?\d+(\.\d+)?$/.test(parts.at(-1)) ? parts.pop() : null;
    const buddy = findBuddy(ctx.chat.id, parts.join(' '));
    if (!buddy) return ctx.reply('Usage: <code>/topup name 10</code>', HTML);
    if (!amount) {
      const kb = new InlineKeyboard().text('$5', `topup:${buddy.id}:500`).text('$10', `topup:${buddy.id}:1000`).text('$20', `topup:${buddy.id}:2000`);
      return ctx.reply(`How much for ${buddy.emoji} ${esc(buddy.name)}?`, { ...HTML, reply_markup: kb });
    }
    const cents = Math.round(parseFloat(amount.replace('$', '')) * 100);
    if (!(cents >= 100 && cents <= 50000)) return ctx.reply('Top-ups must be between $1 and $500.');
    await sendTopup(ctx, buddy, cents);
  });

  async function sendTopup(ctx, buddy, cents) {
    try {
      const { keyboard } = await game.startTopup(buddy, cents, ctx.user);
      await ctx.reply(`💳 Top up ${buddy.emoji} <b>${esc(buddy.name)}</b>’s Gullak with <b>${money(cents)}</b>.\n1. Pay with PayPal (sandbox personal account)\n2. Come back and tap “I’ve paid”`, {
        ...HTML,
        reply_markup: keyboard,
      });
    } catch (err) {
      console.error(err);
      await ctx.reply(`⚠️ PayPal error: <code>${esc(err.message.slice(0, 300))}</code>`, HTML);
    }
  }

  bot.command('leaderboard', async (ctx) => {
    const chatId = String(ctx.chat.id);
    const totals = {};
    for (const t of db().transactions) {
      if (t.type !== 'reward' || t.chatId !== chatId) continue;
      totals[t.userId] = totals[t.userId] || { cents: 0, chores: 0 };
      totals[t.userId].cents += t.cents;
      totals[t.userId].chores += 1;
    }
    const rows = Object.entries(totals).sort((a, b) => b[1].cents - a[1].cents);
    if (!rows.length) return ctx.reply('No chores done yet. Somebody water something! 🪴');
    const medals = ['🥇', '🥈', '🥉'];
    await ctx.reply(
      '🏆 <b>Leaderboard</b>\n' + rows.map(([uid, t], i) => `${medals[i] || '▫️'} ${esc(db().users[uid]?.name || uid)}: ${t.chores} chores · <b>${money(t.cents)}</b>`).join('\n'),
      HTML,
    );
  });

  bot.command('history', async (ctx) => {
    const chatId = String(ctx.chat.id);
    const txs = db().transactions.filter((t) => t.chatId === chatId).slice(-10).reverse();
    if (!txs.length) return ctx.reply('No payments yet.');
    const line = (t) => {
      const b = db().buddies[t.buddyId];
      const u = db().users[t.userId];
      if (t.type === 'reward') return `💸 ${b?.emoji} ${esc(b?.name)} → ${esc(u?.name)} ${money(t.cents)} <i>(${esc(t.paypalStatus || '')})</i>`;
      if (t.type === 'topup') return `💳 ${esc(u?.name)} → ${b?.emoji} ${esc(b?.name)} ${money(t.cents)}`;
      return `🎁 ${b?.emoji} ${esc(b?.name)} +${money(t.cents)} (${esc(t.reason || t.type)})`;
    };
    await ctx.reply('🧾 <b>Recent payments</b>\n' + txs.map(line).join('\n'), HTML);
  });

  bot.command('status', async (ctx) => {
    const lines = [];
    try {
      await paypal.ping();
      lines.push(`✅ PayPal ${config.paypal.env} connected`);
    } catch (e) {
      lines.push(`❌ PayPal: ${esc(e.message.slice(0, 200))}`);
    }
    try {
      const r = await ai.ping();
      lines.push(`✅ Meta AI (${esc(config.meta.model)}) replied: ${esc(r.slice(0, 40))}`);
    } catch (e) {
      lines.push(`❌ Meta AI: ${esc(e.message.slice(0, 200))}`);
    }
    lines.push(`Demo mode: ${config.demoMode ? 'on (fast bounties)' : 'off'}`);
    await ctx.reply(lines.join('\n'), HTML);
  });

  // ---------------------------------------------------------------- buttons
  bot.callbackQuery('noop', (ctx) => ctx.answerCallbackQuery());

  bot.callbackQuery(/^claim:(.+)$/, async (ctx) => {
    const res = await game.claim(ctx.match[1], ctx.user);
    await ctx.answerCallbackQuery({ text: res.ok ? res.toast : res.alert, show_alert: !res.ok });
  });

  bot.callbackQuery(/^review:(.+):(yes|no)$/, async (ctx) => {
    const res = await game.ownerReview(ctx.match[1], ctx.user.id, ctx.match[2] === 'yes');
    await ctx.answerCallbackQuery({ text: res.ok ? res.toast : res.alert, show_alert: !res.ok });
    if (res.ok) await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  });

  bot.callbackQuery(/^retry:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await game.retryPayout(ctx.match[1]);
  });

  bot.callbackQuery(/^topup:(.+):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const buddy = db().buddies[ctx.match[1]];
    if (buddy) await sendTopup(ctx, buddy, Number(ctx.match[2]));
  });

  bot.callbackQuery(/^paid:(.+)$/, async (ctx) => {
    try {
      const res = await game.completeTopup(ctx.match[1]);
      await ctx.answerCallbackQuery({ text: res.message, show_alert: !res.ok });
      if (res.ok) await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    } catch (err) {
      console.error(err);
      await ctx.answerCallbackQuery({ text: `PayPal error: ${err.message.slice(0, 180)}`, show_alert: true });
    }
  });

  bot.callbackQuery(/^nb:(ok|redo|cancel)$/, async (ctx) => {
    const p = db().pending[ctx.user.id];
    await ctx.answerCallbackQuery();
    if (!p || p.type !== 'confirm-buddy') return;
    if (ctx.match[1] === 'cancel') {
      delete db().pending[ctx.user.id];
      save();
      return ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    }
    if (ctx.match[1] === 'redo') {
      db().pending[ctx.user.id] = { type: 'newbuddy', chatId: p.chatId };
      save();
      return ctx.reply('OK, send the photo again with a different description.');
    }
    const buddy = game.createBuddy({ chatId: p.chatId, ownerId: ctx.user.id, design: p.design, refPhotoIds: [p.photoId] });
    delete db().pending[ctx.user.id];
    save();
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    const kb = new InlineKeyboard().text('💳 $5', `topup:${buddy.id}:500`).text('💳 $10', `topup:${buddy.id}:1000`).text('💳 $20', `topup:${buddy.id}:2000`);
    await ctx.reply(
      `${buddy.emoji} <b>${esc(buddy.name)}</b> is alive! Its Gullak is empty, so fill it up so it can pay people.\nTip: /addphoto ${esc(buddy.name)} to add more reference photos.`,
      { ...HTML, reply_markup: kb },
    );
  });

  // ---------------------------------------------------------------- media
  bot.on('message:photo', async (ctx) => {
    const photo = ctx.msg.photo.at(-1);
    const p = db().pending[ctx.user.id];
    if (p && p.chatId === String(ctx.chat.id) && p.type === 'newbuddy') return designFromPhoto(ctx, photo.file_id);
    if (p && p.chatId === String(ctx.chat.id) && p.type === 'addphoto') {
      const buddy = db().buddies[p.buddyId];
      buddy.refPhotoIds = [...(buddy.refPhotoIds || []), photo.file_id].slice(-3);
      delete db().pending[ctx.user.id];
      save();
      return ctx.reply(`📸 Got it, ${esc(buddy.name)} now has ${buddy.refPhotoIds.length} reference photo(s).`, HTML);
    }
    await game.handleProof(ctx, ctx.user, { kind: 'image', fileId: photo.file_id, fileUniqueId: photo.file_unique_id, mime: 'image/jpeg', live: false });
  });

  bot.on('message:video_note', async (ctx) => {
    const v = ctx.msg.video_note;
    await game.handleProof(ctx, ctx.user, { kind: 'video', fileId: v.file_id, fileUniqueId: v.file_unique_id, mime: 'video/mp4', live: true });
  });

  bot.on('message:video', async (ctx) => {
    const v = ctx.msg.video;
    if (v.mime_type && v.mime_type !== 'video/mp4') return ctx.reply('Please send an mp4 video, or better, a round video message.');
    await game.handleProof(ctx, ctx.user, { kind: 'video', fileId: v.file_id, fileUniqueId: v.file_unique_id, mime: 'video/mp4', live: false });
  });

  // Talk to a buddy by replying to one of its messages.
  bot.on('message:text', async (ctx) => {
    const reply = ctx.msg.reply_to_message;
    if (!reply) return;
    const buddy = game.buddyForMessage(ctx.chat.id, reply.message_id);
    if (!buddy) return;
    await ctx.replyWithChatAction('typing').catch(() => {});
    const text = await ai.buddyChat(buddy, { userName: ctx.user.name, text: ctx.msg.text.slice(0, 500), walletCents: buddy.walletCents });
    const msg = await ctx.reply(`${buddy.emoji} <b>${esc(buddy.name)}:</b> ${esc(text)}`, { ...HTML, reply_parameters: { message_id: ctx.msg.message_id } });
    db().msgMap[`${ctx.chat.id}:${msg.message_id}`] = buddy.id;
    save();
  });

  async function designFromPhoto(ctx, photoId) {
    const status = await ctx.reply('🧠 Designing your buddy…');
    try {
      const file = await ctx.api.getFile(photoId);
      const res = await fetch(`https://api.telegram.org/file/bot${config.telegramToken}/${file.file_path}`);
      const photo = Buffer.from(await res.arrayBuffer());
      const design = await ai.designBuddy({ photo, caption: ctx.msg.caption || '' });
      db().pending[ctx.user.id] = { type: 'confirm-buddy', chatId: String(ctx.chat.id), design, photoId };
      save();
      const kb = new InlineKeyboard().text('✅ Create', 'nb:ok').text('🔁 Redo', 'nb:redo').text('❌ Cancel', 'nb:cancel');
      await ctx.api.editMessageText(
        ctx.chat.id,
        status.message_id,
        `${design.emoji} <b>${esc(design.name)}</b> the ${esc(design.kind)}\n` +
          `🎭 ${esc(design.personality)}\n` +
          `🧹 Chore: ${esc(design.task)} · pays <b>${money(design.rewardCents)}</b>\n` +
          `📸 Proof: ${esc(design.proof)}\n` +
          (design.mealTimes?.length
            ? `🍽 Meals at ${design.mealTimes.join(', ')} (${esc(config.timezone)}), each posted at a random moment within ±15 min\n`
            : `⏳ At most once every ${design.cooldownHours}h, between ${design.awakeStart}:00 and ${design.awakeEnd}:00\n`) +
          `👀 Recognised by: ${esc(design.appearance)}`,
        { ...HTML, reply_markup: kb },
      );
    } catch (err) {
      console.error(err);
      await ctx.api.editMessageText(ctx.chat.id, status.message_id, `⚠️ AI error: ${esc(err.message.slice(0, 200))}. Try again.`, HTML).catch(() => {});
    }
  }

  bot.catch((err) => console.error('[bot] error:', err.error || err));
  return bot;
}
