import type { JobPosting, PublishContext, PublishResult, ModuleMeta } from '../types.js';
import { googlePublisher } from './google.js';
import { indeedPublisher } from './indeed.js';

export interface Publisher {
  id: string;
  label: string;
  meta: ModuleMeta;
  publish(job: JobPosting, ctx: PublishContext): Promise<PublishResult>;
}

export const PUBLISHERS: Publisher[] = [googlePublisher, indeedPublisher];

export function getPublisherById(id: string): Publisher | undefined {
  return PUBLISHERS.find((p) => p.id === id);
}

export function listPublisherMeta(): ModuleMeta[] {
  return PUBLISHERS.map((p) => p.meta);
}
