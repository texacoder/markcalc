// Grading engine. Calls an AI vision model from the server only: GitHub Models (free GPT-4.1),
// Google Gemini (free tier) or OpenAI. The browser never sees the provider, the key, or the prompt.

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

const SYSTEM_PROMPT = `You are an experienced, fair examiner. The exam can be from any level: school, college, university or a professional course. You grade a student's answer sheet (photos of handwritten or printed pages) against the question paper and the teacher's marking scheme.

How to grade:
1. Read the question paper and identify every question/sub-question and its maximum marks (marks are usually printed beside each question). If the teacher gives a total, the maxima must add up to it.
2. Read ALL of the student's answers (answer-sheet images and/or typed answers). Students may answer out of order, continue answers on later pages, or label answers differently; match each answer to the right question. Ignore crossed-out work.
3. Grade each question with the marking scheme as the main authority. Where the scheme is silent, use the syllabus and the standard expectations for that subject and level (class, course or year).
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
function buildParts({ setup, questionFiles = [], answerFiles = [], syllabusFiles = [], schemeFiles = [] }) {
  const content = [
    textPart(
      [
        section('Subject / class or course', [setup.subject, setup.className].filter(Boolean).join(' — ')),
        section('Total marks of the paper', setup.totalMarks),
        section('Syllabus', setup.syllabus),
        section('Marking scheme / answer key', setup.scheme),
        section('Additional details', setup.extra),
        section("Teacher's grading instructions", instructionText(setup)),
        section('Question paper (typed)', setup.questionText),
      ].join('\n\n'),
    ),
  ];

  const images = (title, files) => {
    if (!files.length) return;
    content.push(textPart(`## ${title} (${files.length} page image(s), in order)`));
    content.push(...imageParts(files));
  };
  images('Syllabus', syllabusFiles);
  images('Marking scheme / answer key', schemeFiles);
  images('Question paper', questionFiles);

  const typedAnswers = String(setup.answerText || '').trim();
  if (typedAnswers) content.push(textPart(`## Student's answers (typed)\n${typedAnswers}`));
  images('Student answer sheet', answerFiles);
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
  if (!questions.length) warnings.push('No questions could be identified. Check the question paper and the photos.');

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
  if (['gemini', 'groq', 'openrouter', 'custom', 'github', 'openai'].includes(chosen)) return chosen;
  if (env.GEMINI_API_KEY) return 'gemini';
  if (env.GROQ_API_KEY) return 'groq';
  if (env.OPENROUTER_API_KEY) return 'openrouter';
  if (env.AI_BASE_URL && env.AI_API_KEY) return 'custom';
  if (env.GITHUB_MODELS_TOKEN) return 'github';
  if (env.OPENAI_API_KEY) return 'openai';
  return 'none';
}

// GitHub Models' free tier caps input at ~8000 tokens per request. Estimate before sending so the
// user gets a clear message instead of a failed marking. Returns an error message or ''.
const PROMPT_OVERHEAD_TOKENS = 1400; // system prompt + JSON schema + section headings
const TOKENS_PER_PAGE = 765; // one portrait page at GPT-4.1 "high" detail
function requestTooLarge(input, env) {
  if (providerName(env) !== 'github') return '';
  const budget = Number(env.GITHUB_TOKEN_BUDGET) || 8000;
  const text = ['subject', 'className', 'totalMarks', 'syllabus', 'scheme', 'extra', 'questionText', 'instructions', 'answerText']
    .map((k) => String(input.setup[k] || ''))
    .join('') + instructionText(input.setup);
  const images = ['syllabusFiles', 'schemeFiles', 'questionFiles', 'answerFiles'].reduce((n, k) => n + (input[k]?.length || 0), 0);
  const estimate = PROMPT_OVERHEAD_TOKENS + Math.ceil(text.length / 3.5) + images * TOKENS_PER_PAGE;
  if (estimate <= budget) return '';
  const spareChars = Math.max(0, Math.floor((budget - PROMPT_OVERHEAD_TOKENS - images * TOKENS_PER_PAGE) * 3.5));
  return (
    `This is more than the free marking service can read at once (about ${estimate} of ${budget} units). ` +
    `With ${images} page image${images === 1 ? '' : 's'}, the typed text (syllabus, scheme, questions, answers) can be about ${spareChars} characters; ` +
    `it is ${text.length}. Shorten the syllabus (it is optional), keep the scheme to key points, or use fewer page images.`
  );
}

