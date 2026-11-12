// All AI calls go to Meta's Model API (Muse Spark), using the OpenAI-compatible Responses API.
import OpenAI, { toFile } from 'openai';
import { config } from './config.js';
import { normalizeMealTimes } from './meals.js';

const client = new OpenAI({ apiKey: config.meta.apiKey || 'missing', baseURL: config.meta.baseURL });

/**
 * Startup check: make sure the configured model is one this API key can use.
 * If it isn't but the default is, switch to the default so a mistyped META_MODEL doesn't break the bot.
 */
export async function checkModel() {
  const fallback = 'muse-spark-1.3';
  let ids;
  try {
    ids = (await client.models.list()).data.map((m) => m.id);
  } catch (e) {
    console.warn(`⚠️ Could not list Meta models (${e.status || ''} ${e.message}). Check META_API_KEY / META_BASE_URL.`);
    return;
  }
  if (ids.includes(config.meta.model)) return;
  console.warn(`⚠️ Model "${config.meta.model}" is not available to this META_API_KEY. Available: ${ids.join(', ') || '(none)'}`);
  if (config.meta.model !== fallback && ids.includes(fallback)) {
    console.warn(`   Falling back to ${fallback}. Remove or fix the META_MODEL variable to silence this.`);
    config.meta.model = fallback;
  }
}

// Meta sometimes answers 404 model_not_found for a model it lists (seen intermittently from Railway's servers).
// Retry once, then fall back to the other Muse Spark versions this key can use.
const FALLBACK_MODELS = ['muse-spark-1.3', 'muse-spark-1.2', 'muse-spark-1.1'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function respond(params) {
  const models = [config.meta.model, ...FALLBACK_MODELS.filter((m) => m !== config.meta.model)];
  let lastErr;
  for (const model of models) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        return await client.responses.create({ ...params, model });
      } catch (err) {
        if (err.status !== 404 || (err.code && err.code !== 'model_not_found')) throw err;
        lastErr = err;
        console.warn(`[ai] ${model}: 404 model_not_found (attempt ${attempt}), retrying`);
        await sleep(1000 * attempt);
      }
    }
  }
  throw lastErr;
}

const dataUrl = (buffer, mime) => `data:${mime};base64,${buffer.toString('base64')}`;

// Muse Spark is a reasoning model: reasoning tokens count against max_output_tokens,
// so a small cap can end the response before any text is produced.
function textOf(response) {
  if (typeof response.output_text === 'string' && response.output_text) return response.output_text;
  const parts = [];
  for (const item of response.output || []) {
    for (const c of item.content || []) if (c.text) parts.push(c.text);
  }
  const text = parts.join('\n');
  if (!text && response.status === 'incomplete') {
    throw new Error(`AI response incomplete (${response.incomplete_details?.reason || 'unknown'}) before any text was produced`);
  }
  return text;
}

export function extractJson(text) {
  if (!text) throw new Error('empty AI response');
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start !== -1 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error(`AI did not return JSON: ${text.slice(0, 200)}`);
  }
}

/** Ask the model for JSON matching a schema. Falls back to plain prompting if structured output is refused. */
// effort: 'minimal' | 'low' | 'medium' | 'high' (undefined = model default). Lower = faster replies.
async function askJson({ system, content, schemaName, schema, maxTokens = 6000, effort }) {
  const input = [
    { role: 'system', content: system },
    { type: 'message', role: 'user', content },
  ];
  const reasoning = effort ? { reasoning: { effort } } : {};
  try {
    const res = await respond({
      input,
      max_output_tokens: maxTokens,
      ...reasoning,
      text: { format: { type: 'json_schema', name: schemaName, schema, strict: false } },
    });
    return extractJson(textOf(res));
  } catch (err) {
    if (err.status && (err.status >= 500 || err.status === 404)) throw err;
    console.warn(`[ai] ${schemaName}: structured output failed (${err.message}); retrying with plain JSON prompt`);
    // Retry without structured output, asking for raw JSON instead.
    const res = await respond({
      input: [
        { role: 'system', content: `${system}\n\nReply with ONLY a JSON object matching this JSON Schema, no prose:\n${JSON.stringify(schema)}` },
        { type: 'message', role: 'user', content },
      ],
      max_output_tokens: maxTokens,
      ...reasoning,
    });
    return extractJson(textOf(res));
  }
}

const personaLine = (b) =>
  `You are ${b.name}, a ${b.kind} (${b.emoji}) who lives in a shared home and owns a little PayPal wallet called a Gullak. ` +
  `Personality: ${b.personality}. You pay humans small amounts of real money to look after you. ` +
  `Speak in first person, in character, short (1-3 sentences), funny, never mean. Use at most 2 emojis.`;

// ---------------------------------------------------------------- buddy setup

