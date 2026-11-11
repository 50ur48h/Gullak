# Gullak: handoff notes for Claude Code

## What this is
Hackathon entry for **"Build What's Next with PayPal and AI"** (Devpost).
**Deadline: Nov 12, 2026, 12:00pm PST (Nov 13, 4:00am Singapore).** Speed matters more than polish; keep scope tight.
Target prizes: **Best Use of PayPal + AI**, Most Creative, Best Demo Delivery.

**Concept:** plants, pets and objects get a PayPal-backed wallet and an AI personality. In a Telegram group they post bounties at random times ("$0.50 to whoever waters me"). A human claims it, sends a round video or photo doing a random hand gesture, Meta's Muse Spark model checks the proof, and the buddy pays them via PayPal Payouts. Owners fund buddy wallets via PayPal Checkout (Orders v2). Full description: README.md.

## Stack
Node 20+ ESM, no TypeScript, no native modules. grammY (Telegram, long polling), `openai` SDK pointed at Meta Model API (`https://api.meta.ai/v1`, model `muse-spark-1.3`, Responses API), PayPal REST via fetch (sandbox), Express (dashboard at `/`, `/paypal/return`, `/paypal/webhook`), JSON-file DB at `data/db.json`.

```
src/index.js      startup (env check, bot, server, scheduler)
src/bot.js        commands, inline buttons, media handlers
src/game.js       bounties, claims, proof verification, payouts, top-ups
src/ai.js         Meta API calls: designBuddy, bountyMessage, verifyProof, buddyChat
src/paypal.js     OAuth, Payouts, Orders, webhook verification
src/scheduler.js  every 60s: expire claims, surge pricing, random bounties
src/server.js     dashboard + PayPal routes
src/db.js         JSON store
scripts/check.js  `npm run check`: tests Telegram, PayPal, Meta keys
```

## Rules
- **Never print, log, commit or echo the contents of `.env`.** It holds real secrets. `.gitignore` excludes it; before any commit run `git status` and confirm `.env` is not staged.
- Accepted env names (see `src/config.js`): TELEGRAM_BOT_TOKEN, PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, META_API_KEY (+ common aliases). If `npm run check` reports missing keys, tell the user which names to rename in .env; don't open the file yourself.
- The user (Charli) is on Windows. Prefer commands that work in PowerShell.
- Ask before pushing to GitHub or deploying.

## Status
**Verified live on 2026-11-11:** Meta API formats (system item, json_schema, inline image, inline `input_video`, Files API `input_file`) all work; `/demo` end-to-end works including a real sandbox payout (SUCCESS).
Lessons: Muse Spark is a reasoning model, so reasoning tokens count against `max_output_tokens` (keep caps ≥2000). The PayPal sandbox app **must belong to a US business sandbox account**; India accounts get 403 `PAYOUT_NOT_AVAILABLE`.

Original notes: the code was written without network access to the real APIs and tested only with mocks (bounty → claim → weak proof → follow-up → duplicate rejection → good proof → payout → owner review → top-up all pass). **Real API calls are untested.** Most likely things to need fixing:
1. **Meta API request shapes** in `src/ai.js`:
   - Video: uploads via `client.files.create({purpose: 'user_data'})` then `{type:'input_file', file_id}`; falls back to `{type:'input_video', video_url: dataUrl}`.
   - Structured output: `text.format = {type:'json_schema', name, schema, strict:false}`; falls back to prompting for raw JSON.
   - System prompt is sent as an input item `{role:'system', content}`.
   - Docs: https://dev.meta.ai/docs/video-understanding, /docs/media-understanding, /docs/structured-output, /docs/quickstart
2. **PayPal Payouts** need the "Payouts" feature enabled on the sandbox app. A 403 `AUTHORIZATION_ERROR` or `NOT_AUTHORIZED` means it's not enabled (developer.paypal.com → Apps & Credentials → app → Features).
3. Telegram round videos (`video_note`) are mp4, ≤ 1 min. Group Privacy must be OFF in BotFather for the bot to see media in groups.

## Task list (do in order, check in with the user between steps)
1. `npm install`, then `npm run check`. Fix anything red.
2. Write a tiny throwaway script (don't commit it) that calls `ai.verifyProof` with a local test image to confirm the Meta request format works, then the same with a short mp4 if the user can provide one. Adjust `src/ai.js` until both work.
3. `npm start`. Guide the user through: DM bot `/start` → `/link <sandbox personal email>` → `/demo` → claim → send a round video drinking water with the gesture. Watch the console and fix errors.
4. Test `/topup Hydro 5`: pay with the sandbox personal account, tap "I've paid", confirm the wallet increases.
5. Test `/newbuddy` in a group with a real plant/pet photo.
6. Commit and push (after confirming `.env` isn't staged).
7. Deploy to Render: user creates a Blueprint from the GitHub repo (render.yaml exists) and pastes the 4 secrets in the Render dashboard. Set PUBLIC_URL to the Render URL. **Stop the local bot first**: two instances polling the same token conflict (Telegram 409). Free Render instances sleep without HTTP traffic. Suggest a free uptime pinger hitting `/health` every 10 minutes for judging. The JSON DB resets on redeploy, which is acceptable for the demo.
8. Help with the demo video (script in SUBMISSION.md) and Devpost form (text in SUBMISSION.md).

## Nice-to-haves only if time remains
- Owner can talk to Gullak in natural language ("top up Mochi $10") via Meta tool calling.
- Spoken code word challenge using audio understanding (`muse-spark-1.2` for audio).
