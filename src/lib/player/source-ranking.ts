import type { VideoSourceTestResult } from '../utils';

const STARTUP_TIE_BREAKER_MS = 750;

function comparePositiveLowerFirst(
  a: number | undefined,
  b: number | undefined,
): number {
  const hasA = typeof a === 'number' && Number.isFinite(a) && a > 0;
  const hasB = typeof b === 'number' && Number.isFinite(b) && b > 0;
  if (hasA !== hasB) return hasA ? -1 : 1;
  return hasA && hasB ? (a as number) - (b as number) : 0;
}

export function hasMeasuredMediaThroughput(
  result: VideoSourceTestResult | undefined,
): boolean {
  return Boolean(
    result &&
    !result.hasError &&
    Number.isFinite(result.speedKBps) &&
    (result.speedKBps || 0) > 0,
  );
}

export function isVerifiedPlaybackResult(
  result: VideoSourceTestResult | undefined,
): boolean {
  return Boolean(
    result &&
    !result.hasError &&
    (hasMeasuredMediaThroughput(result) ||
      (result.status === 'ok' && result.playable)),
  );
}

export function isPlayableFallbackResult(
  result: VideoSourceTestResult | undefined,
): boolean {
  if (!result || result.hasError || result.mediaType === 'page') return false;
  if (isVerifiedPlaybackResult(result)) return true;
  if (result.status !== 'partial') return false;
  if (
    result.failureKind === 'resolver' ||
    result.failureKind === 'timeout' ||
    result.failureKind === 'manifest' ||
    result.failureKind === 'network'
  ) {
    return false;
  }

  return Boolean(
    result.playable ||
    result.failureKind === 'fragment' ||
    (result.pingTime || 0) > 0,
  );
}

export function getPlaybackEvidenceTier(
  result: VideoSourceTestResult | undefined,
): number {
  if (!result) return 4;
  if (result.hasError || result.status === 'failed') return 5;
  if (hasMeasuredMediaThroughput(result)) return 0;
  if (result.status === 'ok' && result.playable) return 1;
  if (result.status === 'partial' || result.pingTime > 0) return 2;
  return 3;
}

export function comparePlaybackMetrics(
  a: VideoSourceTestResult | undefined,
  b: VideoSourceTestResult | undefined,
): number {
  const tierDifference =
    getPlaybackEvidenceTier(a) - getPlaybackEvidenceTier(b);
  if (tierDifference !== 0) return tierDifference;
  if (!a || !b) return 0;

  const startupDifference = comparePositiveLowerFirst(
    a.startupTimeMs,
    b.startupTimeMs,
  );

  if (Math.abs(startupDifference) > STARTUP_TIE_BREAKER_MS) {
    return startupDifference;
  }

  const speedDifference = (b.speedKBps || 0) - (a.speedKBps || 0);
  if (speedDifference !== 0) return speedDifference;

  if (startupDifference !== 0) {
    return startupDifference;
  }

  return comparePositiveLowerFirst(a.pingTime, b.pingTime);
}
