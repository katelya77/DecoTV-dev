/* eslint-disable @typescript-eslint/no-explicit-any */

import { API_CONFIG, ApiSite, getConfig } from '@/lib/config';
import { getCachedSearchPage, setCachedSearchPage } from '@/lib/search-cache';
import { SearchResult } from '@/lib/types';
import { cleanHtmlTags } from '@/lib/utils';
import { decorateSearchResultQuality } from '@/lib/video-quality';

interface ApiSearchItem {
  vod_id: string;
  vod_name: string;
  vod_pic: string;
  vod_remarks?: string;
  vod_play_url?: string;
  vod_class?: string;
  vod_year?: string;
  vod_content?: string;
  vod_douban_id?: number;
  vod_tmdb_id?: number | string;
  type_name?: string;
}

interface SearchFromApiOptions {
  includeUnplayable?: boolean;
  skipCache?: boolean;
}

function normalizeNumericId(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function isPlayableUrl(url?: string): boolean {
  if (!url) return false;
  return /^https?:\/\//i.test(url.trim());
}

function parseVodPlayUrl(value?: string): {
  episodes: string[];
  titles: string[];
} {
  let episodes: string[] = [];
  let titles: string[] = [];

  if (!value) {
    return { episodes, titles };
  }

  const playGroups = value.split('$$$');
  playGroups.forEach((group: string) => {
    const matchEpisodes: string[] = [];
    const matchTitles: string[] = [];
    const entries = group.split('#');
    entries.forEach((entry: string) => {
      const separatorIndex = entry.indexOf('$');
      if (separatorIndex === -1) return;

      const title = entry.slice(0, separatorIndex).trim();
      const url = entry.slice(separatorIndex + 1).trim();
      if (!isPlayableUrl(url)) return;

      matchTitles.push(title);
      matchEpisodes.push(url);
    });

    if (matchEpisodes.length > episodes.length) {
      episodes = matchEpisodes;
      titles = matchTitles;
    }
  });

  return { episodes, titles };
}

function toSearchResultFromApiItem(
  item: ApiSearchItem,
  apiSite: ApiSite,
  fallbackId?: string,
): SearchResult | null {
  if (!item || (!item.vod_id && !fallbackId) || !item.vod_name) {
    return null;
  }

  const { episodes, titles } = parseVodPlayUrl(item.vod_play_url);
  const result: SearchResult = {
    id: (item.vod_id || fallbackId || '').toString(),
    title: item.vod_name.trim().replace(/\s+/g, ' '),
    poster: item.vod_pic,
    episodes,
    episodes_titles: titles,
    source: apiSite.key,
    source_name: apiSite.name,
    class: item.vod_class,
    year: item.vod_year ? item.vod_year.match(/\d{4}/)?.[0] || '' : 'unknown',
    remarks: item.vod_remarks || '',
    quality_tag: item.vod_remarks || item.type_name || item.vod_class || '',
    desc: cleanHtmlTags(item.vod_content || ''),
    type_name: item.type_name,
    douban_id: item.vod_douban_id,
    tmdb_id: normalizeNumericId(item.vod_tmdb_id),
  };

  return decorateSearchResultQuality(
    result,
    item.vod_remarks,
    item.vod_class,
    item.vod_content,
    item.vod_play_url,
  );
}

/**
 * 通用的带缓存搜索函数
 */
async function searchWithCache(
  apiSite: ApiSite,
  query: string,
  page: number,
  url: string,
  timeoutMs = 5000,
  options: SearchFromApiOptions = {},
): Promise<{ results: SearchResult[]; pageCount?: number }> {
  const useCache = !options.skipCache && !options.includeUnplayable;
  // 先查缓存
  const cached = useCache
    ? getCachedSearchPage(apiSite.key, query, page)
    : null;
  if (cached) {
    if (cached.status === 'ok') {
      return { results: cached.data, pageCount: cached.pageCount };
    } else {
      return { results: [] };
    }
  }

  // 缓存未命中，发起网络请求
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers: API_CONFIG.search.headers,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      if (response.status === 403) {
        if (useCache) {
          setCachedSearchPage(apiSite.key, query, page, 'forbidden', []);
        }
      }
      return { results: [] };
    }

    const data = await response.json();
    if (
      !data ||
      !data.list ||
      !Array.isArray(data.list) ||
      data.list.length === 0
    ) {
      // 空结果不做负缓存要求，这里不写入缓存
      return { results: [] };
    }

    // 处理结果数据
    const allResults = data.list.map((item: ApiSearchItem) =>
      toSearchResultFromApiItem(item, apiSite),
    );

    // 过滤掉无效条目和集数为 0 的结果
    const results = allResults.filter(
      (result: SearchResult | null) =>
        result !== null &&
        (options.includeUnplayable || result.episodes.length > 0),
    );

    const pageCount = page === 1 ? data.pagecount || 1 : undefined;
    // 写入缓存（成功）
    if (useCache) {
      setCachedSearchPage(apiSite.key, query, page, 'ok', results, pageCount);
    }
    return { results, pageCount };
  } catch (error: any) {
    clearTimeout(timeoutId);
    // 识别被 AbortController 中止（超时）
    const aborted =
      error?.name === 'AbortError' ||
      error?.code === 20 ||
      error?.message?.includes('aborted');
    if (aborted) {
      if (useCache) {
        setCachedSearchPage(apiSite.key, query, page, 'timeout', []);
      }
    }
    return { results: [] };
  }
}

