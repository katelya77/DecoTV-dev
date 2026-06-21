/* global afterEach, describe, expect, it, jest */

const {
  buildPanSouAuthorizationHeader,
  normalizePanSouToken,
  resolvePanSouAuthorizationHeader,
  resolvePanSouLoginUrl,
} = require('../src/lib/pansou');

describe('PanSou auth helpers', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    if (originalFetch) {
      global.fetch = originalFetch;
    } else {
      delete global.fetch;
    }
    jest.restoreAllMocks();
  });

  it('normalizes pasted bearer tokens', () => {
    expect(normalizePanSouToken(' Bearer abc.def.ghi ')).toBe('abc.def.ghi');
    expect(buildPanSouAuthorizationHeader({ token: 'Bearer abc' })).toBe(
      'Bearer abc',
    );
  });

  it('resolves the login URL from common PanSou base URLs', () => {
    expect(resolvePanSouLoginUrl('https://pan.example.com')).toBe(
      'https://pan.example.com/api/auth/login',
    );
    expect(resolvePanSouLoginUrl('https://pan.example.com/api')).toBe(
      'https://pan.example.com/api/auth/login',
    );
    expect(resolvePanSouLoginUrl('https://pan.example.com/api/search')).toBe(
      'https://pan.example.com/api/auth/login',
    );
  });

  it('logs in with username and password before returning bearer auth', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () =>
        JSON.stringify({
          token: 'jwt-token',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        }),
    });
    global.fetch = fetchMock;

    const authorization = await resolvePanSouAuthorizationHeader({
      serverUrl: 'https://pan-login.example.com',
      username: 'admin',
      password: 'secret',
    });

    expect(authorization).toBe('Bearer jwt-token');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://pan-login.example.com/api/auth/login',
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      username: 'admin',
      password: 'secret',
    });
  });
});
