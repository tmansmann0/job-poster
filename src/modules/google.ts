import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { JWT } from 'google-auth-library';
import { makeSlug } from '../util/slug.js';
import type { JobPosting, PublishContext, PublishResult, ModuleMeta } from '../types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

async function ensureJobStored(job: JobPosting, slug: string) {
  const jobsDir = path.resolve(__dirname, '../../jobs', slug);
  await fs.promises.mkdir(jobsDir, { recursive: true });
  await fs.promises.writeFile(
    path.resolve(jobsDir, 'job.json'),
    JSON.stringify(job, null, 2),
    'utf-8',
  );
  const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${job.title}</title>
    <script type="application/ld+json">${JSON.stringify(jobToJsonLd(job))}</script>
  </head>
  <body>
    <h1>${job.title}</h1>
    <div>${job.descriptionHTML}</div>
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
    await ensureJobStored(job, slug);

    const hostedUrl = `${ctx.hostBaseUrl}/jobs/${slug}/`;

    let indexingDetails: any;
    const saJson = ctx.creds.google?.serviceAccountJson || process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (saJson) {
      const idx = await callIndexingApi(hostedUrl, saJson);
      indexingDetails = idx.ok ? idx.res : { error: idx.error };
    }

    return { ok: true, url: hostedUrl, id: slug, details: { indexing: indexingDetails } };
  },
} as const;
