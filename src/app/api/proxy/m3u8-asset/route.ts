/* eslint-disable @typescript-eslint/no-explicit-any */

import { NextResponse } from 'next/server';

import { verifyM3U8ProxySignature } from '@/lib/m3u8-proxy';
import {
  fetchWithValidatedRedirects,
  normalizeHeaderUrl,
  validateProxyTargetUrl,
} from '@/lib/proxy-security';

export const runtime = 'nodejs';

const DEFAULT_UA =
  'Mozilla/5.0 (Linux; Android 10; AndroidTV) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 15000;
const FETCH_RETRY_TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 3;
const MAX_UPSTREAM_ATTEMPTS = 5;

function withCorsHeaders(headers: Headers) {
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  headers.set(
    'Access-Control-Allow-Headers',
    'Content-Type, Range, Origin, Accept',
  );
  headers.set(
    'Access-Control-Expose-Headers',
    'Content-Length, Content-Range, Accept-Ranges, Content-Type',
  );
}

function jsonError(error: string, status: number, details?: string) {
  const headers = new Headers();
  withCorsHeaders(headers);
  return NextResponse.json({ error, details }, { status, headers });
}

function inferContentType(decodedUrl: string, kind: string | null) {
  const pathname = (() => {
    try {
      return new URL(decodedUrl).pathname.toLowerCase();
    } catch {
      return decodedUrl.toLowerCase();
    }
  })();

  if (kind === 'key' || pathname.endsWith('.key')) {
    return 'application/octet-stream';
  }
  if (pathname.endsWith('.m4s') || pathname.endsWith('.m4v')) {
    return 'video/iso.segment';
  }
  if (pathname.endsWith('.mp4')) {
    return 'video/mp4';
  }
  if (pathname.endsWith('.aac')) {
    return 'audio/aac';
  }
  if (pathname.endsWith('.vtt')) {
    return 'text/vtt; charset=utf-8';
  }
  return 'video/mp2t';
}

function copyHeader(
  from: Headers,
  to: Headers,
  sourceKey: string,
  targetKey = sourceKey,
) {
  const value = from.get(sourceKey);
  if (value) {
    to.set(targetKey, value);
  }
}

function resolveReferer(
  decodedUrl: string,
  request: Request,
  explicit?: string,
) {
  const sanitizedExplicitReferer = normalizeHeaderUrl(explicit);
  const inboundReferer = normalizeHeaderUrl(request.headers.get('referer'));
  let fallbackReferer: string | undefined;
  try {
    fallbackReferer = new URL(decodedUrl).origin + '/';
  } catch {
    fallbackReferer = undefined;
  }
  return sanitizedExplicitReferer || fallbackReferer || inboundReferer;
}

