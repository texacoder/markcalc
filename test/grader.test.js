const test = require('node:test');
const assert = require('node:assert');
const { normalize, buildMessages, grade } = require('../src/grader');

test('normalize clamps marks and derives total from counted questions', () => {
  const r = normalize({
    totalMaximum: 10,
    questions: [
      { question: '1', awarded: 7, maximum: 5, counted: true },
      { question: '2', awarded: -1, maximum: 5, counted: true },
      { question: '3', awarded: 5, maximum: 5, counted: false },
    ],
    warnings: [],
  });
  assert.deepStrictEqual(r.questions.map((q) => q.awarded), [5, 0, 5]);
  assert.strictEqual(r.totalAwarded, 5);
  assert.strictEqual(r.percentage, 50);
});

test('teacher total overrides model total and caps the score', () => {
  const r = normalize({ totalMaximum: 100, questions: [{ question: '1', awarded: 30, maximum: 30, counted: true }] }, '20');
  assert.strictEqual(r.totalMaximum, 20);
  assert.strictEqual(r.totalAwarded, 20);
  assert.strictEqual(r.warnings.length, 1);
});

test('buildMessages includes setup, instructions and images', () => {
  const img = { mimetype: 'image/png', buffer: Buffer.from('x') };
  const [, user] = buildMessages({
    setup: { scheme: 'Q1: 5 marks', presets: ['Check liberally'], instructions: 'Units required' },
    questionFiles: [img],
    answerFiles: [img, img],
  });
  assert.match(user.content[0].text, /Q1: 5 marks/);
  assert.match(user.content[0].text, /- Check liberally\n- Units required/);
  assert.strictEqual(user.content.filter((p) => p.type === 'image_url').length, 3);
});

test('grade calls the API with a strict schema and retries on 5xx', async (t) => {
  const calls = [];
  const replies = [
    new Response('overloaded', { status: 503 }),
    Response.json({
      choices: [{ message: { content: JSON.stringify({
        studentName: 'Ravi', rollNo: '7', totalMaximum: 10, overallFeedback: 'Good',
        warnings: [], questions: [{ question: '1', studentAnswer: 'x', awarded: 4, maximum: 10, counted: true, comment: 'ok' }],
      }) } }],
    }),
  ];
  t.mock.method(globalThis, 'fetch', async (url, init) => { calls.push(JSON.parse(init.body)); return replies.shift(); });
  t.mock.method(globalThis, 'setTimeout', (fn) => { fn(); return 0; });
  t.mock.method(console, 'error', () => {});
  const r = await grade(
    { setup: { totalMarks: '10' }, questionFiles: [], answerFiles: [{ mimetype: 'image/png', buffer: Buffer.from('x') }] },
    { OPENAI_API_KEY: 'k', OPENAI_MODEL: 'gpt-5' },
  );
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[0].response_format.json_schema.strict, true);
  assert.strictEqual(calls[0].temperature, undefined);
  assert.strictEqual(r.totalAwarded, 4);
  assert.strictEqual(r.studentName, 'Ravi');
});