export async function searchFromApi(
  apiSite: ApiSite,
  query: string,
  options: SearchFromApiOptions = {},
): Promise<SearchResult[]> {
  try {
    const apiBaseUrl = apiSite.api;
    const apiUrl =
      apiBaseUrl + API_CONFIG.search.path + encodeURIComponent(query);

    // 使用新的缓存搜索函数处理第一页
    const firstPageResult = await searchWithCache(
      apiSite,
      query,
      1,
      apiUrl,
      5000,
      options,
    );
    const results = firstPageResult.results;
    const pageCountFromFirst = firstPageResult.pageCount;

    const config = await getConfig();
    const MAX_SEARCH_PAGES: number = config.SiteConfig.SearchDownstreamMaxPage;

    // 获取总页数
    const pageCount = pageCountFromFirst || 1;
    // 确定需要获取的额外页数
    const pagesToFetch = Math.min(pageCount - 1, MAX_SEARCH_PAGES - 1);

    // 如果有额外页数，获取更多页的结果
    if (pagesToFetch > 0) {
      const additionalPagePromises = [];

      for (let page = 2; page <= pagesToFetch + 1; page++) {
        const pageUrl =
          apiBaseUrl +
          API_CONFIG.search.pagePath
            .replace('{query}', encodeURIComponent(query))
            .replace('{page}', page.toString());

        const pagePromise = (async () => {
          // 使用新的缓存搜索函数处理分页
          const pageResult = await searchWithCache(
            apiSite,
            query,
            page,
            pageUrl,
            5000,
            options,
          );
          return pageResult.results;
        })();

        additionalPagePromises.push(pagePromise);
      }

      // 等待所有额外页的结果
      const additionalResults = await Promise.all(additionalPagePromises);

      // 合并所有页的结果
      additionalResults.forEach((pageResults) => {
        if (pageResults.length > 0) {
          results.push(...pageResults);
        }
      });
    }

    return results;
  } catch {
    return [];
  }
}

