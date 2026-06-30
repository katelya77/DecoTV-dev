import {
  fetchWithValidatedRedirects,
  validateProxyTargetUrl,
} from '@/lib/proxy-security';

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const RESOLVE_TIMEOUT_MS = 7000;
const MAX_REDIRECTS = 3;
const MAX_TEXT_BYTES = 512 * 1024;
const MAX_SCRIPT_BYTES = 256 * 1024;
const MAX_EXTERNAL_SCRIPT_PROBES = 5;
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 500;

type PlaybackMediaType = 'hls' | 'file' | 'page' | 'unknown';

export interface PlaybackUrlResolution {
  originalUrl: string;
  resolvedUrl: string;
  mediaType: PlaybackMediaType;
  resolved: boolean;
  referer?: string;
  contentType?: string;
  error?: string;
}

function toChineseResolveError(
  message: string | undefined,
): string | undefined {
  if (!message) return undefined;
  if (/no media url/i.test(message)) {
    return '播放页中未找到可播放媒体地址';
  }
  if (/too large/i.test(message)) {
    return '播放页内容过大，无法解析';
  }
  if (/empty playback url/i.test(message)) {
    return '播放地址为空';
  }
  if (/invalid playback url|invalid url/i.test(message)) {
    return '播放地址无效';
  }
  if (/timeout|timed out|abort/i.test(message)) {
    return '解析播放地址超时';
  }
  if (/fetch failed|network/i.test(message)) {
    return '解析播放地址网络请求失败';
  }
  if (/unable to resolve/i.test(message)) {
    return '无法解析播放地址';
  }
  return message;
}

interface CacheEntry {
  expiresAt: number;
  value: PlaybackUrlResolution;
}

const resolveCache = new Map<string, CacheEntry>();

function pruneCache() {
  const now = Date.now();
  for (const [key, entry] of resolveCache.entries()) {
    if (entry.expiresAt <= now) {
      resolveCache.delete(key);
    }
  }

  while (resolveCache.size > MAX_CACHE_ENTRIES) {
    const oldest = resolveCache.keys().next().value;
    if (!oldest) break;
    resolveCache.delete(oldest);
  }
}

function getCached(url: string): PlaybackUrlResolution | null {
  const entry = resolveCache.get(url);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    resolveCache.delete(url);
    return null;
  }
  return entry.value;
}

function setCached(url: string, value: PlaybackUrlResolution) {
  pruneCache();
  resolveCache.set(url, {
    expiresAt: Date.now() + CACHE_TTL_MS,
    value,
  });
}

