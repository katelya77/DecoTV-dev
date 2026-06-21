export type EffectiveRequestProtocol = 'http' | 'https';

type RequestWithUrl = {
  headers: Headers;
  nextUrl?: URL;
  url?: string;
};

function firstHeaderValue(value: string | null): string | null {
  const first = value?.split(',')[0]?.trim();
  return first || null;
}

function normalizeProtocol(
  value: string | null,
): EffectiveRequestProtocol | null {
  const normalized = value?.replace(/^"|"$/g, '').trim().toLowerCase();
  return normalized === 'http' || normalized === 'https' ? normalized : null;
}

function getForwardedProto(
  header: string | null,
): EffectiveRequestProtocol | null {
  const firstForwarded = firstHeaderValue(header);
  if (!firstForwarded) return null;

  for (const part of firstForwarded.split(';')) {
    const [rawName, ...rawValueParts] = part.split('=');
    if (rawName?.trim().toLowerCase() !== 'proto') continue;

    return normalizeProtocol(rawValueParts.join('='));
  }

  return null;
}

function normalizeHost(value: string | null): string | null {
  const normalized = value?.replace(/^"|"$/g, '').trim();
  if (!normalized || /[\r\n]/.test(normalized)) return null;
  return normalized;
}

function getForwardedHost(header: string | null): string | null {
  const firstForwarded = firstHeaderValue(header);
  if (!firstForwarded) return null;

  for (const part of firstForwarded.split(';')) {
    const [rawName, ...rawValueParts] = part.split('=');
    if (rawName?.trim().toLowerCase() !== 'host') continue;

    return normalizeHost(rawValueParts.join('='));
  }

  return null;
}

function getRequestUrl(request: RequestWithUrl): URL | null {
  if (request.nextUrl) return request.nextUrl;

  if (typeof request.url === 'string') {
    try {
      return new URL(request.url);
    } catch {
      return null;
    }
  }

  return null;
}

export function getEffectiveRequestProtocol(
  request: RequestWithUrl,
): EffectiveRequestProtocol {
  const forwardedProto = normalizeProtocol(
    firstHeaderValue(request.headers.get('x-forwarded-proto')),
  );
  if (forwardedProto) return forwardedProto;

  const standardForwardedProto = getForwardedProto(
    request.headers.get('forwarded'),
  );
  if (standardForwardedProto) return standardForwardedProto;

  const requestUrl = getRequestUrl(request);
  return requestUrl?.protocol.toLowerCase() === 'https:' ? 'https' : 'http';
}

export function isSecureRequest(request: RequestWithUrl): boolean {
  return getEffectiveRequestProtocol(request) === 'https';
}

export function getEffectiveRequestHost(request: RequestWithUrl): string {
  return (
    normalizeHost(firstHeaderValue(request.headers.get('x-forwarded-host'))) ||
    getForwardedHost(request.headers.get('forwarded')) ||
    normalizeHost(request.headers.get('host')) ||
    getRequestUrl(request)?.host ||
    ''
  );
}

export function getEffectiveRequestOrigin(request: RequestWithUrl): string {
  return `${getEffectiveRequestProtocol(request)}://${getEffectiveRequestHost(
    request,
  )}`;
}