// Most pages (question paper + answer sheet) the provider can read in one marking.
// GitHub Models' free tier allows ~8000 input tokens per request (~765 tokens per page).
function maxPages(env) {
  const configured = Number(env.MAX_PAGES);
  if (configured > 0) return configured;
  // Groq's vision models take at most 5 images per request; free OpenRouter models are kept small too.
  return { github: 7, groq: 5, openrouter: 10, custom: 20 }[providerName(env)] || 40;
}

// Drop headers set to null/undefined (lets a caller remove a default).
function cleanHeaders(h) {
  return Object.fromEntries(Object.entries(h).filter(([, v]) => v != null));
}

async function postJson(url, headers, body, env) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: cleanHeaders({ 'Content-Type': 'application/json', Accept: 'application/json', ...headers }),
      body: JSON.stringify(body),
      // A redirect would silently turn this POST into a GET of some other page; treat it as an error.
      redirect: 'manual',
      signal: AbortSignal.timeout(Number(env.AI_TIMEOUT_MS || env.OPENAI_TIMEOUT_MS) || 240000),
    });
    let text = await res.text();
    if (res.status >= 300 && res.status < 400) text = `redirect to ${res.headers.get('location')} ${text}`;
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    const ok = res.status >= 200 && res.status < 300;
    return { status: res.status, ok, json, text, contentType: res.headers.get('content-type') || '' };
  } catch (err) {
    // Network-level failure: keep the underlying reason (ENOTFOUND, ECONNRESET, timeout…).
    const cause = err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : err?.cause?.code || err?.code || 'network';
    return { status: 0, ok: false, json: null, text: `${err} (${cause}) ${err?.cause?.message || ''}`, cause };
  }
}

// Short description of an unexpected reply, safe to show to users (no provider names or content).
function describeReply(res) {
  if (res.status === 0) return `network-${res.cause}`;
  if (res.json && typeof res.json === 'object') return `${res.status}-keys:${Object.keys(res.json).slice(0, 4).join('.') || 'none'}`;
  const t = String(res.text || '').trim();
  if (!t) return `${res.status}-empty`;
  if (t.startsWith('<')) return `${res.status}-html`;
  if (/^(data|event):/m.test(t)) return `${res.status}-stream`;
  return `${res.status}-text`;
}

// The reply's text in any of the shapes an OpenAI-compatible service may use:
// a chat completion, a streamed chat completion (server-sent events), or the newer "responses" format.
function replyText(res) {
  const j = res.json;
  if (j) {
    const fromChat = messageText(j.choices?.[0]?.message);
    if (fromChat) return fromChat;
    if (typeof j.output_text === 'string' && j.output_text) return j.output_text;
    if (Array.isArray(j.output)) {
      const parts = j.output.flatMap((o) => (Array.isArray(o?.content) ? o.content : [])).map((c) => c?.text || '');
      if (parts.join('')) return parts.join('');
    }
    return '';
  }
  const t = String(res.text || '');
  if (/^data:/m.test(t)) {
    let out = '';
    for (const line of t.split('\n')) {
      const data = line.startsWith('data:') ? line.slice(5).trim() : '';
      if (!data || data === '[DONE]') continue;
      try {
        const chunk = JSON.parse(data);
        out += chunk.choices?.[0]?.delta?.content || messageText(chunk.choices?.[0]?.message) || '';
      } catch {}
    }
    return out;
  }
  return '';
}

function parseResultText(text) {
  // Tolerate a reply wrapped in ```json fences, with text around the JSON object, or with the
  // model's reasoning in <think>…</think> first (Qwen and other "thinking" models).
  const raw = String(text)
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^[\s\S]*<\/think>/i, '')
    .trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  try {
    return JSON.parse(start >= 0 && end > start ? raw.slice(start, end + 1) : raw);
  } catch {
    console.error('Unparseable marking reply:', raw.slice(0, 500));
    throw new GradingError('The marking result was incomplete. Please try again. [code: parse]');
  }
}

// Text of a chat message whose content may be a string or a list of parts.
function messageText(message) {
  const c = message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('');
  return '';
}

const FILTERED =
  "The marking service's automatic safety filter stopped this request. This sometimes happens by mistake. Please try again. [code: filter]";
