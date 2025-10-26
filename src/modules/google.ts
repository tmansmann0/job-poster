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
  const applyLink = job.applyUrl
    ? `<p><a href="${escapeHtml(job.applyUrl)}">Apply on company site</a></p>`
    : '';
  const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(job.title)}</title>
    <link rel="canonical" href="${escapeHtml(canonical)}" />
    <meta name="robots" content="index,follow" />
    <script type="application/ld+json">${JSON.stringify(jobToJsonLd(job))}</script>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(job.title)}</h1>
      <section>${job.descriptionHTML}</section>
      ${applyLink}
    </main>
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
