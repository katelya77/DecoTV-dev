import { createHmac, timingSafeEqual } from 'crypto';

import { getAuthSecret } from '@/lib/auth';

function getM3U8ProxySecret(): string | null {
  const explicit =
    process.env.M3U8_PROXY_SIGNING_SECRET ||
    process.env.AUTH_SECRET ||
    process.env.NEXTAUTH_SECRET ||
    process.env.PASSWORD ||
    process.env.ADMIN_PASSWORD ||
    getAuthSecret();

  if (explicit) return explicit;

  return process.env.NODE_ENV === 'production'
    ? null
    : 'dev-m3u8-proxy-signing-secret';
}

function base64Url(input: Buffer): string {
  return input
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function signaturePayload(upstreamUrl: string, referer?: string): string {
  return `${upstreamUrl}\n${referer || ''}`;
}

export function signM3U8ProxyRequest(
  upstreamUrl: string,
  referer?: string,
): string | null {
  const secret = getM3U8ProxySecret();
  if (!secret) return null;

  return base64Url(
    createHmac('sha256', secret)
      .update(signaturePayload(upstreamUrl, referer))
      .digest(),
  );
}

export function verifyM3U8ProxySignature(
  upstreamUrl: string,
  referer: string | undefined,
  signature: string | null,
): boolean {
  if (!signature) return false;

  const expected = signM3U8ProxyRequest(upstreamUrl, referer);
  if (!expected || expected.length !== signature.length) return false;

  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}
