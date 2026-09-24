// Grading engine. Calls an AI vision model from the server only: Google Gemini (has a free tier)
// or OpenAI. The browser never sees the provider, the key, or the prompt.

const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['studentName', 'rollNo', 'totalMaximum', 'questions', 'overallFeedback', 'warnings'],
  properties: {
    studentName: { type: 'string', description: 'Student name as written on the answer sheet, or empty string.' },
    rollNo: { type: 'string', description: 'Roll / register number as written on the answer sheet, or empty string.' },
    totalMaximum: { type: 'number', description: 'Maximum marks of the whole paper.' },
    questions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['question', 'studentAnswer', 'awarded', 'maximum', 'counted', 'comment'],
        properties: {
          question: { type: 'string', description: 'Question number/label as printed, e.g. "1", "2(b)".' },
          studentAnswer: { type: 'string', description: 'Very short summary of what the student wrote/drew, or "Not attempted".' },
          awarded: { type: 'number' },
          maximum: { type: 'number' },
          counted: {
            type: 'boolean',
            description: 'False only when this answer is excluded by a choice rule (e.g. extra answers beyond "answer any 5").',
          },
          comment: { type: 'string', description: 'Short reason for the marks awarded.' },
        },
      },
    },
    overallFeedback: { type: 'string' },
    warnings: {
      type: 'array',
      items: { type: 'string' },
      description: 'Problems the teacher should check: unreadable pages, missing pages, uncertain readings.',
    },
  },
};

const SYSTEM_PROMPT = `You are an experienced, fair school/college examiner. You grade a student's answer sheet (photos of handwritten or printed pages) against the question paper and the teacher's marking scheme.

How to grade:
1. Read the question paper and identify every question/sub-question and its maximum marks (marks are usually printed beside each question). If the teacher gives a total, the maxima must add up to it.
2. Read ALL answer-sheet pages. Students may answer out of order, continue answers on later pages, or label answers differently; match each answer to the right question. Ignore crossed-out work.
3. Grade each question with the marking scheme as the main authority. Where the scheme is silent, use the syllabus level and standard expectations for that subject and class.
4. Follow the teacher's instructions exactly. They override your default strictness (e.g. liberal checking, marks for diagrams alone, step marks).
5. Unless the teacher says otherwise: award partial marks for partially correct answers, use whole or half marks only, and never exceed a question's maximum.
6. List every question in the paper. If the student didn't attempt one, award 0 with studentAnswer "Not attempted".
7. Choice rules (e.g. "answer any 5 of 7"): if the student answered more than allowed, grade all of them, set counted=true only for the best allowed answers (or the first ones, if the paper says so) and counted=false for the rest.
8. If handwriting is unclear, make your best reasonable reading, grade it, and add a warning naming the question. Add warnings for missing or unreadable pages.
9. Read the student's name and roll number from the sheet if they're visible.
10. Keep comments short (one sentence) and specific, and write them for the teacher. overallFeedback: 2–3 sentences on the student's strengths and what to improve.`;

function textPart(text) {
  return { type: 'text', text };
}

function imageParts(files) {
  return files.map((f) => ({ type: 'image', mimetype: f.mimetype, data: Buffer.from(f.buffer).toString('base64') }));
}

function section(title, body) {
  const value = String(body ?? '').trim();
  return `## ${title}\n${value || '(not provided)'}`;
}

function instructionText(setup) {
  const presets = Array.isArray(setup.presets) ? setup.presets : [];
  return [...presets.map((p) => `- ${p}`), setup.instructions?.trim() && `- ${setup.instructions.trim()}`]
    .filter(Boolean)
    .join('\n');
}

// Provider-neutral list of text and image parts.
function buildParts({ setup, questionFiles, answerFiles }) {
  const content = [
    textPart(
      [
        section('Subject / class', [setup.subject, setup.className].filter(Boolean).join(' — ')),
        section('Total marks of the paper', setup.totalMarks),
        section('Syllabus', setup.syllabus),
        section('Marking scheme / answer key', setup.scheme),
        section('Additional details', setup.extra),
        section("Teacher's grading instructions", instructionText(setup)),
        section('Question paper (typed)', setup.questionText),
      ].join('\n\n'),
    ),
  ];

  if (questionFiles.length) {
    content.push(textPart(`## Question paper images (${questionFiles.length} page(s))`));
    content.push(...imageParts(questionFiles));
  }

  content.push(textPart(`## Student answer sheet (${answerFiles.length} page(s), in order)`));
  content.push(...imageParts(answerFiles));
  return content;
}

// OpenAI chat format.
function buildMessages(input) {
  const content = buildParts(input).map((p) =>
    p.type === 'text'
      ? p
      : { type: 'image_url', image_url: { url: `data:${p.mimetype};base64,${p.data}`, detail: 'high' } },
  );
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content },
  ];
}

// Gemini format.
function buildGeminiContents(input) {
  const parts = buildParts(input).map((p) =>
    p.type === 'text' ? { text: p.text } : { inlineData: { mimeType: p.mimetype, data: p.data } },
  );
  return [{ role: 'user', parts }];
}

