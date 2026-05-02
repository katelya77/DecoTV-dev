/* eslint-disable @typescript-eslint/no-explicit-any */

import { lookup } from 'dns/promises';
import { isIP } from 'net';
import { NextResponse } from 'next/server';

import { DEFAULT_AD_FILTER_CONFIG, filterM3U8 } from '@/lib/ad-filter';
import { getConfig } from '@/lib/config';
import { getBaseUrl, resolveUrl } from '@/lib/live';
import {
  signM3U8ProxyRequest,
  verifyM3U8ProxySignature,
} from '@/lib/m3u8-proxy';

export const runtime = 'nodejs';

const DEFAULT_UA =
  'Mozilla/5.0 (Linux; Android 10; AndroidTV) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const FETCH_TIMEOUT_MS = 8000;
const MAX_PLAYLIST_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;

/**
 * 解析广告过滤是否启用：admin 后台开关 > 环境变量 > 默认开。
 * 后台未配置时回落到 ENABLE_AD_FILTER；都没配置时默认 true。
 */
async function isAdFilterEnabled(): Promise<boolean> {
  try {
    const cfg = await getConfig();
    if (typeof cfg?.AdFilterConfig?.enabled === 'boolean') {
      return cfg.AdFilterConfig.enabled;
    }
  } catch {
    // ignore - fallback to env
  }
  const flag = process.env.ENABLE_AD_FILTER;
  if (flag === undefined) return true;
  return flag === 'true' || flag === '1';
}

/**
 * 高级用户可通过环境变量重载广告判定阈值（不在管理 UI 暴露）：
 *   AD_FILTER_MIN_DURATION  / AD_FILTER_MAX_DURATION  / AD_FILTER_MAX_SEGMENTS
 */
function buildFilterConfigFromEnv() {
  const parseNum = (v: string | undefined, fallback: number): number => {
    if (!v) return fallback;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    ...DEFAULT_AD_FILTER_CONFIG,
    minAdDuration: parseNum(
      process.env.AD_FILTER_MIN_DURATION,
      DEFAULT_AD_FILTER_CONFIG.minAdDuration,
    ),
    maxAdDuration: parseNum(
      process.env.AD_FILTER_MAX_DURATION,
      DEFAULT_AD_FILTER_CONFIG.maxAdDuration,
    ),
    maxConsecutiveAdSegments: parseNum(
      process.env.AD_FILTER_MAX_SEGMENTS,
      DEFAULT_AD_FILTER_CONFIG.maxConsecutiveAdSegments,
    ),
  };
}

function buildProxyUrl(
  request: Request,
  upstreamUrl: string,
  referer?: string,
): string {
  const host = request.headers.get('host');
  const protocol =
    request.headers.get('x-forwarded-proto') ||
    (() => {
      try {
        return new URL(request.url).protocol.replace(':', '');
      } catch {
        return 'http';
      }
    })();
  const signature = signM3U8ProxyRequest(upstreamUrl, referer);
  let qs = `url=${encodeURIComponent(upstreamUrl)}`;
  if (referer) qs += `&referer=${encodeURIComponent(referer)}`;
  if (signature) qs += `&sig=${encodeURIComponent(signature)}`;
  return `${protocol}://${host}/api/proxy/m3u8-filter?${qs}`;
}

/**
 * 主播放列表（含 #EXT-X-STREAM-INF）：把每个变体 URL 改写为再次走本路由，
 * 这样客户端最终拿到的变体也会被过滤。
 */
function rewriteMasterPlaylist(
  content: string,
  baseUrl: string,
  request: Request,
  referer?: string,
): string {
  const lines = content.split('\n');
  const out: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    out.push(line);

    if (line.trim().startsWith('#EXT-X-STREAM-INF:')) {
      // 下一行是变体 URL
      if (i + 1 < lines.length) {
        const variantLine = lines[i + 1].trim();
        if (variantLine && !variantLine.startsWith('#')) {
          const absolute = resolveUrl(baseUrl, variantLine);
          out.push(buildProxyUrl(request, absolute, referer));
          i++;
          continue;
        }
      }
    }
  }

  return out.join('\n');
}

