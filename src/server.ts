import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import path from 'path';
import ejs from 'ejs';
import type { JobPosting, PublishContext, PublishResult, Credentials } from './types.js';
import { extractFromUrl } from './ai/extractor.js';
import { sanitizeDescription } from './util/html.js';
import { PUBLISHERS, getPublisherById, listPublisherMeta } from './modules/publisher.js';
import { deleteHostedJob, listHostedJobPages } from './modules/google.js';
import { saveHold, listHolds, getJob, markPublished } from './store.js';

const app = express();
const PORT = process.env.PORT || 3000;

const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const API_KEY = process.env.API_KEY;
const DEFAULT_COMPANY_NAME = process.env.DEFAULT_COMPANY_NAME || 'Care Staff Pro';

if (!ADMIN_USERNAME || !ADMIN_PASSWORD || !API_KEY) {
  throw new Error(
    'Missing required environment variables. Set ADMIN_USERNAME, ADMIN_PASSWORD, and API_KEY before starting the server.',
  );
}

app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json());
app.use('/jobs', express.static(path.join(process.cwd(), 'jobs')));

function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Admin Area"');
    return res.status(401).send('Admin authentication required');
  }

  const decoded = Buffer.from(header.replace('Basic ', ''), 'base64').toString();
  const separatorIndex = decoded.indexOf(':');
  const username = separatorIndex >= 0 ? decoded.substring(0, separatorIndex) : decoded;
  const password = separatorIndex >= 0 ? decoded.substring(separatorIndex + 1) : '';

  if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
    res.set('WWW-Authenticate', 'Basic realm="Admin Area"');
    return res.status(401).send('Invalid admin credentials');
  }

  next();
}

function requireApiKey(req: express.Request, res: express.Response, next: express.NextFunction) {
  const key =
    req.get('x-api-key') ||
    (req.query.api_key as string | undefined) ||
    (req.body?.apiKey as string | undefined);
  if (!key || key !== API_KEY) {
    if (req.accepts('html')) {
      return res.status(401).send('Invalid or missing API key');
    }
    return res.status(401).json({ error: 'Invalid or missing API key' });
  }
  next();
}

const publisherDictionary: Record<string, string> = Object.fromEntries(
  PUBLISHERS.map((p) => [p.id, p.label]),
);

function render(res: express.Response, view: string, params: any = {}) {
  return ejs
    .renderFile(path.resolve(process.cwd(), 'views', view), params, { async: true })
    .then((body: string) =>
      ejs.renderFile(
        path.resolve(process.cwd(), 'views', 'layout.ejs'),
        { title: params.title || 'Job Poster', body },
        { async: true },
      ),
    )
    .then((html: string) => res.send(html));
}

const getByPath = (obj: any, pathStr: string): any => {
  if (!obj) return undefined;
  return pathStr.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
};

const hasField = (obj: any, pathStr: string) => {
  const v = getByPath(obj, pathStr);
  return v !== undefined && v !== null && !(typeof v === 'string' && v.trim() === '');
};

const deepMerge = (base: any, add: any) => {
  if (Array.isArray(add) || typeof add !== 'object' || add === null) return add ?? base;
  const out: any = { ...(base || {}) };
  for (const k of Object.keys(add)) {
    out[k] = deepMerge(base ? base[k] : undefined, add[k]);
  }
  return out;
};

function applyJobDefaults(job: JobPosting, urlHint?: string): JobPosting {
  const sourceUrl = urlHint || job.sourceUrl;
  if (sourceUrl) {
    job.sourceUrl = sourceUrl;
    if (!job.applyUrl) {
      job.applyUrl = sourceUrl;
    }
  }
  if (!job.datePosted) {
    job.datePosted = new Date().toISOString();
  }
  const org = job.hiringOrganization || { name: '' };
  const orgName = (org.name || '').trim();
  job.hiringOrganization = {
    ...org,
    name: orgName || DEFAULT_COMPANY_NAME,
  };
  return job;
}

function collectMissing(job: JobPosting, selectedIds: string[], ctx: PublishContext) {
  const missing: Record<string, { fields: string[]; credentials: string[] }> = {};
  for (const id of selectedIds) {
    const pub = getPublisherById(id);
    if (!pub) continue;
    const missFields = pub.meta.requiredFields.filter((p) => !hasField(job, p));
    const missCreds = (pub.meta.requiredCredentials || []).filter((p) => !hasField(ctx.creds, p));
    if (missFields.length || missCreds.length) {
      missing[id] = { fields: missFields, credentials: missCreds };
    }
  }
  return missing;
}

