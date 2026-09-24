const test = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const { openDb } = require('../src/db');
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
  const db = openDb(':memory:');
  const server = createApp({ db, env: { MOCK_GRADER: '1', ...env } }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://localhost:${server.address().port}`;
  return { base, db, close: () => server.close() };
}

function client(base) {
  let cookie = '';
  return async (path, { method = 'GET', json, form, headers = {} } = {}) => {
    const init = { method, headers: { ...headers, ...(cookie && { cookie }) } };
    if (json) { init.body = JSON.stringify(json); init.headers['content-type'] = 'application/json'; }
    if (form) init.body = form;
    const res = await fetch(base + path, init);
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const type = res.headers.get('content-type') || '';
    const body = type.includes('json') ? await res.json() : await res.text();
    return { status: res.status, body };
  };
}

async function signup(call, email = 'a@school.com', extra = {}) {
  return call('/api/auth/signup', { method: 'POST', json: { name: 'Asha', email, password: 'password123', ...extra } });
}

function examForm(fields = {}, files = 1) {
  const fd = new FormData();
  const values = { title: 'Physics Unit Test', totalMarks: '40', scheme: 'Q1: 20, Q2: 20', presets: JSON.stringify(['Check liberally']), ...fields };
  for (const [k, v] of Object.entries(values)) fd.append(k, v);
  for (let i = 0; i < files; i++) fd.append('questionPaper', new Blob([png()], { type: 'image/png' }), `q${i}.png`);
  return fd;
}

function sheetForm(extra = {}) {
  const fd = new FormData();
  fd.append('answerSheet', new Blob([png()], { type: 'image/png' }), 'p1.png');
  for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  return fd;
}

test('signup, login, logout and protected routes', async () => {
  const s = await startServer();
  try {
    const call = client(s.base);
    assert.strictEqual((await call('/api/exams')).status, 401);
    assert.strictEqual((await signup(call)).status, 201);
    assert.strictEqual((await call('/api/me')).body.user.email, 'a@school.com');
    assert.strictEqual((await signup(client(s.base))).status, 409);
    assert.strictEqual((await call('/api/auth/logout', { method: 'POST' })).status, 200);
    assert.strictEqual((await call('/api/me')).body.user, null);
    assert.strictEqual((await call('/api/auth/login', { method: 'POST', json: { email: 'A@School.com', password: 'wrongpass' } })).status, 401);
    assert.strictEqual((await call('/api/auth/login', { method: 'POST', json: { email: 'A@School.com', password: 'password123' } })).status, 200);
    assert.strictEqual((await call('/api/exams')).status, 200);
  } finally { s.close(); }
});

test('signup code is enforced when configured', async () => {
  const s = await startServer({ SIGNUP_CODE: 'SCHOOL42' });
  try {
    const call = client(s.base);
    assert.strictEqual((await call('/api/config')).body.signupCodeRequired, true);
    assert.strictEqual((await signup(call, 'b@x.com', { code: 'nope' })).status, 403);
    assert.strictEqual((await signup(call, 'b@x.com', { code: 'SCHOOL42' })).status, 201);
  } finally { s.close(); }
});