/**
 * 变体播放列表：把所有相对 URL 解析为上游绝对 URL，让播放器直连上游 CDN
 * 拉 TS（不消耗本服务带宽）。EXT-X-MAP/EXT-X-KEY 同样处理。
 */
function absolutizeVariantPlaylist(content: string, baseUrl: string): string {
  const lines = content.split('\n');

  return lines
    .map((rawLine) => {
      const line = rawLine.trimEnd();

      if (line.startsWith('#EXT-X-MAP:') || line.startsWith('#EXT-X-KEY:')) {
        return line.replace(/URI="([^"]+)"/, (_, uri) => {
          return `URI="${resolveUrl(baseUrl, uri)}"`;
        });
      }

      if (line && !line.startsWith('#')) {
        return resolveUrl(baseUrl, line);
      }

      return line;
    })
    .join('\n');
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function normalizeHeaderUrl(
  value: string | null | undefined,
): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return undefined;
    }
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function normalizeHostname(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
}

function isBlockedHostname(hostname: string): boolean {
  return (
    !hostname ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === 'metadata.google.internal'
  );
}

function isBlockedIPv4(address: string): boolean {
  const parts = address.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
    return true;
  }

  const [a, b, c] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 224 && b === 0 && c === 0) ||
    a >= 224
  );
}

function isBlockedIPv6(address: string): boolean {
  const normalized = address.toLowerCase();
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIPv4(mapped[1]);

  return (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb') ||
    normalized.startsWith('ff') ||
    normalized.startsWith('2001:db8')
  );
}

function isBlockedAddress(address: string): boolean {
  const version = isIP(normalizeHostname(address));
  if (version === 4) return isBlockedIPv4(address);
  if (version === 6) return isBlockedIPv6(normalizeHostname(address));
  return true;
}

async function validateProxyTargetUrl(rawUrl: string): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Invalid url');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http/https supported');
  }

  if (parsed.username || parsed.password) {
    throw new Error('URL credentials are not supported');
  }

  const hostname = normalizeHostname(parsed.hostname);
  if (isBlockedHostname(hostname)) {
    throw new Error('Blocked host');
  }

  const literalVersion = isIP(hostname);
  if (literalVersion) {
    if (isBlockedAddress(hostname)) throw new Error('Blocked IP address');
    return parsed.toString();
  }

  const records = await lookup(hostname, { all: true, verbatim: true });
  if (!records.length) throw new Error('Host did not resolve');

  if (records.some((record) => isBlockedAddress(record.address))) {
    throw new Error('Host resolves to a blocked IP address');
  }

  return parsed.toString();
}

async function fetchPlaylistWithRedirects(
  rawUrl: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  let currentUrl = rawUrl;

  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const validatedUrl = await validateProxyTargetUrl(currentUrl);
    const response = await fetchWithTimeout(
      validatedUrl,
      { ...init, redirect: 'manual' },
      timeoutMs,
    );

    if (
      response.status >= 300 &&
      response.status < 400 &&
      response.headers.has('location')
    ) {
      if (i === MAX_REDIRECTS) throw new Error('Too many redirects');
      const location = response.headers.get('location');
      if (!location) throw new Error('Redirect location missing');
      currentUrl = new URL(location, validatedUrl).toString();
      continue;
    }

    return response;
  }

  throw new Error('Too many redirects');
}

