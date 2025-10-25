
import { PublisherModule, JobData } from '../types.js';
import fs from 'fs';
import path from 'path';
import slugify from 'slugify';
import * as dotenv from 'dotenv';
dotenv.config();

const jobsDir = path.join(process.cwd(), 'jobs');

async function publish(job: JobData): Promise<{ success: boolean; message: string; url?: string }> {
  try {
    if (!fs.existsSync(jobsDir)) {
      fs.mkdirSync(jobsDir);
    }
    const slug = slugify(job.title + '-' + Date.now(), { lower: true, strict: true });
    const filePath = path.join(jobsDir, slug + '.html');

    const jsonLd = {
      '@context': 'https://schema.org/',
      '@type': 'JobPosting',
      title: job.title,
      description: job.description,
      hiringOrganization: {
        '@type': 'Organization',
        name: job.organization
      },
      jobLocation: {
        '@type': 'Place',
        address: {
          '@type': 'PostalAddress',
          streetAddress: job.location
        }
      },
      datePosted: job.datePosted || new Date().toISOString(),
      validThrough: job.validThrough || new Date(Date.now() + 1000*60*60*24*30).toISOString(),
      employmentType: job.employmentType || undefined,
      salary: job.salary || undefined,
      applicantLocationRequirements: undefined,
      directApply: false
    };

    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${job.title}</title>
  <script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
</head>
<body>
  <h1>${job.title}</h1>
  <div>${job.description}</div>
</body>
</html>
`;
    fs.writeFileSync(filePath, html, 'utf-8');
    // TODO: optionally ping Google's Indexing API if configured
    return { success: true, message: 'Job published to Google page', url: '/jobs/' + slug + '.html' };
  } catch (err: any) {
    return { success: false, message: err.message };
  }
}

const module: PublisherModule = {
  name: 'google',
  publish
};

export default module;
