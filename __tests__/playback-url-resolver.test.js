/* global describe, expect, it */

const {
  extractPlaybackUrlFromHtml,
} = require('../src/lib/playback-url-resolver');

describe('playback url resolver', () => {
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
});
