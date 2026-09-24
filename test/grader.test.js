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

test('prompt includes typed answers and scheme/syllabus images in order', () => {
  const img = (tag) => ({ mimetype: 'image/png', buffer: Buffer.from(tag) });
  const [, user] = buildMessages({
    setup: { answerText: 'Q1. Paris' },
    syllabusFiles: [img('y')],
    schemeFiles: [img('s')],
    questionFiles: [img('q')],
    answerFiles: [img('a')],
  });
  const titles = user.content.filter((p) => p.type === 'text').map((p) => p.text.split('\n')[0]);
  assert.deepStrictEqual(titles.slice(1), [
    '## Syllabus (1 page image(s), in order)',
    '## Marking scheme / answer key (1 page image(s), in order)',
    '## Question paper (1 page image(s), in order)',
    "## Student's answers (typed)",
    '## Student answer sheet (1 page image(s), in order)',
  ]);
  assert.strictEqual(user.content.filter((p) => p.type === 'image_url').length, 4);
});

const { requestTooLarge } = require('../src/grader');

test('GitHub token budget: small requests pass, oversized ones get a clear message', () => {
  const env = { GITHUB_MODELS_TOKEN: 'x' };
  const img = { mimetype: 'image/png', buffer: Buffer.from('x') };
  assert.strictEqual(requestTooLarge({ setup: { scheme: 'Q1: 5' }, answerFiles: Array(7).fill(img) }, env), '');
  const msg = requestTooLarge({ setup: { scheme: 'x'.repeat(6000) }, answerFiles: Array(7).fill(img) }, env);
  assert.match(msg, /more than the free marking service can read/);
  assert.match(msg, /it is 6000/);
  // Other providers are not limited this way.
  assert.strictEqual(requestTooLarge({ setup: { scheme: 'x'.repeat(60000) }, answerFiles: [img] }, { GEMINI_API_KEY: 'g' }), '');
});

test('GitHub Models: empty reply is retried in JSON mode; fenced JSON is accepted', async (t) => {
  const bodies = [];
  const replies = [
    Response.json({ choices: [{ finish_reason: 'stop', message: { content: null } }] }),
    Response.json({ choices: [{ finish_reason: 'stop', message: { content: '```json\n' + JSON.stringify(GOOD) + '\n```' } }] }),
  ];
  t.mock.method(globalThis, 'fetch', async (url, init) => { bodies.push(JSON.parse(init.body)); return replies.shift(); });
  t.mock.method(console, 'error', () => {});
  const r = await grade(INPUT, { GITHUB_MODELS_TOKEN: 't' });
  assert.strictEqual(r.totalAwarded, 6);
  assert.strictEqual(bodies[0].response_format.type, 'json_schema');
  assert.strictEqual(bodies[1].response_format.type, 'json_object');
});

test('GitHub Models: refusals and content filters give specific messages', async (t) => {
  t.mock.method(console, 'error', () => {});
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ choices: [{ finish_reason: 'stop', message: { content: null, refusal: "I'm sorry, I can't help with that." } }] }),
  );
  await assert.rejects(grade(INPUT, { GITHUB_MODELS_TOKEN: 't' }), /\[code: declined\]/);

  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ choices: [{ finish_reason: 'content_filter', message: { content: null } }] }),
  );
  await assert.rejects(grade(INPUT, { GITHUB_MODELS_TOKEN: 't' }), /\[code: filter\]/);

  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ error: { code: 'content_filter', message: 'filtered by content management policy' } }, { status: 400 }),
  );
  await assert.rejects(grade(INPUT, { GITHUB_MODELS_TOKEN: 't' }), /\[code: filter\]/);

  t.mock.method(globalThis, 'fetch', async () => new Response('bad credentials', { status: 401 }));
  await assert.rejects(grade(INPUT, { GITHUB_MODELS_TOKEN: 't' }), /\[code: auth-401\]/);
});