const DECLINED = 'The marking service declined to mark this sheet. Please try again. [code: declined]';

// ---------------- OpenAI ----------------

// Reasoning models (gpt-5*, o-series) reject a custom temperature.
function isReasoningModel(model) {
  return /^(gpt-5|o\d)/i.test(model);
}

const TOO_BIG = 'Too much to read in one go. Use fewer pages, or type the questions in the exam setup instead of uploading question-paper photos.';

// Header sets for GitHub Models. Some combinations get a plain-text "OK" instead of a model reply,
// so the grader tries them in order and remembers the first one that returns a real completion.
const GITHUB_VARIANTS = [
  { name: 'json', headers: { Accept: 'application/json', 'User-Agent': 'markcalc/1.0' } },
  { name: 'github', headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'markcalc/1.0' } },
  { name: 'json+version', headers: { Accept: 'application/json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'markcalc/1.0' } },
  { name: 'any', headers: { Accept: '*/*', 'User-Agent': 'markcalc/1.0' } },
];
let githubVariant = 0;

// OpenAI and GitHub Models share the same chat-completions format.
function openAICompatibleConfig(env, provider) {
  if (provider === 'github') {
    return {
      label: 'GitHub Models',
      url: `${env.GITHUB_MODELS_BASE_URL || 'https://models.github.ai/inference'}/chat/completions`,
      key: env.GITHUB_MODELS_TOKEN,
      model: env.GITHUB_MODEL || 'openai/gpt-4.1',
      maxTokensField: 'max_tokens',
      maxTokens: 4000,
      variants: GITHUB_VARIANTS,
      variant: githubVariant,
      headers: GITHUB_VARIANTS[githubVariant].headers,
    };
  }
  if (provider === 'groq') {
    return {
      label: 'Groq',
      url: 'https://api.groq.com/openai/v1/chat/completions',
      modelsUrl: 'https://api.groq.com/openai/v1/models',
      key: env.GROQ_API_KEY,
      // No fixed default: Groq retires models often, so one that reads images is picked automatically.
      model: env.GROQ_MODEL || '',
      maxTokensField: 'max_completion_tokens',
      maxTokens: 4000,
    };
  }
  if (provider === 'openrouter') {
    return {
      label: 'OpenRouter',
      url: 'https://openrouter.ai/api/v1/chat/completions',
      modelsUrl: 'https://openrouter.ai/api/v1/models',
      key: env.OPENROUTER_API_KEY,
      model: env.OPENROUTER_MODEL || '',
      headers: { 'HTTP-Referer': env.SITE_URL || 'https://github.com/texacoder/markcalc', 'X-Title': 'Mark Calculator' },
      maxTokensField: 'max_tokens',
      maxTokens: 4000,
    };
  }
  if (provider === 'custom') {
    const base = String(env.AI_BASE_URL || '').replace(/\/+$/, '');
    return {
      label: 'Custom AI',
      url: `${base}/chat/completions`,
      modelsUrl: `${base}/models`,
      key: env.AI_API_KEY,
      model: env.AI_MODEL || '',
      maxTokensField: 'max_tokens',
      maxTokens: 4000,
    };
  }
  const model = env.OPENAI_MODEL || 'gpt-4.1';
  const base = env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
  return {
    label: 'OpenAI',
    url: `${base}/chat/completions`,
    modelsUrl: `${base}/models`,
    key: env.OPENAI_API_KEY,
    model,
    maxTokensField: 'max_completion_tokens',
    maxTokens: isReasoningModel(model) ? 32000 : 8000,
  };
}

// Which of a service's models can read images, for the self-test report.
function visionModels(provider, list) {
  if (provider === 'openrouter') {
    return list
      .filter((m) => (m.architecture?.input_modalities || []).includes('image'))
      .map((m) => m.id)
      .sort((a, b) => Number(b.endsWith(':free')) - Number(a.endsWith(':free')))
      .slice(0, 15);
  }
  return list.map((m) => m.id).filter((id) => /vision|llama-4|scout|maverick|gpt-4\.1|gpt-4o|gpt-5|pixtral|gemma-3|qwen.*vl/i.test(id)).slice(0, 15);
}

// A 64×64 red PNG used to test whether a model can read images (some models reject images under 32 px).
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAeUlEQVR4nO3PQQkAMAzAwCqpf1ETMxF7HINABFzm7H7dcEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFj13PLIEAOXyUUwAAAABJRU5ErkJggg==';

// ---------------- choosing a model automatically ----------------
// Free services rename and retire models often. When the configured model is missing or can't read
// images, list the service's models and send each likely one a tiny test; use the first that works.

const TINY_IMAGE_MESSAGE = [
  {
    role: 'user',
    content: [
      { type: 'text', text: 'What colour is this image? Answer with one word.' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${TINY_PNG}` } },
    ],
  },
];
const TINY_TEXT_MESSAGE = [{ role: 'user', content: 'Reply with the single word OK.' }];
const NOT_CHAT_MODEL = /whisper|tts|speech|audio|guard|playai|orpheus|distil|embed|rerank|moderation|transcri|allam/i;
const discoveredModels = {}; // "<label>:vision|text" -> model id, or null if none works

function rankModel(id) {
  const s = id.toLowerCase();
  let score = 0;
  if (/maverick/.test(s)) score += 10;
  if (/scout/.test(s)) score += 9;
  if (/vl\b|vl-|vision|multimodal|omni|pixtral/.test(s)) score += 8;
  if (/llama-4|gpt-4|gpt-5|gemma-3|qwen3|qwen-?2\.5|kimi|mistral/.test(s)) score += 4;
  const size = Number((s.match(/(\d+)b\b/) || [])[1] || 0);
  score += Math.min(size, 400) / 100;
  if (/:free$/.test(s)) score += 1;
  return score;
}

async function listModels(cfg) {
  const r = await fetch(cfg.modelsUrl, {
    headers: { Authorization: `Bearer ${cfg.key}`, Accept: 'application/json', ...cfg.headers },
    signal: AbortSignal.timeout(20000),
  });
  const j = await r.json().catch(() => ({}));
  return Array.isArray(j.data) ? j.data : [];
}

// Candidate chat models, best first. OpenRouter reports which models take images, so use that.
function candidateModels(cfg, list, needImages) {
  let models = list.filter((m) => m.active !== false && !NOT_CHAT_MODEL.test(m.id));
  if (cfg.label === 'OpenRouter') {
    if (needImages) models = models.filter((m) => (m.architecture?.input_modalities || []).includes('image'));
    models = models.filter((m) => m.id.endsWith(':free'));
  }
  return models.map((m) => m.id).sort((a, b) => rankModel(b) - rankModel(a));
}

async function tryModel(cfg, model, needImages, env) {
  const res = await postJson(
    cfg.url,
    { Authorization: `Bearer ${cfg.key}`, ...cfg.headers },
    { model, [cfg.maxTokensField]: 20, messages: needImages ? TINY_IMAGE_MESSAGE : TINY_TEXT_MESSAGE },
    { ...env, AI_TIMEOUT_MS: '30000' },
  );
  return { model, ok: res.ok && !!replyText(res), status: res.status, reply: replyText(res).slice(0, 40), error: res.ok ? '' : String(res.text).slice(0, 160) };
}

async function discoverModel(cfg, env, needImages, { maxTries = 8 } = {}) {
  const key = `${cfg.label}:${needImages ? 'vision' : 'text'}`;
  if (key in discoveredModels) return discoveredModels[key];
  let found = null;
  try {
    const candidates = candidateModels(cfg, await listModels(cfg), needImages).slice(0, maxTries);
    for (const id of candidates) {
      const r = await tryModel(cfg, id, needImages, env);
      console.error(`${cfg.label}: model test ${id} (${needImages ? 'image' : 'text'}): ${r.ok ? 'works' : `no (${r.status})`}`);
      if (r.ok) {
        found = id;
        break;
      }
    }
  } catch (err) {
    console.error(`${cfg.label}: could not list models:`, err.message);
    return null; // don't cache a network failure
  }
  discoveredModels[key] = found;
  console.log(`${cfg.label}: ${found ? `using model "${found}"` : `no model that can ${needImages ? 'read images' : 'chat'} was found`}`);
  return found;
}

const hasImages = (input) => ['syllabusFiles', 'schemeFiles', 'questionFiles', 'answerFiles'].some((k) => input[k]?.length);
const MODEL_PROBLEM = /model_not_found|model.{0,40}(does not exist|not found|decommissioned|deprecated|no longer|not supported|unavailable)|image.{0,40}not supported|does not support (image|vision|multimodal)|not a (vision|multimodal) model|image_url.{0,40}(not|unsupported)|content must be a string/i;
const NO_VISION =
  "The AI service connected to this site can't read images at the moment. Type or paste the student's answers instead, or ask the site owner to switch to a service that reads images. [code: no-vision-model]";

async function gradeWithOpenAICompatible(input, env, provider) {
  const cfg = openAICompatibleConfig(env, provider);
  const messages = buildMessages(input);
  const body = {
    model: cfg.model,
    messages,
    [cfg.maxTokensField]: cfg.maxTokens,
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'grading_result', strict: true, schema: RESULT_SCHEMA },
    },
  };
  if (!isReasoningModel(cfg.model.replace(/^openai\//, ''))) body.temperature = 0;

  // A model found automatically earlier replaces a configured one that didn't work.
  const needImages = hasImages(input);
  const discoveredKey = `${cfg.label}:${needImages ? 'vision' : 'text'}`;
  if (cfg.modelsUrl && discoveredModels[discoveredKey]) body.model = cfg.model = discoveredModels[discoveredKey];
  let modelSwitched = false;

  // Qwen 3 models on Groq think out loud by default, which can use up the reply length; turn that off.
  let reasoningParamRejected = false;
  const tuneForModel = () => {
    if (provider === 'groq' && /qwen3/i.test(body.model) && !reasoningParamRejected) body.reasoning_effort = 'none';
    else delete body.reasoning_effort;
  };
  // No model configured: pick one before the first request.
  if (!body.model && cfg.modelsUrl) {
    const found = await discoverModel(cfg, env, needImages);
    if (!found) {
      if (needImages) throw new GradingError(NO_VISION, 422);
      throw new GradingError(`${FAILED} [code: no-model]`);
    }
    body.model = cfg.model = found;
    modelSwitched = true;
  }
  tuneForModel();

  // Output format, stepping down when a service rejects one or returns nothing usable:
  // strict JSON schema → JSON mode with the schema in the prompt → the same prompt without response_format.
  let mode = 'schema';
  const nextMode = () => {
    if (mode === 'plain') return false;
    mode = mode === 'schema' ? 'json' : 'plain';
    messages[0] = {
      role: 'system',
      content: `${SYSTEM_PROMPT}\n\nReply with ONLY a JSON object (no other text) that matches this JSON Schema:\n${JSON.stringify(RESULT_SCHEMA)}`,
    };
    if (mode === 'json') body.response_format = { type: 'json_object' };
    else delete body.response_format;
    console.error(`${cfg.label}: switching output format to "${mode}"`);
    return true;
  };

  // The first problem seen, so later attempts don't hide it.
  let firstProblem = '';
  const fail = (message, code, status = 502) =>
    new GradingError(`${message} [code: ${firstProblem && firstProblem !== code ? `${firstProblem}; then ${code}` : code}]`, status);
  // GitHub Models: try the next header combination. Returns false when none are left.
  let variantsTried = 1;
  const useNextVariant = (problem) => {
    firstProblem ||= problem;
    if (!cfg.variants || variantsTried >= cfg.variants.length) return false;
    cfg.variant = (cfg.variant + 1) % cfg.variants.length;
    cfg.headers = cfg.variants[cfg.variant].headers;
    variantsTried += 1;
    console.error(`${cfg.label}: got "${problem}", retrying with header set "${cfg.variants[cfg.variant].name}"`);
    return true;
  };
  const worked = () => {
    if (cfg.variants && githubVariant !== cfg.variant) {
      githubVariant = cfg.variant;
      console.log(`${cfg.label}: using header set "${cfg.variants[cfg.variant].name}" from now on`);
    }
  };

  let networkRetries = 0;
  for (let attempt = 1; attempt <= 8; attempt++) {
    const res = await postJson(cfg.url, { Authorization: `Bearer ${cfg.key}`, ...cfg.headers }, body, env);

    if (res.ok) {
      const choice = res.json?.choices?.[0];
      const message = choice?.message;
      const text = replyText(res);
      if (text && !message?.refusal) {
        worked();
        return parseResultText(text);
      }

      if (!choice) {
        // Not a chat completion: log the raw reply so the cause can be seen in the server logs.
        const shape = describeReply(res);
        console.error(`${cfg.label}: unexpected reply (attempt ${attempt}) from ${cfg.url}`, res.status, res.contentType, res.text.slice(0, 1500));
        if (JSON.stringify(res.json?.prompt_filter_results || '').includes('"filtered":true')) throw new GradingError(FILTERED, 422);
        if (useNextVariant(`reply-${shape}`)) continue;
        throw fail(UNREADABLE, `reply-${shape}`, 422);
      }

      // A chat completion without usable content: record why, then retry once in JSON mode.
      const reason = choice.finish_reason || 'none';
      console.error(
        `${cfg.label}: reply had no marks (attempt ${attempt})`,
        JSON.stringify({
          finish_reason: reason,
          refusal: message?.refusal || null,
          content_filter_results: choice.content_filter_results,
          prompt_filter_results: res.json?.prompt_filter_results,
          model: res.json?.model,
          usage: res.json?.usage,
          message_keys: message ? Object.keys(message) : null,
        }).slice(0, 2000),
      );
      if (nextMode()) continue;
      if (reason === 'content_filter') throw new GradingError(FILTERED, 422);
      if (message?.refusal) throw new GradingError(DECLINED, 422);
      if (reason === 'length') throw new GradingError(`${TOO_BIG} [code: length]`, 413);
      throw fail(UNREADABLE, `empty-${reason}`, 422);
    }

    console.error(`${cfg.label} error (attempt ${attempt}) from ${cfg.url}`, res.status, res.text.slice(0, 800));
    const shape = describeReply(res);

    if (res.status === 400 && body.reasoning_effort && /reasoning/i.test(res.text)) {
      reasoningParamRejected = true;
      tuneForModel();
      continue;
    }

    // The model is missing, retired or can't read images: pick one that works.
    if ((res.status === 404 || res.status === 400) && MODEL_PROBLEM.test(res.text) && cfg.modelsUrl) {
      if (!modelSwitched) {
        modelSwitched = true;
        const found = await discoverModel(cfg, env, needImages);
        if (found && found !== body.model) {
          body.model = cfg.model = found;
          tuneForModel();
          continue;
        }
      }
      if (needImages) throw new GradingError(NO_VISION, 422);
      throw fail(FAILED, `model-${res.status}`);
    }

    // Some endpoints don't support strict JSON schemas: fall back to JSON mode with the schema in the prompt.
    if (res.status === 400 && /response_format|json_schema|json_object|structured|json mode|json_validate/i.test(res.text) && nextMode()) {
      continue;
    }
    if (res.status === 400 && /content_filter|ResponsibleAIPolicyViolation|content management policy/i.test(res.text)) {
      if (attempt < 2) continue;
      throw new GradingError(FILTERED, 422);
    }
    if (res.status === 413 || /tokens_limit_reached|too large|maximum context|max.*tokens/i.test(res.text)) {
      throw new GradingError(TOO_BIG, 413);
    }
    if (res.status === 429 && /86400|per day|daily|ByDay/i.test(res.text)) {
      throw new GradingError("Today's free marking limit has been reached. Please try again tomorrow.", 429);
    }
    // Temporary problems: wait and retry (not for addresses that don't exist).
    const permanentNetwork = res.status === 0 && ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'CERT_HAS_EXPIRED'].includes(res.cause);
    const temporary = (res.status === 0 && !permanentNetwork) || res.status === 429 || res.status >= 500;
    if (temporary && networkRetries < 2) {
      networkRetries += 1;
      await sleep(res.status === 429 ? 15000 * networkRetries : 2000 * networkRetries ** 2);
      continue;
    }
    if ((res.status >= 300 && res.status < 400) || [403, 404, 405, 406, 415].includes(res.status)) {
      if (useNextVariant(`http-${shape}`)) continue;
    }
    if (res.status === 429) throw fail(BUSY, `http-${shape}`, 503);
    if (res.status === 401 || res.status === 403) console.error(`${cfg.label}: the key/token is invalid or lacks permission.`);
    throw fail(FAILED, res.status === 401 || res.status === 403 ? `auth-${res.status}` : `http-${shape}`);
  }
  throw fail(FAILED, 'too-many-attempts');
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
      if (res.json?.promptFeedback?.blockReason || !candidate) {
        console.error('Gemini: blocked or empty reply', JSON.stringify(res.json?.promptFeedback || res.json).slice(0, 1500));
        throw new GradingError(FILTERED, 422);
      }
      const text = (candidate.content?.parts || [])
        .filter((p) => !p.thought && typeof p.text === 'string')
        .map((p) => p.text)
        .join('');
      if (!text) {
        console.error('Gemini: reply had no text', JSON.stringify({ finishReason: candidate.finishReason, safetyRatings: candidate.safetyRatings }).slice(0, 1500));
        throw new GradingError(`${UNREADABLE} [code: empty-${candidate.finishReason || 'none'}]`, 422);
      }
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

// On-demand connection test (GET /api/selftest): three tiny requests (plain text, strict JSON schema,
// an image) against the configured OpenAI-compatible endpoint(s), reporting exactly what came back.
async function selfTest(env = process.env) {
  const provider = providerName(env);
  if (!['github', 'openai', 'groq', 'openrouter', 'custom'].includes(provider)) {
    return { provider, note: 'The self-test covers Groq, OpenRouter, GitHub Models, OpenAI and custom services.' };
  }
  const cfg = openAICompatibleConfig(env, provider);
  const auth = { Authorization: `Bearer ${cfg.key}` };
  const quickEnv = { ...env, AI_TIMEOUT_MS: '60000' };
  const summary = (res, started) => ({
    status: res.status,
    contentType: res.contentType || '',
    shape: describeReply(res),
    replyText: replyText(res).slice(0, 200),
    rawStart: String(res.text || '').slice(0, 300),
    ms: Date.now() - started,
  });
  const run = async (headers, extra) => {
    const started = Date.now();
    const res = await postJson(cfg.url, { ...auth, ...cfg.headers, ...headers }, { model: cfg.model, [cfg.maxTokensField]: 50, ...extra }, quickEnv);
    return summary(res, started);
  };
  const plain = { messages: [{ role: 'user', content: 'Reply with the single word OK.' }] };
  const schema = {
    messages: [{ role: 'user', content: 'Set ok to true.' }],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'check', strict: true, schema: { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' } } } },
    },
  };
  const image = {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What colour is this image? One word.' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${TINY_PNG}`, detail: 'high' } },
        ],
      },
    ],
  };

  const report = { provider, endpoint: cfg.url, model: cfg.model };

  // GitHub: the model catalogue (does the token work, does the model id exist?) and each header set.
  if (provider === 'github') {
    try {
      const started = Date.now();
      const r = await fetch('https://models.github.ai/catalog/models', {
        headers: { ...auth, Accept: 'application/json', 'User-Agent': 'markcalc/1.0' },
        signal: AbortSignal.timeout(20000),
      });
      const text = await r.text();
      let ids = [];
      try {
        ids = JSON.parse(text).map((m) => m.id);
      } catch {}
      report.catalog = {
        status: r.status,
        models: ids.length,
        modelListed: ids.includes(cfg.model),
        visionModels: ids.filter((id) => /gpt-4\.1|gpt-4o|gpt-5|llama-4|phi-4-multimodal/i.test(id)).slice(0, 12),
        rawStart: ids.length ? '' : text.slice(0, 300),
        ms: Date.now() - started,
      };
    } catch (err) {
      report.catalog = { error: String(err), cause: err?.cause?.code };
    }
    try {
      const r = await fetch('https://api.github.com/user', {
        headers: { ...auth, Accept: 'application/vnd.github+json', 'User-Agent': 'markcalc/1.0' },
        signal: AbortSignal.timeout(20000),
      });
      const text = await r.text();
      let login = '';
      try {
        login = JSON.parse(text).login || '';
      } catch {}
      report.githubApi = { status: r.status, login, rawStart: login ? '' : text.slice(0, 200) };
    } catch (err) {
      report.githubApi = { error: String(err) };
    }
    report.headerSets = [];
    let working = null;
    for (const v of GITHUB_VARIANTS) {
      const r = await run(v.headers, plain);
      report.headerSets.push({ name: v.name, ...r });
      if (r.replyText && !working) {
        working = v;
        break;
      }
    }
    report.workingHeaderSet = working ? working.name : 'none';
    if (!working) return report;
    report.schemaTest = await run(working.headers, schema);
    report.imageTest = await run(working.headers, image);
    return report;
  }

  try {
    const started = Date.now();
    const r = await fetch(cfg.modelsUrl, { headers: { ...auth, Accept: 'application/json', ...cfg.headers }, signal: AbortSignal.timeout(20000) });
    const text = await r.text();
    let list = [];
    try {
      list = JSON.parse(text).data || [];
    } catch {}
    report.models = {
      status: r.status,
      count: list.length,
      modelListed: list.some((m) => m.id === cfg.model),
      all: provider === 'openrouter' ? undefined : list.map((m) => m.id),
      rawStart: list.length ? '' : text.slice(0, 300),
      ms: Date.now() - started,
    };
    // Test which models can actually read an image (best-looking first).
    if (list.length) {
      const candidates = candidateModels(cfg, list, true).slice(0, provider === 'openrouter' ? 6 : 12);
      report.imageCheck = [];
      for (const id of candidates) report.imageCheck.push(await tryModel(cfg, id, true, quickEnv));
      const working = report.imageCheck.find((x) => x.ok);
      report.modelThatReadsImages = working ? working.model : 'none';
      if (working) discoveredModels[`${cfg.label}:vision`] = working.model;
      if (!report.models.modelListed || !working || working.model !== cfg.model) {
        if (working) cfg.model = working.model;
      }
    }
  } catch (err) {
    report.models = { error: String(err), cause: err?.cause?.code };
  }
  report.testedModel = cfg.model;
  report.plainTest = await run({}, plain);
  report.schemaTest = await run({}, schema);
  report.imageTest = await run({}, image);
  return report;
}

