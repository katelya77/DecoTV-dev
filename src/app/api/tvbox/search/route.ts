/* eslint-disable no-console */

import { NextRequest, NextResponse } from 'next/server';

import { getConfig } from '@/lib/config';
import { getDetailFromApi, searchFromApi } from '@/lib/downstream';
import { rankSearchResults } from '@/lib/search-ranking';
import {
  formatTvboxPlayUrl,
  getLastNonEmptySearchParam,
} from '@/lib/tvbox-utils';
import type { SearchResult } from '@/lib/types';
import {
  buildResolutionFilterFromSearchParams,
  filterSearchResultsByResolution,
  formatResolutionLabel,
} from '@/lib/video-quality';
import { yellowWords } from '@/lib/yellow';

export const runtime = 'nodejs';

const normalizedYellowWords = yellowWords.map((word) => word.toLowerCase());

const containsYellowKeyword = (
  ...fields: Array<string | undefined | null>
): boolean => {
  return fields.some((field) => {
    if (!field) return false;
    const normalized = field.toLowerCase();
    return normalizedYellowWords.some((keyword) =>
      normalized.includes(keyword),
    );
  });
};

function buildTvboxHeaders(
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    ...extra,
  };
}

function toTvboxVod(result: SearchResult) {
  const raw = result as SearchResult & Record<string, unknown>;
  const playUrl = formatTvboxPlayUrl(result.episodes, result.episodes_titles);

  return {
    vod_id: result.id,
    vod_name: result.title,
    vod_pic: result.poster,
    vod_remarks:
      String(raw.remarks || raw.note || raw.remark || '') ||
      result.resolution ||
      result.quality_tag ||
      '',
    vod_resolution: result.resolution || '',
    vod_year: String(raw.year || result.year || ''),
    vod_area: String(raw.area || ''),
    vod_actor: String(raw.actor || ''),
    vod_director: String(raw.director || ''),
    vod_content: result.desc || '',
    type_name: result.type_name || '',
    vod_play_from: playUrl
      ? result.source_name || result.source || 'DecoTV'
      : '',
    vod_play_url: playUrl,
  };
}

function buildTvboxListResponse(list: Array<ReturnType<typeof toTvboxVod>>) {
  return {
    code: 1,
    msg: 'success',
    page: 1,
    pagecount: 1,
    limit: list.length,
    total: list.length,
    list,
  };
}

function isOrionClient(request: NextRequest): boolean {
  const ua = (request.headers.get('user-agent') || '').toLowerCase();
  const client = (
    new URL(request.url).searchParams.get('client') || ''
  ).toLowerCase();
  return ua.includes('orion') || client === 'orion' || client === 'oriontv';
}

/**
 * TVBox 智能搜索代理端点
 *
 * 功能：
 * 1. 🔒 成人内容过滤（基于关键词和源标记）
 * 2. 🎯 智能排序（解决搜索结果不精确问题）
 * 3. ⚡ 结果优化（过滤重复和不相关内容）
 *
 * 使用方式：
 * GET /api/tvbox/search?source=dyttzy&wd=斗罗大陆&filter=on
 *
 * 参数：
 * - source: 视频源key（必需）
 * - wd: 搜索关键词（必需）
 * - filter: 成人内容过滤 on|off（可选，默认on）
 * - strict: 严格匹配模式 1|0（可选，默认0）
 */
