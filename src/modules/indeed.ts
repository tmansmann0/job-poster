import type { JobPosting, PublishContext, PublishResult, ModuleMeta } from '../types.js';

async function getIndeedToken(clientId: string, clientSecret: string): Promise<string> {
  const body = new URLSearchParams();
  body.set('grant_type', 'client_credentials');
  body.set('client_id', clientId);
  body.set('client_secret', clientSecret);
  body.set('scope', 'employer_access');

  const res = await fetch('https://apis.indeed.com/oauth/v2/tokens', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Indeed token error ${res.status}: ${text}`);
  }
  const json: any = await res.json();
  return json.access_token as string;
}

function buildGraphQLCreate(job: JobPosting) {
  const mutation = `
    mutation CreateSourcedJobs($jobs: [SourcedJobPostingInput!]!) {
      jobsIngest {
        createSourcedJobPostings(jobPostings: $jobs) {
          jobPostings {
            sourcedPostingId
            status
            errors { field message }
          }
        }
      }
    }
  `;

  const location = (() => {
    const a = job.addresses?.[0];
    let s = '';
    if (a?.addressCountry) s += `${a.addressCountry}`;
    const cityState = [a?.addressLocality, a?.addressRegion].filter(Boolean).join(', ');
    const pc = a?.postalCode ? ` ${a?.postalCode}` : '';
    if (cityState || pc) s += `${s ? ', ' : ''}${cityState}${pc}`;
    return { country: a?.addressCountry || 'US', cityRegionPostal: s || 'US' };
  })();

  const body = {
    title: job.title,
    description: job.descriptionHTML,
    location,
    employmentType: job.employmentType || 'FULL_TIME',
    applyUrl: job.applyUrl,
  };

  const metadata = {
    jobSource: {
      companyName: job.hiringOrganization?.name || 'Unknown Company',
      sourceName: 'CustomATS',
      sourceType: 'Employer',
    },
    jobPostingId: job.refId || `ref-${Date.now()}`,
    datePublished: job.datePosted || new Date().toISOString(),
    url: job.sourceUrl || job.applyUrl,
  };

  const variables = { jobs: [{ body, metadata }] };
  return { mutation, variables };
}

const meta: ModuleMeta = {
  id: 'indeed',
  label: 'Indeed (GraphQL Job Sync)',
  description:
    'Creates/updates job posts directly in Indeed via partner GraphQL API (OAuth2 client-credentials).',
  requiredFields: ['title', 'descriptionHTML', 'hiringOrganization.name'],
  optionalFields: ['addresses', 'remoteType', 'employmentType', 'applyUrl', 'datePosted', 'refId', 'salary'],
  requiredCredentials: ['indeed.clientId', 'indeed.clientSecret'],
  optionalCredentials: [],
  docsUrl: 'https://apis.indeed.com/',
};

export const indeedPublisher = {
  id: meta.id,
  label: meta.label,
  meta,
  async publish(job: JobPosting, ctx: PublishContext): Promise<PublishResult> {
    const clientId = ctx.creds.indeed?.clientId || process.env.INDEED_CLIENT_ID;
    const clientSecret = ctx.creds.indeed?.clientSecret || process.env.INDEED_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      return {
        ok: false,
        error: 'Indeed credentials missing (provide per-request or set INDEED_CLIENT_ID/INDEED_CLIENT_SECRET).',
      };
    }
    try {
      const token = await getIndeedToken(clientId, clientSecret);
      const { mutation, variables } = buildGraphQLCreate(job);

      const res = await fetch('https://apis.indeed.com/graphql', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ query: mutation, variables }),
      });
      const json: any = await res.json();
      if (!res.ok || json.errors) {
        return { ok: false, error: `Indeed API error: ${res.status} ${JSON.stringify(json.errors || json)}` };
      }
      const node = json?.data?.jobsIngest?.createSourcedJobPostings?.jobPostings?.[0];
      if (node?.errors?.length) {
        return { ok: false, error: `Indeed rejected: ${JSON.stringify(node.errors)}` };
      }
      return { ok: true, id: node?.sourcedPostingId, details: node };
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) };
    }
  },
} as const;
