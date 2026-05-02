export const POSTER_FALLBACK_SRC = '/poster-fallback.svg';

const DEFAULT_WSRV_WIDTH = 256;
const DEFAULT_DOUBAN_IMAGE_PROXY_TYPE = 'cmliussss-cdn-tencent';
const TIER1_DIRECT_HOSTS = new Set(['lain.bgm.tv']);
const WSRV_HOSTS = new Set(['wsrv.nl', 'images.weserv.nl']);
const CMLIUSSSS_TENCENT_HOST = 'img.doubanio.cmliussss.net';
const CMLIUSSSS_ALI_HOST = 'img.doubanio.cmliussss.com';
const DOUBAN_IMG3_HOST = 'img3.doubanio.com';

export type DoubanImageProxyType =
  | 'direct'
  | 'server'
  | 'img3'
  | 'cmliussss-cdn-tencent'
  | 'cmliussss-cdn-ali'
  | 'custom';

export interface DoubanImageProxyOverride {
  proxyType?: string;
  proxyUrl?: string;
}

export interface ResolveImageUrlOptions {
  wsrvWidth?: number;
  /**
   * 显式覆盖豆瓣图片代理。SSR 与首次客户端渲染保持一致以避免 hydration 不匹配，
   * 因此调用方应只在 client 端的 effect 中读取 localStorage / RUNTIME_CONFIG
   * 后再传入；不传时回退到 NEXT_PUBLIC_DOUBAN_IMAGE_PROXY_* 环境变量默认值。
   */
  doubanImageProxy?: DoubanImageProxyOverride;
}

function normalizeWsrvWidth(width?: number): number {
  if (!Number.isFinite(width) || !width || width <= 0) {
    return DEFAULT_WSRV_WIDTH;
  }
  return Math.round(width);
}

function isRelativeUrl(url: string): boolean {
  return (
    url.startsWith('/') ||
    url.startsWith('./') ||
    url.startsWith('../') ||
    url.startsWith('#')
  );
}

function toAbsoluteUrl(url: string): URL | null {
  const normalized = url.startsWith('//') ? `https:${url}` : url;

  try {
    return new URL(normalized);
  } catch {
    return null;
  }
}

function isDoubanHost(hostname: string): boolean {
  return hostname === 'douban.com' || hostname.endsWith('.douban.com');
}

function isDoubanImageHost(hostname: string): boolean {
  return (
    hostname === 'doubanio.com' ||
    hostname.endsWith('.doubanio.com') ||
    hostname === CMLIUSSSS_TENCENT_HOST ||
    hostname === CMLIUSSSS_ALI_HOST
  );
}

function toWsrvUrl(absoluteUrl: string, wsrvWidth: number): string {
  const sanitizedTarget = absoluteUrl.replace(/^https?:\/\//i, '');
  return `https://wsrv.nl/?url=${encodeURIComponent(sanitizedTarget)}&w=${wsrvWidth}&default=blank`;
}

function getDefaultDoubanImageProxy(): {
  proxyType: string;
  proxyUrl: string;
} {
  return {
    proxyType:
      process.env.NEXT_PUBLIC_DOUBAN_IMAGE_PROXY_TYPE ||
      DEFAULT_DOUBAN_IMAGE_PROXY_TYPE,
    proxyUrl: process.env.NEXT_PUBLIC_DOUBAN_IMAGE_PROXY || '',
  };
}

function applyDoubanImageProxy(
  parsedUrl: URL,
  proxyType: string,
  proxyUrl: string,
): string {
  parsedUrl.protocol = 'https:';

  switch (proxyType as DoubanImageProxyType) {
    case 'direct':
      return parsedUrl.toString();

    case 'img3':
      parsedUrl.hostname = DOUBAN_IMG3_HOST;
      return parsedUrl.toString();

    case 'cmliussss-cdn-tencent':
      parsedUrl.hostname = CMLIUSSSS_TENCENT_HOST;
      return parsedUrl.toString();

    case 'cmliussss-cdn-ali':
      parsedUrl.hostname = CMLIUSSSS_ALI_HOST;
      return parsedUrl.toString();

    case 'server':
      return `/api/image-proxy?url=${encodeURIComponent(parsedUrl.toString())}`;

    case 'custom': {
      const trimmed = proxyUrl?.trim() ?? '';
      if (!trimmed) {
        // 没填自定义 URL 就当 direct，避免拼出无效请求
        return parsedUrl.toString();
      }
      return `${trimmed}${encodeURIComponent(parsedUrl.toString())}`;
    }

    default:
      parsedUrl.hostname = CMLIUSSSS_TENCENT_HOST;
      return parsedUrl.toString();
  }
}

export function resolveImageUrl(
  originalUrl: string,
  options: ResolveImageUrlOptions = {},
): string {
  const trimmed = originalUrl?.trim?.() ?? '';
  if (!trimmed) {
    return POSTER_FALLBACK_SRC;
  }

  if (
    isRelativeUrl(trimmed) ||
    trimmed.startsWith('data:') ||
    trimmed.startsWith('blob:')
  ) {
    return trimmed;
  }

  const parsedUrl = toAbsoluteUrl(trimmed);
  if (!parsedUrl) {
    return trimmed;
  }

  const hostname = parsedUrl.hostname.toLowerCase();

  if (WSRV_HOSTS.has(hostname)) {
    return parsedUrl.toString();
  }

  if (TIER1_DIRECT_HOSTS.has(hostname)) {
    if (parsedUrl.protocol === 'http:') {
      parsedUrl.protocol = 'https:';
    }
    return parsedUrl.toString();
  }

  if (isDoubanImageHost(hostname)) {
    const defaults = getDefaultDoubanImageProxy();
    const proxyType =
      options.doubanImageProxy?.proxyType?.trim() || defaults.proxyType;
    const proxyUrl =
      options.doubanImageProxy?.proxyUrl ?? defaults.proxyUrl ?? '';
    return applyDoubanImageProxy(parsedUrl, proxyType, proxyUrl);
  }

  if (isDoubanHost(hostname)) {
    if (parsedUrl.protocol === 'http:') {
      parsedUrl.protocol = 'https:';
    }
    return parsedUrl.toString();
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return trimmed;
  }

  return toWsrvUrl(parsedUrl.toString(), normalizeWsrvWidth(options.wsrvWidth));
}