test('OpenAI-compatible replies: streamed and "responses" formats are understood', async (t) => {
  t.mock.method(console, 'error', () => {});
  const json = JSON.stringify(GOOD);
  const sse = ['data: ' + JSON.stringify({ choices: [{ delta: { content: json.slice(0, 40) } }] }),
    'data: ' + JSON.stringify({ choices: [{ delta: { content: json.slice(40) } }] }), 'data: [DONE]', ''].join('\n');
  t.mock.method(globalThis, 'fetch', async () => new Response(sse, { headers: { 'content-type': 'text/event-stream' } }));
  assert.strictEqual((await grade(INPUT, { GITHUB_MODELS_TOKEN: 't' })).totalAwarded, 6);

  t.mock.method(globalThis, 'fetch', async () => Response.json({ output: [{ content: [{ type: 'output_text', text: json }] }] }));
  assert.strictEqual((await grade(INPUT, { GITHUB_MODELS_TOKEN: 't' })).totalAwarded, 6);
});


const { selfTest, resetForTests } = require('../src/grader');

test('GitHub Models: a plain-text "OK" reply makes it try the next header set, and remembers the one that works', async (t) => {
  resetForTests();
  t.mock.method(console, 'error', () => {});
  t.mock.method(console, 'log', () => {});
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push(init.headers);
    return init.headers.Accept === 'application/vnd.github+json'
      ? Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(GOOD) } }] })
      : new Response('OK\r\n', { headers: { 'content-type': 'text/plain' } });
  });
  assert.strictEqual((await grade(INPUT, { GITHUB_MODELS_TOKEN: 't' })).totalAwarded, 6);
  assert.strictEqual(calls[0].Accept, 'application/json');
  assert.strictEqual(calls[0]['User-Agent'], 'markcalc/1.0');
  assert.strictEqual(calls[1].Accept, 'application/vnd.github+json');
  assert.strictEqual(calls[1]['X-GitHub-Api-Version'], '2022-11-28');
  // Next marking starts with the header set that worked.
  calls.length = 0;
  await grade(INPUT, { GITHUB_MODELS_TOKEN: 't' });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].Accept, 'application/vnd.github+json');
  resetForTests();
});

test('GitHub Models: when every header set gets "OK", the code says so', async (t) => {
  resetForTests();
  t.mock.method(console, 'error', () => {});
  let n = 0;
  t.mock.method(globalThis, 'fetch', async () => { n++; return new Response('OK\r\n', { headers: { 'content-type': 'text/plain' } }); });
  await assert.rejects(grade(INPUT, { GITHUB_MODELS_TOKEN: 't' }), /\[code: reply-200-text\]/);
  assert.strictEqual(n, 4);
  resetForTests();
});

test('selfTest checks the catalogue and each header set, then schema and image with the working one', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url).endsWith('/catalog/models')) return Response.json([{ id: 'openai/gpt-4.1' }, { id: 'openai/gpt-4o' }]);
    return init.headers['X-GitHub-Api-Version'] && init.headers.Accept === 'application/json'
      ? Response.json({ choices: [{ message: { content: 'OK' } }] })
      : new Response('OK\r\n', { headers: { 'content-type': 'text/plain' } });
  });
  const r = await selfTest({ GITHUB_MODELS_TOKEN: 't' });
  assert.strictEqual(r.catalog.modelListed, true);
  assert.deepStrictEqual(r.headerSets.map((h) => [h.name, h.shape]), [['json', '200-text'], ['github', '200-text'], ['json+version', '200-keys:choices']]);
  assert.strictEqual(r.workingHeaderSet, 'json+version');
  assert.strictEqual(r.schemaTest.status, 200);
  assert.strictEqual(r.imageTest.status, 200);
});

