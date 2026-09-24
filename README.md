# Mark Calculator

A website that helps teachers mark answer sheets. The teacher:

1. **Sets up the exam**: subject, class, total marks, syllabus, marking scheme or answer key, and any other details. This is saved in the browser, so it's entered once per exam.
2. **Adds the question paper**: uploads a photo of each page, or types the questions.
3. **Uploads the student's answer sheet**: all pages, in order.
4. **Gives checking instructions**: ready-made options (check liberally, marks for a diagram alone, step marks, ignore spelling, no half marks…) plus their own text.
5. Clicks **Calculate marks** and gets the total, the percentage, marks and remarks for each question, overall feedback and any warnings (for example, an unreadable page). **Next student** keeps the setup and clears only the answer sheet.

## How grading works

The browser sends everything to this app's own server (`POST /api/grade`). The server builds the grading prompt and calls the OpenAI (ChatGPT) API with the images and a strict JSON output schema. The API key, the provider, the model and the prompt never reach the browser, and error messages are generic. Before the result is returned, the server clamps each question's marks to its maximum and makes sure the total never exceeds the sum of the question marks or the paper's maximum.

```
public/        teacher-facing page (index.html, app.js, styles.css)
server.js      Express server: static files + /api/grade (image upload + validation)
src/grader.js  prompt, OpenAI call, result schema and normalisation
test/          node --test tests
```

## Run it

Requires Node 18+.

```bash
npm install
cp .env.example .env      # then put your OPENAI_API_KEY in .env
npm start                 # http://localhost:3000
```

To try the UI without an API key, set `MOCK_GRADER=1` in `.env`. It returns a fixed demo result.

`OPENAI_MODEL` defaults to `gpt-4o`. You can change it to any vision-capable model that supports structured outputs.

## Deploying

Deploy it like any Node app (Render, Railway, a VPS, etc.) and set `OPENAI_API_KEY` as an environment variable on the host. Don't commit `.env`. Uploaded images are kept in memory only for the length of the request and are never saved to disk.

## Tests

```bash
npm test
```
