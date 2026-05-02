/* eslint-disable @typescript-eslint/no-explicit-any */

import { NextResponse } from 'next/server';

import { filterM3U8 } from '@/lib/ad-filter';
import { getBaseUrl, resolveUrl } from '@/lib/live';

export const runtime = 'nodejs';

const DEFAULT_UA =
  'Mozilla/5.0 (Linux; Android 10; AndroidTV) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const FETCH_TIMEOUT_MS = 8000;

function isAdFilterEnabled(): boolean {
  const flag = process.env.ENABLE_AD_FILTER;
  if (flag === undefined) return true; // 默认开
  return flag === 'true' || flag === '1';
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
  let qs = `url=${encodeURIComponent(upstreamUrl)}`;
  if (referer) qs += `&referer=${encodeURIComponent(referer)}`;
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

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const url = searchParams.get('url');

  if (!url) {
    return NextResponse.json({ error: 'Missing url' }, { status: 400 });
  }

  let decodedUrl: string;
  try {
    decodedUrl = decodeURIComponent(url);
  } catch {
    return NextResponse.json({ error: 'Invalid url' }, { status: 400 });
  }

  if (!/^https?:\/\//i.test(decodedUrl)) {
    return NextResponse.json(
      { error: 'Only http/https supported' },
      { status: 400 },
    );
  }

  const ua = request.headers.get('user-agent') || DEFAULT_UA;

  // 上游资源站常按 Referer/Origin 做白名单校验。优先级：
  //   1. URL 显式参数 ?referer=...（客户端已知最准确的来源）
  //   2. 入站请求自带的 Referer（浏览器自然发出的）
  //   3. 上游 URL 自身的 origin 作为兜底（很多源站允许同源 Referer）
  const explicitReferer = searchParams.get('referer') || undefined;
  const inboundReferer = request.headers.get('referer') || undefined;
  let fallbackReferer: string | undefined;
  try {
    fallbackReferer = new URL(decodedUrl).origin + '/';
  } catch {
    fallbackReferer = undefined;
  }
  const refererToSend = explicitReferer || inboundReferer || fallbackReferer;

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
    upstream = await fetchWithTimeout(
      decodedUrl,
      {
        cache: 'no-store',
        redirect: 'follow',
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

  const content = await upstream.text();
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
    if (isAdFilterEnabled() && !queryDisable) {
      const result = filterM3U8(absolute);
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