// 匹配 m3u8 链接的正则
const M3U8_PATTERN = /(https?:\/\/[^"'\s]+?\.m3u8[^\s"']*)/gi;

function buildApiUrl(apiBaseUrl: string, query: string): string {
  return `${apiBaseUrl}${apiBaseUrl.includes('?') ? '&' : '?'}${query}`;
}

async function fetchDetailJson(detailUrl: string): Promise<any> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(detailUrl, {
      headers: API_CONFIG.detail.headers,
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`详情请求失败: ${response.status}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function getDetailFromApi(
  apiSite: ApiSite,
  id: string,
): Promise<SearchResult> {
  if (apiSite.detail) {
    return handleSpecialSourceDetail(id, apiSite);
  }

  const encodedId = encodeURIComponent(id);
  const detailUrls = [
    buildApiUrl(apiSite.api, `ac=detail&ids=${encodedId}`),
    buildApiUrl(apiSite.api, `ac=videolist&ids=${encodedId}`),
  ];

  let lastError: unknown;
  for (const detailUrl of Array.from(new Set(detailUrls))) {
    try {
      const data = await fetchDetailJson(detailUrl);

      if (
        !data ||
        !data.list ||
        !Array.isArray(data.list) ||
        data.list.length === 0
      ) {
        throw new Error('获取到的详情内容无效');
      }

      const videoDetail = data.list[0] as ApiSearchItem;
      const result = toSearchResultFromApiItem(videoDetail, apiSite, id);
      if (!result) {
        throw new Error('获取到的详情内容无效');
      }

      if (result.episodes.length === 0 && videoDetail.vod_content) {
        const matches = videoDetail.vod_content.match(M3U8_PATTERN) || [];
        result.episodes = matches.map((link: string) =>
          link.replace(/^\$/, ''),
        );
      }

      if (result.episodes.length === 0) {
        throw new Error('详情未返回播放地址');
      }

      return result;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('获取到的详情内容无效');
}

async function handleSpecialSourceDetail(
  id: string,
  apiSite: ApiSite,
): Promise<SearchResult> {
  const detailUrl = `${apiSite.detail}/index.php/vod/detail/id/${id}.html`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  const response = await fetch(detailUrl, {
    headers: API_CONFIG.detail.headers,
    signal: controller.signal,
  });

  clearTimeout(timeoutId);

  if (!response.ok) {
    throw new Error(`详情页请求失败: ${response.status}`);
  }

  const html = await response.text();
  let matches: string[] = [];

  if (apiSite.key === 'ffzy') {
    const ffzyPattern =
      /\$(https?:\/\/[^"'\s]+?\/\d{8}\/\d+_[a-f0-9]+\/index\.m3u8)/g;
    matches = html.match(ffzyPattern) || [];
  }

  if (matches.length === 0) {
    const generalPattern = /\$(https?:\/\/[^"'\s]+?\.m3u8)/g;
    matches = html.match(generalPattern) || [];
  }

  // 去重并清理链接前缀
  matches = Array.from(new Set(matches)).map((link: string) => {
    link = link.substring(1); // 去掉开头的 $
    const parenIndex = link.indexOf('(');
    return parenIndex > 0 ? link.substring(0, parenIndex) : link;
  });

  // 根据 matches 数量生成剧集标题
  const episodes_titles = Array.from({ length: matches.length }, (_, i) =>
    (i + 1).toString(),
  );

  // 提取标题
  const titleMatch = html.match(/<h1[^>]*>([^<]+)<\/h1>/);
  const titleText = titleMatch ? titleMatch[1].trim() : '';

  // 提取描述
  const descMatch = html.match(
    /<div[^>]*class=["']sketch["'][^>]*>([\s\S]*?)<\/div>/,
  );
  const descText = descMatch ? cleanHtmlTags(descMatch[1]) : '';

  // 提取封面
  const coverMatch = html.match(/(https?:\/\/[^"'\s]+?\.jpg)/g);
  const coverUrl = coverMatch ? coverMatch[0].trim() : '';

  // 提取年份
  const yearMatch = html.match(/>(\d{4})</);
  const yearText = yearMatch ? yearMatch[1] : 'unknown';

  const result: SearchResult = {
    id,
    title: titleText,
    poster: coverUrl,
    episodes: matches,
    episodes_titles,
    source: apiSite.key,
    source_name: apiSite.name,
    class: '',
    year: yearText,
    desc: descText,
    type_name: '',
    douban_id: 0,
  };

  return decorateSearchResultQuality(result, html);
}
