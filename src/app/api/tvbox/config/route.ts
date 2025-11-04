/* eslint-disable @typescript-eslint/no-explicit-any, no-console */

import { NextRequest, NextResponse } from 'next/server';

import { getConfig } from '@/lib/config';
import { getSpiderJar } from '@/lib/spiderJar';

// ================= Spider 公共可达 & 回退缓存逻辑 =================
// 目的：避免出现 “spider url is private/not public” & 404 问题
// 策略：
// 1. 永远优先返回【公网可直接访问】的远程 jar 地址（不用 localhost / 内网 IP）
// 2. 多源顺序探测（HEAD/快速 GET），成功后缓存 30 分钟，减少频繁探测
// 3. 探测失败时，仍然返回第一个候选（保证字段存在），并附加 ;fail 方便诊断
// 4. 可通过 ?forceSpiderRefresh=1 强制刷新缓存
// 5. 若用户仍需要本地代理，在 admin 面板单独展示“备用代理地址”而不是写入 spider 主字段

// 远程候选列表（按稳定性 & 全球可达性排序）
const REMOTE_SPIDER_CANDIDATES: { url: string; md5?: string }[] = [
  {
    url: 'https://deco-spider.oss-cn-hangzhou.aliyuncs.com/XC.jar',
    md5: 'e53eb37c4dc3dce1c8ee0c996ca3a024',
  },
  {
    url: 'https://deco-spider-1250000000.cos.ap-shanghai.myqcloud.com/XC.jar',
    md5: 'e53eb37c4dc3dce1c8ee0c996ca3a024',
  },
  {
    url: 'https://cdn.gitcode.net/qq_26898231/TVBox/-/raw/main/JAR/XC.jar',
    md5: 'e53eb37c4dc3dce1c8ee0c996ca3a024',
  },
  {
    url: 'https://cdn.gitee.com/q215613905/TVBoxOS/raw/main/JAR/XC.jar',
    md5: 'e53eb37c4dc3dce1c8ee0c996ca3a024',
  },
  {
    url: 'https://gitcode.net/qq_26898231/TVBox/-/raw/main/JAR/XC.jar',
    md5: 'e53eb37c4dc3dce1c8ee0c996ca3a024',
  },
  {
    url: 'https://gitee.com/q215613905/TVBoxOS/raw/main/JAR/XC.jar',
    md5: 'e53eb37c4dc3dce1c8ee0c996ca3a024',
  },
  {
    url: 'https://gitcode.net/qq_26898231/TVBox/-/raw/main/JAR/XC.jar',
    md5: 'e53eb37c4dc3dce1c8ee0c996ca3a024',
  },
  {
    url: 'https://ghproxy.com/https://raw.githubusercontent.com/FongMi/CatVodSpider/main/jar/custom_spider.jar',
    md5: 'a8b9c1d2e3f4',
  },
];

// 内网 / 私网 host 判定（TVBox 体检会标记为 private/not public 的几类）
function isPrivateHost(host: string): boolean {
  if (!host) return true;
  const lower = host.toLowerCase();
  return (
    lower.startsWith('localhost') ||
    lower.startsWith('127.') ||
    lower.startsWith('0.0.0.0') ||
    lower.startsWith('10.') ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(lower) ||
    lower.startsWith('192.168.') ||
    lower === '::1'
  );
}

// 旧 spider 探测与缓存逻辑已被 getSpiderJar 取代（保留候选常量供文档或 UI 展示）

// 旧的 selectPublicSpider 已被新的 getSpiderJar 方案取代，保留状态结构供兼容（不再调用）

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic'; // 强制动态渲染，避免构建时获取JAR超时

// TVBox 订阅格式 - 标准 TVBox/猫影视 格式
// 参考: TVBox 官方格式规范

/**
 * 智能检测 API 类型
 * 0: MacCMS XML格式 (标准苹果CMS XML接口)
 * 1: MacCMS JSON格式 (标准苹果CMS JSON接口)
 * 3: CSP源 (Custom Spider Plugin)
 */
