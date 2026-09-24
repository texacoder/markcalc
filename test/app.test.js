const test = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const { createApp } = require('../src/app');

function png() {
  const crc = (buf) => {
    let c, crc = 0xffffffff;
    for (const b of buf) { c = (crc ^ b) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, c]);
  };
  const ihdr = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.from([0, 255, 255, 255]))), chunk('IEND', Buffer.alloc(0))]);
}

async function startServer(env = {}) {
  const server = createApp({ env: { MOCK_GRADER: '1', ...env } }).listen(0);
  await new Promise((r) => server.once('listening', r));
  return { base: `http://localhost:${server.address().port}`, close: () => server.close() };
}

async function post(base, form, headers = {}) {
  const res = await fetch(`${base}/api/grade`, { method: 'POST', body: form, headers });
  return { status: res.status, body: await res.json() };
}

function gradeForm({ questionText = 'Q1. Define force. (20)\nQ2. Newton\'s laws (20)', qp = 0, pages = 1, extra = {} } = {}) {
  const fd = new FormData();
  const values = { totalMarks: '40', scheme: 'Q1: 20, Q2: 20', questionText, presets: JSON.stringify(['Check liberally']), ...extra };
  for (const [k, v] of Object.entries(values)) fd.append(k, v);
  for (let i = 0; i < qp; i++) fd.append('questionPaper', new Blob([png()], { type: 'image/png' }), `q${i}.png`);
  for (let i = 0; i < pages; i++) fd.append('answerSheet', new Blob([png()], { type: 'image/png' }), `a${i}.png`);
  return fd;
}

test('marks an answer sheet without any login and stores nothing', async () => {
  const s = await startServer();
  try {
    const res = await post(s.base, gradeForm({ extra: { studentName: 'Ravi', rollNo: '12' } }));
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.studentName, 'Ravi');
    assert.strictEqual(res.body.rollNo, '12');
    assert.strictEqual(res.body.totalMaximum, 40);
    assert.strictEqual(res.body.totalAwarded, 28);
    assert.strictEqual(res.body.questions.length, 2);
    // No account, exam or result endpoints exist.
    for (const path of ['/api/exams', '/api/me', '/api/auth/login']) {
      assert.strictEqual((await fetch(s.base + path)).status, 404);
    }
  } finally { s.close(); }
});

test('accepts question paper photos instead of typed questions', async () => {
  const s = await startServer();
  try {
    assert.strictEqual((await post(s.base, gradeForm({ questionText: '', qp: 2 }))).status, 200);
  } finally { s.close(); }
});

test('validates input', async () => {
  const s = await startServer();
  try {
    let res = await post(s.base, gradeForm({ pages: 0 }));
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /answer sheet/);

    res = await post(s.base, gradeForm({ questionText: '', extra: { scheme: '' } }));
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /question paper/);

    const fake = gradeForm({ pages: 0 });
    fake.append('answerSheet', new Blob(['definitely not an image'], { type: 'image/png' }), 'evil.png');
    res = await post(s.base, fake);
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /not a supported image/);

    res = await post(s.base, gradeForm(), { origin: 'https://evil.example' });
    assert.strictEqual(res.status, 403);
  } finally { s.close(); }
});

test('page limit counts question paper photos and is exposed in config', async () => {
  const s = await startServer({ MAX_PAGES: '3' });
  try {
    const cfg = await (await fetch(`${s.base}/api/config`)).json();
    assert.strictEqual(cfg.maxPages, 3);
    const res = await post(s.base, gradeForm({ qp: 2, pages: 2 }));
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /At most 3 page images/);
    assert.strictEqual((await post(s.base, gradeForm({ qp: 1, pages: 2 }))).status, 200);
  } finally { s.close(); }
});

test('per-device and site-wide daily limits', async () => {
  let s = await startServer({ PER_DEVICE_DAILY_LIMIT: '2' });
  try {
    assert.strictEqual((await post(s.base, gradeForm())).status, 200);
    assert.strictEqual((await post(s.base, gradeForm())).status, 200);
    const res = await post(s.base, gradeForm());
    assert.strictEqual(res.status, 429);
    assert.match(res.body.error, /per device/);
    assert.strictEqual((await (await fetch(`${s.base}/api/config`)).json()).usedToday, 2);
  } finally { s.close(); }

  s = await startServer({ SITE_DAILY_LIMIT: '1' });
  try {
    assert.strictEqual((await post(s.base, gradeForm())).status, 200);
    const res = await post(s.base, gradeForm());
    assert.strictEqual(res.status, 429);
    assert.match(res.body.error, /website/);
  } finally { s.close(); }
});

test('failed markings do not use up the daily limit', async (t) => {
  const s = await startServer({ MOCK_GRADER: '0', GEMINI_API_KEY: 'k', PER_DEVICE_DAILY_LIMIT: '1' });
  const realFetch = globalThis.fetch;
  // Fail the AI call, pass everything else through to the real test server.
  t.mock.method(globalThis, 'fetch', (url, init) =>
    String(url).includes('generativelanguage') ? Promise.resolve(new Response('bad key', { status: 400 })) : realFetch(url, init),
  );
  t.mock.method(console, 'error', () => {});
  try {
    assert.strictEqual((await post(s.base, gradeForm())).status, 502);
    assert.strictEqual((await post(s.base, gradeForm())).status, 502); // still allowed, not 429
  } finally { s.close(); }
});

test('every input accepts typed text or images', async () => {
  const s = await startServer({ MAX_PAGES: '4' });
  try {
    // Typed answers only, no answer-sheet images.
    let res = await post(s.base, gradeForm({ pages: 0, extra: { answerText: 'Q1. Force is a push or pull.' } }));
    assert.strictEqual(res.status, 200);

    // Scheme and syllabus as images; no typed question paper (scheme stands in for it).
    const fd = gradeForm({ questionText: '', pages: 1, extra: { scheme: '' } });
    fd.append('schemeFiles', new Blob([png()], { type: 'image/png' }), 's.png');
    fd.append('syllabusFiles', new Blob([png()], { type: 'image/png' }), 'y.png');
    res = await post(s.base, fd);
    assert.strictEqual(res.status, 200);

    // All image kinds count towards the page limit.
    const big = gradeForm({ qp: 1, pages: 2 });
    big.append('schemeFiles', new Blob([png()], { type: 'image/png' }), 's.png');
    big.append('syllabusFiles', new Blob([png()], { type: 'image/png' }), 'y.png');
    res = await post(s.base, big);
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /You added 5/);
  } finally { s.close(); }
});
