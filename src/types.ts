
export interface JobData {
  title: string;
  description: string;
  organization: string;
  location: string;
  salary?: string;
  employmentType?: string;
  datePosted?: string;
  validThrough?: string;
  applyUrl?: string;
  [key: string]: any;
}

export interface AiField<T> {
  value: T;
  confidence: number;
}

export interface AiExtractResult {
  data: { [K in keyof JobData]: AiField<JobData[K]> };
  html?: string;
}

export interface PublisherModule {
  name: string;
  publish: (job: JobData) => Promise<{ success: boolean; message: string; [key: string]: any }>;
}
