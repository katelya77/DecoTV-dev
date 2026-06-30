/* eslint-disable @typescript-eslint/no-explicit-any */
import he from 'he';
import Hls from 'hls.js';

import { resolveImageUrl } from './image-url';
import { isLikelyHlsUrl } from './player/hls-url';

export function processImageUrl(originalUrl: string): string {
  return resolveImageUrl(originalUrl, { wsrvWidth: 256 });
}

export type VideoSourceTestStatus = 'ok' | 'partial' | 'failed';
export type VideoSourceFailureKind =
  | 'empty'
  | 'timeout'
  | 'resolver'
  | 'manifest'
  | 'fragment'
  | 'media'
  | 'network'
  | 'unsupported'
  | 'unknown';
export type PlaybackMediaType = 'hls' | 'file' | 'page' | 'unknown';

export interface VideoSourceTestResult {
  quality: string;
  loadSpeed: string;
  pingTime: number;
  speedKBps?: number;
  startupTimeMs?: number;
  hasError?: boolean;
  status?: VideoSourceTestStatus;
  message?: string;
  playable?: boolean;
  testedAt?: number;
  resolvedUrl?: string;
  mediaType?: PlaybackMediaType;
  failureKind?: VideoSourceFailureKind;
}

const DEFAULT_SOURCE_TEST_TIMEOUT_MS = 10000;
const NATIVE_REACHABILITY_TIMEOUT_MS = 3000;

function qualityFromWidth(width: number): string {
  if (!width || width <= 0) return '未知';
  if (width >= 3840) return '4K';
  if (width >= 2560) return '2K';
  if (width >= 1920) return '1080p';
  if (width >= 1280) return '720p';
  if (width >= 854) return '480p';
  return 'SD';
}

function qualityFromLevels(levels: any[] | undefined): string {
  if (!Array.isArray(levels) || levels.length === 0) return '未知';
  const maxWidth = levels.reduce((max, level) => {
    const width = Number(level?.width || level?.attrs?.RESOLUTION?.width);
    return Number.isFinite(width) ? Math.max(max, width) : max;
  }, 0);
  return qualityFromWidth(maxWidth);
}

export function formatVideoLoadSpeed(speedKBps?: number): string {
  if (!speedKBps || !Number.isFinite(speedKBps) || speedKBps <= 0) {
    return '未知';
  }
  return `${(speedKBps / 1024).toFixed(2)} MB/s`;
}

function getStatsTime(stats: any, key: 'start' | 'first' | 'end'): number {
  const loadingValue = Number(stats?.loading?.[key]);
  if (Number.isFinite(loadingValue) && loadingValue > 0) {
    return loadingValue;
  }

  const legacyKey =
    key === 'start' ? 'trequest' : key === 'first' ? 'tfirst' : 'tload';
  const legacyValue = Number(stats?.[legacyKey]);
  return Number.isFinite(legacyValue) && legacyValue > 0 ? legacyValue : 0;
}

function getStatsLoadedBytes(stats: any, payload: any): number {
  const loaded = Number(stats?.loaded || stats?.total);
  if (Number.isFinite(loaded) && loaded > 0) return loaded;
  const payloadLength = Number(payload?.byteLength || payload?.length);
  return Number.isFinite(payloadLength) && payloadLength > 0
    ? payloadLength
    : 0;
}