function shouldRetryUpstreamStatus(status: number): boolean {
  return (
    status === 401 ||
    status === 403 ||
    status === 404 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

async function handleAssetRequest(request: Request, method: 'GET' | 'HEAD') {
  const { searchParams } = new URL(request.url);
  const url = searchParams.get('url');
  const referer = searchParams.get('referer') || undefined;
  const kind = searchParams.get('kind');

  if (!url) {
    return jsonError('Missing url', 400);
  }

  const decodedUrl = url.trim();
  if (!decodedUrl) {
    return jsonError('Invalid url', 400);
  }

  if (!verifyM3U8ProxySignature(decodedUrl, referer, searchParams.get('sig'))) {
    return jsonError('Invalid signature', 403);
  }

  try {
    await validateProxyTargetUrl(decodedUrl);
  } catch (e: any) {
    return jsonError(e?.message || 'Invalid url', 400);
  }

  const refererToSend = resolveReferer(decodedUrl, request, referer);
  let fallbackReferer: string | undefined;
  let playlistDirectoryReferer: string | undefined;
  try {
    fallbackReferer = new URL(decodedUrl).origin + '/';
    playlistDirectoryReferer = new URL('.', decodedUrl).toString();
  } catch {
    fallbackReferer = undefined;
    playlistDirectoryReferer = undefined;
  }
  const inboundReferer = normalizeHeaderUrl(request.headers.get('referer'));

  const buildRequestHeaders = (
    refererValue?: string,
    userAgent = request.headers.get('user-agent') || DEFAULT_UA,
    includeOrigin = true,
  ) => {
    const headers: Record<string, string> = {
      Accept: '*/*',
      'User-Agent': userAgent,
    };

    if (refererValue) {
      headers.Referer = refererValue;
      if (includeOrigin) {
        try {
          headers.Origin = new URL(refererValue).origin;
        } catch {
          // ignore
        }
      }
    }

    const range = request.headers.get('range');
    if (range) {
      headers.Range = range;
    }
    return headers;
  };

  const attempts: Array<{
    referer?: string;
    userAgent: string;
    includeOrigin: boolean;
  }> = [];
  const pushAttempt = (
    attemptReferer: string | undefined,
    userAgent: string,
    includeOrigin: boolean,
  ) => {
    if (
      attempts.some(
        (attempt) =>
          attempt.referer === attemptReferer &&
          attempt.userAgent === userAgent &&
          attempt.includeOrigin === includeOrigin,
      )
    ) {
      return;
    }
    attempts.push({ referer: attemptReferer, userAgent, includeOrigin });
  };

  const requestUa = request.headers.get('user-agent') || DEFAULT_UA;
  for (const attemptReferer of [
    refererToSend,
    fallbackReferer,
    playlistDirectoryReferer,
    inboundReferer,
    undefined,
  ]) {
    pushAttempt(attemptReferer, requestUa, true);
  }
  for (const attemptReferer of [
    refererToSend,
    fallbackReferer,
    playlistDirectoryReferer,
    inboundReferer,
    undefined,
  ]) {
    pushAttempt(attemptReferer, DESKTOP_UA, true);
    pushAttempt(attemptReferer, DESKTOP_UA, false);
  }

  let upstream: Response | null = null;
  let lastErrorMessage = '';
  for (const [index, attempt] of attempts
    .slice(0, MAX_UPSTREAM_ATTEMPTS)
    .entries()) {
    try {
      const response = await fetchWithValidatedRedirects(
        decodedUrl,
        {
          cache: 'no-store',
          headers: buildRequestHeaders(
            attempt.referer,
            attempt.userAgent,
            attempt.includeOrigin,
          ),
          method,
        },
        {
          timeoutMs: index === 0 ? FETCH_TIMEOUT_MS : FETCH_RETRY_TIMEOUT_MS,
          maxRedirects: MAX_REDIRECTS,
        },
      );
      upstream = response;
      if (
        response.ok ||
        response.status === 206 ||
        !shouldRetryUpstreamStatus(response.status)
      ) {
        break;
      }
      lastErrorMessage = `HTTP ${response.status}`;
      await response.body?.cancel().catch(() => undefined);
    } catch (e: any) {
      lastErrorMessage = e?.message || 'unknown';
      continue;
    }
  }

  if (!upstream) {
    return jsonError(
      'Upstream fetch failed',
      502,
      lastErrorMessage || 'unknown',
    );
  }

  if (!upstream.ok && upstream.status !== 206) {
    return jsonError('Failed to fetch asset', upstream.status || 502);
  }

  const headers = new Headers();
  withCorsHeaders(headers);
  headers.set(
    'Cache-Control',
    kind === 'key' ? 'public, max-age=3600' : 'no-cache',
  );
  headers.set('Vary', 'Range');
  copyHeader(upstream.headers, headers, 'content-type', 'Content-Type');
  copyHeader(upstream.headers, headers, 'content-length', 'Content-Length');
  copyHeader(upstream.headers, headers, 'content-range', 'Content-Range');
  copyHeader(upstream.headers, headers, 'accept-ranges', 'Accept-Ranges');
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', inferContentType(decodedUrl, kind));
  }
  if (!headers.has('Accept-Ranges')) {
    headers.set('Accept-Ranges', 'bytes');
  }

  return new Response(method === 'HEAD' ? null : upstream.body, {
    status: upstream.status,
    headers,
  });
}

export async function OPTIONS() {
  const headers = new Headers();
  withCorsHeaders(headers);
  return new Response(null, { status: 204, headers });
}

export async function HEAD(request: Request) {
  return handleAssetRequest(request, 'HEAD');
}

export async function GET(request: Request) {
  return handleAssetRequest(request, 'GET');
}
