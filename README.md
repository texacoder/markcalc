# Mark Calculator

A website that marks students' answer sheets for teachers.

A teacher sets up an exam once: syllabus, marking scheme or answer key, question paper, and checking instructions such as *check liberally*, *marks for diagram alone* or *step marks*. After that, they upload each student's answer sheet (phone photos or a PDF) and get:
- marks for every question, with what the student wrote and a short remark,
- the total and percentage, plus feedback,
- warnings for anything worth checking (unclear handwriting, missing pages),
- a class results table with the average, highest and lowest marks, and a CSV/Excel export.

Teachers can correct any mark; the total updates automatically.

Marking is done by OpenAI's API (ChatGPT models) **on the server**. Teachers never see the provider, the key or the prompt.

**→ To put it online, follow [docs/SETUP.md](docs/SETUP.md).**

## Features

- Teacher accounts (email and password), each teacher's data private to them
- Saved exams, reusable for the whole class
- Question paper and answer sheets as photos or PDFs (PDFs are split into pages in the browser; large photos are resized automatically)
- "Take photo" button on phones; reorder and remove pages
- 8 one-tap checking instructions, plus free-text instructions
- Handles choice questions ("answer any 5"), step marks and half marks
- Mark correction, printing, and a CSV export for the register
- Cost controls: optional signup code and a per-teacher daily limit
- Security: hashed passwords, HttpOnly session cookies, rate-limited login, CSP headers, uploads checked by file content
- Works on phones, tablets and computers, in light and dark mode

## Run it on your computer

Requires Node.js 22.13 or newer.

```bash
npm install
cp .env.example .env     # put your OPENAI_API_KEY in .env
npm start                # open http://localhost:3000
```

No key yet? Set `MOCK_GRADER=1` in `.env` to try the whole app with fake marks.

## Project layout

```
server.js            starts the server (reads .env, opens the database)
src/app.js           Express routes: auth, exams, grading, results, CSV
src/grader.js        prompt, OpenAI call (strict JSON schema, retries), mark normalisation
src/auth.js          password hashing, sessions, rate limiting
src/db.js            SQLite schema (Node's built-in node:sqlite)
public/              the website (no build step)
  js/app.js          screens: login, exams, editor, marking, results, help
  js/pages.js        page picker (upload / camera / reorder)
  js/files.js        PDF → images, photo resizing
scripts/reset-password.js
docs/SETUP.md        going live step by step
render.yaml          one-click Render deployment
Dockerfile           for any Docker host
```

## Tests

```bash
npm test
```