function jobFromForm(body: any): JobPosting {
  const job = {
    sourceUrl: body.sourceUrl || undefined,
    title: body.title || '',
    descriptionHTML: sanitizeDescription(body.descriptionHTML || ''),
    hiringOrganization: {
      name: body.orgName || '',
      website: body.orgWebsite || undefined,
      logoUrl: body.orgLogo || undefined,
    },
    employmentType: body.employmentType || undefined,
    remoteType: body.remoteType || undefined,
    datePosted: body.datePosted ? new Date(body.datePosted).toISOString() : undefined,
    validThrough: body.validThrough ? new Date(body.validThrough).toISOString() : undefined,
    applyUrl: body.applyUrl || undefined,
    refId: body.refId || undefined,
    applicantLocationRequirements: body.applicantLocationRequirements || undefined,
    addresses: [
      {
        streetAddress: body.addr_street || undefined,
        addressLocality: body.addr_city || undefined,
        addressRegion: body.addr_region || undefined,
        postalCode: body.addr_postal || undefined,
        addressCountry: body.addr_country || undefined,
      },
    ],
    salary:
      body.salary_currency || body.salary_min || body.salary_max || body.salary_unit
        ? {
            currency: body.salary_currency || undefined,
            min: body.salary_min ? parseFloat(body.salary_min) : undefined,
            max: body.salary_max ? parseFloat(body.salary_max) : undefined,
            unit: body.salary_unit || undefined,
          }
        : undefined,
  } as JobPosting;
  return applyJobDefaults(job, body.sourceUrl || undefined);
}

function determineHostBaseUrl() {
  const configured =
    process.env.ORIGIN ||
    process.env.PUBLIC_HOST_BASE_URL ||
    process.env.RENDER_EXTERNAL_URL;
  if (configured) {
    return configured.replace(/\/+$/, '');
  }
  return 'https://job-poster-r0c5.onrender.com';
}

function buildContext(creds?: Credentials): PublishContext {
  return {
    hostBaseUrl: determineHostBaseUrl(),
    creds: {
      google: {
        serviceAccountJson: creds?.google?.serviceAccountJson || process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
      },
      indeed: {
        clientId: creds?.indeed?.clientId || process.env.INDEED_CLIENT_ID,
        clientSecret: creds?.indeed?.clientSecret || process.env.INDEED_CLIENT_SECRET,
      },
    },
  };
}

app.get('/', async (_req, res) => {
  const modules = listPublisherMeta();
  const holds = listHolds();

  const queueStats = {
    total: holds.length,
    held: holds.filter((h) => h.status === 'HELD').length,
    published: holds.filter((h) => h.status === 'PUBLISHED').length,
    failed: holds.filter((h) => h.status === 'FAILED').length,
  };

  const queue = holds.slice(0, 5).map((rec) => ({
    id: rec.id,
    title: rec.job.title || '(Untitled)',
    organization: rec.job.hiringOrganization?.name || 'Unknown organization',
    status: rec.status,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    moduleNames: rec.selectedModules.map((id) => publisherDictionary[id] || id),
    failureReason: rec.failureReason,
    warnings: rec.warnings || [],
    missing: Object.entries(rec.missing || {}).map(([moduleId, info]) => ({
      moduleLabel: publisherDictionary[moduleId] || moduleId,
      fields: info.fields,
      credentials: info.credentials,
    })),
  }));

  await render(res, 'index.ejs', {
    modules,
    queue,
    queueStats,
    title: 'Job Poster',
  });
});

