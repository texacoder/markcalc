# Put Mark Calculator online for free, and test it

No login, no database and no credit card are needed. You need two free things:

| What | Service | Cost |
|---|---|---|
| The AI that reads and marks answer sheets | **Groq** (a vision model such as Qwen, picked automatically) | Free |
| The website | **Render** | Free plan |

Nothing is stored anywhere. The question paper and answer sheet are sent to the AI, the marks come back, and everything is thrown away.

> **Note on GitHub Models:** an earlier version used GitHub's free models. From Render, every request to it came back as a plain `OK` instead of an AI answer (even GitHub's own model list), so it can't be used. The steps below use Groq instead.

---

## Step 1: Groq key (the AI), 3 minutes

1. Open **<https://console.groq.com/keys>** and sign in with **GitHub** or **Google**. No card is needed.
2. Click **Create API Key**, name it `markcalc`, and click **Submit**.
3. Copy the key (starts with `gsk_`). Groq shows it only once. Keep it private.

**Alternatives (same steps, different variable name in Render):**
- **OpenRouter** (free models, about 50 requests a day): <https://openrouter.ai/keys> → create key → `OPENROUTER_API_KEY`.
- **Google Gemini** (free, best reading of handwriting, needs a Google Cloud project): <https://aistudio.google.com/app/apikey> → `GEMINI_API_KEY`.

## Step 2: Render (the website), 5 minutes

1. On **<https://dashboard.render.com>**: **New** → **Web Service** → **Public Git Repository** → `https://github.com/texacoder/markcalc` → **Connect**.
2. Settings:

   | Field | Value |
   |---|---|
   | Name | `markcalc` |
   | Language | `Node` |
   | Branch | `claude/ecstatic-ritchie-lecrv9` |
   | Build Command | `npm ci --omit=dev` |
   | Start Command | `npm start` |
   | Instance Type | **Free** |

3. **Environment Variables:**

   | NAME | VALUE |
   |---|---|
   | `GROQ_API_KEY` | your `gsk_…` key |
   | `NODE_ENV` | `production` |
   | `NODE_VERSION` | `22` |

   **Already deployed?** Go to your service → **Environment** → **Add Environment Variable**, add `GROQ_API_KEY`, save, then **Manual Deploy → Deploy latest commit**. You can leave or delete the old `GITHUB_MODELS_TOKEN`; a Groq key takes priority.

4. Click **Deploy Web Service**. When it says **Live**, the link at the top is your website.

**Already deployed an earlier version?** Render updates it automatically when the code changes. You can delete the old `DATABASE_URL` and `DATABASE_AUTH_TOKEN` variables (Environment tab); they're no longer used. The Neon database can be deleted too.

---

## Step 3: Test it

### A. Check the server started properly (1 minute)
Render → your service → **Logs**. You should see:
```
Mark calculator running at http://localhost:10000
Marking: groq key OK (11 models). A model that reads images will be chosen automatically on the first marking.
```
- `groq key check failed (HTTP 401)`: the key was pasted wrongly. Fix `GROQ_API_KEY` under **Environment**.
- `Model ... isn't offered any more`: nothing to do. Free services rename models often, so the site tests the service's models and picks one that reads images by itself. The self-test below shows which one it picked; you can fix it with `GROQ_MODEL` if you like.

**Self-test:** open `https://YOUR-SITE.onrender.com/api/selftest`. It sends three tiny requests (plain text, strict answer format, an image) and shows what came back. In a good result, `modelThatReadsImages` names a model, `plainTest.replyText` contains `OK`, and `imageTest` has a status of `200`. It uses about 10 of the day's requests.

### B. Quick test with a simple paper (5 minutes)
Use something you can check easily:
1. On a sheet of paper, handwrite answers to 2–3 short questions (for example: "Q1. What is the capital of France? (2 marks)", "Q2. 12 × 8 = ? Show working (3 marks)"). Make one answer deliberately wrong.
2. Open your website and fill in:
   - **Total marks:** e.g. `5`
   - **Marking scheme:** `Q1: Paris (2). Q2: 96 – method 1 mark, answer 2 marks (3)`
   - **Question paper:** type the questions in the box.
