# Put Mark Calculator online for free

This takes about **15 minutes**, needs **no credit card** and no coding. You'll create three free accounts, copy four values, and click one button.

| What | Service | Cost |
|---|---|---|
| The AI that reads and marks the answer sheets | Google Gemini API (Google AI Studio) | Free tier |
| The database (teachers, exams, results) | Turso | Free plan |
| The website itself | Render | Free plan |

Keep a notepad open. You'll collect these four values:

```
GEMINI_API_KEY      = AIza...
DATABASE_URL        = libsql://....turso.io
DATABASE_AUTH_TOKEN = eyJ...
SIGNUP_CODE         = (a code you make up, e.g. SUNRISE2026)
```

---

## Step 1: Free AI key (Google Gemini), 3 minutes

1. Go to **<https://aistudio.google.com/app/apikey>** and sign in with any Google account.
2. Accept the terms if asked, then click **Create API key**. If it asks for a project, choose the default or create one.
3. Copy the key (it starts with `AIza`). This is your **GEMINI_API_KEY**.

Keep this key private. Don't post it anywhere or put it in GitHub. It only goes into Render in Step 3.

---

## Step 2: Free database (Turso), 5 minutes

1. Go to **<https://turso.tech>** → **Sign up** (you can use your GitHub account).
2. In the dashboard, click **Create Database**. Name it `markcalc`, pick the location nearest to you, and create it.
3. Open the database. Copy its **URL**. It looks like `libsql://markcalc-yourname.turso.io`. This is your **DATABASE_URL**.
4. On the same page, click **Create Token** (or *Generate token*). Choose *no expiration* and *read & write*, then copy the long token. This is your **DATABASE_AUTH_TOKEN**.

You don't need to create any tables. The website does that itself on first start.

---

## Step 3: Publish the website (Render), 5 minutes

1. Open this link: **<https://render.com/deploy?repo=https://github.com/texacoder/markcalc>**
2. Sign up or log in (choose **GitHub** or Google). Render may ask you to connect GitHub. Allow it.
3. Render shows the **markcalc** service on the **Free** plan and asks for these values. Paste them in:
   - `GEMINI_API_KEY`: from Step 1
   - `DATABASE_URL`: from Step 2
   - `DATABASE_AUTH_TOKEN`: from Step 2
   - `SIGNUP_CODE`: a code only your teachers will know (recommended). Leave it empty to let anyone sign up.
4. Click **Apply / Deploy Blueprint** and wait 3–5 minutes until it says **Live**.
5. Click the link at the top, e.g. **https://markcalc.onrender.com** (yours may have extra letters). **That's your website.** Bookmark it and share it.

**Check it's connected:** in Render, open the service, then **Logs**. You should see
`Marking: gemini key OK, model "gemini-flash-latest" available.`
If it says *check failed*, the Gemini key was pasted wrongly. Fix it under **Environment** and the site restarts automatically.

If the one-click link doesn't work: in Render click **New → Blueprint**, choose the `texacoder/markcalc` repository, and continue from point 3.

---

## Step 4: Test with a real paper

1. Open your website and click **Create an account**. Enter your signup code if you set one.
2. Click **New exam** and fill in the exam name, total marks and marking scheme. Add a photo of the question paper, tick checking options, and click **Save**.
3. Upload photos of an answer sheet **you have already marked by hand** and click **Calculate marks**.
4. Compare. If the marks are off, add more detail to the marking scheme (key points and how the marks are split per question) and try again.

Then send the link and signup code to your teachers. The **Help** page in the site explains everything to them. On a phone they can use the browser menu → **Add to Home Screen** to get an app icon.

---

## What "free" means (limits to know)

- **Website sleeps when unused.** On Render's free plan, if nobody visits for 15 minutes, the site sleeps. The next visit takes about **30–60 seconds** to wake it, then it's fast again. This is normal. To keep it awake, add a free monitor at <https://uptimerobot.com> that opens `https://YOUR-SITE.onrender.com/healthz` every 5 minutes.
- **AI has a daily free quota.** Google limits how many answer sheets can be marked per day and per minute on the free tier. At the time of writing that was roughly a few hundred requests per day for Flash models; see *Usage* in AI Studio. When the day's quota is used up, teachers see "Today's free marking limit has been reached. Please try again tomorrow." If you need more, enable billing on the Google project. Gemini Flash is very cheap, well under 1 cent per answer sheet.
- **Each teacher** can mark up to `DAILY_GRADING_LIMIT` answer sheets per day (40 by default). This stops one person from using the whole free quota. Change it in Render → **Environment**.
- **Database:** Turso's free plan holds several GB, enough for thousands of exams and results.
- **Privacy:** answer-sheet photos are sent to Google's AI to calculate the marks and are **not stored** by the website. On Google's free tier, Google may use submitted content to improve its products. If your school needs stricter privacy, enable billing on the Google project (paid-tier data isn't used that way) or switch to OpenAI (see below).

---

## Settings reference (Render → your service → Environment)

| Variable | Default | What it does |
|---|---|---|
| `GEMINI_API_KEY` | – | Free Google AI key. |
| `OPENAI_API_KEY` | – | Paid alternative (ChatGPT models). If both keys are set, Gemini is used unless `AI_PROVIDER=openai`. |
| `GEMINI_MODEL` | `gemini-flash-latest` | Gemini model. If it's unavailable, `gemini-2.5-flash` is tried automatically. |
| `OPENAI_MODEL` | `gpt-4.1` | OpenAI model. |
| `DATABASE_URL` | `file:./data/markcalc.db` | Turso URL (`libsql://…`) or a local file. On Render free it **must** be Turso, or data is lost on restart. |
| `DATABASE_AUTH_TOKEN` | – | Turso token. |
| `SIGNUP_CODE` | empty | Teachers need this code to sign up. |
| `DAILY_GRADING_LIMIT` | `40` | Answer sheets per teacher per day. |
| `SITE_DAILY_LIMIT` | `0` (off) | Answer sheets for the whole site per day. |
| `NODE_ENV` | `production` | Leave as is on Render. |
| `MOCK_GRADER` | `0` | `1` = fake marks, no AI (for demos). |

## Switching to ChatGPT (OpenAI) later

OpenAI's API isn't free (about 3–6 cents per answer sheet with `gpt-4.1`). To switch, create a key at <https://platform.openai.com/api-keys> (billing required). In Render → **Environment**, add `OPENAI_API_KEY` and set `AI_PROVIDER=openai`. Teachers won't notice any difference in the site.

## Looking after the site

- **Updates:** every push to the repository's default branch redeploys the site automatically. Data stays in Turso.
- **Forgotten teacher password:** Render → service → **Shell** (on the free plan, run it on your computer instead with the same `DATABASE_URL` and `DATABASE_AUTH_TOKEN` in `.env`):
  `npm run reset-password -- teacher@school.com NewPassword123`
- **Backups:** in the Turso dashboard you can create a backup or branch of the database at any time.
- **Own domain (optional):** Render → service → **Settings → Custom Domains** (e.g. `marks.yourschool.com`). This is free on Render; you only pay for the domain name itself.
