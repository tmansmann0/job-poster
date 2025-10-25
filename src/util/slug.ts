import slugify from 'slugify';

export function makeSlug(...parts: string[]): string {
  const base = parts.filter(Boolean).join('-');
  return slugify(base, {
    lower: true,
    strict: true,
    trim: true,
  });
}
