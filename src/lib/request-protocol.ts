export type EffectiveRequestProtocol = 'http' | 'https';

type RequestWithUrl = {
  headers: Headers;
  nextUrl?: URL;
  url?: string;
};

function firstHeaderValue(value: string | null): string | null {
  const first = value?.split(',')[0]?.trim();
  return first || null;
}

function normalizeProtocol(
  value: string | null,
): EffectiveRequestProtocol | null {
  const normalized = value?.replace(/^"|"$/g, '').trim().toLowerCase();
  return normalized === 'http' || normalized === 'https' ? normalized : null;
}

function getForwardedProto(
  header: string | null,
): EffectiveRequestProtocol | null {
  const firstForwarded = firstHeaderValue(header);
  if (!firstForwarded) return null;

  for (const part of firstForwarded.split(';')) {
    const [rawName, ...rawValueParts] = part.split('=');
    if (rawName?.trim().toLowerCase() !== 'proto') continue;

    return normalizeProtocol(rawValueParts.join('='));
  }

  return null;
}

function normalizeHost(value: string | null): string | null {
  const normalized = value?.replace(/^"|"$/g, '').trim();
  if (!normalized || /[\r\n]/.test(normalized)) return null;
  return normalized;
}

function normalizePort(
  value: string | null,
  protocol: EffectiveRequestProtocol,
): string | null {
  const normalized = firstHeaderValue(value)?.replace(/^"|"$/g, '').trim();
  if (!normalized || !/^\d{1,5}$/.test(normalized)) return null;

  const port = Number(normalized);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (
    (protocol === 'https' && port === 443) ||
    (protocol === 'http' && port === 80)
  ) {
    return null;
  }

  return String(port);
}

function hasExplicitPort(host: string): boolean {
  if (host.startsWith('[')) {
    return /\]:\d+$/.test(host);
  }

  const firstColon = host.indexOf(':');
  if (firstColon === -1) return false;
  if (firstColon !== host.lastIndexOf(':')) return false;
  return /^\d+$/.test(host.slice(firstColon + 1));
}

function getHostname(host: string): string {
  try {
    return new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return host.replace(/:\d+$/, '').toLowerCase();
  }
}

function getPortFromHost(host: string): string | null {
  try {
    const parsed = new URL(`http://${host}`);
    return parsed.port || null;
  } catch {
    if (!hasExplicitPort(host)) return null;
    return host.slice(host.lastIndexOf(':') + 1);
  }
}

function appendPortIfNeeded(host: string, port: string | null): string {
  if (!port || hasExplicitPort(host)) return host;
  return `${host}:${port}`;
}

function normalizeForwardedHost(
  host: string | null,
  requestHost: string | null,
  forwardedPort: string | null,
): string | null {
  if (!host) return null;

  const withForwardedPort = appendPortIfNeeded(host, forwardedPort);
  if (withForwardedPort !== host) return withForwardedPort;

  if (
    requestHost &&
    !hasExplicitPort(host) &&
    hasExplicitPort(requestHost) &&
    getHostname(host) === getHostname(requestHost)
  ) {
    return appendPortIfNeeded(host, getPortFromHost(requestHost));
  }

  return host;
}

function getForwardedHost(header: string | null): string | null {
  const firstForwarded = firstHeaderValue(header);
  if (!firstForwarded) return null;

  for (const part of firstForwarded.split(';')) {
    const [rawName, ...rawValueParts] = part.split('=');
    if (rawName?.trim().toLowerCase() !== 'host') continue;

    return normalizeHost(rawValueParts.join('='));
  }

  return null;
}

function getRequestUrl(request: RequestWithUrl): URL | null {
  if (request.nextUrl) return request.nextUrl;

  if (typeof request.url === 'string') {
    try {
      return new URL(request.url);
    } catch {
      return null;
    }
  }

  return null;
}

export function getEffectiveRequestProtocol(
  request: RequestWithUrl,
): EffectiveRequestProtocol {
  const forwardedProto = normalizeProtocol(
    firstHeaderValue(request.headers.get('x-forwarded-proto')),
  );
  if (forwardedProto) return forwardedProto;

  const standardForwardedProto = getForwardedProto(
    request.headers.get('forwarded'),
  );
  if (standardForwardedProto) return standardForwardedProto;

  const requestUrl = getRequestUrl(request);
  return requestUrl?.protocol.toLowerCase() === 'https:' ? 'https' : 'http';
}

export function isSecureRequest(request: RequestWithUrl): boolean {
  return getEffectiveRequestProtocol(request) === 'https';
}

export function getEffectiveRequestHost(request: RequestWithUrl): string {
  const protocol = getEffectiveRequestProtocol(request);
  const requestHost =
    normalizeHost(request.headers.get('host')) ||
    getRequestUrl(request)?.host ||
    '';
  const forwardedPort = normalizePort(
    request.headers.get('x-forwarded-port'),
    protocol,
  );
  const forwardedHost = normalizeForwardedHost(
    normalizeHost(firstHeaderValue(request.headers.get('x-forwarded-host'))),
    requestHost,
    forwardedPort,
  );
  const standardForwardedHost = normalizeForwardedHost(
    getForwardedHost(request.headers.get('forwarded')),
    requestHost,
    forwardedPort,
  );

  return forwardedHost || standardForwardedHost || requestHost || '';
}

export function getEffectiveRequestOrigin(request: RequestWithUrl): string {
  return `${getEffectiveRequestProtocol(request)}://${getEffectiveRequestHost(
    request,
  )}`;
}
