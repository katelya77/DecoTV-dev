/* global describe, expect, it, jest */

jest.mock('@/lib/config', () => ({
  getConfig: jest.fn(),
}));

jest.mock('@/lib/db', () => ({
  db: {},
}));

jest.mock('@/lib/private-library-config', () => ({
  normalizePrivateLibraryConfig: jest.fn(),
}));

jest.mock('@/lib/server-cache', () => ({
  getServerCache: jest.fn(() => null),
  setServerCache: jest.fn(),
}));

jest.mock('@/lib/tmdb', () => ({
  isTmdbEnabled: jest.fn(async () => false),
  tmdbGetMovieDetail: jest.fn(),
  tmdbGetTvDetail: jest.fn(),
  tmdbSearch: jest.fn(),
  toTmdbPosterUrl: jest.fn(() => ''),
}));

const { aggregatePrivateLibraryItems } = require('../src/lib/private-library');

function item(overrides) {
  return {
    id: `openlist:${overrides.sourceItemId}`,
    connectorId: 'openlist',
    connectorType: 'openlist',
    sourceItemId: overrides.sourceItemId,
    title: '快乐综艺',
    searchTitle: '快乐综艺',
    mediaType: 'tv',
    streamPath: overrides.streamPath,
    scannedAt: 1,
    sortKey: overrides.sortKey,
    ...overrides,
  };
}

describe('private library aggregation', () => {
  it('groups OpenList episode files into one series item', () => {
    const result = aggregatePrivateLibraryItems([
      item({
        sourceItemId: '/shows/快乐综艺/第2期.strm',
        streamPath: '/shows/快乐综艺/第2期.strm',
        episode: 2,
        sortKey: 2,
        embeddedStreamUrl: 'https://cdn.example.com/2.m3u8',
      }),
      item({
        sourceItemId: '/shows/快乐综艺/第1期.strm',
        streamPath: '/shows/快乐综艺/第1期.strm',
        episode: 1,
        sortKey: 1,
        embeddedStreamUrl: 'https://cdn.example.com/1.m3u8',
      }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('快乐综艺');
    expect(result[0].episodeCount).toBe(2);
    expect(result[0].episodeItems.map((entry) => entry.sourceItemId)).toEqual([
      '/shows/快乐综艺/第1期.strm',
      '/shows/快乐综艺/第2期.strm',
    ]);
    expect(
      result[0].episodeItems.map((entry) => entry.embeddedStreamUrl),
    ).toEqual([
      'https://cdn.example.com/1.m3u8',
      'https://cdn.example.com/2.m3u8',
    ]);
  });

  it('does not group movie items', () => {
    const result = aggregatePrivateLibraryItems([
      item({
        sourceItemId: '/movies/Movie.mp4',
        title: 'Movie',
        searchTitle: 'Movie',
        mediaType: 'movie',
        streamPath: '/movies/Movie.mp4',
        sortKey: 1,
      }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].episodeItems).toBeUndefined();
  });
});
