// Core game logic: bounties, claims, proof checking, payouts, top-ups.
import crypto from 'node:crypto';
import { InlineKeyboard } from 'grammy';
import { config } from './config.js';
import { db, save, newId, addTransaction, openBountyFor, money } from './db.js';
import * as paypal from './paypal.js';
import * as ai from './ai.js';
import { randomChallenge, challengeById } from './challenges.js';

let api = null; // grammY Api instance, set at startup
let botUsername = 'GullakBot';
export function attachApi(a, username) {
  api = a;
  if (username) botUsername = username;
}
export const getBotUsername = () => botUsername;

export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const HTML = { parse_mode: 'HTML' };
const say = (buddy, text) => `${buddy.emoji} <b>${esc(buddy.name)}:</b> ${esc(text)}`;
const mention = (u) => (u?.username ? `@${esc(u.username)}` : `<b>${esc(u?.name || 'someone')}</b>`);

function rememberMessage(messageId, chatId, buddyId) {
  const d = db();
  d.msgMap = d.msgMap || {};
  d.msgMap[`${chatId}:${messageId}`] = buddyId;
  save();
}
export function buddyForMessage(chatId, messageId) {
  const id = db().msgMap?.[`${chatId}:${messageId}`];
  return id ? db().buddies[id] : null;
}

// ------------------------------------------------------------------ buddies

export function createBuddy({ chatId, ownerId, design, refPhotoIds = [], walletCents = 0 }) {
  const id = newId('b');
  const buddy = {
    id,
    chatId: String(chatId),
    ownerId: String(ownerId),
    name: design.name,
    kind: design.kind,
    emoji: design.emoji || '🐷',
    personality: design.personality,
    task: design.task,
    proof: design.proof,
    rewardCents: design.rewardCents,
    cooldownHours: design.cooldownHours,
    awakeStart: design.awakeStart,
    awakeEnd: design.awakeEnd,
    appearance: design.appearance,
    refPhotoIds,
    walletCents,
    paused: false,
    createdAt: new Date().toISOString(),
    lastDoneAt: null,
    lastBrokeNoticeAt: null,
  };
  db().buddies[id] = buddy;
  save();
  return buddy;
}

export function hoursSince(iso) {
  return iso ? (Date.now() - new Date(iso).getTime()) / 3_600_000 : null;
}

export function cooldownLeftMs(buddy) {
  if (!buddy.lastDoneAt) return 0;
  const cooldownMs = config.demoMode ? Math.min(buddy.cooldownHours * 3_600_000, 2 * 60_000) : buddy.cooldownHours * 3_600_000;
  return Math.max(0, new Date(buddy.lastDoneAt).getTime() + cooldownMs - Date.now());
}

export function isAwake(buddy, date = new Date()) {
  if (config.demoMode) return true;
  const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: config.timezone }).format(date)) % 24;
  return hour >= buddy.awakeStart && hour < buddy.awakeEnd;
}

// ------------------------------------------------------------------ bounties

function bountyKeyboard(bounty) {
  return new InlineKeyboard().text('🙋 I’ll do it!', `claim:${bounty.id}`);
}

function rulesLine(bounty, challenge) {
  return (
    `\n\n💰 <b>${money(bounty.rewardCents)}</b> via PayPal\n` +
    `📸 Proof: a round video message (best) or photo showing the job done <b>and</b> you ${esc(challenge.text)}.\n` +
    `⏱ Tap the button to claim it. You’ll have ${config.claimMinutes} min.`
  );
}

