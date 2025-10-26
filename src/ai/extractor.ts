import axios from 'axios';
import { gotScraping } from 'got-scraping';
import { decode } from 'html-entities';
import { jsonrepair } from 'jsonrepair';
import { ExtractResult, JobPosting } from '../types.js';

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'gpt-5-mini';
const SYSTEM_MESSAGE = [
  'You are a meticulous data extraction assistant.',
  'Return valid JSON that matches the requested schema.',
  'Do not guess when the source provides no evidence—use null instead.',
  'Respect all field-specific guidance supplied by the user.',
].join('\n');

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

const EXTRACTION_SCHEMA = `type ExtractionResult = {
  job: {
    sourceUrl: string | null;
    title: string | null;
    descriptionHTML: string | null;
    hiringOrganization: {
      name: string | null;
      website: string | null;
      logoUrl: string | null;
    } | null;
    employmentType: 'FULL_TIME' | 'PART_TIME' | 'CONTRACT' | 'TEMPORARY' | 'INTERN' | 'VOLUNTEER' | 'PER_DIEM' | 'OTHER' | null;
    datePosted: string | null;
    validThrough: string | null;
    applyUrl: string | null;
    refId: string | null;
    remoteType: 'ONSITE' | 'REMOTE' | 'HYBRID' | null;
    applicantLocationRequirements: string | null;
    addresses: Array<{
      streetAddress: string | null;
      addressLocality: string | null;
      addressRegion: string | null;
      postalCode: string | null;
      addressCountry: string | null;
    }> | null;
    salary: {
      currency: string | null;
      min: number | null;
      max: number | null;
      unit: 'HOUR' | 'DAY' | 'WEEK' | 'MONTH' | 'YEAR' | null;
    } | null;
  };
  confidences: Record<string, number>;
  warnings: string[];
}`;

const JSON_SHAPE_EXAMPLE = `{
  "job": {
    "sourceUrl": "https://example.com/job", 
    "title": "<string|null>",
    "descriptionHTML": "<string|null>",
    "hiringOrganization": {
      "name": "<string|null>",
      "website": "<string|null>",
      "logoUrl": "<string|null>"
    },
    "employmentType": "<enum|null>",
    "datePosted": "<ISO8601|null>",
    "validThrough": "<ISO8601|null>",
    "applyUrl": "<string|null>",
    "refId": "<string|null>",
    "remoteType": "<enum|null>",
    "applicantLocationRequirements": "<string|null>",
    "addresses": [
      {
        "streetAddress": "<string|null>",
        "addressLocality": "<string|null>",
        "addressRegion": "<string|null>",
        "postalCode": "<string|null>",
        "addressCountry": "<ISO-2|null>"
      }
    ],
    "salary": {
      "currency": "<ISO-4217|null>",
      "min": <number|null>,
      "max": <number|null>,
      "unit": "<enum|null>"
    }
  },
  "confidences": {
    "job.title": 0.8
  },
  "warnings": []
}`;

function buildGuidelines(url: string): string {
  return [
    `- Set job.sourceUrl to ${url}.`,
    '- If the apply URL is missing, reuse the source URL.',
    '- Use ISO 8601 dates (include timezone).',
    '- Preserve important formatting in descriptionHTML using simple HTML tags.',
    '- Only include addresses that appear to be job locations.',
    '- When salary/pay info exists without a currency, default to "USD".',
    '- Use null for unknown values; never invent details.',
    '- Provide confidences between 0 and 1 for every populated field path.',
  ].join('\n');
}

function buildPrompt(url: string, html: string): { instructions: string; reference: string } {
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

  const instructions = [
    `Extract structured job data from the page at ${url}.`,
    '',
    '### Output schema',
    EXTRACTION_SCHEMA,
    '',
    '### JSON shape example',
    JSON_SHAPE_EXAMPLE,
    '',
    '### Field guidelines',
    buildGuidelines(url),
    '',
    'Return ONLY a single JSON object that conforms to the schema. Do not include markdown fences or commentary.',
  ].join('\n');

  const reference = `${metadataLines.join('\n')}

Visible text excerpt (truncated to 15k characters):
${visibleText}`.trim();

  return { instructions, reference };
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
  const { instructions, reference } = buildPrompt(url, html);
  const baseMessages = [
    { role: 'system', content: SYSTEM_MESSAGE },
    { role: 'user', content: `${instructions}\n\n### Reference material\n${reference}` },
  ];

  let completion;
  let content: string | undefined;
  let parsed: Partial<ExtractResult> | undefined;
  let repaired = false;
  let parseError: string | undefined;

  for (let attempt = 0; attempt < 3 && !parsed; attempt += 1) {
    const attemptMessages = [...baseMessages];
    if (attempt > 0 && parseError) {
      attemptMessages.push({
        role: 'user',
        content: `The previous response could not be parsed as JSON (${parseError}). Return ONLY valid JSON that matches the ExtractionResult schema with double-quoted keys and strings.`,
      });
    }

    try {
      completion = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          model: OPENROUTER_MODEL,
          messages: attemptMessages,
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

    content = completion.data?.choices?.[0]?.message?.content;
    if (!content) {
      parseError = 'empty response';
      continue;
    }

    try {
      parsed = JSON.parse(content);
      repaired = false;
    } catch (err: any) {
      parseError = err instanceof Error ? err.message : String(err);
      try {
        const repairedJson = jsonrepair(content);
        parsed = JSON.parse(repairedJson);
        repaired = true;
      } catch (repairErr: any) {
        parseError = `${parseError}; repair failed: ${repairErr instanceof Error ? repairErr.message : String(repairErr)}`;
        parsed = undefined;
      }
    }
  }

  if (!parsed) {
    return buildFailureResult(url, 'failed to parse AI response', {
      error: parseError || 'unknown parse error',
      raw: content,
      html,
    });
  }

  const job = (parsed.job || {}) as Partial<JobPosting>;
  if (!job.sourceUrl) {
    job.sourceUrl = url;
  }
  const confidences = parsed.confidences || {};
  const warnings = parsed.warnings ? [...parsed.warnings] : [];
  if (repaired) {
    warnings.unshift('Model output required JSON repair; please verify extracted data.');
  }

  return {
    job,
    confidences,
    warnings,
    rawModelOutput: parsed,
    failureReason: parsed.failureReason,
    failureDetails: parsed.failureDetails,
  };
}
