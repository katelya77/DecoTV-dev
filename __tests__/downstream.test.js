/* global afterEach, describe, expect, it, jest */

jest.mock('@/lib/config', () => ({
  API_CONFIG: {
    search: {
      path: '?ac=videolist&wd=',
      pagePath: '?ac=videolist&wd={query}&pg={page}',
      headers: {},
    },
    detail: {
      path: '?ac=videolist&ids=',
      headers: {},
    },
  },
  getConfig: jest.fn(async () => ({
    SiteConfig: {
      SearchDownstreamMaxPage: 1,
    },
  })),
}));

const { getDetailFromApi, searchFromApi } = require('../src/lib/downstream');

const apiSite = {
  key: 'test',
  name: 'Test Source',
  api: 'https://cms.example.com/api.php/provide/vod/',
};

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn(async () => body),
  };
}

describe('downstream MacCMS helpers', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('can keep TVBox search items that require a detail request for playback', async () => {
    global.fetch = jest.fn(async () =>
      jsonResponse({
        list: [
          {
            vod_id: '42',
            vod_name: 'Only Detail Has Play URL',
            vod_pic: '',
            vod_year: '2026',
          },
        ],
        pagecount: 1,
      }),
    );

    const results = await searchFromApi(apiSite, 'Only Detail', {
      includeUnplayable: true,
      skipCache: true,
    });

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('42');
    expect(results[0].episodes).toEqual([]);
  });

  it('tries ac=detail first and falls back to ac=videolist for detail playback', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          list: [
            {
              vod_id: '42',
              vod_name: 'Playable Detail',
              vod_pic: '',
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          list: [
            {
              vod_id: '42',
              vod_name: 'Playable Detail',
              vod_pic: '',
              vod_play_url:
                '第1集$https://cdn.example.com/video.mp4#第2集$https://cdn.example.com/video.m3u8',
            },
          ],
        }),
      );

    const detail = await getDetailFromApi(apiSite, '42');

    expect(global.fetch.mock.calls[0][0]).toContain('ac=detail&ids=42');
    expect(global.fetch.mock.calls[1][0]).toContain('ac=videolist&ids=42');
    expect(detail.episodes).toEqual([
      'https://cdn.example.com/video.mp4',
      'https://cdn.example.com/video.m3u8',
    ]);
  });
});