3. Photograph the answer sheet with your phone (**Take photo**), or upload the photo.
4. Click **Calculate marks** and wait 30–90 seconds.
5. Check: correct answers get full marks, the wrong one gets 0 or partial marks, and the remark explains why.

### C. Real test (10–15 minutes)
1. Take **3–5 real answer sheets you've already marked by hand**, some good, some weak.
2. Enter the real exam details, marking scheme and questions (typed is best).
3. Mark each one (use **Mark the next student**), then compare with your own marks.
4. If marks differ a lot:
   - add more detail to the marking scheme (key points and the mark split per question),
   - add instructions (e.g. *Step marks*, *Check liberally*),
   - retake blurry photos: flat page, good light, the whole page in view.
5. Try **Correct marks**, **Download CSV / Excel** and **Print** to make sure they work for you.

### D. Test on a phone
Open the link on a phone, use **Take photo** for each page, and mark a sheet. (The first visit after a quiet period can take up to a minute while the free server wakes up.)

### E. Test the limits (optional)
- Add more than 5 page images (with Groq): the button says *Too many pages (max 5)*.
- Mark 15 sheets from the same device in a day: the 16th is refused until tomorrow.

---

## Free limits (please read)

- **Groq's free quota** is per day and per minute. When it runs out, users see a "limit reached" or "busy, try again in a minute" message. Check the current numbers at <https://console.groq.com/settings/limits>.
- **Per-minute size limit:** Groq's free plan limits how much it reads per minute. If a marking is too big, the site first shortens the reply it asks for, then automatically resends the pages a little smaller. If it still doesn't fit, teachers see how many pages would fit.
- **Up to 5 page images per marking** with Groq (its vision models take at most 5 images), counting photos and scanned pages from every section. Typed text, .txt files and typed (non-scanned) PDFs don't count, because their text is copied into the boxes.
- **15 markings per device per day** (`PER_DEVICE_DAILY_LIMIT`), so one person can't use up everyone's quota. There's no login, so this is counted by internet address. It resets at midnight UTC or whenever the server restarts.
- **The site sleeps** after 15 minutes without visitors. The next visit takes 30–60 seconds. To keep it awake, add a free monitor at <https://uptimerobot.com> for `https://YOUR-SITE.onrender.com/healthz`, every 5 minutes.

Free limits are set by each service and can change.

### Need more?
Swap the key in Render → **Environment**. No code changes are needed:
- **Google Gemini (free, better at handwriting, 40 pages per marking):** create a project at <https://console.cloud.google.com/projectcreate>, get a key at <https://aistudio.google.com/app/apikey>, and set `GEMINI_API_KEY`.
- **OpenAI directly (paid, about 3–6 cents per sheet):** set `OPENAI_API_KEY` and `AI_PROVIDER=openai`.

## Settings reference (Render → Environment)

| Variable | Default | What it does |
|---|---|---|
| `GROQ_API_KEY` / `GROQ_MODEL` | – / automatic | Groq (free). With no model set, the site tests Groq's models and uses one that reads images. |
| `OPENROUTER_API_KEY` / `OPENROUTER_MODEL` | – / automatic | OpenRouter (free models; picks a free one that reads images). |
| `GEMINI_API_KEY` / `GEMINI_MODEL` | – / `gemini-flash-latest` | Google Gemini (free tier). |
| `OPENAI_API_KEY` / `OPENAI_MODEL` | – / `gpt-4.1` | OpenAI (paid). |
| `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL` | – | Any other OpenAI-compatible service. |
| `GITHUB_MODELS_TOKEN` | – | GitHub Models (didn't work from Render in testing). |
| `AI_PROVIDER` | automatic | Force `gemini`, `groq`, `openrouter`, `custom`, `github` or `openai`. Otherwise the first key found in that order is used. |
| `MAX_PAGES` | 5 Groq, 10 OpenRouter, 40 Gemini/OpenAI | Page images per marking. |
| `PER_DEVICE_DAILY_LIMIT` | `15` | Markings per device per day. |
| `SITE_DAILY_LIMIT` | `0` (off) | Markings for the whole site per day. |
| `MOCK_GRADER` | `0` | `1` = fake marks, no AI (for trying the layout). |

## Privacy
There are no accounts and nothing is saved. Question papers and answer sheets are sent to the AI service only to calculate the marks, then discarded. Results exist only in the user's open browser page until they close it or download the CSV.
