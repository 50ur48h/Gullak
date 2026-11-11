# Devpost submission kit

## Project name
**Gullak: your plants and pets pay you to look after them**

## Tagline (short)
Plants, pets and things get a PayPal wallet and an AI personality, then pay humans to take care of them, with AI-verified video proof.

## Inspiration
Every shared home has the same fight: who watered the plant, who fed the cat. A *gullak* is the clay piggy bank every Indian kid grew up with. We asked: what if the plant had its own gullak and could just pay whoever looks after it?

## What it does
- Each plant, pet or object becomes a **buddy** with a personality and its own PayPal-backed wallet.
- At random (but welfare-safe) times, a buddy posts a bounty in the house Telegram group: *"$0.50 to whoever waters me."*
- Pets can have **fixed meal times** (just say "feed her at 8am, 1pm and 7pm" when creating them). The buddy then posts exactly one feeding bounty per meal, at a random moment within ±15 min. Owners can serve a meal early with `/feednow`.
- A housemate claims it, does the job, and sends a **round video message** while making a **random hand gesture**, so proof can't be pre-recorded.
- **Meta's Muse Spark model watches the video**, compares it with the buddy's reference photos, and checks the job was done and the gesture is there. It then decides: pay, ask a follow-up in character, or escalate to the owner.
- The buddy **pays the human through PayPal Payouts**. Owners refill buddy wallets through **PayPal Checkout**.
- A live dashboard shows the household economy and a PayPal ledger with the AI's evidence for every payout.

## How we built it
- **PayPal Orders v2:** owners top up buddy wallets (create → approve → capture), idempotent across button, return URL and webhook.
- **PayPal Payouts:** buddy → human rewards, with batch status tracking posted back into the chat. Failed payouts are refunded to the wallet with a one-tap retry.
- **PayPal Webhooks:** `CHECKOUT.ORDER.APPROVED` and `PAYMENT.PAYOUTS-ITEM.*`, signature-verified.
- **Meta Model API (Muse Spark 1.3):** video and image understanding with structured JSON verdicts (identity, task done, gesture, liveness, confidence). It also designs a buddy from one photo + caption (personality, chore, proof rules, reward, safe cooldown, and fixed meal times pulled from the caption) and writes all dialogue in character.
- **Telegram Bot API (grammY), Node.js, Express**, hosted on **Render**.

## Anti-cheat
Random liveness gestures, live-only round videos, identity check against reference photos, duplicate detection (file ID + SHA-256), 15-minute claim locks, confidence thresholds, and owner review as the final word.

## Challenges we ran into
- Making AI judgment safe to attach real money to. We combined hard rules (no gesture = never auto-pay) with confidence thresholds and a human fallback.
- Welfare: a bounty system must never reward overfeeding or overwatering. The AI sets a safe cooldown per buddy, and ignored bounties raise the price instead of asking more often.
- Pets need routine, not randomness. Fixed meal times give exactly one bounty per meal in the household's timezone, with a ±15 min random offset, never repeated, even across restarts.

## What's next
Smart-plug and sensor triggers, spoken code-word challenges via audio understanding, pooled household wallets, and pet-sitting for neighbors while you travel.

## Built with
paypal-orders-api, paypal-payouts-api, paypal-webhooks, meta-muse-spark, telegram-bot-api, grammy, node.js, express, render

## Tools: which AI was used and how
**Meta Model API, `muse-spark-1.3`**, used for: (1) video and photo proof verification with structured JSON output; (2) generating a buddy's character and safe care schedule (cooldown or fixed meal times) from a photo and caption; (3) in-character bounty posts, verdicts, follow-ups and chat. The AI's verdict directly decides whether a PayPal payout is sent.

---

## Demo video script (under 3:00)

| Time | Shot | Voiceover |
|---|---|---|
| 0:00–0:15 | A wilting plant, then a Telegram notification | "Every shared home has this problem. So we gave the plant a wallet." |
| 0:15–0:40 | `/newbuddy`: photo of the plant + caption → AI-designed character card → ✅ | "One photo, and AI turns it into Fernanda: a personality, a chore, a fair reward and a safe schedule." |
| 0:40–0:55 | `/topup Fernanda 10` → PayPal sandbox checkout → wallet balance updates | "The owner fills her Gullak with PayPal." |
| 0:55–1:15 | Fernanda posts a bounty in the group → tap "I'll do it!" | "At a random time, she asks for help, with a random gesture as proof." |
| 1:15–1:35 | Send a deliberately bad proof → AI follow-up in character | "The AI actually watches the video. Miss the gesture and she calls you out." |
| 1:35–2:05 | Real round video: watering + correct gesture → ✅✅✅ → "$0.50 sent via PayPal" → "PayPal confirms SUCCESS" | "Do it right, and she pays you through PayPal Payouts in seconds." |
| 2:05–2:20 | Sandbox PayPal account showing the $0.50 | "Real PayPal money movement, end to end." |
| 2:20–2:45 | Dashboard: wallets, leaderboard, ledger with AI evidence | "Every payout is tied to the AI's evidence." |
| 2:45–3:00 | Logo + "Try it: t.me/PaypalAIGullakbot → /demo" | "Gullak. Your plants pay you now." |

**Optional pet cut (swap in for 0:55–1:15 if filming with a pet):** `/newbuddy` with *"Mochi the cat, feed her at 8am, 1pm and 7pm"* → card shows "🍽 Meals at 08:00, 13:00, 19:00" → `/feednow Mochi` → Mochi posts her mealtime bounty. Voiceover: *"Pets don't eat at random. Mochi asks once per meal, right on schedule."*

Upload to YouTube as **Public**, without copyrighted music.

## Submission checklist
- [ ] Repo public, MIT LICENSE visible
- [ ] README has run instructions (done) and the bot link
- [ ] Hosted on Render, `/demo` works for a stranger
- [ ] YouTube video < 3 min, public
- [ ] Devpost form: description, tools section, repo URL, video URL, try-it link
