import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import path from 'path';
import ejs from 'ejs';
import type { JobPosting, PublishContext, PublishResult, Credentials } from './types.js';
import { extractFromUrl } from './ai/extractor.js';
import { sanitizeDescription } from './util/html.js';
import { PUBLISHERS, getPublisherById, listPublisherMeta } from './modules/publisher.js';
import { saveHold, listHolds, getJob, markPublished } from './store.js';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json());
app.use('/jobs', express.static(path.join(process.cwd(), 'jobs')));

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

function jobFromForm(body: any): JobPosting {
  return {
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
}

function buildContext(creds?: Credentials): PublishContext {
  return {
    hostBaseUrl: process.env.ORIGIN || `http://localhost:${PORT}`,
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
  await render(res, 'index.ejs');
});

app.post('/ingest', async (req, res) => {
  const url = (req.body?.url || '').trim();
  if (!url) {
    return res.status(400).send('Missing URL');
  }
  try {
    const result = await extractFromUrl(url);
    const job = result.job || {};
    const prepared: JobPosting = {
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

    await render(res, 'review.ejs', {
      job: prepared,
      warnings: result.warnings || [],
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

app.get('/api/modules', (_req, res) => {
  res.json({ modules: listPublisherMeta() });
});

app.post('/api/jobs', async (req, res) => {
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

  try {
    let extracted: Partial<JobPosting> = {};
    let confidences: Record<string, number> = {};
    if (url) {
      const r = await extractFromUrl(url);
      extracted = r.job || {};
      confidences = r.confidences || {};
    }

    const mergedPartial = deepMerge(extracted, fields || {});
    const partial: any = { hiringOrganization: { name: '' }, ...mergedPartial };
    const job: JobPosting = {
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

    const selectedIds =
      modules === 'all' || !modules
        ? PUBLISHERS.map((p) => p.id)
        : Array.isArray(modules)
        ? modules
        : [modules];

    const ctx = buildContext(credentials);

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

    const hasMissing = Object.keys(missing).length > 0;
    if (hasMissing && holdIfIncomplete) {
      const rec = saveHold({
        sourceUrl: url,
        job,
        selectedModules: selectedIds,
        missing,
        confidences,
      });
      return res.status(202).json({
        status: 'held',
        jobId: rec.id,
        reviewUrl: `${ctx.hostBaseUrl}/admin/jobs/${rec.id}`,
        missing,
      });
    }

    const results: Record<string, PublishResult> = {};
    for (const id of selectedIds) {
      const pub = getPublisherById(id);
      if (!pub) continue;
      results[id] = await pub.publish(job, ctx);
    }
    return res.json({ status: 'published', results });
  } catch (err: any) {
    return res.status(500).json({ status: 'error', error: err?.message || String(err) });
  }
});

app.get('/admin/holds', async (_req, res) => {
  const holds = listHolds();
  await render(res, 'admin_holds.ejs', { holds, title: 'Held Jobs' });
});

app.get('/admin/jobs/:id', async (req, res) => {
  const rec = getJob(req.params.id);
  if (!rec) {
    return res.status(404).send('Not found');
  }
  await render(res, 'review.ejs', {
    job: rec.job,
    warnings: [`Held due to missing: ${JSON.stringify(rec.missing)}`],
    confidences: rec.confidences || {},
    moduleOptions: listPublisherMeta(),
    selectedModules: rec.selectedModules,
    formAction: `/admin/jobs/${rec.id}/publish`,
  });
});

app.post('/admin/jobs/:id/publish', async (req, res) => {
  const rec = getJob(req.params.id);
  if (!rec) {
    return res.status(404).send('Not found');
  }
  const job = jobFromForm(req.body);
  const ctx = buildContext();
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