app.post('/ingest', requireApiKey, async (req, res) => {
  const url = (req.body?.url || '').trim();
  if (!url) {
    return res.status(400).send('Missing URL');
  }
  try {
    const result = await extractFromUrl(url);
    const job = result.job || {};
    const warnings = [...(result.warnings || [])];
    let prepared: JobPosting = {
      title: job.title || '',
      descriptionHTML: job.descriptionHTML || '',
      hiringOrganization: job.hiringOrganization || { name: '' },
      employmentType: job.employmentType,
      datePosted: job.datePosted,
      validThrough: job.validThrough,
      applyUrl: job.applyUrl,
      refId: job.refId,
      remoteType: job.remoteType,
      applicantLocationRequirements: job.applicantLocationRequirements,
      addresses: job.addresses,
      salary: job.salary,
      sourceUrl: job.sourceUrl || url,
    } as JobPosting;
    prepared = applyJobDefaults(prepared, url);

    const selectedModules = PUBLISHERS.map((p) => p.id);
    const ctx = buildContext();
    const missing = collectMissing(prepared, selectedModules, ctx);

    if (result.failureReason) {
      const hold = saveHold({
        sourceUrl: prepared.sourceUrl || url,
        job: prepared,
        selectedModules,
        missing,
        confidences: result.confidences || {},
        warnings: [...warnings],
        failureReason: result.failureReason,
        failureDetails: result.failureDetails,
      });
      warnings.push(
        `Automatic extraction failed and the job was added to the manual review queue (ID: ${hold.id}).`,
      );
    }

    await render(res, 'review.ejs', {
      job: prepared,
      warnings,
      confidences: result.confidences || {},
      moduleOptions: listPublisherMeta(),
      selectedModules: PUBLISHERS.map((p) => p.id),
      formAction: '/publish',
    });
  } catch (err: any) {
    res.status(500).send(`Extraction failed: ${err?.message || String(err)}`);
  }
});

app.post('/publish', async (req, res) => {
  const targetsRaw = req.body.targets;
  const targets = Array.isArray(targetsRaw)
    ? targetsRaw
    : targetsRaw
    ? [targetsRaw]
    : PUBLISHERS.map((p) => p.id);

  const job = jobFromForm(req.body);
  const ctx = buildContext();

  console.info('[publish] manual publish request received', {
    targets,
    jobTitle: job.title,
    org: job.hiringOrganization?.name,
  });

  const results: Array<PublishResult & { targetId: string; targetLabel: string }> = [];
  for (const id of targets) {
    const pub = getPublisherById(id);
    if (!pub) {
      results.push({ ok: false, error: 'Unknown publisher', targetId: id, targetLabel: id });
      continue;
    }
    const outcome = await pub.publish(job, ctx);
    results.push({ ...outcome, targetId: pub.id, targetLabel: pub.label });
  }

  await render(res, 'result.ejs', { results, title: 'Publish Results' });
});

app.get('/api/modules', requireApiKey, (_req, res) => {
  res.json({ modules: listPublisherMeta() });
});

app.post('/api/jobs', requireApiKey, async (req, res) => {
  const {
    url,
    fields,
    modules,
    credentials,
    holdIfIncomplete = true,
  }: {
    url?: string;
    fields?: Partial<JobPosting>;
    modules?: string[] | 'all';
    credentials?: Credentials;
    holdIfIncomplete?: boolean;
  } = req.body || {};

  console.info('[api/jobs] request received', {
    url,
    modules,
    holdIfIncomplete,
    providedFields: Object.keys(fields || {}),
    providedCredentials: credentials ? Object.keys(credentials) : [],
  });

  try {
    let extracted: Partial<JobPosting> = {};
    let confidences: Record<string, number> = {};
    let extractionWarnings: string[] = [];
    let extractionFailureReason: string | undefined;
    let extractionFailureDetails: any;
    if (url) {
      console.info('[api/jobs] starting extraction', { url });
      const r = await extractFromUrl(url);
      extracted = r.job || {};
      confidences = r.confidences || {};
      extractionWarnings = r.warnings || [];
      extractionFailureReason = r.failureReason;
      extractionFailureDetails = r.failureDetails;
      console.info('[api/jobs] extraction completed', {
        warnings: extractionWarnings,
        failureReason: extractionFailureReason,
      });
    }

    const mergedPartial = deepMerge(extracted, fields || {});
    const partial: any = { hiringOrganization: { name: '' }, ...mergedPartial };
    let job: JobPosting = {
      title: partial.title || '',
      descriptionHTML: partial.descriptionHTML || '',
      hiringOrganization: {
        name: partial.hiringOrganization?.name || '',
        website: partial.hiringOrganization?.website,
        logoUrl: partial.hiringOrganization?.logoUrl,
      },
      employmentType: partial.employmentType,
      datePosted: partial.datePosted,
      validThrough: partial.validThrough,
      applyUrl: partial.applyUrl,
      refId: partial.refId,
      remoteType: partial.remoteType,
      applicantLocationRequirements: partial.applicantLocationRequirements,
      addresses: partial.addresses,
      salary: partial.salary,
      sourceUrl: url || partial.sourceUrl,
    };
    job = applyJobDefaults(job, url || partial.sourceUrl);

    const selectedIds =
      modules === 'all' || !modules
        ? PUBLISHERS.map((p) => p.id)
        : Array.isArray(modules)
        ? modules
        : [modules];

    const ctx = buildContext(credentials);

    const missing = collectMissing(job, selectedIds, ctx);

    const hasMissing = Object.keys(missing).length > 0;
    const shouldHoldForFailure = Boolean(extractionFailureReason);
    const shouldHoldForMissing = hasMissing && holdIfIncomplete;
    if (shouldHoldForFailure || shouldHoldForMissing) {
      console.warn('[api/jobs] job held for review', {
        missing,
        extractionFailureReason,
        selectedIds,
      });
      const rec = saveHold({
        sourceUrl: url || job.sourceUrl,
        job,
        selectedModules: selectedIds,
        missing,
        confidences,
        warnings: extractionWarnings,
        failureReason: extractionFailureReason,
        failureDetails: extractionFailureDetails,
      });
      return res.status(202).json({
        status: 'held',
        jobId: rec.id,
        reviewUrl: `${ctx.hostBaseUrl}/admin/jobs/${rec.id}`,
        missing,
        warnings: rec.warnings || [],
        failureReason: rec.failureReason,
        confidences,
      });
    }

    const results: Record<string, PublishResult> = {};
    for (const id of selectedIds) {
      const pub = getPublisherById(id);
      if (!pub) continue;
      console.info('[api/jobs] publishing via module', { moduleId: id, moduleLabel: pub.label });
      const outcome = await pub.publish(job, ctx);
      results[id] = outcome;
      if (!outcome.ok) {
        console.warn('[api/jobs] module publish failed', { moduleId: id, error: outcome.error });
      } else {
        console.info('[api/jobs] module publish succeeded', {
          moduleId: id,
          externalId: outcome.id,
          externalUrl: outcome.url,
        });
      }
    }
    console.info('[api/jobs] publishing complete', {
      selectedIds,
      warnings: extractionWarnings,
    });
    return res.json({ status: 'published', results, warnings: extractionWarnings });
  } catch (err: any) {
    console.error('[api/jobs] unexpected error', { message: err?.message });
    return res.status(500).json({ status: 'error', error: err?.message || String(err) });
  }
});

