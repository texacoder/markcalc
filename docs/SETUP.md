# Put Mark Calculator online for free

About **15 minutes**, **no credit card**, no coding, and **no Google account needed**. Everything signs in with your GitHub account.

| What | Service | Cost |
|---|---|---|
| The AI that reads and marks answer sheets | **GitHub Models** (OpenAI GPT-4.1, the model behind ChatGPT) | Free |
| The database (teachers, exams, results) | Neon or Turso | Free plan |
| The website | Render | Free plan |

Keep a notepad open. You'll collect these values:

```
GITHUB_MODELS_TOKEN = github_pat_...
DATABASE_URL        = postgresql://... (Neon)  or  libsql://... (Turso)
DATABASE_AUTH_TOKEN = eyJ...  (Turso only)
SIGNUP_CODE         = (a code you make up, e.g. SUNRISE2026)
```

---

## Step 1: Free AI token from GitHub, 3 minutes

1. Log in to GitHub, then open **<https://github.com/settings/personal-access-tokens/new>**.
   (Or go to Profile picture → **Settings** → **Developer settings** → **Personal access tokens** → **Fine-grained tokens** → **Generate new token**.)
2. **Token name:** `markcalc`.
3. **Expiration:** choose **No expiration**, or the longest available. If it expires, marking stops until you make a new one.
4. **Repository access:** leave as **Public repositories**. It doesn't matter for this.
5. **Permissions:** click **Add permissions** (or open **Account permissions**), find **Models**, and set it to **Read-only**.
6. Click **Generate token** and copy it (starts with `github_pat_`). This is your **GITHUB_MODELS_TOKEN**. GitHub shows it only once.

Keep it private. It only goes into Render in Step 3.

---

## Step 2: Free database, 5 minutes

Pick **one**. Both are free and sign in with GitHub. If one website doesn't open for you, use the other.

### Option A: Neon (Postgres)
1. Go to **<https://neon.tech>** → **Sign up** → **Continue with GitHub**.
2. Create a project: name it `markcalc`, pick the region nearest to you, and leave everything else as it is.
3. On the project dashboard, click **Connect** (or find *Connection string*).
4. Copy the connection string. It looks like
   `postgresql://neondb_owner:xxxx@ep-something.region.aws.neon.tech/neondb?sslmode=require`
   This is your **DATABASE_URL**. Make sure the password is shown in it, not `****`; click *Show password* if needed.
5. With Neon, leave **DATABASE_AUTH_TOKEN** empty.

### Option B: Turso
1. Go to **<https://turso.tech>** (dashboard: <https://app.turso.tech>) → **Continue with GitHub**.
2. **Create Database** → name `markcalc` → nearest location.
3. Copy the database **URL** (`libsql://markcalc-yourname.turso.io`). This is your **DATABASE_URL**.
4. Click **Create Token** (no expiration, read & write) and copy it. This is your **DATABASE_AUTH_TOKEN**.

The website creates its tables by itself.

---

## Step 3: Publish the website (Render), 5 minutes

1. Open **<https://render.com/deploy?repo=https://github.com/texacoder/markcalc>**
2. Sign up or log in with **GitHub** and allow access if asked.
3. Render shows the **markcalc** service on the **Free** plan and asks for values:
   - `GITHUB_MODELS_TOKEN`: from Step 1
   - `GEMINI_API_KEY`: **leave empty**
   - `DATABASE_URL`: from Step 2
   - `DATABASE_AUTH_TOKEN`: from Step 2 if you used Turso, or **leave empty** for Neon
   - `SIGNUP_CODE`: a code only your teachers know (recommended), or leave empty so anyone can sign up
