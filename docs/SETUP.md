# Going live: connect ChatGPT and publish the website

This guide takes you from this repository to a public website that teachers can sign up to and use. It takes about 20 minutes, and you don't need to write any code.

You need:
- an **OpenAI account** with billing turned on (this pays for the marking),
- a **Render account** to host the website (sign in with GitHub),
- this GitHub repository (`texacoder/markcalc`).

---

## Step 1: Get an OpenAI API key (the ChatGPT connection)

The website marks papers using OpenAI's API, the same models behind ChatGPT. A ChatGPT Plus subscription does **not** include API access. The API is billed separately, pay-as-you-go.

1. Go to <https://platform.openai.com> and sign in, or create an account.
2. Open **Settings → Billing** and add a payment method. Add some credit ($10 is plenty to start).
3. Recommended: open **Settings → Limits** and set a **monthly budget** (e.g. $20), so the bill can never surprise you.
4. Open **API keys** (<https://platform.openai.com/api-keys>) and click **Create new secret key**. Name it `markcalc` and copy the key (it starts with `sk-`).
   - Treat it like a password. Never put it in the code, in GitHub or in a chat. It only goes into the hosting settings in Step 2.

Teachers never see OpenAI or the key. The browser only ever talks to your server, and the server talks to OpenAI.

### What will it cost?
With the default model (`gpt-4.1`), marking a typical answer sheet (a 2-page question paper and 6–10 answer pages) costs roughly **3–6 US cents** at the time of writing. Check current prices at <https://openai.com/api/pricing>. You control spending with:
- `DAILY_GRADING_LIMIT`: the most answer sheets each teacher can mark per day (default 60),
- `SIGNUP_CODE`: only people with your code can create an account,
- the monthly budget in your OpenAI account.

---

## Step 2: Put the website online (Render)

The repository includes a `render.yaml` file, so Render sets almost everything up automatically.

1. Merge this branch into `main` on GitHub (or deploy from this branch).
2. Go to <https://dashboard.render.com> and sign in with GitHub.
3. Click **New → Blueprint** and choose the `texacoder/markcalc` repository. (If you don't see it, click *Configure GitHub* and give Render access to the repo.)
4. Render reads `render.yaml` and asks for two values:
   - **OPENAI_API_KEY**: paste the key from Step 1.
   - **SIGNUP_CODE**: a code teachers must enter to sign up, e.g. `SUNRISE2026`. Leave it empty to let anyone sign up. For a public site without a code, keep the daily limit and the OpenAI budget in place.
5. Click **Apply**. The first deploy takes 2–4 minutes.
6. When it says **Live**, open the address Render shows (like `https://markcalc.onrender.com`). You should see the login page.

**Plan:** the blueprint uses Render's *Starter* plan (about $7/month) with a 1 GB disk. The disk is where teachers' accounts, exams and results are kept. Render's free plan has no disk and deletes all data on every restart, so don't use it for real teachers.

From now on, every push to the deployed branch redeploys the site automatically. Data on the disk is kept.

### Your own domain (optional)
In Render, open the service → **Settings → Custom Domains → Add**, e.g. `marks.yourschool.com`, and add the DNS record Render shows at your domain provider. HTTPS is set up for you.

### Other hosts
Any host that runs Docker works (Railway, Fly.io, DigitalOcean, a school server) with the included `Dockerfile`:
```bash
docker build -t markcalc .
docker run -d -p 80:3000 -v markcalc-data:/data \
  -e OPENAI_API_KEY=sk-... -e SIGNUP_CODE=SUNRISE2026 markcalc
```
Always mount a volume at `/data`, which is where the database lives. Serve it over HTTPS. If you must run it over plain `http://` (for example inside a school network), set `NODE_ENV=development`, otherwise login cookies won't work.

---

## Step 3: Check it works end to end

1. Open your site and **create an account** (use the signup code if you set one).
2. Click **New exam**. Fill in the details and marking scheme, add a photo of a real question paper, tick a checking instruction, and **Save**.
3. Upload a real answer sheet you've **already marked by hand** and click **Calculate marks**.
4. Compare the marks with yours. If they're off, make the marking scheme more detailed (key points and mark split per question), or adjust the instructions, then mark again.

If marking fails with "Marking is not configured", the `OPENAI_API_KEY` is missing. If it says "could not process", check Render → your service → **Logs** for the detailed OpenAI error. Common causes are no credit left, an invalid key, or a model name your account can't use.

---

## Step 4: Invite teachers

Send teachers the website link, and the signup code if you set one. They can learn everything from the **Help** page in the app. The short version:

1. **New exam**: syllabus, marking scheme, question paper, checking instructions (once per exam).
2. **Open the exam**: add a student's answer sheet (phone photos or PDF), then **Calculate marks**.
3. Review the marks, **Correct marks** if needed, and **Download CSV / Excel** for the whole class.

Teachers can install it on a phone's home screen like an app (browser menu → *Add to Home Screen*).

---

## Settings reference

Set these in Render → your service → **Environment**. Changing a value restarts the site.

| Variable | Default | What it does |
|---|---|---|
| `OPENAI_API_KEY` | – | **Required.** Your OpenAI key. |
| `OPENAI_MODEL` | `gpt-4.1` | Model used for marking. `gpt-4.1-mini` is cheaper but less accurate. Newer models (e.g. `gpt-5`) work too. |
| `SIGNUP_CODE` | empty | If set, teachers need this code to sign up. |
| `DAILY_GRADING_LIMIT` | `60` | Answer sheets per teacher per day. |
| `DATABASE_FILE` | `./data/markcalc.db` | Where data is stored. Must be on a persistent disk. |
| `NODE_ENV` | – | `production` on HTTPS hosts (secure cookies). |
| `OPENAI_TIMEOUT_MS` | `240000` | How long to wait for one marking before retrying. |
| `MOCK_GRADER` | `0` | `1` returns fake marks without calling OpenAI (for demos). |

## Looking after the site

- **Forgotten password:** in Render → your service → **Shell**, run
  `npm run reset-password -- teacher@school.com NewPassword123`
- **Backups:** Render snapshots disks daily. For an extra copy, download `/var/data/markcalc.db` from the Shell occasionally.
- **Costs:** watch usage at <https://platform.openai.com/usage>.
- **Privacy:** answer-sheet photos are sent to OpenAI to calculate the marks and are **not** stored by this app. OpenAI doesn't use API data to train models by default. Question papers, schemes and results are stored in your database. Tell your school this in your privacy notice.