app.get('/admin/holds', requireAdmin, async (_req, res) => {
  const holds = listHolds().map((rec) => ({
    ...rec,
    moduleNames: rec.selectedModules.map((id) => publisherDictionary[id] || id),
    missingList: Object.entries(rec.missing || {}).map(([moduleId, info]) => ({
      moduleId,
      moduleLabel: publisherDictionary[moduleId] || moduleId,
      fields: info.fields,
      credentials: info.credentials,
    })),
  }));
  await render(res, 'admin_holds.ejs', { holds, title: 'Held Jobs' });
});

app.get('/admin/hosted', requireAdmin, async (_req, res) => {
  const pages = await listHostedJobPages();
  await render(res, 'admin_hosted.ejs', { title: 'Hosted Pages', pages });
});

app.post('/admin/hosted/:slug/delete', requireAdmin, async (req, res) => {
  const { slug } = req.params;
  await deleteHostedJob(slug);
  res.redirect('/admin/hosted');
});

app.get('/admin/jobs/:id', requireAdmin, async (req, res) => {
  const rec = getJob(req.params.id);
  if (!rec) {
    return res.status(404).send('Not found');
  }
  const warnings = [...(rec.warnings || [])];
  if (Object.keys(rec.missing || {}).length) {
    warnings.push('Held due to missing information for one or more publishers.');
  }
  await render(res, 'review.ejs', {
    job: rec.job,
    warnings,
    confidences: rec.confidences || {},
    moduleOptions: listPublisherMeta(),
    selectedModules: rec.selectedModules,
    formAction: `/admin/jobs/${rec.id}/publish`,
  });
});

app.post('/admin/jobs/:id/publish', requireAdmin, async (req, res) => {
  const rec = getJob(req.params.id);
  if (!rec) {
    return res.status(404).send('Not found');
  }
  const job = jobFromForm(req.body);
  const ctx = buildContext();
  console.info('[admin] publishing held job', { jobId: rec.id, modules: rec.selectedModules });
  const results: Record<string, PublishResult> = {};
  for (const id of rec.selectedModules) {
    const pub = getPublisherById(id);
    if (!pub) continue;
    results[id] = await pub.publish(job, ctx);
  }
  markPublished(rec.id, results);
  res.redirect('/admin/holds');
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
