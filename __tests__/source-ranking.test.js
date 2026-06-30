/* global describe, expect, it */

const {
  comparePlaybackMetrics,
  getPlaybackEvidenceTier,
  isPlayableFallbackResult,
  isVerifiedPlaybackResult,
} = require('../src/lib/player/source-ranking');

describe('playback source ranking', () => {
  const verified = {
    status: 'ok',
    hasError: false,
    pingTime: 900,
    startupTimeMs: 1700,
    speedKBps: 1100,
    playable: false,
  };

  it('prioritizes a retrieved media segment over a fast playlist-only response', () => {
    const playlistOnly = {
      status: 'partial',
      hasError: false,
      pingTime: 120,
    };

    expect(comparePlaybackMetrics(verified, playlistOnly)).toBeLessThan(0);
    expect(isVerifiedPlaybackResult(playlistOnly)).toBe(false);
  });

  it('prioritizes materially faster first-segment startup', () => {
    const delayed = {
      ...verified,
      startupTimeMs: 4300,
      speedKBps: 2400,
    };

    expect(comparePlaybackMetrics(verified, delayed)).toBeLessThan(0);
  });

  it('uses throughput when first-segment startup times are close', () => {
    const fasterTransfer = {
      ...verified,
      startupTimeMs: 1850,
      speedKBps: 2600,
    };

    expect(comparePlaybackMetrics(fasterTransfer, verified)).toBeLessThan(0);
    expect(getPlaybackEvidenceTier(fasterTransfer)).toBe(0);
  });

  it('allows playlist-level partial results as fallback candidates', () => {
    expect(
      isPlayableFallbackResult({
        status: 'partial',
        hasError: false,
        pingTime: 220,
        mediaType: 'hls',
        failureKind: 'fragment',
        playable: true,
      }),
    ).toBe(true);
  });

  it('does not use unresolved share pages as fallback candidates', () => {
    expect(
      isPlayableFallbackResult({
        status: 'partial',
        hasError: false,
        mediaType: 'page',
        failureKind: 'resolver',
      }),
    ).toBe(false);
  });

  it('does not use recoverable manifest failures as fallback candidates', () => {
    expect(
      isPlayableFallbackResult({
        status: 'partial',
        hasError: false,
        pingTime: 600,
        mediaType: 'hls',
        failureKind: 'manifest',
        playable: false,
      }),
    ).toBe(false);
  });
});