function stripWrappingQuotes(value: string): string {
  return value
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .trim();
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function normalizeEscapedUrl(value: string): string {
  return decodeHtmlEntities(stripWrappingQuotes(value))
    .replace(/\\\//g, '/')
    .replace(/\\x([0-9a-f]{2})/gi, (_match, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    )
    .replace(/\\u([0-9a-f]{4})/gi, (_match, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    )
    .replace(/\\u0026/gi, '&')
    .trim();
}

function decodeURIComponentSafely(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    return decoded !== value ? decoded : null;
  } catch {
    return null;
  }
}

function decodeBase64Candidate(value: string): string | null {
  const normalized = value.trim().replace(/-/g, '+').replace(/_/g, '/');
  if (!normalized || normalized.length < 12) return null;
  if (!/^[a-z0-9+/]+={0,2}$/i.test(normalized)) return null;

  try {
    const decoded = Buffer.from(normalized, 'base64').toString('utf8').trim();
    if (/^(?:https?:)?\/\//i.test(decoded) || decoded.startsWith('/')) {
      return decoded;
    }
  } catch {
    // ignore non-base64 values
  }

  return null;
}

function expandCandidateVariants(value: string): string[] {
  const variants: string[] = [];
  const seen = new Set<string>();
  const queue = [normalizeEscapedUrl(value)];

  while (queue.length > 0) {
    const current = queue.shift()?.trim();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    variants.push(current);

    const uriDecoded = decodeURIComponentSafely(current);
    if (uriDecoded && !seen.has(uriDecoded)) queue.push(uriDecoded);

    const base64Decoded = decodeBase64Candidate(current);
    if (base64Decoded && !seen.has(base64Decoded)) queue.push(base64Decoded);
  }

  return variants;
}

function isUnsupportedMediaCandidate(value: string): boolean {
  const lower = value.trim().toLowerCase();
  return (
    !lower ||
    lower.startsWith('blob:') ||
    lower.startsWith('data:') ||
    lower.startsWith('javascript:') ||
    lower.startsWith('#')
  );
}

function inferMediaTypeFromUrl(url: string): PlaybackMediaType {
  try {
    const parsed = new URL(url, 'http://localhost');
    const path = parsed.pathname.toLowerCase();
    if (path.endsWith('.m3u8')) return 'hls';
    if (
      path.endsWith('.mp4') ||
      path.endsWith('.m4v') ||
      path.endsWith('.webm') ||
      path.endsWith('.mkv') ||
      path.endsWith('.mov') ||
      path.endsWith('.flv')
    ) {
      return 'file';
    }
  } catch {
    // ignore
  }
  return 'unknown';
}

function inferMediaTypeFromContentType(
  contentType: string | null,
): PlaybackMediaType {
  const lower = (contentType || '').toLowerCase();
  if (
    lower.includes('mpegurl') ||
    lower.includes('vnd.apple.mpegurl') ||
    lower.includes('x-mpegurl')
  ) {
    return 'hls';
  }
  if (lower.startsWith('video/') || lower.startsWith('audio/')) {
    return 'file';
  }
  if (
    lower.includes('text/html') ||
    lower.includes('application/xhtml') ||
    lower.includes('charset=')
  ) {
    return 'page';
  }
  return 'unknown';
}

function resolveCandidateVariants(
  baseUrl: string,
  candidate: string,
): string[] {
  const resolvedCandidates: string[] = [];
  const seenValues = new Set<string>();
  const queue = expandCandidateVariants(candidate);
  const mediaParamNames = [
    'url',
    'play',
    'playurl',
    'play_url',
    'video',
    'videoUrl',
    'vurl',
    'src',
    'file',
    'm3u8',
    'id',
    'vid',
    'path',
  ];

  while (queue.length > 0) {
    const normalized = queue.shift()?.trim();
    if (!normalized || seenValues.has(normalized)) continue;
    seenValues.add(normalized);
    if (isUnsupportedMediaCandidate(normalized)) continue;

    let resolved: string;
    try {
      resolved = new URL(normalized, baseUrl).toString();
    } catch {
      continue;
    }

    if (!resolvedCandidates.includes(resolved)) {
      resolvedCandidates.push(resolved);
    }

    try {
      const parsed = new URL(resolved);
      for (const name of mediaParamNames) {
        const paramValue = parsed.searchParams.get(name);
        if (!paramValue) continue;
        for (const variant of expandCandidateVariants(paramValue)) {
          if (!seenValues.has(variant)) queue.push(variant);
        }
      }
    } catch {
      // ignore invalid candidate URLs
    }
  }

  return resolvedCandidates;
}

function pushCandidate(
  candidates: string[],
  baseUrl: string,
  candidate: string | undefined,
) {
  if (!candidate) return;
  const resolvedCandidates = resolveCandidateVariants(baseUrl, candidate);
  for (const resolved of resolvedCandidates) {
    if (!/^https?:\/\//i.test(resolved)) continue;
    if (!candidates.includes(resolved)) {
      candidates.push(resolved);
    }
  }
}

export function extractPlaybackCandidatesFromHtml(
  html: string,
  pageUrl: string,
): string[] {
  if (!html) return [];

  const candidates: string[] = [];
  const patterns: RegExp[] = [
    /\b(?:const|let|var)\s+(?:url|playUrl|playurl|play_url|videoUrl|video|m3u8|src|file|source)\s*=\s*(['"`])([^'"`]+)\1/gi,
    /["']?(?:url|play_url|playUrl|playurl|videoUrl|video|m3u8|src|file|source)["']?\s*:\s*(['"`])([^'"`]+)\1/gi,
    /\.(?:url|playUrl|playurl|play_url|videoUrl|video|m3u8|src|file|source)\s*=\s*(['"`])([^'"`]+)\1/gi,
    /\b(?:atob|decodeURIComponent|unescape)\(\s*(['"`])([^'"`]+)\1\s*\)/gi,
    /\bhls\.loadSource\(\s*(['"`])([^'"`]+)\1\s*\)/gi,
    /<(?:source|video|iframe|embed)\b[^>]+src=(['"])([^'"]+)\1/gi,
    /<(?:source|video|meta)\b[^>]+(?:data-src|content)=(['"])([^'"]+)\1/gi,
    /\bdata-(?:url|play-url|playurl|video-url|m3u8|src|file|source)=(['"])([^'"]+)\1/gi,
  ];

  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      pushCandidate(candidates, pageUrl, match[2]);
    }
  }

  for (const match of html.matchAll(
    /(?:(?:https?:)?\/\/|\/)[^'"<>\s]+?\.m3u8(?:\?[^'"<>\s]*)?/gi,
  )) {
    pushCandidate(candidates, pageUrl, match[0]);
  }

  for (const match of html.matchAll(
    /(?:https?%3a%2f%2f|%2f)[^'"<>\s]+?\.m3u8(?:%3f[^'"<>\s]*)?/gi,
  )) {
    pushCandidate(candidates, pageUrl, match[0]);
  }

  return candidates;
}

function extractExternalScriptUrlsFromHtml(
  html: string,
  pageUrl: string,
): string[] {
  if (!html) return [];

  const scripts: string[] = [];
  for (const match of html.matchAll(/<script\b[^>]+src=(['"])([^'"]+)\1/gi)) {
    const src = match[2];
    if (!src || isUnsupportedMediaCandidate(src)) continue;

    try {
      const resolved = new URL(normalizeEscapedUrl(src), pageUrl).toString();
      if (/^https?:\/\//i.test(resolved) && !scripts.includes(resolved)) {
        scripts.push(resolved);
      }
    } catch {
      // ignore invalid script urls
    }
  }

  return scripts.slice(0, MAX_EXTERNAL_SCRIPT_PROBES);
}

export function extractPlaybackUrlFromHtml(
  html: string,
  pageUrl: string,
): string | null {
  const candidates = extractPlaybackCandidatesFromHtml(html, pageUrl);
  return (
    candidates.find(
      (candidate) => inferMediaTypeFromUrl(candidate) === 'hls',
    ) ||
    candidates.find(
      (candidate) => inferMediaTypeFromUrl(candidate) === 'file',
    ) ||
    null
  );
}

async function extractPlaybackUrlFromExternalScripts(
  html: string,
  pageUrl: string,
): Promise<string | null> {
  const scriptUrls = extractExternalScriptUrlsFromHtml(html, pageUrl);
  for (const scriptUrl of scriptUrls) {
    try {
      const response = await fetchWithValidatedRedirects(
        scriptUrl,
        {
          cache: 'no-store',
          headers: {
            Accept:
              'application/javascript,text/javascript,text/plain,*/*;q=0.5',
            Range: `bytes=0-${MAX_SCRIPT_BYTES - 1}`,
            Referer: pageUrl,
            'User-Agent': DEFAULT_UA,
          },
        },
        { timeoutMs: RESOLVE_TIMEOUT_MS, maxRedirects: MAX_REDIRECTS },
      );
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        continue;
      }

      const script = await readTextWithLimit(response, MAX_SCRIPT_BYTES);
      const extractedUrl = extractPlaybackUrlFromHtml(
        script,
        response.url || scriptUrl,
      );
      if (extractedUrl) return extractedUrl;
    } catch {
      // External player scripts are best-effort; keep trying the next one.
    }
  }

  return null;
}

function extractNestedPlaybackPageUrlFromHtml(
  html: string,
  pageUrl: string,
): string | null {
  if (!html) return null;

  const candidates: string[] = [];
  for (const match of html.matchAll(/<iframe\b[^>]+src=(['"])([^'"]+)\1/gi)) {
    pushCandidate(candidates, pageUrl, match[2]);
  }

  return (
    candidates.find((candidate) => {
      if (candidate === pageUrl) return false;
      const type = inferMediaTypeFromUrl(candidate);
      return type === 'unknown' || type === 'page';
    }) || null
  );
}

async function readTextWithLimit(
  response: Response,
  maxBytes = MAX_TEXT_BYTES,
): Promise<string> {
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
      await reader.cancel().catch(() => undefined);
      throw new Error('Playback page too large');
    }

    text += decoder.decode(value, { stream: true });
  }

  text += decoder.decode();
  return text;
}

export async function resolveExternalPlaybackUrl(
  rawUrl: string,
): Promise<PlaybackUrlResolution> {
  const originalUrl = rawUrl.trim();
  if (!originalUrl) {
    return {
      originalUrl,
      resolvedUrl: '',
      mediaType: 'unknown',
      resolved: false,
      error: '播放地址为空',
    };
  }

  const cached = getCached(originalUrl);
  if (cached) return cached;

  try {
    await validateProxyTargetUrl(originalUrl);
  } catch (error) {
    return {
      originalUrl,
      resolvedUrl: originalUrl,
      mediaType: inferMediaTypeFromUrl(originalUrl),
      resolved: false,
      error:
        error instanceof Error
          ? toChineseResolveError(error.message)
          : '播放地址无效',
    };
  }

  const directType = inferMediaTypeFromUrl(originalUrl);
  if (directType === 'hls' || directType === 'file') {
    const directResult = {
      originalUrl,
      resolvedUrl: originalUrl,
      mediaType: directType,
      resolved: false,
    } satisfies PlaybackUrlResolution;
    setCached(originalUrl, directResult);
    return directResult;
  }

  try {
    const response = await fetchWithValidatedRedirects(
      originalUrl,
      {
        cache: 'no-store',
        headers: {
          Accept:
            'text/html,application/vnd.apple.mpegurl,application/x-mpegURL,video/*;q=0.8,*/*;q=0.5',
          Range: `bytes=0-${MAX_TEXT_BYTES - 1}`,
          'User-Agent': DEFAULT_UA,
        },
      },
      { timeoutMs: RESOLVE_TIMEOUT_MS, maxRedirects: MAX_REDIRECTS },
    );

    const finalUrl = response.url || originalUrl;
    const contentType = response.headers.get('content-type') || '';
    const responseType =
      inferMediaTypeFromContentType(contentType) ||
      inferMediaTypeFromUrl(finalUrl);
    const finalUrlType = inferMediaTypeFromUrl(finalUrl);

    if (responseType === 'hls' || finalUrlType === 'hls') {
      await response.body?.cancel().catch(() => undefined);
      const result = {
        originalUrl,
        resolvedUrl: finalUrl,
        mediaType: 'hls',
        resolved: finalUrl !== originalUrl,
        contentType,
      } satisfies PlaybackUrlResolution;
      setCached(originalUrl, result);
      return result;
    }

    if (responseType === 'file' || finalUrlType === 'file') {
      await response.body?.cancel().catch(() => undefined);
      const result = {
        originalUrl,
        resolvedUrl: finalUrl,
        mediaType: 'file',
        resolved: finalUrl !== originalUrl,
        contentType,
      } satisfies PlaybackUrlResolution;
      setCached(originalUrl, result);
      return result;
    }

    const html = await readTextWithLimit(response);
    const extractedUrl = extractPlaybackUrlFromHtml(html, finalUrl);
    if (extractedUrl) {
      const result = {
        originalUrl,
        resolvedUrl: extractedUrl,
        mediaType: inferMediaTypeFromUrl(extractedUrl),
        resolved: true,
        referer: finalUrl,
        contentType,
      } satisfies PlaybackUrlResolution;
      setCached(originalUrl, result);
      return result;
    }

    const scriptExtractedUrl = await extractPlaybackUrlFromExternalScripts(
      html,
      finalUrl,
    );
    if (scriptExtractedUrl) {
      const result = {
        originalUrl,
        resolvedUrl: scriptExtractedUrl,
        mediaType: inferMediaTypeFromUrl(scriptExtractedUrl),
        resolved: true,
        referer: finalUrl,
        contentType,
      } satisfies PlaybackUrlResolution;
      setCached(originalUrl, result);
      return result;
    }

    const nestedPageUrl = extractNestedPlaybackPageUrlFromHtml(html, finalUrl);
    if (nestedPageUrl) {
      try {
        const nestedResponse = await fetchWithValidatedRedirects(
          nestedPageUrl,
          {
            cache: 'no-store',
            headers: {
              Accept:
                'text/html,application/vnd.apple.mpegurl,application/x-mpegURL,video/*;q=0.8,*/*;q=0.5',
              Range: `bytes=0-${MAX_TEXT_BYTES - 1}`,
              Referer: finalUrl,
              'User-Agent': DEFAULT_UA,
            },
          },
          { timeoutMs: RESOLVE_TIMEOUT_MS, maxRedirects: MAX_REDIRECTS },
        );
        const nestedFinalUrl = nestedResponse.url || nestedPageUrl;
        const nestedContentType =
          nestedResponse.headers.get('content-type') || '';
        const nestedResponseType =
          inferMediaTypeFromContentType(nestedContentType);
        const nestedFinalType = inferMediaTypeFromUrl(nestedFinalUrl);

        if (nestedResponseType === 'hls' || nestedFinalType === 'hls') {
          await nestedResponse.body?.cancel().catch(() => undefined);
          const result = {
            originalUrl,
            resolvedUrl: nestedFinalUrl,
            mediaType: 'hls',
            resolved: true,
            referer: finalUrl,
            contentType: nestedContentType,
          } satisfies PlaybackUrlResolution;
          setCached(originalUrl, result);
          return result;
        }

        if (nestedResponseType === 'file' || nestedFinalType === 'file') {
          await nestedResponse.body?.cancel().catch(() => undefined);
          const result = {
            originalUrl,
            resolvedUrl: nestedFinalUrl,
            mediaType: 'file',
            resolved: true,
            referer: finalUrl,
            contentType: nestedContentType,
          } satisfies PlaybackUrlResolution;
          setCached(originalUrl, result);
          return result;
        }

        const nestedHtml = await readTextWithLimit(nestedResponse);
        const nestedExtractedUrl = extractPlaybackUrlFromHtml(
          nestedHtml,
          nestedFinalUrl,
        );
        if (nestedExtractedUrl) {
          const result = {
            originalUrl,
            resolvedUrl: nestedExtractedUrl,
            mediaType: inferMediaTypeFromUrl(nestedExtractedUrl),
            resolved: true,
            referer: nestedFinalUrl,
            contentType: nestedContentType,
          } satisfies PlaybackUrlResolution;
          setCached(originalUrl, result);
          return result;
        }

        const nestedScriptExtractedUrl =
          await extractPlaybackUrlFromExternalScripts(
            nestedHtml,
            nestedFinalUrl,
          );
        if (nestedScriptExtractedUrl) {
          const result = {
            originalUrl,
            resolvedUrl: nestedScriptExtractedUrl,
            mediaType: inferMediaTypeFromUrl(nestedScriptExtractedUrl),
            resolved: true,
            referer: nestedFinalUrl,
            contentType: nestedContentType,
          } satisfies PlaybackUrlResolution;
          setCached(originalUrl, result);
          return result;
        }
      } catch {
        // Keep the original page fallback when a nested player page is blocked.
      }
    }

    const fallback = {
      originalUrl,
      resolvedUrl: finalUrl,
      mediaType: responseType === 'page' ? 'page' : 'unknown',
      resolved: finalUrl !== originalUrl,
      contentType,
      error:
        responseType === 'page' ? '播放页中未找到可播放媒体地址' : undefined,
    } satisfies PlaybackUrlResolution;
    setCached(originalUrl, fallback);
    return fallback;
  } catch (error) {
    return {
      originalUrl,
      resolvedUrl: originalUrl,
      mediaType: inferMediaTypeFromUrl(originalUrl),
      resolved: false,
      error:
        error instanceof Error
          ? toChineseResolveError(error.message)
          : '无法解析播放地址',
    };
  }
}