test('Groq / OpenRouter: chosen over the GitHub token, right limits and request format', async (t) => {
  assert.strictEqual(providerName({ GITHUB_MODELS_TOKEN: 'g', GROQ_API_KEY: 'q' }), 'groq');
  assert.strictEqual(providerName({ GITHUB_MODELS_TOKEN: 'g', OPENROUTER_API_KEY: 'o' }), 'openrouter');
  assert.strictEqual(providerName({ AI_BASE_URL: 'https://x/v1', AI_API_KEY: 'k' }), 'custom');
  assert.strictEqual(maxPages({ GROQ_API_KEY: 'q' }), 5);

  t.mock.method(console, 'error', () => {});
  const calls = [];
  const replies = [
    new Response('{"error":{"message":"response_format json_schema is not supported with this model"}}', { status: 400 }),
    new Response('{"error":{"message":"json mode is not supported with images"}}', { status: 400 }),
    Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'Here you go:\n' + JSON.stringify(GOOD) } }] }),
  ];
  t.mock.method(globalThis, 'fetch', async (url, init) => { calls.push({ url, body: JSON.parse(init.body), headers: init.headers }); return replies.shift(); });
  const r = await grade(INPUT, { GROQ_API_KEY: 'q', GITHUB_MODELS_TOKEN: 'g', GROQ_MODEL: 'some/vision-model' });
  assert.strictEqual(r.totalAwarded, 6);
  assert.strictEqual(calls[0].url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.strictEqual(calls[0].headers.Authorization, 'Bearer q');
  assert.strictEqual(calls[0].body.model, 'some/vision-model');
  assert.strictEqual(calls[0].body.max_completion_tokens, 4000);
  assert.strictEqual(calls[0].body.response_format.type, 'json_schema');
  assert.strictEqual(calls[1].body.response_format.type, 'json_object');
  assert.strictEqual(calls[2].body.response_format, undefined);
  assert.match(calls[2].body.messages[0].content, /JSON Schema/);
});

test('selfTest for Groq lists all models, finds one that reads images, and tests with it', async (t) => {
  resetForTests();
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url).endsWith('/models')) {
      return Response.json({ data: [{ id: 'llama-3.3-70b-versatile' }, { id: 'whisper-large-v3' }, { id: 'qwen/qwen3-vl-32b' }] });
    }
    const body = JSON.parse(init.body);
    const withImage = JSON.stringify(body.messages).includes('image_url');
    if (body.model === 'meta-llama/llama-4-scout-17b-16e-instruct') {
      return Response.json({ error: { code: 'model_not_found', message: 'The model does not exist' } }, { status: 404 });
    }
    if (withImage && body.model !== 'qwen/qwen3-vl-32b') {
      return Response.json({ error: { message: 'model does not support image input' } }, { status: 400 });
    }
    return Response.json({ choices: [{ message: { content: withImage ? 'Red' : 'OK' } }] });
  });
  const r = await selfTest({ GROQ_API_KEY: 'q' });
  assert.deepStrictEqual(r.models.all, ['llama-3.3-70b-versatile', 'whisper-large-v3', 'qwen/qwen3-vl-32b']);
  assert.strictEqual(r.models.modelListed, false);
  assert.deepStrictEqual(r.imageCheck.map((x) => [x.model, x.ok]), [['qwen/qwen3-vl-32b', true], ['llama-3.3-70b-versatile', false]]);
  assert.strictEqual(r.modelThatReadsImages, 'qwen/qwen3-vl-32b');
  assert.strictEqual(r.testedModel, 'qwen/qwen3-vl-32b');
  assert.strictEqual(r.imageTest.replyText, 'Red');
  resetForTests();
});

test('marking replaces a retired model with one that reads images, and remembers it', async (t) => {
  resetForTests();
  t.mock.method(console, 'error', () => {});
  t.mock.method(console, 'log', () => {});
  const used = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url).endsWith('/models')) return Response.json({ data: [{ id: 'llama-3.3-70b-versatile' }, { id: 'vision-model-90b' }] });
    const body = JSON.parse(init.body);
    used.push(body.model);
    if (body.model === 'meta-llama/llama-4-scout-17b-16e-instruct') {
      return Response.json({ error: { code: 'model_not_found', message: 'The model `x` does not exist or you do not have access to it.' } }, { status: 404 });
    }
    if (body.model !== 'vision-model-90b') return Response.json({ error: { message: 'This model does not support image input' } }, { status: 400 });
    const isProbe = body.max_completion_tokens === 20;
    return Response.json({ choices: [{ message: { content: isProbe ? 'Red' : JSON.stringify(GOOD) } }] });
  });
  const env = { GROQ_API_KEY: 'q', GROQ_MODEL: 'meta-llama/llama-4-scout-17b-16e-instruct' };
  const r = await grade(INPUT, env);
  assert.strictEqual(r.totalAwarded, 6);
  assert.strictEqual(used.at(-1), 'vision-model-90b');
  used.length = 0;
  await grade(INPUT, env);
  assert.deepStrictEqual(used, ['vision-model-90b']); // straight to the remembered model
  resetForTests();
});