export async function GET(request: NextRequest) {
  const startTime = Date.now();

  try {
    const { searchParams } = new URL(request.url);
    const sourceKey = searchParams.get('source');
    const ac = (searchParams.get('ac') || '').toLowerCase();
    const detailId = getLastNonEmptySearchParam(searchParams, [
      'ids',
      'id',
      'vod_id',
    ]);
    const wantsDetail = ac === 'detail' || Boolean(detailId);
    const query = getLastNonEmptySearchParam(searchParams, [
      'wd',
      'q',
      'key',
      'keyword',
      'searchword',
    ]);
    const filterRaw = searchParams.get('filter');
    const filterParam = (filterRaw ?? 'on').toLowerCase();
    const strictMode = searchParams.get('strict') === '1';
    const resolutionFilter =
      buildResolutionFilterFromSearchParams(searchParams);

    // 参数验证
    if (!sourceKey || (!query && !wantsDetail)) {
      return NextResponse.json(
        {
          code: 400,
          msg: '缺少必要参数: source 或 wd',
          list: [],
        },
        { status: 400 },
      );
    }

    const config = await getConfig();
    const adultSourceKeys = new Set(
      config.SourceConfig.filter((s) => s.is_adult).map((s) => s.key),
    );
    const adultSourceNames = new Set(
      config.SourceConfig.filter((s) => s.is_adult && s.name).map((s) =>
        s.name.trim().toLowerCase(),
      ),
    );
    const siteDefaultFilter = true; // 站点默认开启成人过滤
    const shouldFilter =
      ['on', 'enable', '1', 'true', 'yes'].includes(filterParam) ||
      (filterRaw == null && siteDefaultFilter);
    const isOrion = isOrionClient(request);

    // 查找视频源配置
    const targetSource = config.SourceConfig.find((s) => s.key === sourceKey);
    if (!targetSource) {
      return NextResponse.json(
        {
          code: 404,
          msg: `未找到视频源: ${sourceKey}`,
          list: [],
        },
        { status: 404 },
      );
    }

    // 检查源是否被禁用
    if (targetSource.disabled) {
      return NextResponse.json(
        {
          code: 403,
          msg: `视频源已被禁用: ${sourceKey}`,
          list: [],
        },
        { status: 403 },
      );
    }

    if (wantsDetail && shouldFilter && targetSource.is_adult) {
      return NextResponse.json(
        {
          code: 1,
          msg: '该视频源已被成人内容过滤策略禁用',
          page: 1,
          pagecount: 1,
          limit: 0,
          total: 0,
          list: [],
        },
        {
          status: 200,
          headers: buildTvboxHeaders({
            'Cache-Control': 'public, max-age=60, s-maxage=60',
            'X-Filter-Applied': 'true',
          }),
        },
      );
    }

    if (wantsDetail) {
      if (!detailId) {
        return NextResponse.json(
          {
            code: 400,
            msg: '缺少详情参数: ids 或 id',
            list: [],
          },
          { status: 400 },
        );
      }

      try {
        const detail = await getDetailFromApi(
          {
            key: targetSource.key,
            name: targetSource.name,
            api: targetSource.api,
            detail: targetSource.detail,
          },
          detailId,
        );

        return NextResponse.json(buildTvboxListResponse([toTvboxVod(detail)]), {
          headers: buildTvboxHeaders({
            'Cache-Control': 'public, max-age=300, s-maxage=300',
          }),
        });
      } catch (error) {
        console.error('[TVBox Search Proxy] Detail error:', error);
        return NextResponse.json(
          {
            code: 1,
            msg: error instanceof Error ? error.message : '详情获取失败',
            page: 1,
            pagecount: 1,
            limit: 0,
            total: 0,
            list: [],
          },
          {
            status: 200,
            headers: buildTvboxHeaders({
              'Cache-Control': 'no-store',
            }),
          },
        );
      }
    }

    console.log(
      `[TVBox Search Proxy] source=${sourceKey}, query="${query}", filter=${filterParam}, strict=${strictMode}, client=${
        isOrion ? 'orion' : 'generic'
      }`,
    );

    if (shouldFilter && targetSource.is_adult) {
      console.warn(
        `[TVBox Search Proxy] source=${sourceKey} blocked by adult policy`,
      );
      return NextResponse.json(
        {
          code: 1,
          msg: '该视频源已被成人内容过滤策略禁用',
          page: 1,
          pagecount: 1,
          limit: 0,
          total: 0,
          list: [],
        },
        {
          status: 200,
          headers: buildTvboxHeaders({
            'Cache-Control': 'public, max-age=60, s-maxage=60',
            'X-Filter-Applied': 'true',
          }),
        },
      );
    }

    // 从上游API搜索
    let results = await searchFromApi(
      {
        key: targetSource.key,
        name: targetSource.name,
        api: targetSource.api,
        detail: targetSource.detail,
      },
      query,
      {
        includeUnplayable: true,
        skipCache: true,
      },
    );

    console.log(
      `[TVBox Search Proxy] Fetched ${results.length} results from upstream`,
    );

    // 🔒 成人内容过滤（Orion 客户端下更严格）
    if (shouldFilter) {
      const beforeFilterCount = results.length;

      results = results.filter((result) => {
        const typeName = result.type_name || '';
        const title = result.title || '';
        const desc = result.desc || '';
        const srcName = result.source_name || '';
        const srcKey = result.source || '';

        const matchedAdultSource =
          targetSource.is_adult ||
          adultSourceKeys.has(srcKey) ||
          adultSourceNames.has(srcName.trim().toLowerCase());

        if (matchedAdultSource) {
          return false;
        }

        // 关键词拦截：扩大到 type_name/title/desc/source_name
        if (containsYellowKeyword(typeName, title, desc, srcName)) {
          return false;
        }

        return true;
      });

      console.log(
        `[TVBox Search Proxy] Adult filter: ${beforeFilterCount} → ${
          results.length
        } (filtered ${beforeFilterCount - results.length})`,
      );
    }

    // 🎯 智能排序 - 解决搜索不精确问题
    if (results.length > 0) {
      results = rankSearchResults(results, query);
      console.log(`[TVBox Search Proxy] Applied smart ranking`);
    }

    // ⚡ 严格匹配模式 - 只返回高度相关的结果
    if (strictMode && results.length > 0) {
      const queryLower = query.toLowerCase().trim();
      const beforeStrictCount = results.length;

      results = results.filter((result) => {
        const title = (result.title || '').toLowerCase().trim();

        // 完全匹配
        if (title === queryLower) return true;

        // 开头匹配
        if (title.startsWith(queryLower)) return true;

        // 包含匹配（但必须是完整词）
        const regex = new RegExp(`\\b${queryLower}\\b`, 'i');
        if (regex.test(title)) return true;

        // 编辑距离小于3（非常相似）
        if (levenshteinDistance(title, queryLower) <= 2) return true;

        return false;
      });

      console.log(
        `[TVBox Search Proxy] Strict mode: ${beforeStrictCount} → ${results.length}`,
      );
    }

    if (results.length > 0) {
      const beforeResolutionFilterCount = results.length;
      results = filterSearchResultsByResolution(results, resolutionFilter);
      if (resolutionFilter.minLevel) {
        console.log(
          `[TVBox Search Proxy] Resolution filter ${formatResolutionLabel(
            resolutionFilter.minLevel,
          )}${resolutionFilter.strict ? ' strict' : ''}: ${beforeResolutionFilterCount} → ${results.length}`,
        );
      }
    }

    const processingTime = Date.now() - startTime;
    console.log(
      `[TVBox Search Proxy] Completed in ${processingTime}ms, returning ${results.length} results`,
    );

    // 返回TVBox兼容的格式
    // TVBox期望的搜索API返回格式通常是MacCMS标准格式
    const response = buildTvboxListResponse(results.map(toTvboxVod));

    return NextResponse.json(response, {
      headers: buildTvboxHeaders({
        'Cache-Control': 'public, max-age=300, s-maxage=300', // 5分钟缓存
        'X-Processing-Time': `${processingTime}ms`,
        'X-Result-Count': `${results.length}`,
        'X-Filter-Applied': shouldFilter ? 'true' : 'false',
        'X-Min-Resolution': resolutionFilter.minLevel
          ? formatResolutionLabel(resolutionFilter.minLevel)
          : 'off',
        'X-Resolution-Strict': resolutionFilter.strict ? 'true' : 'false',
      }),
    });
  } catch (error) {
    console.error('[TVBox Search Proxy] Error:', error);
    return NextResponse.json(
      {
        code: 500,
        msg: error instanceof Error ? error.message : '搜索失败',
        list: [],
      },
      { status: 500 },
    );
  }
}

// CORS 预检请求
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    },
  });
}

/**
 * 计算两个字符串的编辑距离（Levenshtein distance）
 */
function levenshteinDistance(str1: string, str2: string): number {
  const len1 = str1.length;
  const len2 = str2.length;
  const matrix: number[][] = [];

  if (len1 === 0) return len2;
  if (len2 === 0) return len1;

  // 初始化矩阵
  for (let i = 0; i <= len1; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= len2; j++) {
    matrix[0][j] = j;
  }

  // 计算编辑距离
  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1, // 删除
        matrix[i][j - 1] + 1, // 插入
        matrix[i - 1][j - 1] + cost, // 替换
      );
    }
  }

  return matrix[len1][len2];
}
