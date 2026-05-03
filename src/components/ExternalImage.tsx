'use client';

import Image, { type ImageProps } from 'next/image';
import {
  SyntheticEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';

import {
  type DoubanImageProxyOverride,
  POSTER_FALLBACK_SRC,
  resolveImageUrl,
} from '@/lib/image-url';

type ExternalImageProps = Omit<ImageProps, 'src'> & {
  src: ImageProps['src'];
  fallbackSrc?: string;
  proxyWidth?: number;
};

function resolveSrc(
  src: ImageProps['src'],
  proxyWidth: number,
  doubanImageProxy?: DoubanImageProxyOverride,
): ImageProps['src'] {
  if (typeof src !== 'string') {
    return src;
  }
  return resolveImageUrl(src, { wsrvWidth: proxyWidth, doubanImageProxy });
}

let cachedClientDoubanImageProxy: DoubanImageProxyOverride | undefined;
let cachedClientDoubanImageProxyAt = 0;
const CLIENT_PROXY_CACHE_TTL_MS = 2000;

function readClientDoubanImageProxy(): DoubanImageProxyOverride | undefined {
  if (typeof window === 'undefined') return undefined;
  const now = Date.now();
  if (now - cachedClientDoubanImageProxyAt < CLIENT_PROXY_CACHE_TTL_MS) {
    return cachedClientDoubanImageProxy;
  }

  const runtime = window.RUNTIME_CONFIG ?? {};
  let storedType: string | null = null;
  let storedUrl: string | null = null;
  try {
    storedType = window.localStorage.getItem('doubanImageProxyType');
    storedUrl = window.localStorage.getItem('doubanImageProxyUrl');
  } catch {
    // localStorage 被禁用时静默回退
  }
  cachedClientDoubanImageProxy = {
    proxyType: storedType ?? runtime.DOUBAN_IMAGE_PROXY_TYPE ?? undefined,
    proxyUrl: storedUrl ?? runtime.DOUBAN_IMAGE_PROXY ?? undefined,
  };
  cachedClientDoubanImageProxyAt = now;

  return cachedClientDoubanImageProxy;
}

export default function ExternalImage(props: ExternalImageProps) {
  const {
    src,
    decoding = 'async',
    loading,
    onError: externalOnError,
    fallbackSrc = POSTER_FALLBACK_SRC,
    proxyWidth = 256,
    ...rest
  } = props;

  // SSR 与首屏渲染只走 process.env 默认值，确保两端 HTML 一致避免 hydration 警告。
  const ssrSafeSrc = useMemo(
    () => resolveSrc(src, proxyWidth),
    [src, proxyWidth],
  );
  const [currentSrc, setCurrentSrc] = useState<ImageProps['src']>(ssrSafeSrc);
  const [fallbackApplied, setFallbackApplied] = useState(false);

  // 客户端挂载后再叠加 RUNTIME_CONFIG / localStorage 中的用户/管理员选择。
  useEffect(() => {
    const override = readClientDoubanImageProxy();
    const nextSrc = resolveSrc(src, proxyWidth, override);
    setCurrentSrc((previousSrc) =>
      Object.is(previousSrc, nextSrc) ? previousSrc : nextSrc,
    );
    setFallbackApplied((wasFallbackApplied) =>
      wasFallbackApplied ? false : wasFallbackApplied,
    );
  }, [src, proxyWidth]);

  const handleError = useCallback(
    (e: SyntheticEvent<HTMLImageElement, Event>) => {
      if (!fallbackApplied) {
        setCurrentSrc(fallbackSrc);
        setFallbackApplied(true);
      }
      if (typeof externalOnError === 'function') {
        externalOnError(e);
      }
    },
    [externalOnError, fallbackApplied, fallbackSrc],
  );

  return (
    <Image
      {...rest}
      src={currentSrc}
      decoding={decoding}
      loading={loading ?? 'lazy'}
      referrerPolicy={rest.referrerPolicy ?? 'no-referrer'}
      unoptimized
      onError={handleError}
    />
  );
}
