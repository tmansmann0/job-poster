
import axios from 'axios';
import { AiExtractResult, JobData } from '../types.js';
import * as dotenv from 'dotenv';
dotenv.config();

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'gpt-5-mini';

// Compose a prompt for extraction
const buildPrompt = (url: string, html: string): string => {
  return `You are an AI that extracts job posting data from HTML. Given the page content from ${url}, extract fields in JSON: {title, description (HTML), organization, location, salary, employmentType, datePosted, validThrough, applyUrl}. Provide confidence score (0-1) for each field. If a field is absent, set confidence to 0 and value to empty string.`;
};

export async function extractJob(url: string, html: string): Promise<AiExtractResult> {
  if (!OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY missing');
  }
  const prompt = buildPrompt(url, html);
  const messages = [
    { role: 'system', content: 'You are a helpful assistant that extracts job data from HTML.' },
    { role: 'user', content: prompt + '\n\n' + html }
  ];
  try {
    const response = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
      model: OPENROUTER_MODEL,
      messages
    }, {
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });
    const content = response.data.choices[0].message.content;
    const result = JSON.parse(content);
    return result as AiExtractResult;
  } catch (err: any) {
    throw new Error('AI extraction failed: ' + err.message);
  }
}
