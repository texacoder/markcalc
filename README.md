# Mark Calculator

A website that marks students' answer sheets for teachers.

A teacher sets up an exam once: syllabus, marking scheme or answer key, question paper, and checking instructions such as *check liberally*, *marks for diagram alone* or *step marks*. After that, they upload each student's answer sheet (phone photos or a PDF) and get:
- marks for every question, with what the student wrote and a short remark,
- the total and percentage, plus feedback,
- warnings for anything worth checking (unclear handwriting, missing pages),
- a class results table with the average, highest and lowest marks, and a CSV/Excel export.

Teachers can correct any mark; the total updates automatically.

Marking is done by an AI vision model **on the server**: OpenAI's GPT-4.1 through free GitHub Models, Google Gemini (free tier), or OpenAI directly. Teachers never see the provider, the key or the prompt.

## Put it online for free

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/texacoder/markcalc)

Everything runs on free plans: GitHub Models (AI), Turso (database) and Render (website), all with your GitHub login. Follow **[docs/SETUP.md](docs/SETUP.md)**. It takes about 15 minutes and no credit card.

## Features

- Teacher accounts (email and password), each teacher's data private to them
- Saved exams, reusable for the whole class
- Question paper and answer sheets as photos or PDFs (PDFs are split into pages in the browser; large photos are resized automatically)
- "Take photo" button on phones; reorder and remove pages
- 8 one-tap checking instructions, plus free-text instructions
- Handles choice questions ("answer any 5"), step marks and half marks
- Mark correction, printing, and a CSV export for the register
- Cost/quota controls: optional signup code, per-teacher and site-wide daily limits, friendly messages when the free AI quota runs out
- Security: hashed passwords, HttpOnly session cookies, rate-limited login, CSP headers, uploads checked by file content
- Works on phones, tablets and computers, in light and dark mode

## Run it on your computer

Requires Node.js 20 or newer.

```bash
npm install
cp .env.example .env     # put a GITHUB_MODELS_TOKEN (or GEMINI_API_KEY / OPENAI_API_KEY) in .env
npm start                # open http://localhost:3000
```

Locally, data is stored in `data/markcalc.db`. Set `DATABASE_URL` to use a Turso database instead.

No key yet? Set `MOCK_GRADER=1` in `.env` to try the whole app with fake marks.

## Project layout

```
server.js            starts the server (reads .env, opens the database)
src/app.js           Express routes: auth, exams, grading, results, CSV
src/grader.js        prompt, GitHub Models / Gemini / OpenAI calls (structured JSON, retries, quota handling), mark normalisation
src/auth.js          password hashing, sessions, rate limiting
src/db.js            SQLite schema via libSQL (local file or Turso)
public/              the website (no build step)
  js/app.js          screens: login, exams, editor, marking, results, help
  js/pages.js        page picker (upload / camera / reorder)
  js/files.js        PDF → images, photo resizing
scripts/reset-password.js
docs/SETUP.md        going live for free, step by step
render.yaml          one-click Render deployment (free plan)
Dockerfile           for any Docker host
```

## Tests

```bash
npm test
```
