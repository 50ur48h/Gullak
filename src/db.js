// Tiny JSON-file database. No native modules, so it runs anywhere (Windows, Render, Mac).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

const empty = () => ({
  users: {}, // telegramUserId -> { id, name, username, paypalEmail, earnedCents, chores }
  buddies: {}, // buddyId -> buddy
  bounties: {}, // bountyId -> bounty
  transactions: [], // ledger entries
  topups: {}, // paypal orderId -> { buddyId, cents, status, userId }
  proofHashes: {}, // sha256 / file_unique_id -> bountyId (duplicate detection)
  pending: {}, // per-user conversation state (e.g. buddy setup)
});

let state = empty();
let saveTimer = null;

export function load() {
  try {
    if (fs.existsSync(config.dataFile)) {
      state = { ...empty(), ...JSON.parse(fs.readFileSync(config.dataFile, 'utf8')) };
    }
  } catch (err) {
    console.error('[db] could not read data file, starting fresh:', err.message);
    state = empty();
  }
  return state;
}

export function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 200);
}

export function flush() {
  clearTimeout(saveTimer);
  fs.mkdirSync(path.dirname(config.dataFile), { recursive: true });
  const tmp = config.dataFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, config.dataFile);
}

export const db = () => state;
export const newId = (prefix) => `${prefix}_${crypto.randomBytes(5).toString('hex')}`;

export function upsertUser(from) {
  const id = String(from.id);
  const u = state.users[id] || { id, earnedCents: 0, chores: 0, paypalEmail: null };
  u.name = [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || 'Human';
  u.username = from.username || u.username || null;
  state.users[id] = u;
  save();
  return u;
}

export function addTransaction(tx) {
  const entry = { id: newId('tx'), at: new Date().toISOString(), ...tx };
  state.transactions.push(entry);
  save();
  return entry;
}

export function buddiesInChat(chatId) {
  return Object.values(state.buddies).filter((b) => String(b.chatId) === String(chatId));
}

export function findBuddy(chatId, nameOrId) {
  const list = buddiesInChat(chatId);
  if (!nameOrId) return list.length === 1 ? list[0] : null;
  const q = String(nameOrId).toLowerCase().replace(/^@/, '');
  return list.find((b) => b.id === q || b.name.toLowerCase() === q || b.name.toLowerCase().startsWith(q)) || null;
}

export function openBountyFor(buddyId) {
  return Object.values(state.bounties).find((b) => b.buddyId === buddyId && ['open', 'claimed', 'review'].includes(b.status));
}

export function activeClaimFor(userId, chatId) {
  return Object.values(state.bounties).find(
    (b) => b.status === 'claimed' && String(b.claimedBy) === String(userId) && String(b.chatId) === String(chatId),
  );
}

export const money = (cents) => `$${(cents / 100).toFixed(2)}`;
