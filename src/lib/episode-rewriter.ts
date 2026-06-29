import { NextRequest } from 'next/server';

import { AdminConfig } from '@/lib/admin.types';
import { getConfig } from '@/lib/config';
import { signM3U8ProxyRequest } from '@/lib/m3u8-proxy';
import { getEffectiveRequestOrigin } from '@/lib/request-protocol';
import { SearchResult } from '@/lib/types';

// Browser playback defaults to the filter proxy so upstream ad segments can be
// removed. Native TV clients stay direct unless explicitly opted in below.
function parseBooleanFlag(value: string | undefined): boolean | null {
  if (value === undefined) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'on') {
    return true;
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'off') {
    return false;
  }
  return null;
}

function getQueryProxyMode(request: NextRequest): boolean | null {
  const value = request.nextUrl.searchParams.get('adfilter');
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (['server', 'proxy', 'true', '1', 'on'].includes(normalized)) {
    return true;
  }
  if (['direct', 'false', '0', 'off'].includes(normalized)) {
    return false;
  }
  return null;
}

function isNativeTvClient(request: NextRequest): boolean {
  const headers = request.headers as Headers | undefined;
  const searchParams = request.nextUrl?.searchParams;
  const ua = (headers?.get('user-agent') || '').toLowerCase();
  const client = (searchParams?.get('client') || '').toLowerCase();

  return (
    client === 'orion' ||
    client === 'oriontv' ||
    ua.includes('orion') ||
    ua.includes('reactnative') ||
    ua.includes('expo') ||
    ua.includes('okhttp')
  );
}

export function shouldUseServerSideEpisodeProxy(
  adminConfig: AdminConfig | null,
  request: NextRequest,
): boolean {
  const queryMode = getQueryProxyMode(request);
  if (queryMode !== null) return queryMode;

  // Native TV players are more sensitive to rewritten HLS playlists. Keep their
  // default playback URL direct so seeking uses the upstream timeline.
  if (isNativeTvClient(request)) return false;

  const explicitProxyFlag =
    parseBooleanFlag(process.env.M3U8_SERVER_PROXY) ??
    parseBooleanFlag(process.env.ENABLE_M3U8_SERVER_PROXY);
  if (explicitProxyFlag !== null) return explicitProxyFlag;

  const legacyAdFilterFlag = parseBooleanFlag(process.env.ENABLE_AD_FILTER);
  if (legacyAdFilterFlag !== null) return legacyAdFilterFlag;

  const adminFlag = adminConfig?.AdFilterConfig?.enabled;
  if (typeof adminFlag === 'boolean') return adminFlag;

  return true;
}

export function buildFilterProxyUrl(
  request: NextRequest,
  upstreamUrl: string,
  referer?: string,
): string {
  const signature = signM3U8ProxyRequest(upstreamUrl, referer);
  if (!signature) return upstreamUrl;

  const proxyUrl = new URL(
    '/api/proxy/m3u8-filter',
    getEffectiveRequestOrigin(request),
  );
  proxyUrl.searchParams.set('url', upstreamUrl);
  if (referer) proxyUrl.searchParams.set('referer', referer);
  proxyUrl.searchParams.set('sig', signature);
  return proxyUrl.toString();
}

function shouldRewriteEpisode(url: string): boolean {
  if (!url) return false;
  if (!/^https?:\/\//i.test(url)) return false; // 跳过 /api/private-library/stream 这类内部路径
  if (!/\.m3u8(\?|#|$)/i.test(url)) return false; // 只处理 m3u8
  return true;
}

export function isSourceAdFilterDisabled(
  adminConfig: AdminConfig | null,
  sourceKey: string | undefined,
): boolean {
  if (!adminConfig || !sourceKey) return false;
  const entry = adminConfig.SourceConfig?.find((s) => s.key === sourceKey);
  return !!entry?.disable_ad_filter;
}

/**
 * 把 SearchResult 的 episodes 数组里的 m3u8 URL 包成
 * /api/proxy/m3u8-filter?url=... 形式，过滤上游广告。
 *
 * 跳过条件：
 * - admin 后台关掉了广告过滤（或环境变量 ENABLE_AD_FILTER=false）
 * - 客户端请求带 ?adfilter=false 显式禁用
 * - 该源在后台被标记为 disable_ad_filter
 * - source 是 private_library（私人影库已是内部代理 URL）
 * - URL 不是 http/https 或不是 m3u8
 */
export async function rewriteEpisodesForAdFilter<
  T extends SearchResult | null | undefined,
>(result: T, request: NextRequest): Promise<T> {
  if (!result) return result;
  const adminConfig = await safeGetConfig();
  if (!shouldUseServerSideEpisodeProxy(adminConfig, request)) return result;
  if (result.source === 'private_library') return result;
  if (isSourceAdFilterDisabled(adminConfig, result.source)) return result;
  if (!Array.isArray(result.episodes) || result.episodes.length === 0)
    return result;

  const rewritten = result.episodes.map((ep) =>
    shouldRewriteEpisode(ep) ? buildFilterProxyUrl(request, ep) : ep,
  );

  return { ...result, episodes: rewritten };
}

export async function rewriteEpisodesForAdFilterMany(
  results: SearchResult[],
  request: NextRequest,
): Promise<SearchResult[]> {
  const adminConfig = await safeGetConfig();
  if (!shouldUseServerSideEpisodeProxy(adminConfig, request)) return results;

  // 对每条结果按"源是否豁免"独立判断
  return results.map((r) => {
    if (isSourceAdFilterDisabled(adminConfig, r.source)) return r;
    if (r.source === 'private_library') return r;
    if (!Array.isArray(r.episodes) || r.episodes.length === 0) return r;
    const rewritten = r.episodes.map((ep) =>
      shouldRewriteEpisode(ep) ? buildFilterProxyUrl(request, ep) : ep,
    );
    return { ...r, episodes: rewritten };
  });
}

async function safeGetConfig(): Promise<AdminConfig | null> {
  try {
    return await getConfig();
  } catch {
    return null;
  }
}