const buddySchema = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Short name for the buddy. Use the one given, else invent a fun one.' },
    kind: { type: 'string', description: 'What it is: e.g. fern, cat, dog, bike, fridge, water bottle' },
    emoji: { type: 'string', description: 'One emoji representing it' },
    personality: { type: 'string', description: 'A vivid one-sentence personality' },
    task: { type: 'string', description: 'The chore humans do for it, as an imperative, e.g. "water me"' },
    proof: { type: 'string', description: 'What the proof photo/video must show for the chore to count' },
    rewardCents: { type: 'integer', description: 'Reward per chore in US cents (25-300)' },
    cooldownHours: { type: 'number', description: 'Minimum hours between chores so it is never over-fed or over-watered' },
    awakeStart: { type: 'integer', description: 'Hour of day (0-23) bounties may start' },
    awakeEnd: { type: 'integer', description: 'Hour of day (1-24) bounties stop' },
    mealTimes: {
      type: 'array',
      items: { type: 'string' },
      description: 'Fixed feeding times the user explicitly mentioned, as 24h "HH:MM" (e.g. ["08:00","19:00"]). Empty array if none were mentioned. Never invent times.',
    },
    appearance: { type: 'string', description: 'Distinctive visual details to recognise this exact buddy later' },
  },
  required: ['name', 'kind', 'emoji', 'personality', 'task', 'proof', 'rewardCents', 'cooldownHours', 'awakeStart', 'awakeEnd', 'appearance'],
};

export async function designBuddy({ photo, caption }) {
  const content = [
    {
      type: 'input_text',
      text:
        `A user wants to give this plant/pet/object a Gullak wallet. Their description: "${caption || '(none)'}".\n` +
        'Design the buddy. Pick a SAFE cooldown for living things (plants: usually 48-96h for watering; ' +
        'pets: feeding at most every 8-12h; play/walks 3-6h). Respect any numbers the user gave. ' +
        'If the user names specific feeding/meal times (e.g. "feed her at 8am and 7pm", "meals 8, 1 and 7pm"), ' +
        'put them in mealTimes as 24h HH:MM and make the task about feeding; otherwise mealTimes must be []. ' +
        'Describe its appearance precisely (colour, pot, markings, shape) so it can be recognised in later photos.',
    },
  ];
  if (photo) content.push({ type: 'input_image', image_url: dataUrl(photo, 'image/jpeg') });
  const b = await askJson({
    system: 'You design playful characters for a chores-for-cash Telegram game. Be practical about animal and plant welfare.',
    content,
    schemaName: 'buddy',
    schema: buddySchema,
  });
  b.rewardCents = Math.max(10, Math.min(1000, Math.round(Number(b.rewardCents) || 50)));
  b.cooldownHours = Math.max(0.5, Number(b.cooldownHours) || 24);
  b.awakeStart = Math.min(23, Math.max(0, Number(b.awakeStart) || 8));
  b.awakeEnd = Math.min(24, Math.max(b.awakeStart + 1, Number(b.awakeEnd) || 22));
  b.mealTimes = normalizeMealTimes(b.mealTimes);
  return b;
}

// ---------------------------------------------------------------- bounty text

export async function bountyMessage(buddy, { rewardCents, challenge, hoursSinceLast, mealTime }) {
  const timing = mealTime
    ? `It's your ${mealTime} mealtime and your tummy runs on a strict schedule. `
    : `It has been ${hoursSinceLast == null ? 'a long time' : `${hoursSinceLast.toFixed(1)} hours`} since someone did it. `;
  try {
    const out = await askJson({
      system: personaLine(buddy),
      content: [
        {
          type: 'input_text',
          text:
            `Post a bounty in the house group chat. You need: "${buddy.task}". ` +
            timing +
            `Reward: $${(rewardCents / 100).toFixed(2)}. Don't explain the rules, the bot adds them.`,
        },
      ],
      schemaName: 'bounty',
      schema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
      maxTokens: 3000,
      effort: 'low',
    });
    if (out.message) return out.message;
  } catch (err) {
    console.warn('[ai] bountyMessage fallback:', err.message);
  }
  return `HUMANS. I need you to ${buddy.task}. $${(rewardCents / 100).toFixed(2)} to whoever does it first. ${buddy.emoji}`;
}

// ---------------------------------------------------------------- proof check

const verdictSchema = {
  type: 'object',
  properties: {
    identityMatch: { type: 'boolean', description: 'Is this the same buddy as in the reference photos/description?' },
    taskDone: { type: 'boolean', description: 'Does the media show the chore actually being done / completed?' },
    challengeDone: { type: 'boolean', description: 'Is the requested hand gesture clearly visible (at any point, for videos)?' },
    looksLive: { type: 'boolean', description: 'Looks like a fresh real capture (not a screen, printout, or stock image)?' },
    confidence: { type: 'number', description: '0-1 confidence that the chore was genuinely done just now' },
    observed: { type: 'string', description: 'One sentence: what you actually see' },
    missing: { type: 'string', description: 'If anything is missing/unclear, the specific thing to show next time; else empty' },
    reply: { type: 'string', description: 'In-character reply to the human (1-2 sentences). Thank them if approved; ask for the missing thing if unsure; playful call-out if fake.' },
  },
  required: ['identityMatch', 'taskDone', 'challengeDone', 'looksLive', 'confidence', 'observed', 'missing', 'reply'],
};

