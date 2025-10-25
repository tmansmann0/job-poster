
import express from 'express';
import bodyParser from 'body-parser';
import fs from 'fs';
import path from 'path';
import slugify from 'slugify';
import axios from 'axios';
import { extractJob } from './services/aiExtractor.js';
import googleModule from './modules/google.js';
import indeedModule from './modules/indeed.js';
import { JobData, AiExtractResult } from './types.js';
import * as dotenv from 'dotenv';
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Register view engine
app.set('view engine', 'ejs');
app.set('views', path.join(process.cwd(), 'views'));

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// Serve static job pages
app.use('/jobs', express.static(path.join(process.cwd(), 'jobs')));

// Modules registry
const modules = {
  google: googleModule,
  indeed: indeedModule
};

app.get('/', (req, res) => {
  res.render('index', { modules: Object.keys(modules) });
});

app.post('/extract', async (req, res) => {
  const { url } = req.body;
  try {
    const response = await axios.get(url);
    const html = response.data;
    const aiResult = await extractJob(url, html);
    // convert AI result to job data for default fill
    const job: JobData = {} as any;
    for (const key in aiResult.data) {
      job[key] = (aiResult.data as any)[key].value;
    }
    res.render('review', { job, modules: Object.keys(modules) });
  } catch (err: any) {
    res.status(500).send('Error extracting job: ' + err.message);
  }
});

app.post('/publish', async (req, res) => {
  const { selectedModules, ...jobFields } = req.body;
  const selected = Array.isArray(selectedModules) ? selectedModules : [selectedModules];
  const job: JobData = jobFields as any;
  const results: any[] = [];

  for (const name of selected) {
    const mod = (modules as any)[name];
    if (mod) {
      const result = await mod.publish(job);
      results.push({ name, result });
    }
  }
  res.json({ results });
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
