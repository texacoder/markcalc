// Grading engine. Talks to the OpenAI API from the server only;
// the browser never sees the provider, the key, or the prompt.

const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['studentName', 'totalAwarded', 'totalMaximum', 'questions', 'overallFeedback', 'warnings'],
  properties: {
    studentName: { type: 'string', description: 'Name / roll number read from the answer sheet, or empty string.' },
    totalAwarded: { type: 'number' },
    totalMaximum: { type: 'number' },
    questions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['question', 'awarded', 'maximum', 'comment'],
        properties: {
          question: { type: 'string', description: 'Question number/label as printed, e.g. "1(a)".' },
          awarded: { type: 'number' },
          maximum: { type: 'number' },
          comment: { type: 'string', description: 'Short reason for the marks awarded.' },
        },
      },
    },
    overallFeedback: { type: 'string' },
    warnings: {
      type: 'array',
      items: { type: 'string' },
      description: 'Problems such as unreadable pages or missing answers.',
    },
  },
};

const SYSTEM_PROMPT = `You are an experienced, fair examiner grading a student's handwritten or printed answer sheet.

Rules:
- Use the marking scheme as the primary authority. Use the syllabus for context on what is expected.
- If a marking scheme is missing for a question, infer reasonable marks from the question paper (marks are usually printed next to each question).
- Grade every question in the question paper. If the student did not attempt it, award 0 and say "Not attempted".
- Respect the question paper's choice rules (e.g. "answer any 5"): count only the best allowed answers and note it.
- Follow the teacher's grading instructions exactly; they override your default strictness.
- Never award more than the maximum for a question. Half marks are allowed unless the teacher says otherwise.
- totalAwarded must equal the sum of counted questions' awarded marks; totalMaximum must equal the paper's total.
- If part of the answer sheet is unreadable, grade what you can and add a warning.
- Keep comments short and useful for the teacher.`;

function textPart(text) {
  return { type: 'text', text };
}

function imageParts(files) {
  return files.map((f) => ({
    type: 'image_url',
    image_url: { url: `data:${f.mimetype};base64,${f.buffer.toString('base64')}`, detail: 'high' },
  }));
}

function section(title, body) {
  const value = (body || '').trim();
  return `## ${title}\n${value || '(not provided)'}`;
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
        section('Teacher grading instructions', setup.instructions),
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

// Clamp per-question marks and recompute the total so the numbers always add up.
function normalize(result) {
  const questions = (result.questions || []).map((q) => {
    const maximum = Math.max(0, round(q.maximum) || 0);
    const awarded = Math.min(maximum, Math.max(0, round(q.awarded) || 0));
    return { question: String(q.question), awarded, maximum, comment: q.comment || '' };
  });
  const sum = round(questions.reduce((s, q) => s + q.awarded, 0));
  const warnings = [...(result.warnings || [])];
  let totalAwarded = round(result.totalAwarded);
  // Allow a lower total (optional-question rules), but never more than the per-question sum.
  if (!Number.isFinite(totalAwarded) || totalAwarded > sum) totalAwarded = sum;
  const totalMaximum = round(result.totalMaximum) || round(questions.reduce((s, q) => s + q.maximum, 0));
  if (totalAwarded > totalMaximum) {
    totalAwarded = totalMaximum;
    warnings.push('Total was capped at the paper maximum.');
  }
  return {
    studentName: result.studentName || '',
    totalAwarded,
    totalMaximum,
    percentage: totalMaximum ? round((totalAwarded / totalMaximum) * 100) : 0,
    questions,
    overallFeedback: result.overallFeedback || '',
    warnings,
  };
}

function mockResult(setup) {
  const max = Number(setup.totalMarks) || 20;
  return normalize({
    studentName: 'Demo Student',
    totalAwarded: max * 0.7,
    totalMaximum: max,
    questions: [
      { question: '1', awarded: max * 0.4, maximum: max / 2, comment: 'Correct method, minor calculation error.' },
      { question: '2', awarded: max * 0.3, maximum: max / 2, comment: 'Diagram correct; explanation incomplete.' },
    ],
    overallFeedback: 'Demo mode result (MOCK_GRADER=1). No real grading was done.',
    warnings: [],
  });
}

class GradingError extends Error {}

async function grade({ setup, questionFiles, answerFiles }, env = process.env) {
  if (env.MOCK_GRADER === '1') return mockResult(setup);
  if (!env.OPENAI_API_KEY) throw new GradingError('Grading service is not configured on the server.');

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: env.OPENAI_MODEL || 'gpt-4o',
      temperature: 0,
      messages: buildMessages({ setup, questionFiles, answerFiles }),
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'grading_result', strict: true, schema: RESULT_SCHEMA },
      },
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.error('Grading API error', res.status, detail.slice(0, 500));
    throw new GradingError('The grading service could not process this request. Please try again.');
  }

  const data = await res.json();
  const choice = data.choices?.[0]?.message;
  if (!choice || choice.refusal || !choice.content) {
    throw new GradingError('The answer sheet could not be graded. Check the images are clear and try again.');
  }
  return normalize(JSON.parse(choice.content));
}

module.exports = { grade, normalize, buildMessages, GradingError };
