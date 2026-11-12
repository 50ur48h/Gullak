// Google Gemini as a backup AI provider (native REST API, no extra dependencies).
// Takes the same Responses-API-style params the Meta calls use and returns { output_text, status },
// so the rest of ai.js doesn't need to know which provider answered.
import { config } from './config.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

const TIMEOUT_MS = 45_000; // an overloaded model can take a minute; skip to the next one instead

async function call(pathAndQuery, body) {
  let res;
  try {
    res = await fetch(`${BASE}/${pathAndQuery}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.gemini.apiKey },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const err = new Error(`Gemini ${e.name === 'TimeoutError' ? `timed out after ${TIMEOUT_MS / 1000}s` : e.message}`);
    err.status = 504;
    throw err;
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Gemini ${res.status}: ${json.error?.message || res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

// Ordered models to try. Availability varies a lot (retired models answer 404, busy ones 503, some 429),
// so calls walk this list and stick with whichever model last answered.
let candidates = [];

/** Build the candidate list: GEMINI_MODEL first if available, then flash models newest first. Returns the first. */
export async function pickModel() {
  const { models = [] } = await call('models?pageSize=1000');
  const ids = models
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => m.name.replace(/^models\//, ''));
  if (config.gemini.model && !ids.includes(config.gemini.model)) {
    console.warn(`⚠️ GEMINI_MODEL "${config.gemini.model}" not available; choosing automatically.`);
  }
  const version = (id) => Number((id.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || 0);
  const flash = ids
    .filter((id) => /^gemini-[\d.]+-flash/.test(id))
    .filter((id) => !/lite|image|tts|audio|live|thinking|exp|embedding/.test(id))
    .sort((a, b) => version(b) - version(a) || /preview/.test(a) - /preview/.test(b) || a.length - b.length);
  const preferred = config.gemini.model && ids.includes(config.gemini.model) ? [config.gemini.model] : [];
  candidates = [...preferred, ...flash.filter((id) => !preferred.includes(id))];
  if (!candidates.length) throw new Error(`no Gemini flash model available (have: ${ids.slice(0, 10).join(', ')})`);
  return candidates[0];
}

// Errors worth trying the next model for: retired (404), over quota (429), overloaded/down (5xx).
const RETRYABLE = (status) => status === 404 || status === 429 || status >= 500;

// After a fallback, go back to the preferred model every 10 minutes (overload is usually temporary).
const RETRY_BEST_MS = 10 * 60_000;
let fellBackAt = 0;

async function generate(body) {
  if (fellBackAt && Date.now() - fellBackAt > RETRY_BEST_MS && candidates[0]) {
    config.gemini.model = candidates[0];
    fellBackAt = 0;
  }
  const order = [config.gemini.model, ...candidates.filter((m) => m !== config.gemini.model)].filter(Boolean);
  let lastErr;
  for (const model of order) {
    try {
      const json = await call(`models/${model}:generateContent`, body);
      if (model !== config.gemini.model) {
        console.warn(`[ai] Gemini: switched to ${model}`);
        if (model !== candidates[0]) fellBackAt = Date.now();
      }
      config.gemini.model = model; // sticky: start with this one next time
      return json;
    } catch (err) {
      if (!RETRYABLE(err.status)) throw err;
      lastErr = err;
      console.warn(`[ai] Gemini ${model}: ${err.message.slice(0, 90)}`);
    }
  }
  throw lastErr || new Error('no Gemini model configured');
}

function toPart(p) {
  if (typeof p === 'string') return { text: p };
  if (p.type === 'input_text') return { text: p.text };
  const url = p.image_url || p.video_url;
  if (url) {
    const m = /^data:([^;]+);base64,(.*)$/s.exec(url);
    if (!m) throw new Error('Gemini backup only supports inline (data URL) media');
    return { inline_data: { mime_type: m[1], data: m[2] } };
  }
  throw new Error(`Gemini backup can't handle input part type "${p.type}"`);
}

export async function respond(params) {
  const items = typeof params.input === 'string' ? [{ role: 'user', content: params.input }] : params.input;
  const system = [];
  const contents = [];
  for (const item of items) {
    if (item.role === 'system') {
      system.push(String(item.content));
      continue;
    }
    const parts = typeof item.content === 'string' ? [{ text: item.content }] : item.content.map(toPart);
    contents.push({ role: item.role === 'assistant' ? 'model' : 'user', parts });
  }
  const schema = params.text?.format?.type === 'json_schema' ? params.text.format.schema : null;
  if (schema) system.push(`Reply with ONLY a JSON object matching this JSON Schema, no prose:\n${JSON.stringify(schema)}`);

  const body = {
    contents,
    generationConfig: {
      maxOutputTokens: params.max_output_tokens || 4000,
      ...(schema ? { responseMimeType: 'application/json' } : {}),
      // Quick tasks (chat, bounty text) think lightly; proof checks keep the model's full reasoning.
      // "low" is the lightest level every Gemini 3.x flash model accepts (3.8 rejects "minimal").
      ...(['minimal', 'low'].includes(params.reasoning?.effort) ? { thinkingConfig: { thinkingLevel: 'low' } } : {}),
    },
  };
  if (system.length) body.systemInstruction = { parts: [{ text: system.join('\n\n') }] };

  const json = await generate(body);
  const cand = json.candidates?.[0];
  const text = (cand?.content?.parts || []).map((p) => (p.thought ? '' : p.text || '')).join('');
  if (!text) {
    const reason = cand?.finishReason || json.promptFeedback?.blockReason || 'no text';
    return { output_text: '', status: 'incomplete', incomplete_details: { reason: `Gemini: ${reason}` } };
  }
  return { output_text: text, status: 'completed' };
}