async function probeUrlReachability(
  url: string,
  timeoutMs = NATIVE_REACHABILITY_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<{ reachable: boolean; responseMs: number; message?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();
  const abortFromParent = () => controller.abort();

  if (signal?.aborted) {
    controller.abort();
  } else {
    signal?.addEventListener('abort', abortFromParent, { once: true });
  }

  try {
    const response = await fetch(url, {
      cache: 'no-store',
      mode: 'no-cors',
      signal: controller.signal,
    });
    const reader = response.body?.getReader();
    if (reader) {
      await reader.read().catch(() => undefined);
      await reader.cancel().catch(() => undefined);
    }
    controller.abort();
    return {
      reachable: true,
      responseMs: performance.now() - startedAt,
    };
  } catch (error) {
    const aborted =
      error instanceof DOMException && error.name === 'AbortError';
    return {
      reachable: false,
      responseMs: 0,
      message: aborted ? '连接超时' : '地址不可访问',
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abortFromParent);
  }
}

function buildResult(input: {
  quality: string;
  pingTime: number;
  speedKBps?: number;
  startupTimeMs?: number;
  status: VideoSourceTestStatus;
  message?: string;
  playable?: boolean;
  failureKind?: VideoSourceFailureKind;
  resolvedUrl?: string;
  mediaType?: PlaybackMediaType;
}): VideoSourceTestResult {
  return {
    quality: input.quality || '未知',
    loadSpeed: formatVideoLoadSpeed(input.speedKBps),
    pingTime: Math.max(0, Math.round(input.pingTime || 0)),
    speedKBps: input.speedKBps,
    startupTimeMs:
      typeof input.startupTimeMs === 'number'
        ? Math.max(0, Math.round(input.startupTimeMs))
        : undefined,
    hasError: input.status === 'failed',
    status: input.status,
    message: input.message,
    playable: input.playable,
    testedAt: Date.now(),
    resolvedUrl: input.resolvedUrl,
    mediaType: input.mediaType,
    failureKind: input.failureKind,
  };
}

async function measureNativeVideoSource(
  url: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<VideoSourceTestResult> {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'metadata';

    let finished = false;
    let pingTime = 0;
    const startedAt = performance.now();
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let failureCheckStarted = false;
    let abortHandler: (() => void) | null = null;

    const finish = (
      status: VideoSourceTestStatus,
      message?: string,
      failureKind?: VideoSourceFailureKind,
    ) => {
      if (finished) return;
      finished = true;
      const elapsedMs = performance.now() - startedAt;
      if (timeout) clearTimeout(timeout);
      if (abortHandler && signal) {
        signal.removeEventListener('abort', abortHandler);
      }
      video.removeAttribute('src');
      video.load();
      video.remove();

      resolve(
        buildResult({
          quality: qualityFromWidth(video.videoWidth),
          pingTime: pingTime || elapsedMs,
          startupTimeMs: status === 'ok' ? elapsedMs : undefined,
          status,
          message,
          playable: status !== 'failed',
          failureKind,
          resolvedUrl: url,
          mediaType: 'file',
        }),
      );
    };

    abortHandler = () => finish('failed', '测速已取消', 'unknown');
    if (signal?.aborted) {
      abortHandler();
      return;
    }
    signal?.addEventListener('abort', abortHandler, { once: true });

    const finishAfterReachabilityCheck = async (fallbackMessage: string) => {
      if (failureCheckStarted || finished) return;
      failureCheckStarted = true;
      const probe = await probeUrlReachability(
        url,
        Math.min(NATIVE_REACHABILITY_TIMEOUT_MS, timeoutMs),
        signal,
      );
      if (finished) return;

      if (probe.reachable) {
        pingTime = probe.responseMs;
        finish('partial', `${fallbackMessage}，但地址可访问`, 'media');
      } else {
        finish(
          'failed',
          probe.message || fallbackMessage,
          probe.message === '连接超时' ? 'timeout' : 'network',
        );
      }
    };

    timeout = setTimeout(() => {
      void finishAfterReachabilityCheck('未在限定时间内返回媒体信息');
    }, timeoutMs);

    video.onloadedmetadata = () => finish('ok', '媒体元数据可用');
    video.oncanplay = () => finish('ok', '可播放');
    video.onerror = () => {
      void finishAfterReachabilityCheck('浏览器无法解析该媒体');
    };
    video.src = url;
  });
}