test('when no model can read images, the message says to type the answers', async (t) => {
  resetForTests();
  t.mock.method(console, 'error', () => {});
  t.mock.method(console, 'log', () => {});
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url).endsWith('/models')) return Response.json({ data: [{ id: 'text-only-70b' }] });
    const body = JSON.parse(init.body);
    if (body.model === 'meta-llama/llama-4-scout-17b-16e-instruct') return Response.json({ error: { code: 'model_not_found' } }, { status: 404 });
    return Response.json({ error: { message: 'model does not support image input' } }, { status: 400 });
  });
  await assert.rejects(grade(INPUT, { GROQ_API_KEY: 'q', GROQ_MODEL: 'meta-llama/llama-4-scout-17b-16e-instruct' }), /\[code: no-vision-model\]/);
  resetForTests();
  // With no model configured, it looks for one straight away.
  await assert.rejects(grade(INPUT, { GROQ_API_KEY: 'q' }), /\[code: no-vision-model\]/);
  resetForTests();
});

test('replies with <think> reasoning before the JSON are parsed', async (t) => {
  resetForTests();
  t.mock.method(console, 'error', () => {});
  const content = '<think>The student wrote {something} for Q1…</think>\n' + JSON.stringify(GOOD);
  t.mock.method(globalThis, 'fetch', async () => Response.json({ choices: [{ finish_reason: 'stop', message: { content } }] }));
  assert.strictEqual((await grade(INPUT, { GROQ_API_KEY: 'q', GROQ_MODEL: 'm' })).totalAwarded, 6);
});

test('Groq Qwen models: thinking is turned off, and the setting is dropped if rejected', async (t) => {
  resetForTests();
  t.mock.method(console, 'error', () => {});
  const bodies = [];
  const replies = [
    Response.json({ error: { message: '`reasoning_effort` is not supported with this model' } }, { status: 400 }),
    Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(GOOD) } }] }),
  ];
  t.mock.method(globalThis, 'fetch', async (url, init) => { bodies.push(JSON.parse(init.body)); return replies.shift(); });
  const r = await grade(INPUT, { GROQ_API_KEY: 'q', GROQ_MODEL: 'qwen/qwen3.6-27b' });
  assert.strictEqual(r.totalAwarded, 6);
  assert.strictEqual(bodies[0].reasoning_effort, 'none');
  assert.strictEqual(bodies[1].reasoning_effort, undefined);
});

test('Groq with no model set: lists models, picks the one that reads images, then marks', async (t) => {
  resetForTests();
  t.mock.method(console, 'error', () => {});
  t.mock.method(console, 'log', () => {});
  const used = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url).endsWith('/models')) {
      return Response.json({ data: [{ id: 'openai/gpt-oss-120b' }, { id: 'whisper-large-v3' }, { id: 'meta-llama/llama-prompt-guard-2-86m' }, { id: 'qwen/qwen3.6-27b' }] });
    }
    const body = JSON.parse(init.body);
    used.push(body.model);
    if (body.model !== 'qwen/qwen3.6-27b') return Response.json({ error: { message: 'messages[0].content must be a string' } }, { status: 400 });
    return Response.json({ choices: [{ message: { content: body.max_completion_tokens === 20 ? 'Red' : JSON.stringify(GOOD) } }] });
  });
  const r = await grade(INPUT, { GROQ_API_KEY: 'q' });
  assert.strictEqual(r.totalAwarded, 6);
  assert.strictEqual(used[0], 'qwen/qwen3.6-27b'); // ranked first, so only one test was needed
  assert.strictEqual(used.at(-1), 'qwen/qwen3.6-27b');
  resetForTests();
});
