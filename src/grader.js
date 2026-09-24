// Grading engine. Talks to the OpenAI API from the server only;
// the browser never sees the provider, the key, or the prompt.

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
  return files.map((f) => ({
    type: 'image_url',
    image_url: { url: `data:${f.mimetype};base64,${Buffer.from(f.buffer).toString('base64')}`, detail: 'high' },
  }));
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

function buildMessages({ setup, questionFiles, answerFiles }) {
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

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content },
  ];
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

// Reasoning models (gpt-5*, o-series) reject a custom temperature.
function isReasoningModel(model) {
  return /^(gpt-5|o\d)/i.test(model);
}

async function callOpenAI(body, env, attempt = 1) {
  const res = await fetch(`${env.OPENAI_BASE_URL || 'https://api.openai.com/v1'}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Number(env.OPENAI_TIMEOUT_MS) || 240000),
  }).catch((err) => ({ ok: false, status: 0, text: async () => String(err) }));

  if (res.ok) return res.json();

  const detail = await res.text().catch(() => '');
  console.error(`Grading API error (attempt ${attempt})`, res.status, detail.slice(0, 800));
  const retryable = res.status === 0 || res.status === 429 || res.status >= 500;
  if (retryable && attempt < 3) {
    await new Promise((r) => setTimeout(r, 2000 * attempt ** 2));
    return callOpenAI(body, env, attempt + 1);
  }
  if (res.status === 429) throw new GradingError('The marking service is busy right now. Please try again in a minute.', 503);
  throw new GradingError('The marking service could not process this request. Please try again.');
}

async function grade({ setup, questionFiles, answerFiles }, env = process.env) {
  if (env.MOCK_GRADER === '1') return mockResult(setup);
  if (!env.OPENAI_API_KEY) throw new GradingError('Marking is not configured on the server yet.', 503);

  const model = env.OPENAI_MODEL || 'gpt-4.1';
  const body = {
    model,
    messages: buildMessages({ setup, questionFiles, answerFiles }),
    max_completion_tokens: isReasoningModel(model) ? 32000 : 8000,
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'grading_result', strict: true, schema: RESULT_SCHEMA },
    },
  };
  if (!isReasoningModel(model)) body.temperature = 0;

  const data = await callOpenAI(body, env);
  const message = data.choices?.[0]?.message;
  if (!message || message.refusal || !message.content) {
    throw new GradingError('This answer sheet could not be marked. Check that the photos are clear and try again.', 422);
  }
  let parsed;
  try {
    parsed = JSON.parse(message.content);
  } catch {
    throw new GradingError('The marking result was incomplete. Please try again.');
  }
  return normalize(parsed, setup.totalMarks);
}

module.exports = { grade, normalize, buildMessages, instructionText, GradingError, RESULT_SCHEMA };