test('exam lifecycle, grading, edits, csv and isolation', async () => {
  const s = await startServer();
  try {
    const call = client(s.base);
    await signup(call);
    const created = await call('/api/exams', { method: 'POST', form: examForm({}, 2) });
    assert.strictEqual(created.status, 201);
    const exam = created.body;
    assert.strictEqual(exam.files.length, 2);
    assert.deepStrictEqual(exam.presets, ['Check liberally']);

    const img = await fetch(`${s.base}/api/exams/${exam.id}/files/${exam.files[0]}`);
    assert.strictEqual(img.status, 401);

    // Update: keep only the second file, add one new.
    const upd = examForm({ title: 'Physics UT-1', keepFiles: JSON.stringify([exam.files[1]]) }, 1);
    const updated = (await call(`/api/exams/${exam.id}`, { method: 'PUT', form: upd })).body;
    assert.strictEqual(updated.title, 'Physics UT-1');
    assert.strictEqual(updated.files.length, 2);
    assert.strictEqual(updated.files[0], exam.files[1]);

    const graded = await call(`/api/exams/${exam.id}/grade`, { method: 'POST', form: sheetForm({ studentName: 'Ravi', rollNo: '12' }) });
    assert.strictEqual(graded.status, 201);
    assert.strictEqual(graded.body.studentName, 'Ravi');
    assert.strictEqual(graded.body.totalMaximum, 40);
    assert.strictEqual(graded.body.totalAwarded, 28);

    const edited = await call(`/api/results/${graded.body.id}`, { method: 'PATCH', json: { questions: [{ awarded: 20 }, { awarded: 99 }] } });
    assert.strictEqual(edited.body.totalAwarded, 40);
    assert.strictEqual(edited.body.questions[1].awarded, 20);
    assert.strictEqual(edited.body.edited, true);

    const csv = await call(`/api/exams/${exam.id}/results.csv`);
    assert.match(csv.body, /Roll No,Student,Q1,Q2,Total,Out of,Percentage/);
    assert.match(csv.body, /12,Ravi,20,20,40,40,100%/);

    const list = (await call('/api/exams')).body;
    assert.strictEqual(list[0].resultCount, 1);
    assert.strictEqual(list[0].averagePercent, 100);
    assert.strictEqual((await call('/api/me')).body.usage.today, 1);

    // Another teacher cannot see or touch this data.
    const other = client(s.base);
    await signup(other, 'b@school.com');
    assert.strictEqual((await other(`/api/exams/${exam.id}`)).status, 404);
    assert.strictEqual((await other(`/api/results/${graded.body.id}`, { method: 'PATCH', json: {} })).status, 404);
    assert.strictEqual((await other(`/api/exams/${exam.id}/grade`, { method: 'POST', form: sheetForm() })).status, 404);
    assert.deepStrictEqual((await other('/api/exams')).body, []);

    assert.strictEqual((await call(`/api/results/${graded.body.id}`, { method: 'DELETE' })).status, 200);
    assert.strictEqual((await call(`/api/exams/${exam.id}`, { method: 'DELETE' })).status, 200);
    assert.strictEqual((await call(`/api/exams/${exam.id}`)).status, 404);
  } finally { s.close(); }
});

test('rejects non-images, missing pages, cross-site posts, and enforces the daily limit', async () => {
  const s = await startServer({ DAILY_GRADING_LIMIT: '1' });
  try {
    const call = client(s.base);
    await signup(call);
    const fake = new FormData();
    fake.append('title', 'x');
    fake.append('questionPaper', new Blob(['not an image, really'], { type: 'image/png' }), 'evil.png');
    assert.strictEqual((await call('/api/exams', { method: 'POST', form: fake })).status, 400);

    const exam = (await call('/api/exams', { method: 'POST', form: examForm() })).body;
    assert.strictEqual((await call(`/api/exams/${exam.id}/grade`, { method: 'POST', form: new FormData() })).status, 400);
    assert.strictEqual(
      (await call(`/api/exams/${exam.id}/grade`, { method: 'POST', form: sheetForm(), headers: { origin: 'https://evil.example' } })).status,
      403,
    );
    assert.strictEqual((await call(`/api/exams/${exam.id}/grade`, { method: 'POST', form: sheetForm() })).status, 201);
    const limited = await call(`/api/exams/${exam.id}/grade`, { method: 'POST', form: sheetForm() });
    assert.strictEqual(limited.status, 429);
    assert.match(limited.body.error, /limit/);
  } finally { s.close(); }
});

test('exam without question paper cannot be graded', async () => {
  const s = await startServer();
  try {
    const call = client(s.base);
    await signup(call);
    const exam = (await call('/api/exams', { method: 'POST', form: examForm({}, 0) })).body;
    const res = await call(`/api/exams/${exam.id}/grade`, { method: 'POST', form: sheetForm() });
    assert.strictEqual(res.status, 400);
  } finally { s.close(); }
});