4. Click **Apply / Deploy Blueprint** and wait 3–5 minutes until it says **Live**.
5. Click the link at the top (like **https://markcalc.onrender.com**). **That's your website.**

**Check it's connected:** Render → your service → **Logs** should show
`Marking: github token OK (account texacoder), model "openai/gpt-4.1".`
If it says *check failed*, the token was pasted wrongly or doesn't have the **Models** permission. Fix it under **Environment**; the site restarts by itself.

If the one-click link doesn't work: Render → **New → Blueprint** → choose `texacoder/markcalc` → continue from point 3.

---

## Step 4: Test with a real paper

1. Open your website → **Create an account**.
2. **New exam**: fill in the name, total marks and marking scheme. Tip: **type the questions** in the "Type or paste the questions" box instead of uploading question-paper photos. That leaves more pages for the answer sheet (see limits below). Tick the checking options → **Save**.
3. Upload photos of an answer sheet **you already marked by hand** → **Calculate marks**.
4. Compare. If the marks are off, make the marking scheme more detailed (key points and the mark split for each question).

Then share the link and signup code with teachers. The **Help** page in the site explains everything.

---

## Free limits (please read)

With the free GitHub option:
- **About 50 answer sheets per day for the whole website.** The free quota belongs to your GitHub account and resets every 24 hours. When it runs out, teachers see "Today's free marking limit has been reached. Please try again tomorrow."
- **Up to 7 pages per marking**, counting question-paper photos. With a typed question paper, that's 7 answer-sheet pages. The website shows teachers this limit.
- **The website sleeps** after 15 minutes without visitors, and the next visit takes 30–60 seconds to wake it. To keep it awake, add a free monitor at <https://uptimerobot.com> that opens `https://YOUR-SITE.onrender.com/healthz` every 5 minutes.

These are the limits I know of. GitHub may change them; see *GitHub Models → rate limits* in GitHub's docs.

### Need more later?
You don't have to change any code. Just swap the key in Render → **Environment**:
- **Google Gemini (free, much bigger limits: hundreds of sheets a day, 40 pages each):** create a free project at <https://console.cloud.google.com/projectcreate> (no billing), then get a key at <https://aistudio.google.com/app/apikey>. Put it in `GEMINI_API_KEY`.
- **OpenAI directly (paid, about 3–6 cents per sheet, no daily cap):** key from <https://platform.openai.com/api-keys> → `OPENAI_API_KEY` and set `AI_PROVIDER=openai`.

If more than one key is set, the site uses Gemini first, then GitHub, then OpenAI, unless `AI_PROVIDER` says otherwise.

### Privacy
Answer-sheet photos are sent to the AI service to calculate the marks and are **not stored** by the website. Question papers, schemes and results are stored in your database (Neon or Turso). Mention this in your school's privacy notice.

---

## Settings reference (Render → your service → Environment)

| Variable | Default | What it does |
|---|---|---|
| `GITHUB_MODELS_TOKEN` | – | Free GitHub token with the Models permission. |
| `GITHUB_MODEL` | `openai/gpt-4.1` | Model used through GitHub Models. |
| `GEMINI_API_KEY` / `GEMINI_MODEL` | – / `gemini-flash-latest` | Google Gemini (optional). |
| `OPENAI_API_KEY` / `OPENAI_MODEL` | – / `gpt-4.1` | OpenAI directly (optional, paid). |
| `AI_PROVIDER` | automatic | Force `github`, `gemini` or `openai`. |
| `MAX_PAGES` | 7 for GitHub, 40 otherwise | Pages per marking (question paper + answer sheet). |
| `DATABASE_URL` | `file:./data/markcalc.db` | Neon/Postgres (`postgresql://…`) or Turso (`libsql://…`). On Render free it **must** be one of these, or data is lost on restart. |
| `DATABASE_AUTH_TOKEN` | – | Turso token (not used for Neon). |
| `SIGNUP_CODE` | empty | Teachers need this code to sign up. |
| `DAILY_GRADING_LIMIT` | `40` | Answer sheets per teacher per day. |
| `SITE_DAILY_LIMIT` | `0` (off) | Answer sheets for the whole site per day. |
| `MOCK_GRADER` | `0` | `1` = fake marks, no AI (for demos). |

## Looking after the site

- **Updates:** every push to the repository's default branch redeploys automatically. Data stays in your database.
- **Forgotten teacher password:** on your computer, put the same `DATABASE_URL` and `DATABASE_AUTH_TOKEN` in `.env`, then run
  `npm run reset-password -- teacher@school.com NewPassword123`
- **Backups:** Neon and Turso both keep automatic history, and you can create a branch or backup from their dashboards.
- **Own domain (optional):** Render → service → **Settings → Custom Domains**.
