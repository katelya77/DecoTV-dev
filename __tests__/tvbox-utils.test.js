/* global describe, expect, it */

const {
  decodeTvboxId,
  encodeTvboxId,
  formatTvboxPlayUrl,
  getLastNonEmptySearchParam,
} = require('../src/lib/tvbox-utils');

describe('tvbox utils', () => {
  it('uses the last non-empty search keyword when TVBox appends wd twice', () => {
    const params = new URLSearchParams('source=a&wd=&wd=%E6%B5%8B%E8%AF%95');

    expect(getLastNonEmptySearchParam(params, ['wd'])).toBe('测试');
  });

  it('round-trips encoded TVBox ids', () => {
    const payload = {
      kind: 'douban',
      id: '1292052',
      title: '肖申克的救赎',
      rate: '9.7',
    };

    expect(decodeTvboxId(encodeTvboxId(payload))).toEqual(payload);
  });

  it('formats episode URLs in MacCMS play-url syntax', () => {
    expect(
      formatTvboxPlayUrl(
        ['https://cdn.example.com/1.m3u8', 'https://cdn.example.com/2.m3u8'],
        ['第1集', '第2集'],
      ),
    ).toBe(
      '第1集$https://cdn.example.com/1.m3u8#第2集$https://cdn.example.com/2.m3u8',
    );
  });

  it('sanitizes TVBox episode titles that contain separators', () => {
    expect(
      formatTvboxPlayUrl(['https://cdn.example.com/1.m3u8'], ['A$B#C']),
    ).toBe('A B C$https://cdn.example.com/1.m3u8');
  });
});
