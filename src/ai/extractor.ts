import axios from 'axios';
import { ExtractResult, JobPosting } from '../types.js';

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'gpt-5-mini';

function buildPrompt(url: string, html: string): string {
  return `Extract structured job data from the page at ${url}. Return JSON with keys "job" (matching the JobPosting schema) and "confidences" (map of field paths to 0-1 confidence). Only output JSON.`;
}

export async function extractFromUrl(url: string): Promise<ExtractResult> {
  if (!OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY missing');
  }
  const response = await axios.get(url);
  const html = response.data as string;
  const prompt = buildPrompt(url, html);
  const messages = [
    { role: 'system', content: 'You extract job postings into structured data.' },
    { role: 'user', content: `${prompt}\n\n${html}` },
  ];

  const completion = await axios.post(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      model: OPENROUTER_MODEL,
      messages,
      response_format: { type: 'json_object' },
    },
    {
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
      },
    },
  );

  const content = completion.data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('Empty AI response');
  }

  let parsed: Partial<ExtractResult> = {};
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error('Failed to parse AI response');
  }

  const job = (parsed.job || {}) as Partial<JobPosting>;
  const confidences = parsed.confidences || {};
  return {
    job,
    confidences,
    warnings: parsed.warnings || [],
    rawModelOutput: parsed,
  };
}
