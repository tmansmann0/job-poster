import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { JWT } from 'google-auth-library';
import { makeSlug } from '../util/slug.js';
import type {
  JobPosting,
  PublishContext,
  PublishResult,
  ModuleMeta,
} from '../types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const JOBS_ROOT = path.resolve(__dirname, '../../jobs');
const DEFAULT_HOST_BASE = (
  process.env.ORIGIN ||
  process.env.PUBLIC_HOST_BASE_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  'https://job-poster-r0c5.onrender.com'
).replace(/\/+$/, '');

const HTML_ESCAPE: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

const escapeHtml = (value: string | undefined) =>
  (value || '').replace(/[&<>"']/g, (char) => HTML_ESCAPE[char] || char);

export type IndexingStatus = 'skipped' | 'succeeded' | 'failed';

export interface HostedJobMetadata {
  slug: string;
  title: string;
  organization?: string;
  hostedUrl: string;
  applyUrl?: string;
  createdAt: string;
  updatedAt: string;
  indexing?: {
    status: IndexingStatus;
    reason?: string;
    lastAttemptedAt?: string;
    response?: any;
  };
}

const getJobDir = (slug: string) => path.resolve(JOBS_ROOT, slug);
const getMetaPath = (slug: string) => path.resolve(getJobDir(slug), 'meta.json');

async function loadExistingMeta(slug: string): Promise<HostedJobMetadata | null> {
  try {
    const raw = await fs.promises.readFile(getMetaPath(slug), 'utf-8');
    return JSON.parse(raw) as HostedJobMetadata;
  } catch (err: any) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

async function persistHostedJobMeta(
  slug: string,
  updates: Omit<HostedJobMetadata, 'slug' | 'createdAt' | 'updatedAt'> &
    Partial<Pick<HostedJobMetadata, 'createdAt'>>,
): Promise<HostedJobMetadata> {
  const existing = await loadExistingMeta(slug);
  const createdAt = updates.createdAt || existing?.createdAt || new Date().toISOString();
  const meta: HostedJobMetadata = {
    slug,
    title: updates.title || existing?.title || '(Untitled job)',
    organization: updates.organization ?? existing?.organization,
    hostedUrl: updates.hostedUrl || existing?.hostedUrl || '',
    applyUrl: updates.applyUrl ?? existing?.applyUrl,
    createdAt,
    updatedAt: new Date().toISOString(),
    indexing: updates.indexing ?? existing?.indexing,
  };
  await fs.promises.writeFile(getMetaPath(slug), JSON.stringify(meta, null, 2), 'utf-8');
  return meta;
}

function jobToJsonLd(job: JobPosting) {
  const jobLocation = job.remoteType === 'REMOTE'
    ? undefined
    : (job.addresses || []).map((addr) => ({
        '@type': 'Place',
        address: {
          '@type': 'PostalAddress',
          streetAddress: addr.streetAddress,
          addressLocality: addr.addressLocality,
          addressRegion: addr.addressRegion,
          postalCode: addr.postalCode,
          addressCountry: addr.addressCountry,
        },
      }));

  const jsonld: any = {
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    title: job.title,
    description: job.descriptionHTML,
    datePosted: job.datePosted || new Date().toISOString(),
    hiringOrganization: {
      '@type': 'Organization',
      name: job.hiringOrganization?.name,
      sameAs: job.hiringOrganization?.website,
      logo: job.hiringOrganization?.logoUrl,
    },
    employmentType: job.employmentType,
    validThrough: job.validThrough,
    applicantLocationRequirements: job.applicantLocationRequirements,
    identifier: job.refId
      ? {
          '@type': 'PropertyValue',
          name: job.hiringOrganization?.name,
          value: job.refId,
        }
      : undefined,
    jobLocation,
    jobLocationType: job.remoteType === 'REMOTE' ? 'TELECOMMUTE' : undefined,
    directApply: !!job.applyUrl,
    applyUrl: job.applyUrl,
  };

  if (job.salary && (job.salary.min || job.salary.max)) {
    jsonld.baseSalary = {
      '@type': 'MonetaryAmount',
      currency: job.salary.currency || 'USD',
      value: {
        '@type': 'QuantitativeValue',
        minValue: job.salary.min,
        maxValue: job.salary.max,
        unitText: job.salary.unit || 'YEAR',
      },
    };
  }
  return jsonld;
}

async function ensureJobStored(job: JobPosting, slug: string, hostedUrl: string) {
  const jobsDir = getJobDir(slug);
  await fs.promises.mkdir(jobsDir, { recursive: true });
  await fs.promises.writeFile(
    path.resolve(jobsDir, 'job.json'),
    JSON.stringify(job, null, 2),
    'utf-8',
  );
  const canonical = job.applyUrl || hostedUrl;

  const organizationName = job.hiringOrganization?.name;
  const organizationWebsite = job.hiringOrganization?.website;
  const organizationLogo = job.hiringOrganization?.logoUrl;

  const locationParts = (job.addresses || [])
    .map((addr) =>
      [addr.addressLocality, addr.addressRegion, addr.addressCountry]
        .filter(Boolean)
        .join(', '),
    )
    .filter(Boolean);
  const primaryLocation = locationParts.length
    ? `${locationParts[0]}${
        locationParts.length > 1 ? ` (+${locationParts.length - 1} more)` : ''
      }`
    : '';

  const remoteTypeLabels: Record<string, string> = {
    REMOTE: 'Remote',
    HYBRID: 'Hybrid',
    ONSITE: 'On-site',
  };
  const employmentTypeLabels: Record<string, string> = {
    FULL_TIME: 'Full-time',
    PART_TIME: 'Part-time',
    CONTRACT: 'Contract',
    TEMPORARY: 'Temporary',
    INTERN: 'Internship',
    VOLUNTEER: 'Volunteer',
    PER_DIEM: 'Per diem',
    OTHER: 'Other',
  };

  const formatDate = (value?: string) => {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' }).format(date);
  };

  const formatSalary = () => {
    const salary = job.salary;
    if (!salary || (salary.min == null && salary.max == null)) return '';
    const currency = salary.currency || 'USD';
    const formatter = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
    });
    const unitLabels: Record<string, string> = {
      HOUR: 'hour',
      DAY: 'day',
      WEEK: 'week',
      MONTH: 'month',
      YEAR: 'year',
    };
    const unit = unitLabels[salary.unit || 'YEAR'] || 'year';
    const min = salary.min != null ? formatter.format(salary.min) : null;
    const max = salary.max != null ? formatter.format(salary.max) : null;
    const range =
      min && max && salary.min !== salary.max
        ? `${min} - ${max}`
        : formatter.format(Number(salary.min ?? salary.max ?? 0));
    return `${range} per ${unit}`;
  };

  const detailRows: { label: string; value: string; href?: string }[] = [];

  if (organizationName) {
    detailRows.push({
      label: 'Company',
      value: escapeHtml(organizationName),
      href: organizationWebsite ? escapeHtml(organizationWebsite) : undefined,
    });
  }

  if (primaryLocation) {
    detailRows.push({ label: 'Location', value: escapeHtml(primaryLocation) });
  }

  const remoteLabel = job.remoteType ? remoteTypeLabels[job.remoteType] : '';
  if (remoteLabel) {
    detailRows.push({ label: 'Work style', value: escapeHtml(remoteLabel) });
  }

  const employmentLabel = job.employmentType
    ? employmentTypeLabels[job.employmentType] || job.employmentType
    : '';
  if (employmentLabel) {
    detailRows.push({ label: 'Employment type', value: escapeHtml(employmentLabel) });
  }

  const salaryText = formatSalary();
  if (salaryText) {
    detailRows.push({ label: 'Compensation', value: escapeHtml(salaryText) });
  }

  if (job.datePosted) {
    detailRows.push({ label: 'Posted', value: escapeHtml(formatDate(job.datePosted)) });
  }

  if (job.validThrough) {
    detailRows.push({ label: 'Apply by', value: escapeHtml(formatDate(job.validThrough)) });
  }

  if (job.refId) {
    detailRows.push({ label: 'Job ID', value: escapeHtml(job.refId) });
  }

  if (job.applicantLocationRequirements) {
    detailRows.push({
      label: 'Location requirements',
      value: escapeHtml(job.applicantLocationRequirements),
    });
  }

  const detailsHtml = detailRows.length
    ? `<dl class="job-meta">${detailRows
        .map(
          (row) =>
            `<div class="meta-row"><dt>${row.label}</dt><dd>${
              row.href
                ? `<a href="${row.href}" target="_blank" rel="noopener">${row.value}</a>`
                : row.value
            }</dd></div>`,
        )
        .join('')}</dl>`
    : '';

  const applyCta = job.applyUrl
    ? `<section class="apply-section">
        <h2>Ready to apply?</h2>
        <a class="apply-button" href="${escapeHtml(
          job.applyUrl,
        )}" target="_blank" rel="noopener">Apply now</a>
        <p class="apply-hint">Opens in a new tab${
          organizationName ? ` on ${escapeHtml(organizationName)}'s site.` : '.'
        }</p>
      </section>`
    : '';

  const logoMarkup = organizationLogo
    ? `<img class="company-logo" src="${escapeHtml(organizationLogo)}" alt="${
        organizationName ? escapeHtml(`${organizationName} logo`) : 'Company logo'
      }" />`
    : '';

  const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(job.title)}</title>
    <link rel="canonical" href="${escapeHtml(canonical)}" />
    <meta name="robots" content="index,follow" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap"
      rel="stylesheet"
    />
    <style>
      :root {
        color-scheme: light;
      }
      *,
      *::before,
      *::after {
        box-sizing: border-box;
      }
      body {
        margin: 0;
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        color: #1f2933;
        background: linear-gradient(160deg, #eef2ff 0%, #f8fafc 40%, #ffffff 100%);
      }
      a {
        color: #1d4ed8;
      }
      .page {
        min-height: 100vh;
        display: flex;
        align-items: flex-start;
        justify-content: center;
        padding: 48px 16px;
      }
      .card {
        width: min(960px, 100%);
        background: #ffffff;
        border-radius: 28px;
        overflow: hidden;
        box-shadow: 0 35px 60px rgba(15, 23, 42, 0.15);
        border: 1px solid rgba(148, 163, 184, 0.2);
      }
      .job-hero {
        padding: 48px clamp(24px, 5vw, 56px);
        background: radial-gradient(circle at top left, rgba(79, 70, 229, 0.16), transparent 60%),
          linear-gradient(135deg, rgba(37, 99, 235, 0.08), rgba(79, 70, 229, 0.02));
        position: relative;
      }
      .job-hero::after {
        content: '';
        position: absolute;
        inset: 24px;
        border-radius: 24px;
        border: 1px solid rgba(255, 255, 255, 0.5);
        pointer-events: none;
      }
      .job-hero-inner {
        position: relative;
        z-index: 1;
        display: grid;
        gap: 24px;
        align-items: center;
      }
      .job-hero-top {
        display: flex;
        flex-wrap: wrap;
        gap: 20px;
        align-items: center;
      }
      .company-logo {
        width: 72px;
        height: 72px;
        border-radius: 20px;
        object-fit: cover;
        background: rgba(255, 255, 255, 0.75);
        padding: 8px;
        border: 1px solid rgba(255, 255, 255, 0.6);
      }
      h1 {
        margin: 0;
        font-size: clamp(1.8rem, 4vw, 2.8rem);
        font-weight: 700;
        letter-spacing: -0.01em;
        color: #0f172a;
      }
      .subhead {
        font-size: 1.1rem;
        color: rgba(15, 23, 42, 0.78);
        margin: 0;
      }
      .job-meta {
        display: grid;
        gap: 16px;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        margin: 0;
      }
      .meta-row {
        background: rgba(255, 255, 255, 0.75);
        border-radius: 16px;
        padding: 16px 18px;
        border: 1px solid rgba(148, 163, 184, 0.25);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.6);
      }
      dt {
        font-size: 0.75rem;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: #6366f1;
        margin-bottom: 6px;
      }
      dd {
        margin: 0;
        font-size: 0.98rem;
        color: #0f172a;
        line-height: 1.5;
      }
      .body-section {
        padding: clamp(28px, 6vw, 56px);
        display: grid;
        gap: 32px;
      }
      .job-description {
        font-size: 1.05rem;
        line-height: 1.75;
        color: #1f2937;
      }
      .job-description h1,
      .job-description h2,
      .job-description h3,
      .job-description h4 {
        color: #111827;
        margin-top: 1.6em;
      }
      .job-description p {
        margin: 0 0 1.2em;
      }
      .job-description ul,
      .job-description ol {
        margin: 0 0 1.2em 1.4em;
      }
      .apply-section {
        background: linear-gradient(140deg, rgba(59, 130, 246, 0.12), rgba(129, 140, 248, 0.08));
        border-radius: 20px;
        padding: 28px;
        display: grid;
        gap: 12px;
        text-align: center;
        border: 1px solid rgba(59, 130, 246, 0.24);
      }
      .apply-section h2 {
        margin: 0;
        font-size: 1.4rem;
        font-weight: 600;
        color: #1d4ed8;
      }
      .apply-button {
        display: inline-block;
        padding: 14px 32px;
        border-radius: 999px;
        background: linear-gradient(135deg, #2563eb, #7c3aed);
        color: #ffffff;
        font-weight: 600;
        font-size: 1rem;
        text-decoration: none;
        box-shadow: 0 15px 30px rgba(37, 99, 235, 0.25);
        transition: transform 0.15s ease, box-shadow 0.15s ease;
      }
      .apply-button:hover,
      .apply-button:focus {
        transform: translateY(-1px);
        box-shadow: 0 20px 40px rgba(37, 99, 235, 0.35);
      }
      .apply-button:focus {
        outline: none;
      }
      .apply-hint {
        margin: 0;
        font-size: 0.85rem;
        color: rgba(30, 41, 59, 0.7);
      }
      @media (max-width: 640px) {
        .job-hero {
          padding: 32px 24px;
        }
        .meta-row {
          padding: 14px 16px;
        }
        .apply-section {
          padding: 24px 20px;
        }
      }
    </style>
    <script type="application/ld+json">${JSON.stringify(jobToJsonLd(job))}</script>
  </head>
  <body>
    <div class="page">
      <article class="card">
        <header class="job-hero">
          <div class="job-hero-inner">
            <div class="job-hero-top">
              ${logoMarkup}
              <div>
                <h1>${escapeHtml(job.title)}</h1>
                ${
                  organizationName
                    ? `<p class="subhead">${escapeHtml(organizationName)}</p>`
                    : ''
                }
              </div>
            </div>
            ${detailsHtml}
          </div>
        </header>
        <div class="body-section">
          <section class="job-description">${job.descriptionHTML}</section>
          ${applyCta}
        </div>
      </article>
    </div>
  </body>
</html>`;
  await fs.promises.writeFile(path.resolve(jobsDir, 'index.html'), html, 'utf-8');
}

async function callIndexingApi(url: string, serviceAccountJson: string) {
  try {
    const creds = JSON.parse(serviceAccountJson);
    const jwt = new JWT({
      email: creds.client_email,
      key: creds.private_key,
      scopes: ['https://www.googleapis.com/auth/indexing'],
    });
    const tokenResponse = await jwt.authorize();
    const accessToken = tokenResponse?.access_token;
    if (!accessToken) {
      return { ok: false, error: 'Failed to obtain Google access token' };
    }

    const res = await fetch('https://indexing.googleapis.com/v3/urlNotifications:publish', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ url, type: 'URL_UPDATED' }),
    });

    if (!res.ok) {
      const text = await res.text();
      return { ok: false, error: `Indexing API error ${res.status}: ${text}` };
    }

    const json = await res.json();
    return { ok: true, res: json };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

const meta: ModuleMeta = {
  id: 'google',
  label: 'Google for Jobs (hosted JSON-LD + optional Indexing API)',
  description:
    'Publishes a hosted page with JobPosting JSON-LD; optionally pings Google Indexing API for rapid inclusion.',
  requiredFields: ['title', 'descriptionHTML', 'hiringOrganization.name'],
  optionalFields: [
    'employmentType',
    'datePosted',
    'validThrough',
    'applyUrl',
    'refId',
    'remoteType',
    'applicantLocationRequirements',
    'addresses',
    'salary',
  ],
  requiredCredentials: [],
  optionalCredentials: ['google.serviceAccountJson'],
  docsUrl: 'https://developers.google.com/search/docs/appearance/structured-data/job-posting',
};

export const googlePublisher = {
  id: meta.id,
  label: meta.label,
  meta,
  jobToJsonLd,
  async publish(job: JobPosting, ctx: PublishContext): Promise<PublishResult> {
    if (!job.title || !job.descriptionHTML || !job.hiringOrganization?.name) {
      return {
        ok: false,
        error: 'Missing required fields (title, descriptionHTML, hiringOrganization.name)',
      };
    }

    const slugSeed = `${job.title}-${job.hiringOrganization?.name}`;
    const slug = makeSlug(slugSeed, Math.floor(Math.random() * 1e6).toString(36));
    const hostBase = (ctx.hostBaseUrl || DEFAULT_HOST_BASE).replace(/\/+$/, '');
    const hostedUrl = `${hostBase}/jobs/${slug}/`;
    await ensureJobStored(job, slug, hostedUrl);

    const saJson =
      ctx.creds.google?.serviceAccountJson || process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

    const indexingAttemptedAt = new Date().toISOString();
    let indexingStatus: IndexingStatus = 'skipped';
    let indexingReason = 'Google Indexing API credentials not configured.';
    let indexingResponse: any;
    let lastAttemptedAt: string | undefined = indexingAttemptedAt;
    if (saJson) {
      const idx = await callIndexingApi(hostedUrl, saJson);
      if (idx.ok) {
        indexingStatus = 'succeeded';
        indexingReason = undefined;
        indexingResponse = idx.res;
      } else {
        indexingStatus = 'failed';
        indexingReason = idx.error;
      }
    }

    await persistHostedJobMeta(slug, {
      title: job.title,
      organization: job.hiringOrganization?.name,
      hostedUrl,
      applyUrl: job.applyUrl,
      indexing: {
        status: indexingStatus,
        reason: indexingReason,
        lastAttemptedAt,
        response: indexingResponse,
      },
    });

    const ok = indexingStatus === 'succeeded';
    const error =
      indexingStatus === 'succeeded'
        ? undefined
        : indexingReason ||
          (indexingStatus === 'failed'
            ? 'Google Indexing API request failed.'
            : 'Google Indexing API credentials not configured.');

    return {
      ok,
      url: hostedUrl,
      id: slug,
      error,
      details: {
        hostedUrl,
        applyUrl: job.applyUrl,
        indexing: {
          status: indexingStatus,
          reason: indexingReason,
          lastAttemptedAt,
          response: indexingResponse,
        },
      },
    };
  },
} as const;

export async function listHostedJobPages(): Promise<HostedJobMetadata[]> {
  try {
    const entries = await fs.promises.readdir(JOBS_ROOT, { withFileTypes: true });
    const summaries: HostedJobMetadata[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const slug = entry.name;
      const jobDir = getJobDir(slug);
      const meta = await loadExistingMeta(slug);
      if (meta) {
        summaries.push(meta);
        continue;
      }
      try {
        const jobJson = await fs.promises.readFile(
          path.resolve(jobDir, 'job.json'),
          'utf-8',
        );
        const job = JSON.parse(jobJson) as JobPosting;
        const stats = await fs.promises.stat(path.resolve(jobDir, 'job.json'));
        const createdAt =
          typeof stats.birthtime?.toISOString === 'function'
            ? stats.birthtime.toISOString()
            : stats.mtime.toISOString();
        summaries.push({
          slug,
          title: job.title || '(Untitled job)',
          organization: job.hiringOrganization?.name,
          hostedUrl: `${DEFAULT_HOST_BASE}/jobs/${slug}/`,
          applyUrl: job.applyUrl,
          createdAt,
          updatedAt: stats.mtime.toISOString(),
        });
      } catch (err) {
        // Ignore malformed entries but continue processing others
      }
    }
    summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return summaries;
  } catch (err: any) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
}

export async function deleteHostedJob(slug: string): Promise<void> {
  const dir = getJobDir(slug);
  await fs.promises.rm(dir, { recursive: true, force: true });
}
