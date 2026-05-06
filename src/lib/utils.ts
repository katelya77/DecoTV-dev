/* eslint-disable @typescript-eslint/no-explicit-any */
import he from 'he';
import Hls from 'hls.js';

import { resolveImageUrl } from './image-url';

export function processImageUrl(originalUrl: string): string {
  return resolveImageUrl(originalUrl, { wsrvWidth: 256 });
}

export type VideoSourceTestStatus = 'ok' | 'partial' | 'failed';

export interface VideoSourceTestResult {
  quality: string;
  loadSpeed: string;
  pingTime: number;
  speedKBps?: number;
  hasError?: boolean;
  status?: VideoSourceTestStatus;
  message?: string;
  playable?: boolean;
  testedAt?: number;
}

const DEFAULT_SOURCE_TEST_TIMEOUT_MS = 10000;

function isLikelyHlsUrl(url: string): boolean {
  return /\.m3u8(?:$|[?#])/i.test(url) || /\/m3u8(?:$|[/?#])/i.test(url);
}

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
  if (speedKBps >= 1024) {
    return `${(speedKBps / 1024).toFixed(1)} MB/s`;
  }
  return `${speedKBps.toFixed(1)} KB/s`;
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

async function measureFetchLatency(url: string): Promise<number> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  const startedAt = performance.now();

  try {
    const response = await fetch(url, {
      cache: 'no-store',
      signal: controller.signal,
    });
    const reader = response.body?.getReader();
    if (reader) {
      await reader.read().catch(() => undefined);
      await reader.cancel().catch(() => undefined);
    }
    return performance.now() - startedAt;
  } catch {
    return 0;
  } finally {
    clearTimeout(timer);
  }
}

function buildResult(input: {
  quality: string;
  pingTime: number;
  speedKBps?: number;
  status: VideoSourceTestStatus;
  message?: string;
  playable?: boolean;
}): VideoSourceTestResult {
  return {
    quality: input.quality || '未知',
    loadSpeed: formatVideoLoadSpeed(input.speedKBps),
    pingTime: Math.max(0, Math.round(input.pingTime || 0)),
    speedKBps: input.speedKBps,
    hasError: input.status === 'failed',
    status: input.status,
    message: input.message,
    playable: input.playable,
    testedAt: Date.now(),
  };
}

async function measureNativeVideoSource(
  url: string,
  timeoutMs: number,
): Promise<VideoSourceTestResult> {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'metadata';
    video.crossOrigin = 'anonymous';

    let finished = false;
    let pingTime = 0;
    const startedAt = performance.now();
    let timeout: ReturnType<typeof setTimeout> | null = null;

    const finish = (status: VideoSourceTestStatus, message?: string) => {
      if (finished) return;
      finished = true;
      if (timeout) clearTimeout(timeout);
      video.removeAttribute('src');
      video.load();
      video.remove();

      resolve(
        buildResult({
          quality: qualityFromWidth(video.videoWidth),
          pingTime: pingTime || performance.now() - startedAt,
          status,
          message,
          playable: status !== 'failed',
        }),
      );
    };

    timeout = setTimeout(() => {
      finish('failed', '连接超时');
    }, timeoutMs);

    void measureFetchLatency(url).then((latency) => {
      if (latency > 0) pingTime = latency;
    });

    video.onloadedmetadata = () => finish('ok', '媒体元数据可用');
    video.oncanplay = () => finish('ok', '可播放');
    video.onerror = () => finish('failed', '媒体加载失败');
    video.src = url;
  });
}

export async function getVideoResolutionFromM3u8(
  m3u8Url: string,
  options: { timeoutMs?: number } = {},
): Promise<VideoSourceTestResult> {
  if (!m3u8Url) {
    return buildResult({
      quality: '未知',
      pingTime: 0,
      status: 'failed',
      message: '播放地址为空',
    });
  }

  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return buildResult({
      quality: '未知',
      pingTime: 0,
      status: 'failed',
      message: '当前环境无法测速',
    });
  }

  const timeoutMs = options.timeoutMs || DEFAULT_SOURCE_TEST_TIMEOUT_MS;

  if (!isLikelyHlsUrl(m3u8Url) || !Hls.isSupported()) {
    return measureNativeVideoSource(m3u8Url, timeoutMs);
  }

  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'metadata';
    video.crossOrigin = 'anonymous';

    const hls = new Hls({
      autoStartLoad: true,
      enableWorker: true,
      lowLatencyMode: false,
      maxBufferLength: 8,
      backBufferLength: 0,
      maxBufferSize: 24 * 1000 * 1000,
    });

    let finished = false;
    let manifestLoaded = false;
    let playable = false;
    let quality = '未知';
    let pingTime = 0;
    let speedKBps = 0;
    let fragmentStartTime = 0;
    let lastMessage = '';
    const startedAt = performance.now();
    let timeout: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
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

    const finish = (status?: VideoSourceTestStatus, message?: string) => {
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
          status: finalStatus,
          message: message || lastMessage,
          playable,
        }),
      );
    };

    timeout = setTimeout(() => {
      finish(
        undefined,
        manifestLoaded ? '测速超时，已确认源可连接' : '连接超时',
      );
    }, timeoutMs);

    const maybeFinish = () => {
      if (speedKBps > 0 && (playable || quality !== '未知')) {
        finish('ok', '分片测速完成');
      }
    };

    void measureFetchLatency(m3u8Url).then((latency) => {
      if (latency > 0 && (!pingTime || latency < pingTime)) {
        pingTime = latency;
      }
    });

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
        finish('partial', '媒体元素未返回元数据，但源已连通');
      } else {
        finish('failed', '媒体加载失败');
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
      const message = data?.details || data?.type || 'HLS 加载失败';
      if (manifestLoaded || speedKBps > 0) {
        finish('partial', message);
      } else {
        finish('failed', message);
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
