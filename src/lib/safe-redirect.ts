const FALLBACK_REDIRECT = '/';
const INTERNAL_ORIGIN = 'http://decotv.local';

export function getSafeRedirectPath(
  redirect: string | null | undefined,
): string {
  const value = redirect?.trim();
  if (!value || !value.startsWith('/') || value.startsWith('//')) {
    return FALLBACK_REDIRECT;
  }

  try {
    const parsed = new URL(value, INTERNAL_ORIGIN);
    if (parsed.origin !== INTERNAL_ORIGIN) {
      return FALLBACK_REDIRECT;
    }

    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return FALLBACK_REDIRECT;
  }
}
