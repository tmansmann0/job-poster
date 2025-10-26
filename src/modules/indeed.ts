import type { JobPosting, PublishContext, PublishResult, ModuleMeta } from '../types.js';

const BASE_URL = process.env.INDEED_API_BASE_URL || 'https://apis.indeed.com';
const GRAPHQL_URL = process.env.INDEED_GRAPHQL_URL || `${BASE_URL}/graphql`;
const OAUTH_URL = process.env.INDEED_OAUTH_URL || `${BASE_URL}/oauth/v2/tokens`;
const OAUTH_SCOPE = process.env.INDEED_OAUTH_SCOPE || 'employer_access';

const mask = (value?: string) => {
  if (!value) return 'unset';
  if (value.length <= 4) return '****';
  return `${value.slice(0, 2)}…${value.slice(-2)}`;
};

async function getIndeedToken(clientId: string, clientSecret: string): Promise<string> {
  const body = new URLSearchParams();
  body.set('grant_type', 'client_credentials');
  body.set('client_id', clientId);
  body.set('client_secret', clientSecret);
  body.set('scope', OAUTH_SCOPE);

  console.info('[indeed] requesting OAuth token', {
    clientId: mask(clientId),
    scope: OAUTH_SCOPE,
    oauthUrl: OAUTH_URL,
  });

  const res = await fetch(OAUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    console.error('[indeed] OAuth token request failed', {
      status: res.status,
      statusText: res.statusText,
      body: text,
    });
    throw new Error(`Indeed token error ${res.status}: ${text}`);
  }
  const json: any = await res.json();
  console.info('[indeed] obtained OAuth token', {
    expiresIn: json.expires_in,
    tokenType: json.token_type,
  });
  return json.access_token as string;
}

function buildGraphQLCreate(job: JobPosting) {
  const mutation = `
    mutation CreateSourcedJobs($input: CreateSourcedJobPostingsInput!) {
      jobsIngest {
        createSourcedJobPostings(input: $input) {
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

  const variables = {
    input: {
      jobPostings: [
        {
          body,
          metadata,
        },
      ],
    },
  };
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
      const jobPostingId = variables.input.jobPostings[0].metadata.jobPostingId;

      console.info('[indeed] submitting job posting', {
        jobPostingId,
        graphqlUrl: GRAPHQL_URL,
      });

      const res = await fetch(GRAPHQL_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ query: mutation, variables }),
      });
      const json: any = await res.json();
      if (!res.ok || json.errors) {
        console.error('[indeed] GraphQL request failed', {
          status: res.status,
          statusText: res.statusText,
          response: json,
        });
        const message =
          res.status === 401 || res.status === 403
            ? 'Indeed API rejected the credentials (check client ID/secret or environment).'
            : `Indeed API error: ${res.status}`;
        return { ok: false, error: `${message} ${JSON.stringify(json.errors || json)}` };
      }
      const node = json?.data?.jobsIngest?.createSourcedJobPostings?.jobPostings?.[0];
      if (node?.errors?.length) {
        console.warn('[indeed] job posting rejected', {
          jobPostingId,
          errors: node.errors,
        });
        return { ok: false, error: `Indeed rejected: ${JSON.stringify(node.errors)}` };
      }
      console.info('[indeed] job posting submitted successfully', {
        jobPostingId,
        status: node?.status,
      });
      return { ok: true, id: node?.sourcedPostingId, details: node };
    } catch (err: any) {
      console.error('[indeed] unexpected error', {
        message: err?.message,
      });
      return { ok: false, error: err?.message || String(err) };
    }
  },
} as const;
