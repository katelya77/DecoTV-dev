/* eslint-disable @typescript-eslint/no-explicit-any,no-console */

import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { getAvailableApiSites, getCacheTime, getConfig } from '@/lib/config';
import { searchFromApi } from '@/lib/downstream';
import { rankSearchResults } from '@/lib/search-ranking';
import { yellowWords } from '@/lib/yellow';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const authInfo = getAuthInfoFromCookie(request);
  if (!authInfo || !authInfo.username) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q');

  if (!query) {
    const cacheTime = await getCacheTime();
    return NextResponse.json(
      { results: [] },
      {
        headers: {
          'Cache-Control': `public, max-age=${cacheTime}, s-maxage=${cacheTime}`,
          'CDN-Cache-Control': `public, s-maxage=${cacheTime}`,
          'Vercel-CDN-Cache-Control': `public, s-maxage=${cacheTime}`,
          'Netlify-Vary': 'query',
        },
      }
    );
  }

  const config = await getConfig();
  const apiSites = await getAvailableApiSites(authInfo.username);

  // 🔒 成人内容过滤逻辑
  // URL 参数优先级: ?adult=1 (显示成人) > ?filter=off (显示成人) > 全局配置
  const adultParam = searchParams.get('adult'); // OrionTV 风格参数
  const filterParam = searchParams.get('filter'); // TVBox 风格参数

  let shouldFilterAdult = !config.SiteConfig.DisableYellowFilter; // 默认使用全局配置

  // URL 参数覆盖全局配置
  if (adultParam === '1' || adultParam === 'true') {
    shouldFilterAdult = false; // 显式启用成人内容
  } else if (adultParam === '0' || adultParam === 'false') {
    shouldFilterAdult = true; // 显式禁用成人内容
  } else if (filterParam === 'off' || filterParam === 'disable') {
    shouldFilterAdult = false; // 禁用过滤 = 显示成人内容
  } else if (filterParam === 'on' || filterParam === 'enable') {
    shouldFilterAdult = true; // 启用过滤 = 隐藏成人内容
  }

  // 添加超时控制和错误处理，避免慢接口拖累整体响应
  const searchPromises = apiSites.map((site) =>
    Promise.race([
      searchFromApi(site, query),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`${site.name} timeout`)), 20000)
      ),
    ]).catch((err) => {
      console.warn(`搜索失败 ${site.name}:`, err.message);
      return []; // 返回空数组而不是抛出错误
    })
  );

  try {
    const results = await Promise.allSettled(searchPromises);
    const successResults = results
      .filter((result) => result.status === 'fulfilled')
      .map((result) => (result as PromiseFulfilledResult<any>).value);
    let flattenedResults = successResults.flat();

    // 🔒 成人内容过滤逻辑
    // shouldFilterAdult=true 表示启用过滤(过滤成人内容)
    // shouldFilterAdult=false 表示禁用过滤(显示所有内容)
    if (shouldFilterAdult) {
      flattenedResults = flattenedResults.filter((result) => {
        const typeName = result.type_name || '';
        const sourceKey = result.source_key || '';

        // 检查视频源是否标记为成人资源
        const source = apiSites.find((s) => s.key === sourceKey);
        if (source && source.is_adult) {
          return false; // 过滤掉标记为成人资源的源
        }

        // 检查分类名称是否包含敏感关键词
        return !yellowWords.some((word: string) => typeName.includes(word));
      });
    }

    // 🎯 智能排序：按相关性对搜索结果排序
    flattenedResults = rankSearchResults(flattenedResults, query);

    const cacheTime = await getCacheTime();

    if (flattenedResults.length === 0) {
      // no cache if empty
      return NextResponse.json({ results: [] }, { status: 200 });
    }

    return NextResponse.json(
      { results: flattenedResults },
      {
        headers: {
          'Cache-Control': `public, max-age=${cacheTime}, s-maxage=${cacheTime}`,
          'CDN-Cache-Control': `public, s-maxage=${cacheTime}`,
          'Vercel-CDN-Cache-Control': `public, s-maxage=${cacheTime}`,
          'Netlify-Vary': 'query',
          'X-Adult-Filter': shouldFilterAdult ? 'enabled' : 'disabled', // 调试信息
        },
      }
    );
  } catch (error) {
    return NextResponse.json({ error: '搜索失败' }, { status: 500 });
  }
}