// Gemini's responseSchema is an OpenAPI subset: upper-case types, no additionalProperties.
function toGeminiSchema(schema) {
  const out = { type: String(schema.type).toUpperCase() };
  if (schema.description) out.description = schema.description;
  if (schema.properties) {
    out.properties = Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, toGeminiSchema(v)]));
    out.propertyOrdering = Object.keys(schema.properties);
  }
  if (schema.required) out.required = schema.required;
  if (schema.items) out.items = toGeminiSchema(schema.items);
  return out;
}

function round(n) {
  return Math.round(Number(n) * 100) / 100;
}

const CAPPED = 'The question marks added up to more than the paper total, so the total was capped.';

// Clamp per-question marks and derive the total from the questions, so numbers always add up.
function normalize(result, teacherTotal) {
  const questions = (result.questions || []).map((q) => {
    const maximum = Math.max(0, round(q.maximum) || 0);
    const awarded = Math.min(maximum, Math.max(0, round(q.awarded) || 0));
    return {
      question: String(q.question ?? ''),
      studentAnswer: String(q.studentAnswer ?? ''),
      awarded,
      maximum,
      counted: q.counted !== false,
      comment: String(q.comment ?? ''),
    };
  });
  const counted = questions.filter((q) => q.counted);
  const warnings = (result.warnings || []).map(String);

  const fixedTotal = round(teacherTotal);
  const totalMaximum =
    fixedTotal > 0 ? fixedTotal : round(result.totalMaximum) || round(counted.reduce((s, q) => s + q.maximum, 0));

  let totalAwarded = round(counted.reduce((s, q) => s + q.awarded, 0));
  if (totalAwarded > totalMaximum) {
    totalAwarded = totalMaximum;
    if (!warnings.includes(CAPPED)) warnings.push(CAPPED);
  }

  return {
    studentName: String(result.studentName ?? ''),
    rollNo: String(result.rollNo ?? ''),
    totalAwarded,
    totalMaximum,
    percentage: totalMaximum ? round((totalAwarded / totalMaximum) * 100) : 0,
    questions,
    overallFeedback: String(result.overallFeedback ?? ''),
    warnings,
  };
}

function mockResult(setup) {
  const max = Number(setup.totalMarks) || 20;
  return normalize(
    {
      studentName: '',
      rollNo: '',
      totalMaximum: max,
      questions: [
        { question: '1', studentAnswer: 'Defined the term with an example', awarded: max * 0.4, maximum: max / 2, counted: true, comment: 'Correct method, minor calculation error.' },
        { question: '2', studentAnswer: 'Labelled diagram, short explanation', awarded: max * 0.3, maximum: max / 2, counted: true, comment: 'Diagram correct; explanation incomplete.' },
      ],
      overallFeedback: 'Demo mode result (MOCK_GRADER=1). No real grading was done.',
      warnings: [],
    },
    setup.totalMarks,
  );
}

class GradingError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BUSY = 'The marking service is busy right now. Please try again in a minute.';
const FAILED = 'The marking service could not process this request. Please try again.';
const UNREADABLE = 'This answer sheet could not be marked. Check that the photos are clear and try again.';

function providerName(env) {
  if (env.MOCK_GRADER === '1') return 'mock';
  const chosen = String(env.AI_PROVIDER || '').toLowerCase();
  if (chosen === 'gemini' || chosen === 'openai') return chosen;
  if (env.GEMINI_API_KEY) return 'gemini';
  if (env.OPENAI_API_KEY) return 'openai';
  return 'none';
}

async function postJson(url, headers, body, env) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Number(env.AI_TIMEOUT_MS || env.OPENAI_TIMEOUT_MS) || 240000),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, ok: res.ok, json, text };
  } catch (err) {
    return { status: 0, ok: false, json: null, text: String(err) };
  }
}

function parseResultText(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new GradingError('The marking result was incomplete. Please try again.');
  }
}

// ---------------- OpenAI ----------------

// Reasoning models (gpt-5*, o-series) reject a custom temperature.
function isReasoningModel(model) {
  return /^(gpt-5|o\d)/i.test(model);
}

async function gradeWithOpenAI(input, env) {
  const model = env.OPENAI_MODEL || 'gpt-4.1';
  const body = {
    model,
    messages: buildMessages(input),
    max_completion_tokens: isReasoningModel(model) ? 32000 : 8000,
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'grading_result', strict: true, schema: RESULT_SCHEMA },
    },
  };
  if (!isReasoningModel(model)) body.temperature = 0;

  const url = `${env.OPENAI_BASE_URL || 'https://api.openai.com/v1'}/chat/completions`;
  for (let attempt = 1; ; attempt++) {
    const res = await postJson(url, { Authorization: `Bearer ${env.OPENAI_API_KEY}` }, body, env);
    if (res.ok) {
      const message = res.json?.choices?.[0]?.message;
      if (!message || message.refusal || !message.content) throw new GradingError(UNREADABLE, 422);
      return parseResultText(message.content);
    }
    console.error(`OpenAI error (attempt ${attempt})`, res.status, res.text.slice(0, 800));
    const retryable = res.status === 0 || res.status === 429 || res.status >= 500;
    if (retryable && attempt < 3) {
      await sleep(2000 * attempt ** 2);
      continue;
    }
    if (res.status === 429) throw new GradingError(BUSY, 503);
    throw new GradingError(FAILED);
  }
}

