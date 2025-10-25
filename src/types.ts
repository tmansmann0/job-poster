export type EmploymentType =
  | 'FULL_TIME' | 'PART_TIME' | 'CONTRACT' | 'TEMPORARY'
  | 'INTERN' | 'VOLUNTEER' | 'PER_DIEM' | 'OTHER';

export interface PostalAddress {
  streetAddress?: string;
  addressLocality?: string; // City
  addressRegion?: string;   // State/Province
  postalCode?: string;
  addressCountry?: string;  // ISO-2 code
}

export interface Salary {
  currency?: string;
  min?: number;
  max?: number;
  unit?: 'HOUR' | 'DAY' | 'WEEK' | 'MONTH' | 'YEAR';
}

export interface HiringOrganization {
  name: string;
  website?: string;
  logoUrl?: string;
}

export interface JobPosting {
  id?: string;
  sourceUrl?: string;
  title: string;
  descriptionHTML: string;
  hiringOrganization: HiringOrganization;
  employmentType?: EmploymentType;
  datePosted?: string;
  validThrough?: string;
  applyUrl?: string;
  refId?: string;
  remoteType?: 'ONSITE' | 'REMOTE' | 'HYBRID';
  applicantLocationRequirements?: string;
  addresses?: PostalAddress[];
  salary?: Salary;
}

export interface FieldConfidence<T> {
  value: T | null;
  confidence: number; // 0..1
  notes?: string;
}

export interface ExtractResult {
  job: Partial<JobPosting>;
  confidences: Record<string, number>;
  warnings?: string[];
  rawModelOutput?: any;
}

/** ===== Multi-tenant credential model ===== */
export interface Credentials {
  google?: { serviceAccountJson?: string }; // optional (only for Indexing API)
  indeed?: { clientId?: string; clientSecret?: string };
}
export interface PublishContext {
  hostBaseUrl: string;
  creds: Credentials; // per-request creds (fallback to env handled in modules)
}

export interface PublishResult {
  ok: boolean;
  url?: string;
  id?: string;
  details?: any;
  error?: string;
}

/** ===== Module metadata for discovery ===== */
export interface ModuleMeta {
  id: string;
  label: string;
  description?: string;
  requiredFields: string[];        // dot-paths on JobPosting
  optionalFields?: string[];
  requiredCredentials?: string[];  // dot-paths on Credentials (e.g. "indeed.clientId")
  optionalCredentials?: string[];
  docsUrl?: string;
}

/** ===== Store records for holds/review ===== */
export type JobStatus = 'HELD' | 'PUBLISHED' | 'FAILED';

export interface JobRecord {
  id: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  sourceUrl?: string;
  job: JobPosting;
  selectedModules: string[];
  missing: { [moduleId: string]: { fields: string[]; credentials: string[] } };
  confidences?: Record<string, number>;
  results?: Record<string, PublishResult>;
}
