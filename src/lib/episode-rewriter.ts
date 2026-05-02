import { NextRequest } from 'next/server';

import { SearchResult } from '@/lib/types';

function isAdFilterEnabled(): boolean {
  const flag = process.env.ENABLE_AD_FILTER;
  if (flag === undefined) return true; // 默认开
  return flag === 'true' || flag === '1';
}

function adFilterDisabledByQuery(request: NextRequest): boolean {
  const v = request.nextUrl.searchParams.get('adfilter');
  return v === 'false' || v === '0';
}

function buildFilterProxyUrl(request: NextRequest, upstreamUrl: string): string {
  const host = request.headers.get('host');
  const protocol =
    request.headers.get('x-forwarded-proto') ||
    request.nextUrl.protocol.replace(':', '') ||
    'http';
  return `${protocol}://${host}/api/proxy/m3u8-filter?url=${encodeURIComponent(
    upstreamUrl,
  )}`;
}

function shouldRewriteEpisode(url: string): boolean {
  if (!url) return false;
  if (!/^https?:\/\//i.test(url)) return false; // 跳过 /api/private-library/stream 这类内部路径
  if (!/\.m3u8(\?|#|$)/i.test(url)) return false; // 只处理 m3u8
  return true;
}

/**
 * 把 SearchResult 的 episodes 数组里的 m3u8 URL 包成
 * /api/proxy/m3u8-filter?url=... 形式，过滤上游广告。
 *
 * 跳过条件：
 * - 服务端 ENABLE_AD_FILTER=false
 * - 客户端请求带 ?adfilter=false 显式禁用
 * - source 是 private_library（私人影库已是内部代理 URL）
 * - URL 不是 http/https 或不是 m3u8
 */
export function rewriteEpisodesForAdFilter<T extends SearchResult | null | undefined>(
  result: T,
  request: NextRequest,
): T {
  if (!result) return result;
  if (!isAdFilterEnabled() || adFilterDisabledByQuery(request)) return result;
  if (result.source === 'private_library') return result;
  if (!Array.isArray(result.episodes) || result.episodes.length === 0) return result;

  const rewritten = result.episodes.map((ep) =>
    shouldRewriteEpisode(ep) ? buildFilterProxyUrl(request, ep) : ep,
  );

  return { ...result, episodes: rewritten };
}

export function rewriteEpisodesForAdFilterMany(
  results: SearchResult[],
  request: NextRequest,
): SearchResult[] {
  if (!isAdFilterEnabled() || adFilterDisabledByQuery(request)) return results;
  return results.map((r) => rewriteEpisodesForAdFilter(r, request));
}