/** Post a new bounty for a buddy. Returns the bounty, or a reason string if it couldn't. */
export async function postBounty(buddy, { force = false } = {}) {
  if (openBountyFor(buddy.id)) return 'already-open';
  if (!force && cooldownLeftMs(buddy) > 0) return 'cooldown';
  if (buddy.walletCents < buddy.rewardCents) {
    await brokeNotice(buddy, force);
    return 'broke';
  }
  const challenge = randomChallenge();
  const bounty = {
    id: newId('q'),
    buddyId: buddy.id,
    chatId: buddy.chatId,
    status: 'open',
    rewardCents: buddy.rewardCents,
    challengeId: challenge.id,
    createdAt: new Date().toISOString(),
    claimedBy: null,
    claimExpiresAt: null,
    attempts: 0,
    lastFeedback: null,
    proofs: [],
    bumped: false,
  };
  db().bounties[bounty.id] = bounty;
  save();
  const text = await ai.bountyMessage(buddy, { rewardCents: bounty.rewardCents, challenge, hoursSinceLast: hoursSince(buddy.lastDoneAt) });
  const msg = await api.sendMessage(buddy.chatId, say(buddy, text) + rulesLine(bounty, challenge), { ...HTML, reply_markup: bountyKeyboard(bounty) });
  bounty.messageId = msg.message_id;
  rememberMessage(msg.message_id, buddy.chatId, buddy.id);
  save();
  return bounty;
}

async function brokeNotice(buddy, force) {
  const since = hoursSince(buddy.lastBrokeNoticeAt);
  const gapH = config.demoMode ? 0.15 : 6;
  if (!force && since !== null && since < gapH) return;
  buddy.lastBrokeNoticeAt = new Date().toISOString();
  save();
  const kb = new InlineKeyboard().text('💳 Top up $5', `topup:${buddy.id}:500`).text('💳 $10', `topup:${buddy.id}:1000`).text('💳 $20', `topup:${buddy.id}:2000`);
  const msg = await api.sendMessage(
    buddy.chatId,
    say(buddy, `I need someone to ${buddy.task}, but my Gullak only has ${money(buddy.walletCents)} and the reward is ${money(buddy.rewardCents)}. Can my owner top me up?`),
    { ...HTML, reply_markup: kb },
  );
  rememberMessage(msg.message_id, buddy.chatId, buddy.id);
}

export async function claim(bountyId, user) {
  const bounty = db().bounties[bountyId];
  if (!bounty) return { ok: false, alert: 'This bounty no longer exists.' };
  const buddy = db().buddies[bounty.buddyId];
  if (bounty.status === 'claimed' && bounty.claimedBy === user.id) return { ok: false, alert: 'It’s yours already! Send your proof.' };
  if (bounty.status !== 'open') return { ok: false, alert: 'Too slow, someone already claimed it 😅' };
  if (!user.paypalEmail) return { ok: false, alert: 'Link your PayPal first! Send me a DM: /link your-paypal@email.com' };
  bounty.status = 'claimed';
  bounty.claimedBy = user.id;
  bounty.claimedAt = new Date().toISOString();
  bounty.claimExpiresAt = new Date(Date.now() + config.claimMinutes * 60_000).toISOString();
  save();
  const challenge = challengeById(bounty.challengeId);
  if (bounty.messageId) {
    await api
      .editMessageReplyMarkup(bounty.chatId, bounty.messageId, { reply_markup: new InlineKeyboard().text(`🔒 Claimed by ${user.name}`, 'noop') })
      .catch(() => {});
  }
  await api.sendMessage(
    bounty.chatId,
    `🔒 ${mention(user)} claimed ${buddy.emoji} <b>${esc(buddy.name)}</b>’s bounty!\n` +
      `Do the job (<i>${esc(buddy.task)}</i>), then send a <b>round video message</b> or photo here while you ${esc(challenge.text)}. ` +
      `You have ${config.claimMinutes} minutes.`,
    HTML,
  );
  return { ok: true, toast: `It’s yours! Remember: ${challenge.text}` };
}

export async function expireClaims() {
  const now = Date.now();
  for (const bounty of Object.values(db().bounties)) {
    if (bounty.status === 'claimed' && bounty.claimExpiresAt && new Date(bounty.claimExpiresAt).getTime() < now) {
      const buddy = db().buddies[bounty.buddyId];
      const user = db().users[bounty.claimedBy];
      bounty.status = 'open';
      bounty.claimedBy = null;
      bounty.claimExpiresAt = null;
      bounty.attempts = 0;
      save();
      if (bounty.messageId) await api.editMessageReplyMarkup(bounty.chatId, bounty.messageId, { reply_markup: bountyKeyboard(bounty) }).catch(() => {});
      await api.sendMessage(bounty.chatId, say(buddy, `${user?.name || 'Someone'} ghosted me. The ${money(bounty.rewardCents)} bounty is open again!`), HTML).catch(() => {});
    }
  }
}

