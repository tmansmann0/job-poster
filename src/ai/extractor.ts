import axios from 'axios';
import { gotScraping } from 'got-scraping';
import { decode } from 'html-entities';
import { ExtractResult, JobPosting } from '../types.js';

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'gpt-5-mini';

function stripScripts(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
}

function extractTitle(html: string): string | undefined {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? decode(match[1].trim()) : undefined;
}

function extractMetaTags(html: string): Array<{ key: string; value: string }> {
  const tags: Array<{ key: string; value: string }> = [];
  const regex = /<meta\s+[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html))) {
    const tag = match[0];
    const keyMatch = tag.match(/(?:name|property)=["']([^"']+)["']/i);
    const valueMatch = tag.match(/content=["']([^"']*)["']/i);
    if (!valueMatch) continue;
    const key = keyMatch ? keyMatch[1].trim() : 'content';
    const value = decode(valueMatch[1].trim());
    tags.push({ key, value });
    if (tags.length >= 12) break;
  }
  return tags;
}

function extractVisibleText(html: string): string {
  const withoutScripts = stripScripts(html);
  const withoutTags = withoutScripts.replace(/<[^>]+>/g, ' ');
  const decoded = decode(withoutTags);
  return decoded.replace(/\s+/g, ' ').trim().slice(0, 15000);
}

function buildPrompt(url: string, html: string): { prompt: string; metadata: string } {
  const title = extractTitle(html);
  const metaTags = extractMetaTags(html);
  const visibleText = extractVisibleText(html);

  const metadataLines: string[] = [];
  if (title) {
    metadataLines.push(`Page title: ${title}`);
  }
  const ogTitle = metaTags.find((m) => m.key.toLowerCase() === 'og:title');
  if (ogTitle) {
    metadataLines.push(`OpenGraph title: ${ogTitle.value}`);
  }
  const description = metaTags.find((m) => m.key.toLowerCase() === 'description')
    || metaTags.find((m) => m.key.toLowerCase() === 'og:description');
  if (description) {
    metadataLines.push(`Description: ${description.value}`);
  }
  const siteName = metaTags.find((m) => m.key.toLowerCase() === 'og:site_name');
  if (siteName) {
    metadataLines.push(`Site name: ${siteName.value}`);
  }
  if (metaTags.length) {
    const other = metaTags
      .filter((m) => !['description', 'og:description', 'og:title', 'og:site_name'].includes(m.key.toLowerCase()))
      .slice(0, 6)
      .map((m) => `${m.key}: ${m.value}`);
    if (other.length) {
      metadataLines.push('Additional meta tags:');
      metadataLines.push(...other.map((line) => `  - ${line}`));
    }
  }

  const prompt = `Extract structured job data from the page at ${url}. Return JSON with keys "job" (matching the JobPosting schema) and "confidences" (map of field paths to 0-1 confidence). Fill in known fields even if some are missing. Use "warnings" when data appears uncertain or incomplete. Only output JSON.`;
  const metadata = `${metadataLines.join('\n')}

Visible text excerpt (truncated to 15k characters):
${visibleText}`.trim();

  return { prompt, metadata };
}

function fallbackJobFromHtml(url: string, html?: string): Partial<JobPosting> {
  const job: Partial<JobPosting> = { sourceUrl: url };
  if (html) {
    const title = extractTitle(html);
    if (title) {
      job.title = title;
    }
    const metaTags = extractMetaTags(html);
    const description = metaTags.find((m) => m.key.toLowerCase() === 'description')
      || metaTags.find((m) => m.key.toLowerCase() === 'og:description');
    if (description) {
      job.descriptionHTML = `<p>${description.value}</p>`;
    }
    const siteName = metaTags.find((m) => m.key.toLowerCase() === 'og:site_name');
    if (siteName) {
      job.hiringOrganization = { name: siteName.value } as JobPosting['hiringOrganization'];
    }
  }
  return job;
}

function buildFailureResult(
  url: string,
  reason: string,
  options: { error?: any; html?: string; warnings?: string[]; raw?: any } = {},
): ExtractResult {
  const warnings = [
    `Automatic extraction unavailable: ${reason}`,
    ...(options.warnings || []),
  ];
  return {
    job: fallbackJobFromHtml(url, options.html),
    confidences: {},
    warnings,
    rawModelOutput: options.raw,
    failureReason: reason,
    failureDetails: options.error,
  };
}

async function downloadHtml(url: string): Promise<string> {
  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) JobPosterBot/1.0',
    Accept: 'text/html,application/xhtml+xml',
  };
  try {
    const response = await gotScraping({
      url,
      headers,
      timeout: {
        request: 15000,
      },
      retry: {
        limit: 2,
      },
      decompress: true,
    });
    return response.body;
  } catch (primaryError: any) {
    try {
      const response = await axios.get(url, {
        headers,
        timeout: 15000,
      });
      return response.data as string;
    } catch (fallbackError: any) {
      const error = fallbackError?.message || primaryError?.message || fallbackError || primaryError;
      throw new Error(typeof error === 'string' ? error : 'failed to download page');
    }
  }
}

export async function extractFromUrl(url: string): Promise<ExtractResult> {
  if (!OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY missing');
  }
  let html: string | undefined;
  try {
    html = await downloadHtml(url);
  } catch (err: any) {
    return buildFailureResult(url, 'failed to download page', { error: err?.message || err });
  }
  const { prompt, metadata } = buildPrompt(url, html);
  const messages = [
    {
      role: 'system',
      content:
        'You extract job postings into structured data. When information is missing, leave the field null rather than guessing.',
    },
    { role: 'user', content: `${prompt}\n\n${metadata}` },
  ];

  let completion;
  try {
    completion = await axios.post(
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
  } catch (err: any) {
    return buildFailureResult(url, 'model request failed', { error: err?.message || err, html });
  }

  const content = completion.data?.choices?.[0]?.message?.content;
  if (!content) {
    return buildFailureResult(url, 'empty AI response', { raw: completion.data, html });
  }

  let parsed: Partial<ExtractResult> = {};
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    return buildFailureResult(url, 'failed to parse AI response', {
      error: err instanceof Error ? err.message : String(err),
      raw: content,
      html,
    });
  }

  const job = (parsed.job || {}) as Partial<JobPosting>;
  if (!job.sourceUrl) {
    job.sourceUrl = url;
  }
  const confidences = parsed.confidences || {};
  return {
    job,
    confidences,
    warnings: parsed.warnings || [],
    rawModelOutput: parsed,
    failureReason: parsed.failureReason,
    failureDetails: parsed.failureDetails,
  };
}
