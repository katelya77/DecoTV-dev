/* global describe, expect, it */

const { inspectHlsPlaylist } = require('../src/lib/playback-probe');

describe('playback probe playlist inspection', () => {
  it('extracts variant playlist and quality from a master playlist', () => {
    const playlist = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1280x720',
      '720p/index.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080',
      '1080p/index.m3u8',
    ].join('\n');

    const result = inspectHlsPlaylist(
      playlist,
      'https://cdn.example.com/movie/master.m3u8',
    );

    expect(result.isHls).toBe(true);
    expect(result.isMaster).toBe(true);
    expect(result.quality).toBe('1080p');
    expect(result.firstVariantUrl).toBe(
      'https://cdn.example.com/movie/720p/index.m3u8',
    );
  });

  it('extracts the first media segment from a variant playlist', () => {
    const playlist = [
      '#EXTM3U',
      '#EXT-X-TARGETDURATION:6',
      '#EXTINF:6,',
      '../segments/0001.ts',
      '#EXTINF:6,',
      '../segments/0002.ts',
    ].join('\n');

    const result = inspectHlsPlaylist(
      playlist,
      'https://cdn.example.com/movie/720p/index.m3u8',
    );

    expect(result.isHls).toBe(true);
    expect(result.isMaster).toBe(false);
    expect(result.firstSegmentUrl).toBe(
      'https://cdn.example.com/movie/segments/0001.ts',
    );
  });
});