/** If a bounty sits unclaimed for a while, the buddy raises the reward ("surge pricing"). */
export async function surgeStaleBounties() {
  const staleH = config.demoMode ? 0.1 : 4;
  for (const bounty of Object.values(db().bounties)) {
    if (bounty.status !== 'open' || bounty.bumped) continue;
    if (hoursSince(bounty.createdAt) < staleH) continue;
    const buddy = db().buddies[bounty.buddyId];
    const newReward = Math.round((bounty.rewardCents * 1.5) / 5) * 5;
    if (buddy.walletCents < newReward) continue;
    bounty.rewardCents = newReward;
    bounty.bumped = true;
    save();
    const msg = await api
      .sendMessage(bounty.chatId, say(buddy, `Fine. FINE. I’m raising it to ${money(newReward)}. Someone please ${buddy.task}!`), {
        ...HTML,
        reply_markup: bountyKeyboard(bounty),
      })
      .catch(() => null);
    if (msg) {
      rememberMessage(msg.message_id, bounty.chatId, buddy.id);
      bounty.messageId = msg.message_id;
      save();
    }
  }
}

// ------------------------------------------------------------------ proof checking

const refCache = new Map();
async function downloadTelegramFile(fileId) {
  const file = await api.getFile(fileId);
  if (!file.file_path) throw new Error('Telegram did not return a file path');
  if (file.file_size && file.file_size > 20 * 1024 * 1024) throw new Error('File too big (max 20 MB)');
  const res = await fetch(`https://api.telegram.org/file/bot${config.telegramToken}/${file.file_path}`);
  if (!res.ok) throw new Error(`Telegram download failed (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}
async function referencePhotos(buddy) {
  const out = [];
  for (const id of (buddy.refPhotoIds || []).slice(0, 3)) {
    if (!refCache.has(id)) refCache.set(id, await downloadTelegramFile(id).catch(() => null));
    if (refCache.get(id)) out.push(refCache.get(id));
  }
  return out;
}

/**
 * Handle a proof photo/video from a user who has (or can auto-claim) a bounty.
 * media: { kind: 'image' | 'video', fileId, fileUniqueId, mime, live: boolean }
 */
export async function handleProof(ctx, user, media) {
  const d = db();
  const chatId = String(ctx.chat.id);
  let bounty = Object.values(d.bounties).find((b) => b.status === 'claimed' && b.claimedBy === user.id && b.chatId === chatId);

  if (!bounty) {
    // Convenience: if exactly one open bounty here, sending proof claims it.
    const open = Object.values(d.bounties).filter((b) => b.status === 'open' && b.chatId === chatId);
    if (open.length !== 1) {
      if (ctx.chat.type === 'private' && open.length === 0) await ctx.reply('No open bounty here right now. Try /buddies or /demo.');
      return;
    }
    const res = await claim(open[0].id, user);
    if (!res.ok) {
      await ctx.reply(res.alert);
      return;
    }
    bounty = open[0];
  }

  const buddy = d.buddies[bounty.buddyId];
  const challenge = challengeById(bounty.challengeId);

  // Duplicate detection (same Telegram file or same bytes = reused proof).
  if (d.proofHashes[media.fileUniqueId]) {
    await ctx.reply(say(buddy, 'I’ve seen this exact one before. Nice try 😏 Send a fresh one.'), { ...HTML, reply_parameters: { message_id: ctx.msg.message_id } });
    return;
  }

  const status = await ctx.reply(`🔍 ${buddy.emoji} ${esc(buddy.name)} is inspecting your proof…`, { ...HTML, reply_parameters: { message_id: ctx.msg.message_id } });
  await ctx.replyWithChatAction(media.kind === 'video' ? 'record_video_note' : 'typing').catch(() => {});

  let buffer;
  try {
    buffer = await downloadTelegramFile(media.fileId);
  } catch (err) {
    await api.editMessageText(chatId, status.message_id, `⚠️ Couldn’t download that: ${esc(err.message)}`, HTML).catch(() => {});
    return;
  }
  const sha = crypto.createHash('sha256').update(buffer).digest('hex');
  if (d.proofHashes[sha]) {
    await api.editMessageText(chatId, status.message_id, say(buddy, 'That’s a re-upload of an old proof. I wasn’t born yesterday.'), HTML).catch(() => {});
    return;
  }
  d.proofHashes[media.fileUniqueId] = bounty.id;
  d.proofHashes[sha] = bounty.id;
  bounty.attempts += 1;
  save();

  let verdict;
  try {
    verdict = await ai.verifyProof({
      buddy,
      bounty,
      challenge,
      media: { kind: media.kind, buffer, mime: media.mime },
      referencePhotos: await referencePhotos(buddy),
      attempt: bounty.attempts,
      previousFeedback: bounty.lastFeedback,
    });
  } catch (err) {
    console.error('[game] AI verification error:', err);
    bounty.attempts -= 1;
    save();
    await api.editMessageText(chatId, status.message_id, `⚠️ My AI brain hiccuped (${esc(err.message.slice(0, 150))}). Please send the proof again.`, HTML).catch(() => {});
    return;
  }

  // Photos are slightly less trustworthy than live round videos.
  if (!media.live) verdict.confidence = Math.min(verdict.confidence, media.kind === 'image' ? 0.9 : 0.95);

  bounty.proofs.push({ kind: media.kind, fileId: media.fileId, live: media.live, at: new Date().toISOString(), verdict });
  save();

  const checks =
    `${verdict.identityMatch ? '✅' : '❌'} it’s really ${esc(buddy.name)}   ` +
    `${verdict.taskDone ? '✅' : '❌'} job done   ` +
    `${verdict.challengeDone ? '✅' : '❌'} ${esc(challenge.text)}\n` +
    `<i>AI saw: ${esc(verdict.observed)}</i> · confidence ${(verdict.confidence * 100).toFixed(0)}%`;

  if (verdict.confidence >= config.approveThreshold) {
    await api.editMessageText(chatId, status.message_id, `${say(buddy, verdict.reply)}\n\n${checks}`, HTML).catch(() => {});
    await payBounty(bounty, user, verdict);
    return;
  }

  if (bounty.attempts >= config.maxAttempts) {
    bounty.status = 'review';
    save();
    await api.editMessageText(chatId, status.message_id, `${say(buddy, verdict.reply)}\n\n${checks}`, HTML).catch(() => {});
    const owner = d.users[buddy.ownerId];
    const kb = new InlineKeyboard().text('✅ Approve & pay', `review:${bounty.id}:yes`).text('❌ Reject', `review:${bounty.id}:no`);
    await api.sendMessage(
      chatId,
      `🧑‍⚖️ ${mention(owner)}, the AI isn’t sure after ${bounty.attempts} tries. You’re ${esc(buddy.name)}’s owner, so you decide: did ${mention(user)} really ${esc(buddy.task)}?`,
      { ...HTML, reply_markup: kb },
    );
    return;
  }

  bounty.lastFeedback = verdict.missing || `show the job being done while you ${challenge.text}`;
  save();
  const left = config.maxAttempts - bounty.attempts;
  const prefix = verdict.confidence < config.followUpThreshold ? '🤨' : '🤔';
  await api
    .editMessageText(
      chatId,
      status.message_id,
      `${say(buddy, verdict.reply)}\n\n${checks}\n\n${prefix} <b>Follow-up:</b> ${esc(bounty.lastFeedback)}\n(${left} ${left === 1 ? 'try' : 'tries'} left, send another proof)`,
      HTML,
    )
    .catch(() => {});
}

export async function ownerReview(bountyId, deciderId, approve) {
  const bounty = db().bounties[bountyId];
  if (!bounty || bounty.status !== 'review') return { ok: false, alert: 'Already decided.' };
  const buddy = db().buddies[bounty.buddyId];
  if (String(deciderId) !== buddy.ownerId) return { ok: false, alert: `Only ${buddy.name}’s owner can decide.` };
  const user = db().users[bounty.claimedBy];
  if (approve) {
    await api.sendMessage(bounty.chatId, say(buddy, `My owner vouched for you, ${user.name}. Paying up.`), HTML);
    await payBounty(bounty, user, { observed: 'Approved by owner', confidence: 1 });
  } else {
    bounty.status = 'open';
    bounty.claimedBy = null;
    bounty.attempts = 0;
    bounty.lastFeedback = null;
    bounty.challengeId = randomChallenge(bounty.challengeId).id;
    save();
    const ch = challengeById(bounty.challengeId);
    await api.sendMessage(bounty.chatId, say(buddy, `Owner says no. Bounty’s open again, and the new gesture is: ${ch.text}.`), {
      ...HTML,
      reply_markup: bountyKeyboard(bounty),
    });
  }
  return { ok: true, toast: approve ? 'Approved' : 'Rejected' };
}

// ------------------------------------------------------------------ payouts

export async function payBounty(bounty, user, verdict) {
  const d = db();
  const buddy = d.buddies[bounty.buddyId];
  if (buddy.walletCents < bounty.rewardCents) {
    bounty.status = 'payout_failed';
    save();
    await api.sendMessage(bounty.chatId, say(buddy, `Oh no, my wallet is short (${money(buddy.walletCents)}). Owner, /topup ${buddy.name} please!`), HTML);
    return;
  }
  // Reserve the money first so we can never double-spend.
  buddy.walletCents -= bounty.rewardCents;
  bounty.status = 'paying';
  save();
  try {
    const note = `${buddy.emoji} ${buddy.name} says thanks for: ${buddy.task}`;
    const payout = await paypal.sendPayout({ email: user.paypalEmail, cents: bounty.rewardCents, note, itemId: bounty.id });
    bounty.status = 'paid';
    bounty.paidAt = new Date().toISOString();
    bounty.payout = payout;
    buddy.lastDoneAt = bounty.paidAt;
    user.earnedCents = (user.earnedCents || 0) + bounty.rewardCents;
    user.chores = (user.chores || 0) + 1;
    const tx = addTransaction({
      type: 'reward',
      chatId: bounty.chatId,
      buddyId: buddy.id,
      userId: user.id,
      cents: bounty.rewardCents,
      paypalRef: payout.batchId,
      paypalStatus: payout.status,
      reason: verdict?.observed || '',
      confidence: verdict?.confidence ?? null,
    });
    save();
    const msg = await api.sendMessage(
      bounty.chatId,
      `💸 <b>${money(bounty.rewardCents)}</b> sent to ${mention(user)} via PayPal\n` +
        `Batch <code>${esc(payout.batchId)}</code> · ${esc(payout.status)}\n` +
        `${buddy.emoji} ${esc(buddy.name)}’s Gullak: ${money(buddy.walletCents)} left`,
      HTML,
    );
    // Check back with PayPal for the final status.
    setTimeout(() => confirmPayout(tx.id, bounty.chatId, msg.message_id).catch(() => {}), 15_000);
  } catch (err) {
    console.error('[game] payout failed:', err);
    buddy.walletCents += bounty.rewardCents; // refund the reservation
    bounty.status = 'payout_failed';
    bounty.payoutError = err.message;
    save();
    await api.sendMessage(
      bounty.chatId,
      `⚠️ PayPal payout failed: <code>${esc(err.message.slice(0, 300))}</code>\nThe money is still in ${esc(buddy.name)}’s wallet.`,
      { ...HTML, reply_markup: new InlineKeyboard().text('🔁 Retry payout', `retry:${bounty.id}`) },
    );
  }
}

async function confirmPayout(txId, chatId, messageId, tries = 0) {
  const tx = db().transactions.find((t) => t.id === txId);
  if (!tx?.paypalRef) return;
  const info = await paypal.getPayout(tx.paypalRef);
  const done = FINAL_PAYOUT_STATUSES.includes(info.itemStatus);
  if (!done && tries < 6) {
    setTimeout(() => confirmPayout(txId, chatId, messageId, tries + 1).catch(() => {}), 20_000);
    return;
  }
  tx.paypalStatus = info.itemStatus || info.batchStatus;
  tx.paypalTransactionId = info.transactionId;
  save();
  const icon = info.itemStatus === 'SUCCESS' ? '✅' : info.itemStatus === 'UNCLAIMED' ? '📨' : '⏳';
  const what = messageId ? 'payout' : `${money(tx.cents)} payout (batch <code>${esc(tx.paypalRef)}</code>)`;
  await api.sendMessage(chatId, `${icon} PayPal confirms ${what}: <b>${esc(tx.paypalStatus)}</b>${info.transactionId ? ` · txn <code>${esc(info.transactionId)}</code>` : ''}`, {
    ...HTML,
    ...(messageId ? { reply_parameters: { message_id: messageId } } : {}),
  });
}

const FINAL_PAYOUT_STATUSES = ['SUCCESS', 'UNCLAIMED', 'FAILED', 'RETURNED', 'BLOCKED', 'REFUNDED'];

/** On startup, re-check payouts that were still pending when the bot last stopped. */
export function resumePendingPayouts() {
  const pending = db().transactions.filter((t) => t.type === 'reward' && t.paypalRef && !FINAL_PAYOUT_STATUSES.includes(t.paypalStatus));
  for (const tx of pending) confirmPayout(tx.id, tx.chatId, null).catch((err) => console.error('[game] payout re-check failed:', err.message));
  return pending.length;
}

export async function retryPayout(bountyId) {
  const bounty = db().bounties[bountyId];
  if (!bounty || bounty.status !== 'payout_failed') return { ok: false, alert: 'Nothing to retry.' };
  const user = db().users[bounty.claimedBy];
  await payBounty(bounty, user, { observed: 'retry', confidence: null });
  return { ok: true, toast: 'Retrying…' };
}

// ------------------------------------------------------------------ top-ups (money in)

export async function startTopup(buddy, cents, user) {
  const returnUrl = config.publicUrl ? `${config.publicUrl}/paypal/return` : `https://t.me/${botUsername}`;
  const cancelUrl = config.publicUrl ? `${config.publicUrl}/paypal/cancel` : `https://t.me/${botUsername}`;
  const order = await paypal.createTopupOrder({ cents, buddyName: buddy.name, buddyId: buddy.id, returnUrl, cancelUrl });
  db().topups[order.orderId] = { buddyId: buddy.id, cents, status: 'created', userId: user.id, chatId: buddy.chatId, createdAt: new Date().toISOString() };
  save();
  const kb = new InlineKeyboard().url(`💳 Pay ${money(cents)} with PayPal`, order.approveUrl).row().text('✅ I’ve paid', `paid:${order.orderId}`);
  return { order, keyboard: kb };
}

/** Capture an approved order and credit the buddy. Safe to call many times (webhook + button + return page). */
export async function completeTopup(orderId) {
  const t = db().topups[orderId];
  if (!t) return { ok: false, message: 'Unknown order.' };
  if (t.status === 'completed') return { ok: true, already: true, message: 'Already added to the wallet ✅' };
  if (t.status === 'capturing') return { ok: false, message: 'Processing, one sec…' };
  const order = await paypal.getOrder(orderId);
  if (order.status === 'CREATED' || order.status === 'PAYER_ACTION_REQUIRED') return { ok: false, message: 'PayPal says you haven’t approved the payment yet. Tap “Pay with PayPal” first.' };
  t.status = 'capturing';
  save();
  try {
    let captureId = null;
    if (order.status !== 'COMPLETED') {
      const cap = await paypal.captureOrder(orderId);
      if (cap.status !== 'COMPLETED') throw new Error(`capture status ${cap.status}`);
      captureId = cap.captureId;
    }
    const buddy = db().buddies[t.buddyId];
    buddy.walletCents += t.cents;
    t.status = 'completed';
    t.captureId = captureId;
    addTransaction({ type: 'topup', chatId: t.chatId, buddyId: buddy.id, userId: t.userId, cents: t.cents, paypalRef: orderId, paypalStatus: 'COMPLETED' });
    save();
    await api.sendMessage(t.chatId, say(buddy, `My Gullak just got ${money(t.cents)} richer! Balance: ${money(buddy.walletCents)}. Thank you, boss.`), HTML).catch(() => {});
    return { ok: true, message: `Added ${money(t.cents)} to ${buddy.name}’s wallet ✅` };
  } catch (err) {
    t.status = 'created';
    save();
    throw err;
  }
}