function detectApiType(api: string): number {
  const url = api.toLowerCase().trim();

  // CSP 源（插件源，优先判断）
  if (url.startsWith('csp_')) return 3;

  // XML 采集接口 - 更精确匹配
  if (
    url.includes('.xml') ||
    url.includes('xml.php') ||
    url.includes('api.php/provide/vod/at/xml') ||
    url.includes('provide/vod/at/xml') ||
    (url.includes('maccms') && url.includes('xml'))
  ) {
    return 0;
  }

  // JSON 采集接口 - 标准苹果CMS格式
  if (
    url.includes('.json') ||
    url.includes('json.php') ||
    url.includes('api.php/provide/vod') ||
    url.includes('provide/vod') ||
    url.includes('api.php') ||
    url.includes('maccms') ||
    url.includes('/api/') ||
    url.match(/\/provide.*vod/) ||
    url.match(/\/api.*vod/)
  ) {
    return 1;
  }

  // 默认为JSON类型（苹果CMS最常见）
  return 1;
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams, href } = new URL(req.url);
    const format = searchParams.get('format') || 'json';
    const mode = (searchParams.get('mode') || '').toLowerCase(); // 可选: safe|min|yingshicang

    // 🔒 成人内容过滤参数
    const filterParam = searchParams.get('filter'); // on|off
    const adultParam = searchParams.get('adult'); // 0|1

    // 🎯 智能搜索代理控制（默认启用）
    const proxyParam = searchParams.get('proxy'); // off 表示禁用代理，直连原始API
    const useSmartProxy = proxyParam !== 'off' && proxyParam !== 'disable'; // 默认启用

    console.log(
      '[TVBox] request:',
      href,
      'format:',
      format,
      'mode:',
      mode,
      'filter:',
      filterParam,
      'proxy:',
      useSmartProxy
    );

    const cfg = await getConfig();

    // 确定是否应该过滤成人内容
    // URL 参数优先级: ?filter=off (禁用过滤) > ?adult=1 (启用成人) > 全局配置
    let shouldFilterAdult = !cfg.SiteConfig.DisableYellowFilter; // 默认使用全局配置

    if (filterParam === 'off' || filterParam === 'disable') {
      shouldFilterAdult = false; // 禁用过滤 = 显示成人内容
    } else if (filterParam === 'on' || filterParam === 'enable') {
      shouldFilterAdult = true; // 启用过滤 = 隐藏成人内容
    } else if (adultParam === '1' || adultParam === 'true') {
      shouldFilterAdult = false; // 显式启用成人内容
    } else if (adultParam === '0' || adultParam === 'false') {
      shouldFilterAdult = true; // 显式禁用成人内容
    }

    const forceSpiderRefresh = searchParams.get('forceSpiderRefresh') === '1';

    // 高可用 JAR 策略：智能选择 + 多重备选 + 错误处理 + 超时控制
    let jarInfo;
    try {
      // 添加 5 秒超时限制，避免 OrionTV 等待过久
      jarInfo = await Promise.race([
        getSpiderJar(forceSpiderRefresh),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Spider JAR timeout')), 5000)
        ),
      ]);
    } catch (err) {
      console.warn('[TVBox] Spider JAR fetch timeout/failed:', err);
      // 超时或失败时使用默认备选
      jarInfo = {
        success: false,
        source: 'fallback',
        md5: 'e53eb37c4dc3dce1c8ee0c996ca3a024',
        buffer: null,
        cached: false,
      };
    }

    let globalSpiderJar: string;

    if (jarInfo.success && jarInfo.source !== 'fallback') {
      // 成功获取远程 JAR，使用完整的 URL;md5 格式
      globalSpiderJar = `${jarInfo.source};md5;${jarInfo.md5}`;
    } else {
      // 所有远程源失败时的智能备选策略
      // 根据请求来源和模式选择最优备选方案
      const backupStrategies = {
        // 国内用户优先策略
        domestic: [
          'https://gitcode.net/qq_26898231/TVBox/-/raw/main/JAR/XC.jar;md5;e53eb37c4dc3dce1c8ee0c996ca3a024',
          'https://gitee.com/q215613905/TVBoxOS/raw/main/JAR/XC.jar;md5;e53eb37c4dc3dce1c8ee0c996ca3a024',
          'https://cdn.gitcode.net/qq_26898231/TVBox/-/raw/main/JAR/XC.jar;md5;e53eb37c4dc3dce1c8ee0c996ca3a024',
        ],
        // 国际用户优先策略
        international: [
          'https://cdn.jsdelivr.net/gh/hjdhnx/dr_py@main/js/drpy.jar;md5;' +
            jarInfo.md5,
          'https://fastly.jsdelivr.net/gh/hjdhnx/dr_py@main/js/drpy.jar;md5;' +
            jarInfo.md5,
          'https://cdn.jsdelivr.net/gh/FongMi/CatVodSpider@main/jar/spider.jar;md5;' +
            jarInfo.md5,
        ],
        // 代理访问策略
        proxy: [
          'https://ghproxy.com/https://raw.githubusercontent.com/hjdhnx/dr_py/main/js/drpy.jar;md5;' +
            jarInfo.md5,
          'https://github.moeyy.xyz/https://raw.githubusercontent.com/hjdhnx/dr_py/main/js/drpy.jar;md5;' +
            jarInfo.md5,
        ],
      };

      // 智能选择备选策略（可以根据 User-Agent、地理位置等优化）
      const userAgent = req.headers.get('user-agent') || '';
      const acceptLanguage = req.headers.get('accept-language') || '';

      let selectedStrategy: string[];
      if (acceptLanguage.includes('zh-CN') || userAgent.includes('zh-CN')) {
        selectedStrategy = backupStrategies.domestic;
      } else {
        selectedStrategy = backupStrategies.international;
      }

      // 添加代理备选（总是包含）
      selectedStrategy = [...selectedStrategy, ...backupStrategies.proxy];

      // 时间基础的轮询选择（避免总是使用同一个源）
      const timeBasedIndex =
        Math.floor(Date.now() / (30 * 60 * 1000)) % selectedStrategy.length;
      globalSpiderJar = selectedStrategy[timeBasedIndex];
    }

    // 🔒 根据过滤设置筛选视频源
    let sourcesToUse = (cfg.SourceConfig || []).filter((s) => !s.disabled);

    if (shouldFilterAdult) {
      // 过滤掉成人资源源
      sourcesToUse = sourcesToUse.filter((s) => !s.is_adult);
      console.log(
        `[TVBox] Adult filter enabled, filtered ${
          cfg.SourceConfig.length - sourcesToUse.length
        } adult sources`
      );
    } else {
      console.log(
        `[TVBox] Adult filter disabled, returning all ${sourcesToUse.length} sources`
      );
    }

    const sites = sourcesToUse.map((s) => {
      const apiType = detectApiType(s.api);
      const site: any = {
        key: s.key,
        name: s.name,
        type: apiType,
        api: s.api,
        // 根据API类型优化配置
        searchable: apiType === 3 ? 1 : 1, // CSP源通常支持搜索
        quickSearch: apiType === 3 ? 1 : 1, // 快速搜索
        filterable: apiType === 3 ? 1 : 1, // 筛选功能
        changeable: 1, // 允许换源
      };

      // 🎯 默认启用智能搜索代理（解决TVBox搜索不精确问题）
      // 只代理普通采集源（type 0, 1），CSP源保持原样
      if (useSmartProxy && (apiType === 0 || apiType === 1)) {
        const requestUrl = new URL(req.url);
        const baseUrl = `${requestUrl.protocol}//${requestUrl.host}`;

        // 保存原始API供代理使用
        site.original_api = site.api;

        // 替换为智能搜索代理端点
        // TVBox会在URL后拼接搜索关键词，格式：api + wd={keyword}
        site.api = `${baseUrl}/api/tvbox/search?source=${encodeURIComponent(
          s.key
        )}&filter=${shouldFilterAdult ? 'on' : 'off'}&wd=`;

        console.log(`[TVBox] Enabled smart proxy for source: ${s.key}`);
      }

      // 优化：根据不同API类型设置请求头，提升稳定性和切换体验
      if (apiType === 0 || apiType === 1) {
        // 苹果CMS接口优化配置
        site.header = {
          'User-Agent':
            'Mozilla/5.0 (Linux; Android 11; SM-G973F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Mobile Safari/537.36',
          Accept: 'application/json, text/plain, */*',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          'Cache-Control': 'no-cache',
          Connection: 'close', // 避免连接复用问题
        };

        // 优化搜索参数配置
        if (!s.api.includes('?')) {
          if (apiType === 1) {
            // JSON接口标准参数
            site.api = s.api + (s.api.endsWith('/') ? '' : '/') + '?ac=list';
          }
        }

        // 增加超时和重试配置
        site.timeout = 10000; // 10秒超时
        site.retry = 2; // 重试2次
      } else if (apiType === 3) {
        // CSP源优化配置
        site.header = {
          'User-Agent': 'okhttp/3.15',
          Accept: '*/*',
          Connection: 'close',
        };

        // CSP源通常更稳定，设置更长超时
        site.timeout = 15000; // 15秒超时
        site.retry = 1; // 重试1次
      }

      // 解析 detail 扩展配置
      const detail = (s.detail || '').trim();
      if (detail) {
        try {
          const obj = JSON.parse(detail);
          if (obj && typeof obj === 'object') {
            // 更新站点配置
            if (obj.type !== undefined) {
              site.type = Number(obj.type);
              // 重新设置对应的请求头
              if (site.type === 3) {
                site.header = { 'User-Agent': 'okhttp/3.15' };
              }
            }
            if (obj.api) site.api = obj.api;

            // 处理ext配置
            if (obj.ext !== undefined) {
              site.ext =
                typeof obj.ext === 'string' ? obj.ext : JSON.stringify(obj.ext);
            }

            // 搜索相关配置
            if (obj.searchable !== undefined)
              site.searchable = Number(obj.searchable);
            if (obj.quickSearch !== undefined)
              site.quickSearch = Number(obj.quickSearch);
            if (obj.filterable !== undefined)
              site.filterable = Number(obj.filterable);
            if (obj.playUrl !== undefined) site.playUrl = obj.playUrl;

            // jar配置处理
            if (obj.jar) {
              const jarUrl = obj.jar.trim();
              if (jarUrl.startsWith('http')) {
                site.jar = jarUrl;
                globalSpiderJar = jarUrl;
              }
            }

            // 处理自定义请求头
            if (obj.header && typeof obj.header === 'object') {
              site.header = { ...site.header, ...obj.header };
            }
          }
        } catch {
          // 如果不是JSON，作为ext字符串处理
          site.ext = detail;
        }
      }

      // 最终类型检查和修正
      if (
        typeof site.api === 'string' &&
        site.api.toLowerCase().startsWith('csp_')
      ) {
        site.type = 3;
        site.header = { 'User-Agent': 'okhttp/3.15' };
      }

      // 确保必要字段存在
      if (!site.ext) site.ext = '';

      return site;
    });

    // 构建直播配置
    const lives = (cfg.LiveConfig || [])
      .filter((l) => !l.disabled)
      .map((l) => ({
        name: l.name,
        type: 0, // 0-m3u格式
        url: l.url,
        ua:
          l.ua ||
          'Mozilla/5.0 (Linux; Android 11; SM-G973F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/89.0.4389.72 Mobile Safari/537.36',
        epg: l.epg || '',
        logo: '',
        group: '直播',
      }));

    // 构建配置对象（支持多种模式优化）
    let tvboxConfig: any;
    if (mode === 'yingshicang') {
      // 专门为影视仓优化的配置 - 解决数据获取问题
      tvboxConfig = {
        // 使用公共 spider（不要使用 localhost 避免体检判定 private）
        spider: globalSpiderJar,
        sites: sites.map((site) => {
          const optimizedSite = { ...site };

          // 影视仓优化：保留必要字段，删除可能冲突的字段
          delete optimizedSite.timeout;
          delete optimizedSite.retry;
          delete optimizedSite.changeable;

          // 影视仓稳定配置
          if (optimizedSite.type === 3) {
            // CSP源：简化配置，提升兼容性
            optimizedSite.header = {
              'User-Agent': 'okhttp/3.15',
              Accept: '*/*',
            };
          } else {
            // 苹果CMS：使用移动端UA，提升兼容性
            optimizedSite.header = {
              'User-Agent':
                'Mozilla/5.0 (Linux; Android 11; SM-G973F) AppleWebKit/537.36',
              Accept: 'application/json, */*',
              Connection: 'close',
            };
          }

          // 强制启用所有搜索功能，提升切换体验
          optimizedSite.searchable = 1;
          optimizedSite.quickSearch = 1;
          optimizedSite.filterable = 1;

          // 影视仓特有优化
          optimizedSite.playerType = 1; // 强制使用系统播放器
          optimizedSite.playUrl = ''; // 清空可能的播放链接冲突

          return optimizedSite;
        }),
        lives,
        parses: [
          {
            name: '默认解析',
            type: 0,
            url: 'https://jx.xmflv.com/?url=',
            ext: {
              flag: ['qq', 'qiyi', 'mgtv', 'youku', 'letv', 'sohu', 'iqiyi'],
              header: { 'User-Agent': 'Mozilla/5.0' },
            },
          },
          {
            name: '备用解析',
            type: 0,
            url: 'https://www.yemu.xyz/?url=',
            ext: {
              flag: ['qq', 'qiyi', 'mgtv', 'youku', 'letv'],
              header: { 'User-Agent': 'Mozilla/5.0' },
            },
          },
          {
            name: '高速解析',
            type: 0,
            url: 'https://jx.aidouer.net/?url=',
            ext: {
              flag: ['qq', 'qiyi', 'mgtv', 'youku'],
              header: { 'User-Agent': 'Mozilla/5.0' },
            },
          },
          { name: 'Json并发', type: 2, url: 'Parallel' },
          { name: 'Json轮询', type: 2, url: 'Sequence' },
        ],
        flags: [
          'youku',
          'qq',
          'iqiyi',
          'qiyi',
          'letv',
          'sohu',
          'tudou',
          'pptv',
          'mgtv',
          'wasu',
          'bilibili',
          'renrenmi',
        ],
        // 影视仓专用规则 - 解决播放问题
        rules: [
          {
            name: '量子资源',
            hosts: ['vip.lz', 'hd.lz', 'v.cdnlz.com'],
            regex: [
              '#EXT-X-DISCONTINUITY\\r?\\n\\#EXTINF:6.433333,[\\s\\S]*?#EXT-X-DISCONTINUITY',
              '#EXTINF.*?\\s+.*?1o.*?\\.ts\\s+',
            ],
          },
          {
            name: '非凡资源',
            hosts: ['vip.ffzy', 'hd.ffzy', 'v.ffzyapi.com'],
            regex: [
              '#EXT-X-DISCONTINUITY\\r?\\n\\#EXTINF:6.666667,[\\s\\S]*?#EXT-X-DISCONTINUITY',
              '#EXTINF.*?\\s+.*?1o.*?\\.ts\\s+',
            ],
          },
        ],
        // 添加影视仓专用的壁纸和其他配置
        wallpaper: 'https://picsum.photos/1920/1080/?blur=1',
        maxHomeVideoContent: '20',
      };
    } else if (mode === 'fast' || mode === 'optimize') {
      // 快速切换优化模式：专门针对资源源切换体验优化
      tvboxConfig = {
        spider: globalSpiderJar,
        sites: sites.map((site) => {
          const fastSite = { ...site };
          // 快速模式：移除可能导致卡顿的配置
          delete fastSite.timeout;
          delete fastSite.retry;

          // 优化请求头，提升响应速度
          if (fastSite.type === 3) {
            fastSite.header = { 'User-Agent': 'okhttp/3.15' };
          } else {
            fastSite.header = {
              'User-Agent':
                'Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36',
              Connection: 'close',
            };
          }

          // 强制启用快速切换相关功能
          fastSite.searchable = 1;
          fastSite.quickSearch = 1;
          fastSite.filterable = 1;
          fastSite.changeable = 1;

          return fastSite;
        }),
        lives,
        parses: [
          {
            name: '极速解析',
            type: 0,
            url: 'https://jx.xmflv.com/?url=',
            ext: { flag: ['all'] },
          },
          { name: 'Json并发', type: 2, url: 'Parallel' },
        ],
        flags: ['youku', 'qq', 'iqiyi', 'qiyi', 'letv', 'sohu', 'mgtv'],
        wallpaper: '', // 移除壁纸加快加载
        maxHomeVideoContent: '15', // 减少首页内容，提升加载速度
      };
    } else if (mode === 'safe' || mode === 'min') {
      // 仅输出最必要字段，避免解析器因字段不兼容而失败
      tvboxConfig = {
        spider: globalSpiderJar,
        sites,
        lives,
        parses: [
          { name: '默认解析', type: 0, url: 'https://jx.xmflv.com/?url=' },
          { name: '夜幕解析', type: 0, url: 'https://www.yemu.xyz/?url=' },
        ],
      };
    } else {
      // 标准完整配置 - 优化体验和兼容性
      tvboxConfig = {
        spider: globalSpiderJar,
        wallpaper: 'https://picsum.photos/1920/1080/?blur=2',
        sites,
        lives,
        parses: [
          {
            name: '默认解析',
            type: 0,
            url: 'https://jx.xmflv.com/?url=',
            ext: {
              flag: [
                'qq',
                'qiyi',
                'mgtv',
                'youku',
                'letv',
                'sohu',
                'xigua',
                'cntv',
              ],
              header: { 'User-Agent': 'Mozilla/5.0' },
            },
          },
          {
            name: '夜幕解析',
            type: 0,
            url: 'https://www.yemu.xyz/?url=',
            ext: {
              flag: ['qq', 'qiyi', 'mgtv', 'youku', 'letv', 'sohu'],
              header: { 'User-Agent': 'Mozilla/5.0' },
            },
          },
          {
            name: '爱豆解析',
            type: 0,
            url: 'https://jx.aidouer.net/?url=',
            ext: {
              flag: ['qq', 'qiyi', 'mgtv', 'youku', 'letv'],
              header: { 'User-Agent': 'Mozilla/5.0' },
            },
          },
          {
            name: '8090解析',
            type: 0,
            url: 'https://www.8090g.cn/?url=',
            ext: {
              flag: ['qq', 'qiyi', 'mgtv', 'youku'],
              header: { 'User-Agent': 'Mozilla/5.0' },
            },
          },
          { name: 'Json并发', type: 2, url: 'Parallel' },
          { name: 'Json轮询', type: 2, url: 'Sequence' },
        ],
        flags: [
          'youku',
          'qq',
          'iqiyi',
          'qiyi',
          'letv',
          'sohu',
          'tudou',
          'pptv',
          'mgtv',
          'wasu',
          'bilibili',
          'renrenmi',
          'xigua',
          'cntv',
          '1905',
          'fun',
        ],
        ijk: [
          {
            group: '软解码',
            options: [
              { category: 4, name: 'opensles', value: '0' },
              { category: 4, name: 'overlay-format', value: '842225234' },
              { category: 4, name: 'framedrop', value: '1' },
              { category: 4, name: 'start-on-prepared', value: '1' },
              { category: 1, name: 'http-detect-range-support', value: '0' },
              { category: 1, name: 'fflags', value: 'fastseek' },
              { category: 4, name: 'reconnect', value: '1' },
              { category: 4, name: 'enable-accurate-seek', value: '0' },
              { category: 4, name: 'mediacodec', value: '0' },
              { category: 4, name: 'mediacodec-auto-rotate', value: '0' },
              {
                category: 4,
                name: 'mediacodec-handle-resolution-change',
                value: '0',
              },
              { category: 2, name: 'skip_loop_filter', value: '48' },
              { category: 4, name: 'packet-buffering', value: '0' },
              { category: 1, name: 'analyzeduration', value: '2000000' },
              { category: 1, name: 'probesize', value: '10485760' },
              { category: 1, name: 'flush_packets', value: '1' },
            ],
          },
          {
            group: '硬解码',
            options: [
              { category: 4, name: 'opensles', value: '0' },
              { category: 4, name: 'overlay-format', value: '842225234' },
              { category: 4, name: 'framedrop', value: '1' },
              { category: 4, name: 'start-on-prepared', value: '1' },
              { category: 1, name: 'http-detect-range-support', value: '0' },
              { category: 1, name: 'fflags', value: 'fastseek' },
              { category: 4, name: 'reconnect', value: '1' },
              { category: 4, name: 'enable-accurate-seek', value: '0' },
              { category: 4, name: 'mediacodec', value: '1' },
              { category: 4, name: 'mediacodec-auto-rotate', value: '1' },
              {
                category: 4,
                name: 'mediacodec-handle-resolution-change',
                value: '1',
              },
              { category: 2, name: 'skip_loop_filter', value: '48' },
              { category: 4, name: 'packet-buffering', value: '0' },
              { category: 1, name: 'analyzeduration', value: '2000000' },
              { category: 1, name: 'probesize', value: '10485760' },
            ],
          },
        ],
        ads: [
          'mimg.0c1q0l.cn',
          'www.googletagmanager.com',
          'mc.usihnbcq.cn',
          'wan.51img1.com',
          'iqiyi.hbuioo.com',
          'vip.ffzyad.com',
          'https://lf1-cdn-tos.bytegoofy.com/obj/tos-cn-i-dy/455ccf9e8ae744378118e4bd289288dd',
        ],
        doh: [
          {
            name: '阿里DNS',
            url: 'https://dns.alidns.com/dns-query',
            ips: ['223.5.5.5', '223.6.6.6'],
          },
          {
            name: '腾讯DNS',
            url: 'https://doh.pub/dns-query',
            ips: ['119.29.29.29', '119.28.28.28'],
          },
        ],
      };
    }

    // 若用户传入了 ?spider=<url> 覆盖，则在保证公共可达（非私网）时允许替换
    const overrideSpider = searchParams.get('spider');
    if (
      overrideSpider &&
      /^https?:\/\//i.test(overrideSpider) &&
      !isPrivateHost(new URL(overrideSpider).hostname)
    ) {
      tvboxConfig.spider = overrideSpider;
    } else {
      tvboxConfig.spider = globalSpiderJar;
    }
    // 附加可观测字段（TVBox 忽略未知字段，不影响使用）
    tvboxConfig.spider_url = jarInfo.source;
    tvboxConfig.spider_md5 = jarInfo.md5;
    tvboxConfig.spider_cached = jarInfo.cached;
    tvboxConfig.spider_real_size = jarInfo.size;
    tvboxConfig.spider_tried = jarInfo.tried;
    tvboxConfig.spider_success = jarInfo.success;

    // 提供备用字段：仅用于调试，不影响体检
    (tvboxConfig as any).spider_backup =
      'https://gitcode.net/qq_26898231/TVBox/-/raw/main/JAR/XC.jar';
    // 保留候选列表以便前端展示（可选）
    (tvboxConfig as any).spider_candidates = REMOTE_SPIDER_CANDIDATES.map(
      (c) => c.url
    );

    // 配置验证和清理
    console.log('TVBox配置验证:', {
      sitesCount: tvboxConfig.sites.length,
      livesCount: tvboxConfig.lives.length,
      parsesCount: tvboxConfig.parses.length,
      spider: tvboxConfig.spider ? '已设置' : '未设置',
      spiderUrl: tvboxConfig.spider.split(';')[0],
      mode: mode || 'standard',
    });

    let responseContent: string;
    let contentType: string;

    if (format === 'base64') {
      // Base64编码 - 影视仓等部分应用需要
      const jsonString = JSON.stringify(tvboxConfig, null, 0);
      responseContent = Buffer.from(jsonString, 'utf-8').toString('base64');
      contentType = 'text/plain; charset=utf-8';
    } else {
      // 标准JSON格式 - 确保字段顺序和格式正确
      responseContent = JSON.stringify(
        tvboxConfig,
        (key, value) => {
          // 数字类型的字段确保为数字
          if (
            ['type', 'searchable', 'quickSearch', 'filterable'].includes(key)
          ) {
            return typeof value === 'string' ? parseInt(value) || 0 : value;
          }
          return value;
        },
        0
      ); // 紧凑格式，不使用缩进

      // TVBox体检要求content-type为text/plain
      contentType = 'text/plain; charset=utf-8';
    }

    return new NextResponse(responseContent, {
      headers: {
        'content-type': contentType,
        'cache-control': 'no-store, no-cache, must-revalidate',
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, OPTIONS',
        'access-control-allow-headers': 'Content-Type',
      },
    });
  } catch (e) {
    console.error('TVBox 配置生成失败:', e);
    return NextResponse.json(
      {
        error: 'TVBox 配置生成失败',
        details: e instanceof Error ? e.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}

// 处理 CORS 预检请求 (OrionTV 1.3.11+ 可能需要)
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-allow-headers': 'Content-Type',
      'access-control-max-age': '86400',
    },
  });
}
