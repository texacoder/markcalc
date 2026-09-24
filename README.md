# Mark Calculator

A website that marks answer sheets, for schools, colleges and universities alike. **No login, and nothing is stored.**

The teacher or lecturer opens the site and enters:
1. exam details (subject or paper, class or course, total marks, syllabus),
2. the marking scheme or answer key,
3. the question paper,
4. checking instructions such as *check liberally*, *marks for diagram alone* or *step marks*,
5. the student's answer sheet.

Every input can be **typed or pasted**, or uploaded as a **PDF, photos or a .txt file**. If a PDF already contains typed text, the text is copied into the box for checking, which saves page-image quota. Scanned PDFs and photos are read as images. Answer-sheet PDFs are always read as images, so handwriting and diagrams are kept.

They click **Calculate marks** and get:
- marks for every question, with what the student wrote and a short remark,
- the total and percentage, plus feedback,
- warnings for anything worth checking (unclear handwriting, missing pages).

Any mark can be corrected. **Mark the next student** keeps the exam details, so a whole class can be marked in a row, and the results list can be downloaded as CSV/Excel. When the page is closed, everything is gone.

Marking is done by an AI vision model **on the server**: OpenAI's GPT-4.1 through free GitHub Models, Google Gemini (free tier), or OpenAI directly. Users never see the provider, the key or the prompt.

## Put it online for free

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/texacoder/markcalc)

You only need a GitHub token (AI) and Render (website), both free. See **[docs/SETUP.md](docs/SETUP.md)**.

## Features

- No accounts and no database: question papers, answer sheets and results are never saved on the server
- Syllabus, marking scheme, question paper and answer sheet each accept typed text, PDFs, photos or .txt files (PDFs are processed in the browser; large photos are resized automatically)
- "Take photo" button on phones; reorder and remove pages
- 8 one-tap checking instructions, plus free-text instructions
- Handles choice questions ("answer any 5"), step marks and half marks
- Mark correction, printing, a results list for the session, and a CSV/Excel download
- Protection for the free AI quota: per-device and site-wide daily limits, a page limit, and a cap on how many markings run at the same time
- Security: uploads checked by file content, requests only accepted from the site itself, CSP headers
- Works on phones, tablets and computers, in light and dark mode

## Run it on your computer

Requires Node.js 20 or newer.

```bash
npm install
cp .env.example .env     # put a GITHUB_MODELS_TOKEN (or GEMINI_API_KEY / OPENAI_API_KEY) in .env
npm start                # open http://localhost:3000
```

No key yet? Set `MOCK_GRADER=1` in `.env` to try the whole site with fake marks.

## Project layout

```
server.js            starts the server
src/app.js           Express: /api/grade (upload + validation + limits), /api/config
src/grader.js        prompt, GitHub Models / Gemini / OpenAI calls (structured JSON, retries, quota handling), mark normalisation
public/              the website (no build step)
  js/app.js          the marking page, results, session list, CSV, help
  js/pages.js        page picker (upload / camera / reorder)
  js/files.js        PDF → images, photo resizing
docs/SETUP.md        going live for free, and how to test
render.yaml          one-click Render deployment (free plan)
Dockerfile           for any Docker host
```

## Tests

```bash
npm test
```