async function readTextWithLimit(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error('Playlist too large');
  }

  if (!response.body) return '';

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw new Error('Playlist too large');
    }
    text += decoder.decode(value, { stream: true });
  }

  text += decoder.decode();
  return text;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const url = searchParams.get('url');

  if (!url) {
    return NextResponse.json({ error: 'Missing url' }, { status: 400 });
  }

  const decodedUrl = url.trim();
  if (!decodedUrl) {
    return NextResponse.json({ error: 'Invalid url' }, { status: 400 });
  }

  const explicitReferer = searchParams.get('referer') || undefined;
  if (
    !verifyM3U8ProxySignature(
      decodedUrl,
      explicitReferer,
      searchParams.get('sig'),
    )
  ) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 403 });
  }

  try {
    await validateProxyTargetUrl(decodedUrl);
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message || 'Invalid url' },
      { status: 400 },
    );
  }

  const ua = request.headers.get('user-agent') || DEFAULT_UA;

  // 上游资源站常按 Referer/Origin 做白名单校验。优先级：
  //   1. URL 显式参数 ?referer=...（客户端已知最准确的来源）
  //   2. 入站请求自带的 Referer（浏览器自然发出的）
  //   3. 上游 URL 自身的 origin 作为兜底（很多源站允许同源 Referer）
  const sanitizedExplicitReferer = normalizeHeaderUrl(explicitReferer);
  const inboundReferer = normalizeHeaderUrl(request.headers.get('referer'));
  let fallbackReferer: string | undefined;
  try {
    fallbackReferer = new URL(decodedUrl).origin + '/';
  } catch {
    fallbackReferer = undefined;
  }
  const refererToSend =
    sanitizedExplicitReferer || inboundReferer || fallbackReferer;

  const upstreamHeaders: Record<string, string> = { 'User-Agent': ua };
  if (refererToSend) {
    upstreamHeaders['Referer'] = refererToSend;
    try {
      upstreamHeaders['Origin'] = new URL(refererToSend).origin;
    } catch {
      // ignore
    }
  }

  let upstream: Response;
  try {
    upstream = await fetchPlaylistWithRedirects(
      decodedUrl,
      {
        cache: 'no-store',
        headers: upstreamHeaders,
      },
      FETCH_TIMEOUT_MS,
    );
  } catch (e: any) {
    return NextResponse.json(
      { error: 'Upstream fetch failed', details: e?.message || 'unknown' },
      { status: 502 },
    );
  }

  if (!upstream.ok) {
    return NextResponse.json(
      { error: 'Upstream returned non-OK', status: upstream.status },
      { status: 502 },
    );
  }

  let content: string;
  try {
    content = await readTextWithLimit(upstream, MAX_PLAYLIST_BYTES);
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message || 'Unable to read playlist' },
      { status: 502 },
    );
  }

  if (!content.trimStart().startsWith('#EXTM3U')) {
    return NextResponse.json(
      { error: 'Upstream is not an m3u8 playlist' },
      { status: 502 },
    );
  }
  // 跟随重定向后实际拿到内容的 URL，作为相对路径解析的 baseUrl
  const finalUrl = upstream.url || decodedUrl;
  const baseUrl = getBaseUrl(finalUrl);

  let body: string;
  let adsRemoved = 0;
  let adsDuration = 0;

  if (content.includes('#EXT-X-STREAM-INF')) {
    // 把当前请求用的 referer 透传到变体 URL 的代理参数里，
    // 否则下一跳又会因为没有 Referer 被上游拒
    body = rewriteMasterPlaylist(content, baseUrl, request, refererToSend);
  } else {
    const absolute = absolutizeVariantPlaylist(content, baseUrl);
    // 调试/对照场景：?adfilter=false 让代理只做 referer 透传 + 相对路径绝对化，
    // 不删任何广告段，方便客户端拿到原始时间轴
    const queryDisable =
      searchParams.get('adfilter') === 'false' ||
      searchParams.get('adfilter') === '0';
    if ((await isAdFilterEnabled()) && !queryDisable) {
      const result = filterM3U8(absolute, buildFilterConfigFromEnv());
      body = result.filtered;
      adsRemoved = result.adsRemoved;
      adsDuration = result.adsDuration;
    } else {
      body = absolute;
    }
  }

  const headers = new Headers();
  headers.set(
    'Content-Type',
    upstream.headers.get('Content-Type') || 'application/vnd.apple.mpegurl',
  );
  headers.set('Cache-Control', 'no-cache');
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Range, Accept');
  headers.set(
    'Access-Control-Expose-Headers',
    'Content-Length, Content-Range, X-Ads-Removed, X-Ads-Duration',
  );
  if (adsRemoved > 0) {
    headers.set('X-Ads-Removed', String(adsRemoved));
    headers.set('X-Ads-Duration', adsDuration.toFixed(1));
  }

  return new Response(body, { status: 200, headers });
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Range, Accept',
    },
  });
}
