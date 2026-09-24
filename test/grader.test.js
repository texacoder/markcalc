const test = require('node:test');
const assert = require('node:assert');
const { normalize, buildMessages } = require('../src/grader');
const { createApp } = require('../server');

test('normalize clamps marks and fixes totals', () => {
  const r = normalize({
    totalAwarded: 99,
    totalMaximum: 10,
    questions: [
      { question: '1', awarded: 7, maximum: 5, comment: '' },
      { question: '2', awarded: -1, maximum: 5, comment: '' },
    ],
    warnings: [],
  });
  assert.deepStrictEqual(r.questions.map((q) => q.awarded), [5, 0]);
  assert.strictEqual(r.totalAwarded, 5);
  assert.strictEqual(r.percentage, 50);
});

test('buildMessages includes setup text and images', () => {
  const img = { mimetype: 'image/png', buffer: Buffer.from('x') };
  const [, user] = buildMessages({
    setup: { scheme: 'Q1: 5 marks', instructions: '- Check liberally' },
    questionFiles: [img],
    answerFiles: [img, img],
  });
  assert.match(user.content[0].text, /Q1: 5 marks/);
  assert.match(user.content[0].text, /Check liberally/);
  assert.strictEqual(user.content.filter((p) => p.type === 'image_url').length, 3);
});

test('POST /api/grade validates and grades in mock mode', async () => {
  process.env.MOCK_GRADER = '1';
  const server = createApp().listen(0);
  const url = `http://localhost:${server.address().port}/api/grade`;
  try {
    let fd = new FormData();
    fd.append('totalMarks', '40');
    let res = await fetch(url, { method: 'POST', body: fd });
    assert.strictEqual(res.status, 400);

    fd = new FormData();
    fd.append('totalMarks', '40');
    fd.append('questionText', 'Q1. Define force. (40)');
    fd.append('answerSheet', new Blob([Buffer.from('fake')], { type: 'image/png' }), 'p1.png');
    res = await fetch(url, { method: 'POST', body: fd });
    const body = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(body.totalMaximum, 40);

    fd = new FormData();
    fd.append('questionText', 'Q1');
    fd.append('answerSheet', new Blob(['x'], { type: 'text/plain' }), 'a.txt');
    res = await fetch(url, { method: 'POST', body: fd });
    assert.strictEqual(res.status, 400);
  } finally {
    server.close();
    delete process.env.MOCK_GRADER;
  }
});
