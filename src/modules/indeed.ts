
import { PublisherModule, JobData } from '../types.js';
import { request, gql } from 'graphql-request';
import * as dotenv from 'dotenv';
dotenv.config();

const INDEED_CLIENT_ID = process.env.INDEED_CLIENT_ID;
const INDEED_CLIENT_SECRET = process.env.INDEED_CLIENT_SECRET;

async function getAccessToken(): Promise<string> {
  if (!INDEED_CLIENT_ID || !INDEED_CLIENT_SECRET) {
    throw new Error('Indeed credentials missing');
  }
  const params = new URLSearchParams();
  params.append('grant_type', 'client_credentials');
  params.append('client_id', INDEED_CLIENT_ID);
  params.append('client_secret', INDEED_CLIENT_SECRET);
  params.append('scope', 'employer_access');
  const res = await fetch('https://apis.indeed.com/oauth/v2/tokens', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params
  });
  if (!res.ok) {
    throw new Error('Failed to get token: ' + res.status);
  }
  const data = await res.json();
  return data.access_token;
}

async function publish(job: JobData): Promise<{ success: boolean; message: string }> {
  try {
    const token = await getAccessToken();
    const endpoint = 'https://apis.indeed.com/graphql';
    const mutation = gql`
    mutation CreateSourcedJob($input: [jobsIngestCreateSourcedJobPostingsInput!]!) {
      jobsIngest {
        createSourcedJobPostings(jobPostings: $input) {
          sourcedPostingId
          jobPostingId
        }
      }
    }
    `;

    const input = [
      {
        body: {
          title: job.title,
          description: job.description,
          location: { country: 'US', cityRegionPostal: job.location },
          benefits: []
        },
        metadata: {
          jobSource: {
            companyName: job.organization,
            sourceName: 'CustomATS',
            sourceType: 'Employer'
          },
          jobPostingId: String(Date.now()),
          datePublished: job.datePosted || new Date().toISOString(),
          url: job.applyUrl || ''
        }
      }
    ];

    const headers = {
      Authorization: `Bearer ${token}`
    };
    const variables = { input };
    const res = await request(endpoint, mutation, variables, headers);
    return { success: true, message: 'Job posted to Indeed: ' + JSON.stringify(res) };
  } catch (err: any) {
    return { success: false, message: err.message };
  }
}

const module: PublisherModule = {
  name: 'indeed',
  publish
};

export default module;