const INLINE_VIDEO_MAX = 12 * 1024 * 1024;

async function mediaPart(media) {
  if (media.kind === 'image') return { part: { type: 'input_image', image_url: dataUrl(media.buffer, media.mime || 'image/jpeg') } };
  // Video: small clips (Telegram round videos are a few MB) go inline, which skips an upload round trip.
  // Bigger files go through the Files API. Both formats were verified against the live API.
  if (media.buffer.length <= INLINE_VIDEO_MAX) {
    return { part: { type: 'input_video', video_url: dataUrl(media.buffer, 'video/mp4') } };
  }
  try {
    const file = await client.files.create({
      file: await toFile(media.buffer, 'proof.mp4', { type: 'video/mp4' }),
      purpose: 'user_data',
    });
    return { part: { type: 'input_file', file_id: file.id }, fileId: file.id };
  } catch (err) {
    console.warn('[ai] file upload failed, sending video inline:', err.message);
    return { part: { type: 'input_video', video_url: dataUrl(media.buffer, 'video/mp4') } };
  }
}

export async function verifyProof({ buddy, bounty, challenge, media, referencePhotos = [], attempt = 1, previousFeedback }) {
  const { part, fileId } = await mediaPart(media);
  const content = [
    {
      type: 'input_text',
      text:
        `You are the strict but fair referee for a chores-for-cash game. Decide if this ${media.kind} proves the chore was done just now.\n\n` +
        `Buddy: ${buddy.name}, a ${buddy.kind}. Appearance: ${buddy.appearance}.\n` +
        `Chore: "${buddy.task}". Proof required: ${buddy.proof}.\n` +
        `Liveness challenge: the human must show ${challenge.check}. ` +
        (media.kind === 'video'
          ? 'In a video the gesture may appear at ANY moment of the clip; it does not need to be in the same frame as the buddy, because one continuous recording already proves it is live. Mark challengeDone true if the exact gesture is clearly shown at any point.\n'
          : 'In a photo the gesture must be visible in the same photo as the buddy.\n') +
        `This is attempt ${attempt}.${previousFeedback ? ` Last time we asked them to: ${previousFeedback}.` : ''}\n` +
        (referencePhotos.length ? `The first ${referencePhotos.length} image(s) are REFERENCE photos of the real buddy. The LAST item is the proof.\n` : 'The attached item is the proof.\n') +
        'Rules: be generous about lighting/angles, strict about the gesture and about the chore actually happening ' +
        '(e.g. water poured / soil visibly wet, food going into the bowl, actually playing). ' +
        'For videos, consider the whole clip. Write the reply in character as the buddy.\n' +
        `Buddy personality for the reply: ${buddy.personality}`,
    },
    ...referencePhotos.slice(0, 3).map((buf) => ({ type: 'input_image', image_url: dataUrl(buf, 'image/jpeg') })),
    part,
  ];
  try {
    const v = await askJson({ system: 'You are a careful visual verification model. Output JSON only.', content, schemaName: 'verdict', schema: verdictSchema });
    v.confidence = Math.max(0, Math.min(1, Number(v.confidence) || 0));
    // Hard rules: no gesture or wrong buddy can never auto-approve.
    if (!v.challengeDone || !v.identityMatch || !v.taskDone || !v.looksLive) v.confidence = Math.min(v.confidence, 0.6);
    return v;
  } finally {
    if (fileId) client.files.delete(fileId).catch(() => {});
  }
}

// ---------------------------------------------------------------- small talk

export async function buddyChat(buddy, { userName, text, walletCents }) {
  try {
    const out = await askJson({
      system: personaLine(buddy),
      content: [
        {
          type: 'input_text',
          text:
            `${userName} says to you: "${text}". Your wallet has $${(walletCents / 100).toFixed(2)}. ` +
            `Your chore is "${buddy.task}" for $${(buddy.rewardCents / 100).toFixed(2)}. ` +
            'Reply in character. You can tease, gossip about chores, or beg for a wallet top-up if you are low. ' +
            'Never promise extra money beyond your reward.',
        },
      ],
      schemaName: 'chat',
      schema: { type: 'object', properties: { reply: { type: 'string' } }, required: ['reply'] },
      maxTokens: 3000,
      effort: 'low',
    });
    return out.reply;
  } catch (err) {
    console.warn('[ai] buddyChat failed:', err.message);
    return `${buddy.emoji} *stares at you silently*`;
  }
}

export async function ping() {
  const res = await respond({
    input: 'Reply with the single word: ok',
    max_output_tokens: 2000,
    reasoning: { effort: 'minimal' },
  });
  return textOf(res);
}