// ---------------- Gemini ----------------

function geminiRetryDelayMs(json) {
  const info = json?.error?.details?.find((d) => String(d['@type']).includes('RetryInfo'));
  const seconds = parseFloat(info?.retryDelay);
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}

function geminiDailyQuotaHit(json) {
  const failure = json?.error?.details?.find((d) => String(d['@type']).includes('QuotaFailure'));
  return Boolean(failure?.violations?.some((v) => /PerDay/i.test(String(v.quotaId))));
}

async function gradeWithGemini(input, env) {
  const models = [env.GEMINI_MODEL || 'gemini-flash-latest'];
  if (!env.GEMINI_MODEL) models.push('gemini-2.5-flash'); // fallback if the alias is unavailable
  const base = env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta';
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: buildGeminiContents(input),
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: toGeminiSchema(RESULT_SCHEMA),
      maxOutputTokens: 32768,
    },
  };

  let modelIndex = 0;
  for (let attempt = 1; ; attempt++) {
    const model = models[modelIndex];
    const res = await postJson(`${base}/models/${encodeURIComponent(model)}:generateContent`, { 'x-goog-api-key': env.GEMINI_API_KEY }, body, env);

    if (res.ok) {
      const candidate = res.json?.candidates?.[0];
      if (res.json?.promptFeedback?.blockReason || !candidate) throw new GradingError(UNREADABLE, 422);
      const text = (candidate.content?.parts || [])
        .filter((p) => !p.thought && typeof p.text === 'string')
        .map((p) => p.text)
        .join('');
      if (!text) throw new GradingError(UNREADABLE, 422);
      if (candidate.finishReason === 'MAX_TOKENS') {
        throw new GradingError('The answer sheet is too long to mark in one go. Try fewer pages.', 422);
      }
      return parseResultText(text);
    }

    console.error(`Gemini error (${model}, attempt ${attempt})`, res.status, res.text.slice(0, 800));
    if (res.status === 404 && modelIndex < models.length - 1) {
      modelIndex += 1;
      continue;
    }
    if (res.status === 429 && geminiDailyQuotaHit(res.json)) {
      throw new GradingError("Today's free marking limit has been reached. Please try again tomorrow.", 429);
    }
    const retryable = res.status === 0 || res.status === 429 || res.status >= 500;
    if (retryable && attempt < 4) {
      const wait = geminiRetryDelayMs(res.json) ?? 3000 * attempt ** 2;
      await sleep(Math.min(wait + 500, 65000));
      continue;
    }
    if (res.status === 429 || res.status === 503) throw new GradingError(BUSY, 503);
    throw new GradingError(FAILED);
  }
}

// Startup self-check so setup mistakes (bad key, unknown model) show up clearly in the server logs.
async function checkProvider(env = process.env) {
  const provider = providerName(env);
  if (provider === 'mock') return { ok: true, message: 'Demo mode (MOCK_GRADER=1): fake marks, no AI calls.' };
  if (provider === 'none') return { ok: false, message: 'No GEMINI_API_KEY or OPENAI_API_KEY set. Marking will not work.' };
  const [url, headers, model] =
    provider === 'gemini'
      ? [
          `${env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta'}/models/${env.GEMINI_MODEL || 'gemini-flash-latest'}`,
          { 'x-goog-api-key': env.GEMINI_API_KEY },
          env.GEMINI_MODEL || 'gemini-flash-latest',
        ]
      : [
          `${env.OPENAI_BASE_URL || 'https://api.openai.com/v1'}/models/${env.OPENAI_MODEL || 'gpt-4.1'}`,
          { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
          env.OPENAI_MODEL || 'gpt-4.1',
        ];
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    if (res.ok) return { ok: true, message: `${provider} key OK, model "${model}" available.` };
    const text = (await res.text()).slice(0, 300).replace(/\s+/g, ' ');
    return { ok: false, message: `${provider} check failed (HTTP ${res.status}) for model "${model}": ${text}` };
  } catch (err) {
    return { ok: false, message: `${provider} check could not connect: ${err.message}` };
  }
}

async function grade(input, env = process.env) {
  const provider = providerName(env);
  if (provider === 'mock') return mockResult(input.setup);
  let raw;
  if (provider === 'gemini' && env.GEMINI_API_KEY) raw = await gradeWithGemini(input, env);
  else if (provider === 'openai' && env.OPENAI_API_KEY) raw = await gradeWithOpenAI(input, env);
  else throw new GradingError('Marking is not configured on the server yet.', 503);
  return normalize(raw, input.setup.totalMarks);
}

module.exports = {
  grade,
  normalize,
  buildMessages,
  buildGeminiContents,
  toGeminiSchema,
  instructionText,
  providerName,
  checkProvider,
  GradingError,
  RESULT_SCHEMA,
};
