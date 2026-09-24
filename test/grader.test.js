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

const { toGeminiSchema, RESULT_SCHEMA, providerName } = require('../src/grader');

const GOOD = {
  studentName: 'Meena', rollNo: '3', totalMaximum: 10, overallFeedback: 'Good', warnings: [],
  questions: [{ question: '1', studentAnswer: 'x', awarded: 6, maximum: 10, counted: true, comment: 'ok' }],
};
const INPUT = { setup: { totalMarks: '10' }, questionFiles: [], answerFiles: [{ mimetype: 'image/jpeg', buffer: Buffer.from('img') }] };
const geminiOk = (obj) =>
  Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ thought: true, text: 'thinking…' }, { text: JSON.stringify(obj) }] } }] });

test('provider selection prefers explicit choice, then Gemini, then OpenAI', () => {
  assert.strictEqual(providerName({ GEMINI_API_KEY: 'g', OPENAI_API_KEY: 'o' }), 'gemini');
  assert.strictEqual(providerName({ OPENAI_API_KEY: 'o' }), 'openai');
  assert.strictEqual(providerName({ AI_PROVIDER: 'openai', GEMINI_API_KEY: 'g', OPENAI_API_KEY: 'o' }), 'openai');
  assert.strictEqual(providerName({}), 'none');
});

test('Gemini schema has no additionalProperties and keeps order', () => {
  const g = toGeminiSchema(RESULT_SCHEMA);
  assert.ok(!JSON.stringify(g).includes('additionalProperties'));
  assert.strictEqual(g.type, 'OBJECT');
  assert.strictEqual(g.properties.questions.items.properties.counted.type, 'BOOLEAN');
  assert.deepStrictEqual(g.propertyOrdering, Object.keys(RESULT_SCHEMA.properties));
});

test('grade with Gemini sends images inline and ignores thought parts', async (t) => {
  let call;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    call = { url, init, body: JSON.parse(init.body) };
    return geminiOk(GOOD);
  });
  const r = await grade(INPUT, { GEMINI_API_KEY: 'gkey' });
  assert.match(call.url, /models\/gemini-flash-latest:generateContent$/);
  assert.strictEqual(call.init.headers['x-goog-api-key'], 'gkey');
  assert.strictEqual(call.body.generationConfig.responseMimeType, 'application/json');
  const parts = call.body.contents[0].parts;
  assert.deepStrictEqual(parts.at(-1), { inlineData: { mimeType: 'image/jpeg', data: Buffer.from('img').toString('base64') } });
  assert.match(call.body.systemInstruction.parts[0].text, /examiner/);
  assert.strictEqual(r.totalAwarded, 6);
  assert.strictEqual(r.studentName, 'Meena');
});

test('Gemini: waits and retries on per-minute limit, falls back when model is missing', async (t) => {
  const urls = [];
  const replies = [
    Response.json({ error: { code: 404, message: 'model not found' } }, { status: 404 }),
    Response.json({ error: { code: 429, details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '1s' }] } }, { status: 429 }),
    geminiOk(GOOD),
  ];
  const waits = [];
  t.mock.method(globalThis, 'fetch', async (url) => { urls.push(url); return replies.shift(); });
  t.mock.method(globalThis, 'setTimeout', (fn, ms) => { waits.push(ms); fn(); return 0; });
  t.mock.method(console, 'error', () => {});
  const r = await grade(INPUT, { GEMINI_API_KEY: 'g' });
  assert.strictEqual(r.totalAwarded, 6);
  assert.match(urls[1], /gemini-2\.5-flash/);
  assert.ok(waits.includes(1500));
});

test('Gemini: daily free quota gives a clear message without retrying', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return Response.json(
      { error: { code: 429, details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }] } },
      { status: 429 },
    );
  });
  t.mock.method(console, 'error', () => {});
  await assert.rejects(grade(INPUT, { GEMINI_API_KEY: 'g', GEMINI_MODEL: 'gemini-2.5-flash' }), (err) => {
    assert.strictEqual(err.status, 429);
    assert.match(err.message, /free marking limit/);
    return true;
  });
  assert.strictEqual(calls, 1);
});

const { maxPages } = require('../src/grader');

test('GitHub Models: uses gpt-4.1, falls back to JSON mode, reports daily limit', async (t) => {
  const bodies = [];
  const replies = [
    new Response('{"error":{"message":"Invalid parameter: response_format json_schema not supported"}}', { status: 400 }),
    Response.json({ choices: [{ message: { content: JSON.stringify(GOOD) } }] }),
  ];
  let seen;
  t.mock.method(globalThis, 'fetch', async (url, init) => { seen = { url, init }; bodies.push(JSON.parse(init.body)); return replies.shift(); });
  t.mock.method(console, 'error', () => {});
  const env = { GITHUB_MODELS_TOKEN: 'github_pat_x' };
  assert.strictEqual(providerName(env), 'github');
  assert.strictEqual(maxPages(env), 7);
  const r = await grade(INPUT, env);
  assert.strictEqual(r.totalAwarded, 6);
  assert.strictEqual(seen.url, 'https://models.github.ai/inference/chat/completions');
  assert.strictEqual(seen.init.headers.Authorization, 'Bearer github_pat_x');
  assert.strictEqual(bodies[0].model, 'openai/gpt-4.1');
  assert.strictEqual(bodies[0].max_tokens, 4000);
  assert.strictEqual(bodies[0].response_format.type, 'json_schema');
  assert.strictEqual(bodies[1].response_format.type, 'json_object');
  assert.match(bodies[1].messages[0].content, /JSON Schema/);

  t.mock.method(globalThis, 'fetch', async () => new Response('Rate limit of 50 per 86400s exceeded for UserByModelByDay.', { status: 429 }));
  await assert.rejects(grade(INPUT, env), /free marking limit/);

  t.mock.method(globalThis, 'fetch', async () => new Response('{"error":{"code":"tokens_limit_reached"}}', { status: 413 }));
  await assert.rejects(grade(INPUT, env), /Too much to read/);
});
