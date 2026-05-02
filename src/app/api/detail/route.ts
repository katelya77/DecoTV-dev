import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie, verifyApiAuth } from '@/lib/auth';
import { getAvailableApiSites, getCacheTime } from '@/lib/config';
import { getDetailFromApi } from '@/lib/downstream';
import {
  buildPrivateLibraryPosterUrl,
  formatPrivateLibrarySourceName,
  getConnectorCachedItems,
  getPrivateLibraryConfig,
  hydratePrivateLibraryItem,
  resolvePrivateLibraryAudioStreams,
  scanConnector,
  toPrivateLibraryErrorMessage,
} from '@/lib/private-library';
import { SearchResult } from '@/lib/types';

export const runtime = 'nodejs';

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
  if (!/\.m3u8(\?|$|#)/i.test(url)) return false; // 只处理 m3u8
  return true;
}

function maybeRewriteEpisodesForAdFilter(
  result: SearchResult,
  request: NextRequest,
): SearchResult {
  if (!isAdFilterEnabled() || adFilterDisabledByQuery(request)) return result;
  if (result.source === 'private_library') return result;
  if (!Array.isArray(result.episodes) || result.episodes.length === 0) {
    return result;
  }

  const rewritten = result.episodes.map((ep) =>
    shouldRewriteEpisode(ep) ? buildFilterProxyUrl(request, ep) : ep,
  );

  return { ...result, episodes: rewritten };
}

export async function GET(request: NextRequest) {
  const authResult = verifyApiAuth(request);
  if (!authResult.isValid) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const authInfo = getAuthInfoFromCookie(request);
  const username =
    authInfo?.username || (authResult.isLocalMode ? '__local__' : '');

  const { searchParams } = new URL(request.url);
  const id = (searchParams.get('id') || '').trim();
  const sourceCode = (searchParams.get('source') || '').trim();

  if (!id || !sourceCode) {
    return NextResponse.json(
      { error: 'id 和 source 不能为空' },
      { status: 400 },
    );
  }

  if (sourceCode !== 'private_library' && !/^[\w-]+$/.test(id)) {
    return NextResponse.json(
      { error: '资源站详情 id 格式无效' },
      { status: 400 },
    );
  }

  try {
    if (sourceCode === 'private_library') {
      const cfg = await getPrivateLibraryConfig();
      const enabledConnectors = cfg.connectors.filter((item) => item.enabled);
      const scanErrors: string[] = [];

      for (const connector of enabledConnectors) {
        let items = getConnectorCachedItems(connector.id);
        if (items.length === 0) {
          try {
            items = await scanConnector(connector);
          } catch (error) {
            scanErrors.push(
              `${connector.name}: ${toPrivateLibraryErrorMessage(error)}`,
            );
            continue;
          }
        }

        const target = items.find((item) => item.id === id);
        if (!target) {
          continue;
        }

        let hydratedTarget = target;
        try {
          hydratedTarget = await hydratePrivateLibraryItem(target);
        } catch {
          hydratedTarget = target;
        }

        const title = hydratedTarget.title;
        const poster =
          hydratedTarget.poster ||
          (connector.type === 'emby' || connector.type === 'jellyfin'
            ? buildPrivateLibraryPosterUrl(
                hydratedTarget.connectorId,
                hydratedTarget.sourceItemId,
              )
            : '');
        const desc = hydratedTarget.overview || '';

        const streamUrl = `/api/private-library/stream?connectorId=${encodeURIComponent(hydratedTarget.connectorId)}&sourceItemId=${encodeURIComponent(hydratedTarget.sourceItemId)}`;
        let privateAudioStreams: Awaited<
          ReturnType<typeof resolvePrivateLibraryAudioStreams>
        > = [];
        try {
          privateAudioStreams = await resolvePrivateLibraryAudioStreams(
            hydratedTarget.connectorId,
            hydratedTarget.sourceItemId,
          );
        } catch {
          // 音轨读取失败时不影响播放主链路。
        }

        const result: SearchResult = {
          id: hydratedTarget.id,
          title,
          poster,
          episodes: [streamUrl],
          episodes_titles: [hydratedTarget.title],
          source: 'private_library',
          source_name: formatPrivateLibrarySourceName(connector),
          class: '私人影库',
          year: hydratedTarget.year ? String(hydratedTarget.year) : 'unknown',
          desc,
          type_name: hydratedTarget.mediaType === 'tv' ? '剧集' : '电影',
          douban_id: undefined,
          tmdb_id: hydratedTarget.tmdbId,
          connector_id: hydratedTarget.connectorId,
          connector_type: hydratedTarget.connectorType,
          source_item_id: hydratedTarget.sourceItemId,
          private_audio_streams: privateAudioStreams.map((stream) => ({
            index: stream.index,
            display_title: stream.displayTitle,
            language: stream.language,
            codec: stream.codec,
            is_default: stream.isDefault,
          })),
        };

        return NextResponse.json(result, {
          headers: {
            'Cache-Control': 'private, max-age=30',
          },
        });
      }

      if (
        scanErrors.length === enabledConnectors.length &&
        scanErrors.length > 0
      ) {
        return NextResponse.json(
          {
            error: '私人影库当前不可用',
            details: scanErrors[0],
          },
          { status: 502 },
        );
      }

      return NextResponse.json(
        { error: '未找到对应的私人影库资源' },
        { status: 404 },
      );
    }

    const apiSites = await getAvailableApiSites(username);
    const apiSite = apiSites.find((site) => site.key === sourceCode);

    if (!apiSite) {
      return NextResponse.json(
        { error: '未找到对应的资源站配置' },
        { status: 400 },
      );
    }

    const result = await getDetailFromApi(apiSite, id);
    const cacheTime = await getCacheTime();

    const finalResult = maybeRewriteEpisodesForAdFilter(result, request);

    return NextResponse.json(finalResult, {
      headers: {
        'Cache-Control': `public, max-age=${cacheTime}, s-maxage=${cacheTime}`,
        'CDN-Cache-Control': `public, s-maxage=${cacheTime}`,
        'Vercel-CDN-Cache-Control': `public, s-maxage=${cacheTime}`,
        'Netlify-Vary': 'query',
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: '读取详情失败',
        details: error instanceof Error ? error.message : 'unknown error',
      },
      { status: 500 },
    );
  }
}
