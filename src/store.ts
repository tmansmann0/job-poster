import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { JobRecord, JobPosting, PublishResult } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT = path.resolve(__dirname, 'data');
const HOLDS = path.resolve(ROOT, 'holds');

function ensureDirs() {
  fs.mkdirSync(HOLDS, { recursive: true });
}

function nowISO() { return new Date().toISOString(); }

export function saveHold(rec: Omit<JobRecord, 'id'|'createdAt'|'updatedAt'|'status'>): JobRecord {
  ensureDirs();
  const id = Math.floor(Math.random()*1e9).toString(36);
  const full: JobRecord = { ...rec, id, status: 'HELD', createdAt: nowISO(), updatedAt: nowISO() };
  fs.writeFileSync(path.resolve(HOLDS, `${id}.json`), JSON.stringify(full, null, 2), 'utf-8');
  return full;
}

export function listHolds(): JobRecord[] {
  ensureDirs();
  return fs.readdirSync(HOLDS)
    .filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(fs.readFileSync(path.resolve(HOLDS, f), 'utf-8')) as JobRecord)
    .sort((a,b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function getJob(id: string): JobRecord | undefined {
  const p = path.resolve(HOLDS, `${id}.json`);
  if (!fs.existsSync(p)) return undefined;
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as JobRecord;
}

export function updateJob(id: string, patch: Partial<JobRecord>) {
  const cur = getJob(id);
  if (!cur) return;
  const next = { ...cur, ...patch, updatedAt: nowISO() };
  fs.writeFileSync(path.resolve(HOLDS, `${id}.json`), JSON.stringify(next, null, 2), 'utf-8');
}

export function markPublished(id: string, results: Record<string, PublishResult>) {
  updateJob(id, { status: 'PUBLISHED', results });
}
