/* global describe, expect, it */

const {
  filterM3U8,
  shouldBypassFilteredPlaylist,
} = require('../src/lib/ad-filter');

describe('ad filter', () => {
  it('removes casino/gambling ad domains from variant playlists', () => {
    const playlist = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXTINF:6.0,',
      'https://vip.ffzyad.com/casino-roll.ts',
      '#EXTINF:10.0,',
      'https://video.example.com/main.ts',
      '#EXT-X-ENDLIST',
    ].join('\n');

    const result = filterM3U8(playlist);

    expect(result.changed).toBe(true);
    expect(result.adsRemoved).toBe(1);
    expect(result.filtered).not.toContain('vip.ffzyad.com');
    expect(result.filtered).toContain('video.example.com/main.ts');
  });

  it('keeps long-form content when discontinuity heuristics would remove most segments', () => {
    const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:6'];
    for (let group = 0; group < 20; group++) {
      lines.push('#EXT-X-DISCONTINUITY');
      for (let index = 0; index < 10; index++) {
        lines.push('#EXTINF:6.0,');
        lines.push(`https://video.example.com/g${group}/main-${index}.ts`);
      }
    }
    lines.push('#EXT-X-ENDLIST');

    const result = filterM3U8(lines.join('\n'));

    expect(result.changed).toBe(false);
    expect(result.adsRemoved).toBe(0);
    expect(result.filtered).toContain(
      'https://video.example.com/g19/main-9.ts',
    );
  });

  it('bypasses ad filtering when the filtered playlist becomes abnormally short', () => {
    const original = ['#EXTM3U', '#EXT-X-VERSION:3'];
    for (let index = 0; index < 120; index++) {
      original.push('#EXTINF:6.0,');
      original.push(`https://video.example.com/main-${index}.ts`);
    }
    original.push('#EXT-X-ENDLIST');

    const filtered = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXTINF:6.0,',
      'https://video.example.com/main-0.ts',
      '#EXT-X-ENDLIST',
    ].join('\n');

    expect(shouldBypassFilteredPlaylist(original.join('\n'), filtered)).toBe(
      true,
    );
  });
});