export async function getVideoResolutionFromM3u8(
  m3u8Url: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<VideoSourceTestResult> {
  if (!m3u8Url) {
    return buildResult({
      quality: '未知',
      pingTime: 0,
      status: 'failed',
      message: '播放地址为空',
      failureKind: 'empty',
    });
  }

  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return buildResult({
      quality: '未知',
      pingTime: 0,
      status: 'failed',
      message: '当前环境无法测速',
      failureKind: 'unsupported',
      resolvedUrl: m3u8Url,
      mediaType: isLikelyHlsUrl(m3u8Url) ? 'hls' : 'unknown',
    });
  }

  const timeoutMs = options.timeoutMs || DEFAULT_SOURCE_TEST_TIMEOUT_MS;

  if (!isLikelyHlsUrl(m3u8Url) || !Hls.isSupported()) {
    return measureNativeVideoSource(m3u8Url, timeoutMs, options.signal);
  }

  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'metadata';

    const hls = new Hls({
      autoStartLoad: true,
      enableWorker: true,
      lowLatencyMode: false,
      maxBufferLength: 4,
      backBufferLength: 0,
      maxBufferSize: 8 * 1000 * 1000,
    });

    let finished = false;
    let manifestLoaded = false;
    let playable = false;
    let quality = '未知';
    let pingTime = 0;
    let speedKBps = 0;
    let startupTimeMs = 0;
    let fragmentStartTime = 0;
    let lastMessage = '';
    const startedAt = performance.now();
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let abortHandler: (() => void) | null = null;

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      if (abortHandler && options.signal) {
        options.signal.removeEventListener('abort', abortHandler);
      }
      try {
        hls.destroy();
      } catch {
        // ignore
      }
      video.removeAttribute('src');
      try {
        video.load();
      } catch {
        // ignore
      }
      video.remove();
    };

    const finish = (
      status?: VideoSourceTestStatus,
      message?: string,
      failureKind?: VideoSourceFailureKind,
    ) => {
      if (finished) return;
      finished = true;
      cleanup();

      const finalStatus =
        status ||
        (playable || speedKBps > 0
          ? 'ok'
          : manifestLoaded || pingTime > 0
            ? 'partial'
            : 'failed');

      resolve(
        buildResult({
          quality,
          pingTime: pingTime || performance.now() - startedAt,
          speedKBps: speedKBps || undefined,
          startupTimeMs: startupTimeMs || undefined,
          status: finalStatus,
          message: message || lastMessage,
          playable,
          resolvedUrl: m3u8Url,
          mediaType: 'hls',
          failureKind:
            failureKind ||
            (finalStatus === 'failed'
              ? 'unknown'
              : finalStatus === 'partial'
                ? 'fragment'
                : undefined),
        }),
      );
    };

    abortHandler = () => finish('failed', '测速已取消', 'unknown');
    if (options.signal?.aborted) {
      abortHandler();
      return;
    }
    options.signal?.addEventListener('abort', abortHandler, { once: true });

    timeout = setTimeout(() => {
      finish(
        undefined,
        manifestLoaded ? '测速超时，已确认源可连接' : '连接超时',
        'timeout',
      );
    }, timeoutMs);

    const maybeFinish = () => {
      if (speedKBps > 0) {
        finish('ok', '分片测速完成');
      }
    };

    video.onloadedmetadata = () => {
      playable = true;
      const nativeQuality = qualityFromWidth(video.videoWidth);
      if (nativeQuality !== '未知') quality = nativeQuality;
      maybeFinish();
    };
    video.oncanplay = () => {
      playable = true;
      maybeFinish();
    };
    video.onerror = () => {
      if (manifestLoaded || speedKBps > 0) {
        finish('partial', '媒体元素未返回元数据，但源已连通', 'media');
      } else {
        finish('failed', '浏览器未能加载媒体，未确认源可用', 'media');
      }
    };

    hls.on(Hls.Events.MANIFEST_LOADED, (_event: any, data: any) => {
      manifestLoaded = true;
      const manifestQuality = qualityFromLevels(data?.levels);
      if (manifestQuality !== '未知') quality = manifestQuality;

      const start = getStatsTime(data?.stats, 'start');
      const first = getStatsTime(data?.stats, 'first');
      const end = getStatsTime(data?.stats, 'end');
      const measuredLatency = first && start ? first - start : end - start;
      if (measuredLatency > 0) {
        pingTime = measuredLatency;
      } else if (!pingTime) {
        pingTime = performance.now() - startedAt;
      }
      lastMessage = '播放清单可访问';
    });

    hls.on(Hls.Events.MANIFEST_PARSED, (_event: any, data: any) => {
      const parsedQuality = qualityFromLevels(data?.levels);
      if (parsedQuality !== '未知') quality = parsedQuality;
    });

    hls.on(Hls.Events.FRAG_LOADING, () => {
      fragmentStartTime = performance.now();
    });

    hls.on(Hls.Events.FRAG_LOADED, (_event: any, data: any) => {
      const loadedBytes = getStatsLoadedBytes(data?.stats, data?.payload);
      const start = getStatsTime(data?.stats, 'start') || fragmentStartTime;
      const end = getStatsTime(data?.stats, 'end') || performance.now();
      const loadTime = end - start;

      if (loadedBytes > 0 && loadTime > 0) {
        speedKBps = loadedBytes / 1024 / (loadTime / 1000);
        startupTimeMs ||= performance.now() - startedAt;
        lastMessage = '媒体分片可访问';
      }

      const levelIndex = Number(data?.frag?.level);
      const levelQuality = Number.isFinite(levelIndex)
        ? qualityFromWidth(Number(hls.levels?.[levelIndex]?.width))
        : '未知';
      if (levelQuality !== '未知') quality = levelQuality;
      maybeFinish();
    });

    hls.on(Hls.Events.ERROR, (_event: any, data: any) => {
      if (!data?.fatal) return;
      const details = String(data?.details || '');
      const { message, failureKind } = (() => {
        if (/manifest/i.test(details)) {
          return {
            message: '播放清单不可访问或格式异常',
            failureKind: 'manifest' as const,
          };
        }
        if (/frag/i.test(details)) {
          return {
            message: '媒体分片加载失败，源不稳定',
            failureKind: 'fragment' as const,
          };
        }
        if (/buffer|media/i.test(details)) {
          return {
            message: '浏览器解码失败，源可能不兼容',
            failureKind: 'media' as const,
          };
        }
        return {
          message: data?.details || data?.type || 'HLS 加载失败',
          failureKind: 'unknown' as const,
        };
      })();
      if (manifestLoaded || speedKBps > 0) {
        finish('partial', message, failureKind);
      } else {
        finish('failed', message, failureKind);
      }
    });

    try {
      hls.attachMedia(video);
      hls.loadSource(m3u8Url);
      hls.startLoad(0);
    } catch (error) {
      finish(
        'failed',
        error instanceof Error ? error.message : 'HLS 初始化失败',
      );
    }
  });
}

export function cleanHtmlTags(text: string) {
  if (!text) return '';

  const cleanedText = text
    .replace(/<[^>]+>/g, '\n')
    .replace(/\n+/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/^\n+|\n+$/g, '')
    .trim();

  return he.decode(cleanedText);
}
