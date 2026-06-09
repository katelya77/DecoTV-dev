import type { NextRequest } from 'next/server';

export type EffectiveRequestProtocol = 'http' | 'https';

type RequestWithUrl = Pick<NextRequest, 'headers' | 'nextUrl'>;

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

  return request.nextUrl.protocol.toLowerCase() === 'https:' ? 'https' : 'http';
}

export function isSecureRequest(request: RequestWithUrl): boolean {
  return getEffectiveRequestProtocol(request) === 'https';
}

export function getEffectiveRequestHost(request: RequestWithUrl): string {
  return (
    firstHeaderValue(request.headers.get('x-forwarded-host')) ||
    request.headers.get('host')?.trim() ||
    request.nextUrl.host
  );
}

export function getEffectiveRequestOrigin(request: RequestWithUrl): string {
  return `${getEffectiveRequestProtocol(request)}://${getEffectiveRequestHost(
    request,
  )}`;
}
