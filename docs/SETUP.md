# Put Mark Calculator online for free, and test it

No login, no database and no credit card are needed. You need two free things:

| What | Service | Cost |
|---|---|---|
| The AI that reads and marks answer sheets | **GitHub Models** (OpenAI GPT-4.1) | Free |
| The website | **Render** | Free plan |

Nothing is stored anywhere. The question paper and answer sheet are sent to the AI, the marks come back, and everything is thrown away.

---

## Step 1: GitHub token (the AI), 3 minutes

1. Log in to GitHub and open **<https://github.com/settings/personal-access-tokens/new>**.
2. **Token name:** `markcalc`. **Expiration:** *No expiration*, or the longest available.
3. **Permissions:** add **Models** → **Read-only**.
4. Click **Generate token** and copy it (starts with `github_pat_`). Keep it private.

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
   | `GITHUB_MODELS_TOKEN` | your `github_pat_…` token |
   | `NODE_ENV` | `production` |
   | `NODE_VERSION` | `22` |

4. Click **Deploy Web Service**. When it says **Live**, the link at the top is your website.

**Already deployed an earlier version?** Render updates it automatically when the code changes. You can delete the old `DATABASE_URL` and `DATABASE_AUTH_TOKEN` variables (Environment tab); they're no longer used. The Neon database can be deleted too.

---

## Step 3: Test it

### A. Check the server started properly (1 minute)
Render → your service → **Logs**. You should see:
```
Mark calculator running at http://localhost:10000
Marking: github token OK (account <your GitHub name>), model "openai/gpt-4.1".
```
- `github token check failed`: the token is wrong or doesn't have the **Models** permission. Fix `GITHUB_MODELS_TOKEN` under **Environment**.
- Also open `https://YOUR-SITE.onrender.com/healthz`. It should show `{"ok":true,"markingConfigured":true}`.

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
- Add more than 7 pages: the button says *Too many pages (max 7)*.
- Mark 15 sheets from the same device in a day: the 16th is refused until tomorrow.

---

## Free limits (please read)

- **About 50 markings per day for the whole website** (the GitHub free quota). When it runs out, users see "Today's free marking limit has been reached. Please try again tomorrow."
- **Up to 7 pages per marking**, counting question-paper photos. Typing the questions leaves all 7 pages for the answer sheet.
- **15 markings per device per day** (`PER_DEVICE_DAILY_LIMIT`), so one person can't use up everyone's quota. There's no login, so this is counted by internet address. It resets at midnight UTC or whenever the server restarts.
- **The site sleeps** after 15 minutes without visitors. The next visit takes 30–60 seconds. To keep it awake, add a free monitor at <https://uptimerobot.com> for `https://YOUR-SITE.onrender.com/healthz`, every 5 minutes.

These are the GitHub Models limits I know of. GitHub may change them.

### Need more?
Swap the key in Render → **Environment**. No code changes are needed:
- **Google Gemini (free, bigger limits, 40 pages per marking):** create a project at <https://console.cloud.google.com/projectcreate>, get a key at <https://aistudio.google.com/app/apikey>, and set `GEMINI_API_KEY`.
- **OpenAI directly (paid, about 3–6 cents per sheet):** set `OPENAI_API_KEY` and `AI_PROVIDER=openai`.

## Settings reference (Render → Environment)

| Variable | Default | What it does |
|---|---|---|
| `GITHUB_MODELS_TOKEN` | – | Free GitHub token with the Models permission. |
| `GITHUB_MODEL` | `openai/gpt-4.1` | Model used through GitHub Models. |
| `GEMINI_API_KEY` / `GEMINI_MODEL` | – / `gemini-flash-latest` | Google Gemini (optional). |
| `OPENAI_API_KEY` / `OPENAI_MODEL` | – / `gpt-4.1` | OpenAI directly (optional, paid). |
| `AI_PROVIDER` | automatic | Force `github`, `gemini` or `openai`. |
| `MAX_PAGES` | 7 for GitHub, 40 otherwise | Pages per marking (question paper + answer sheet). |
| `PER_DEVICE_DAILY_LIMIT` | `15` | Markings per device per day. |
| `SITE_DAILY_LIMIT` | `0` (off) | Markings for the whole site per day. |
| `MOCK_GRADER` | `0` | `1` = fake marks, no AI (for trying the layout). |

## Privacy
There are no accounts and nothing is saved. Question papers and answer sheets are sent to the AI service only to calculate the marks, then discarded. Results exist only in the user's open browser page until they close it or download the CSV.