// Startup self-check so setup mistakes (bad key, unknown model) show up clearly in the server logs.
async function checkProvider(env = process.env) {
  const provider = providerName(env);
  if (provider === 'mock') return { ok: true, message: 'Demo mode (MOCK_GRADER=1): fake marks, no AI calls.' };
  if (provider === 'none') {
    return { ok: false, message: 'No AI key set (GROQ_API_KEY, OPENROUTER_API_KEY, GEMINI_API_KEY, OPENAI_API_KEY or GITHUB_MODELS_TOKEN). Marking will not work.' };
  }
  if (provider === 'github') {
    // Validate the token without spending the daily model quota.
    try {
      const res = await fetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${env.GITHUB_MODELS_TOKEN}`, 'User-Agent': 'markcalc' },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return { ok: false, message: `github token check failed (HTTP ${res.status}). Create a new token with the "Models" permission.` };
      const user = await res.json();
      return { ok: true, message: `github token OK (account ${user.login}), model "${env.GITHUB_MODEL || 'openai/gpt-4.1'}".` };
    } catch (err) {
      return { ok: false, message: `github check could not connect: ${err.message}` };
    }
  }
  if (['groq', 'openrouter', 'custom', 'openai'].includes(provider)) {
    const cfg = openAICompatibleConfig(env, provider);
    try {
      const res = await fetch(cfg.modelsUrl, {
        headers: { Authorization: `Bearer ${cfg.key}`, Accept: 'application/json', ...cfg.headers },
        signal: AbortSignal.timeout(15000),
      });
      const text = await res.text();
      if (!res.ok) return { ok: false, message: `${provider} key check failed (HTTP ${res.status}): ${text.slice(0, 200).replace(/\s+/g, ' ')}` };
      let ids = [];
      try {
        ids = (JSON.parse(text).data || []).map((m) => m.id);
      } catch {}
      const listed = ids.includes(cfg.model);
      if (!cfg.model) {
        return { ok: true, message: `${provider} key OK (${ids.length} models). A model that reads images will be chosen automatically on the first marking.` };
      }
      return {
        ok: listed || !ids.length,
        message: listed
          ? `${provider} key OK, model "${cfg.model}" available.`
          : `${provider} key OK. Model "${cfg.model}" isn't offered any more, so the site will pick one that reads images automatically (see /api/selftest).`,
      };
    } catch (err) {
      return { ok: false, message: `${provider} check could not connect: ${err.message}` };
    }
  }
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
  else if (['github', 'openai', 'groq', 'openrouter', 'custom'].includes(provider) && openAICompatibleConfig(env, provider).key) {
    raw = await gradeWithOpenAICompatible(input, env, provider);
  }
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
  maxPages,
  requestTooLarge,
  checkProvider,
  selfTest,
  resetForTests: () => {
    githubVariant = 0;
    for (const k of Object.keys(discoveredModels)) delete discoveredModels[k];
  },
  GradingError,
  RESULT_SCHEMA,
};
