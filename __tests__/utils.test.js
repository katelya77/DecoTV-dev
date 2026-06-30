/* global describe, expect, it */

const { formatVideoLoadSpeed } = require('../src/lib/utils');

describe('video source utils', () => {
  it('formats measured playback throughput in MB/s', () => {
    expect(formatVideoLoadSpeed(1536)).toBe('1.50 MB/s');
    expect(formatVideoLoadSpeed(256)).toBe('0.25 MB/s');
  });
});
