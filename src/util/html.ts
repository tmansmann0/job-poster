export function sanitizeDescription(html: string): string {
  if (!html) return '';
  return html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '').trim();
}
