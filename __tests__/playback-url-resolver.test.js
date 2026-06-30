/* global beforeEach, describe, expect, it, jest */

jest.mock('../src/lib/proxy-security', () => ({
  fetchWithValidatedRedirects: jest.fn(),
  validateProxyTargetUrl: jest.fn(),
}));

const {
  fetchWithValidatedRedirects,
  validateProxyTargetUrl,
} = require('../src/lib/proxy-security');
const { TextDecoder, TextEncoder } = require('util');

global.TextDecoder = TextDecoder;
global.TextEncoder = TextEncoder;

const {
  extractPlaybackUrlFromHtml,
  resolveExternalPlaybackUrl,
} = require('../src/lib/playback-url-resolver');

function textResponse(body, url = '') {
  return {
    url,
    headers: {
      get(name) {
        return name.toLowerCase() === 'content-type'
          ? 'text/html; charset=utf-8'
          : '';
      },
    },
    body: {
      getReader() {
        let consumed = false;
        return {
          async read() {
            if (consumed) return { done: true };
            consumed = true;
            return { done: false, value: Buffer.from(body, 'utf8') };
          },
          async cancel() {},
        };
      },
    },
  };
}

describe('playback url resolver', () => {
  beforeEach(() => {
    fetchWithValidatedRedirects.mockReset();
    validateProxyTargetUrl.mockResolvedValue(undefined);
  });

  it('extracts relative HLS urls from share pages', () => {
    const html = `
      <script>
        const vid = "94c4dd41f9dddce696557d3717d98d82";
        const url = "/20250220/6857_94c4dd41/index.m3u8?sign=abc123";
      </script>
    `;

    expect(
      extractPlaybackUrlFromHtml(
        html,
        'https://vip.dytt-cinema.com/share/94c4dd41f9dddce696557d3717d98d82',
      ),
    ).toBe(
      'https://vip.dytt-cinema.com/20250220/6857_94c4dd41/index.m3u8?sign=abc123',
    );
  });

  it('extracts escaped HLS urls from player config objects', () => {
    const html =
      '<script>window.player = {"url":"https:\\/\\/cdn.example.com\\/movie\\/index.m3u8?token=1\\u0026v=2"}</script>';

    expect(
      extractPlaybackUrlFromHtml(html, 'https://player.example.com/watch/1'),
    ).toBe('https://cdn.example.com/movie/index.m3u8?token=1&v=2');
  });

  it('resolves HLS urls from a nested iframe player page', async () => {
    fetchWithValidatedRedirects
      .mockResolvedValueOnce(
        textResponse('<iframe src="/player/abc"></iframe>'),
      )
      .mockResolvedValueOnce(
        textResponse(
          '<script>window.player = {"url":"/media/index.m3u8?token=1"}</script>',
        ),
      );

    const result = await resolveExternalPlaybackUrl(
      'https://site.example/share/abc',
    );

    expect(result.mediaType).toBe('hls');
    expect(result.resolvedUrl).toBe(
      'https://site.example/media/index.m3u8?token=1',
    );
    expect(result.referer).toBe('https://site.example/player/abc');
  });

  it('returns a Chinese message when a playback page has no media url', async () => {
    fetchWithValidatedRedirects.mockResolvedValueOnce(
      textResponse('<html><body>empty player</body></html>'),
    );

    const result = await resolveExternalPlaybackUrl(
      'https://site.example/share/empty',
    );

    expect(result.mediaType).toBe('page');
    expect(result.error).toBe('播放页中未找到可播放媒体地址');
  });
});
