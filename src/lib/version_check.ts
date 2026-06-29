/* eslint-disable no-console */

'use client';

import {
  BuildMetadata,
  compareBuildMetadata,
  compareSemanticVersions,
  isoToDisplay,
  normalizeCommitSha,
  normalizeVersion,
  shortCommit,
  timestampFromIso,
  timestampToDisplay,
} from '@/lib/version-metadata';

/**
 * 版本检测模块 - 混合策略实现
 *
 * 策略优先级：
 * 1. 首先尝试调用 /api/version/check API（最可靠，同源无 CORS 问题）
 * 2. 如果 API 失败，回退到客户端直接获取
 *
 * 时间戳格式: YYYYMMDDHHMMSS (14位数字)
 *
 * 性能优化：
 * - 使用单例模式，App 生命周期内只执行一次版本检测
 * - 结果缓存到 sessionStorage，避免重复请求
 */

// 版本检查结果枚举
export enum UpdateStatus {
  CHECKING = 'checking', // 正在检测
  HAS_UPDATE = 'has_update', // 有新版本
  NO_UPDATE = 'no_update', // 已是最新版本
  FETCH_FAILED = 'fetch_failed', // 获取失败
}

// 远程版本源配置
const UPDATE_REPO = process.env.NEXT_PUBLIC_UPDATE_REPO || 'Decohererk/DecoTV';
const UPDATE_REF = process.env.NEXT_PUBLIC_UPDATE_REF || 'main';

// 多个镜像源，确保至少一个能访问
const REMOTE_VERSION_URLS = [
  // jsDelivr CDN (国际+国内加速，最稳定)
  `https://cdn.jsdelivr.net/gh/${UPDATE_REPO}@${UPDATE_REF}/VERSION.txt`,
  // Fastly jsDelivr
  `https://fastly.jsdelivr.net/gh/${UPDATE_REPO}@${UPDATE_REF}/VERSION.txt`,
  // GitHub Raw (国际)
  `https://raw.githubusercontent.com/${UPDATE_REPO}/${UPDATE_REF}/VERSION.txt`,
  // ghproxy 国内代理
  `https://ghproxy.net/https://raw.githubusercontent.com/${UPDATE_REPO}/${UPDATE_REF}/VERSION.txt`,
  // mirror.ghproxy
  `https://mirror.ghproxy.com/https://raw.githubusercontent.com/${UPDATE_REPO}/${UPDATE_REF}/VERSION.txt`,
];

const REMOTE_VERSION_METADATA_URLS = [
  `https://raw.githubusercontent.com/${UPDATE_REPO}/${UPDATE_REF}/public/version.json`,
  `https://cdn.jsdelivr.net/gh/${UPDATE_REPO}@${UPDATE_REF}/public/version.json`,
  `https://fastly.jsdelivr.net/gh/${UPDATE_REPO}@${UPDATE_REF}/public/version.json`,
];

const REMOTE_PACKAGE_URLS = [
  `https://raw.githubusercontent.com/${UPDATE_REPO}/${UPDATE_REF}/package.json`,
  `https://cdn.jsdelivr.net/gh/${UPDATE_REPO}@${UPDATE_REF}/package.json`,
  `https://fastly.jsdelivr.net/gh/${UPDATE_REPO}@${UPDATE_REF}/package.json`,
];

const REMOTE_COMMIT_URL = `https://api.github.com/repos/${UPDATE_REPO}/commits/${encodeURIComponent(
  UPDATE_REF,
)}`;

const API_TIMEOUT = 5000; // API 超时 5 秒
const FETCH_TIMEOUT = 6000; // 远程获取超时 6 秒

// ============ 单例缓存机制 ============
const CACHE_KEY = 'decotv_version_check_result';
const CACHE_TTL = 5 * 60 * 1000; // 缓存 5 分钟

// 内存缓存：避免同一页面多次调用
let memoryCache: { result: VersionCheckResult; timestamp: number } | null =
  null;

// 正在进行的请求 Promise，防止并发重复请求
let pendingRequest: Promise<VersionCheckResult> | null = null;

export interface VersionCheckResult {
  status: UpdateStatus;
  localVersion?: string;
  remoteVersion?: string;
  localTimestamp?: string;
  remoteTimestamp?: string;
  localCommit?: string;
  remoteCommit?: string;
  localCommitDate?: string;
  remoteCommitDate?: string;
  updateReason?: 'semantic-version' | 'commit' | 'timestamp' | 'none';
  formattedLocalTime?: string;
  formattedRemoteTime?: string;
  error?: string;
}

interface CheckOptions {
  force?: boolean;
}

/**
 * 从 sessionStorage 获取缓存结果
 */
function getCachedResult(): VersionCheckResult | null {
  if (typeof window === 'undefined') return null;

  // 优先检查内存缓存
  if (memoryCache && Date.now() - memoryCache.timestamp < CACHE_TTL) {
    return memoryCache.result;
  }

  try {
    const cached = sessionStorage.getItem(CACHE_KEY);
    if (!cached) return null;

    const { result, timestamp } = JSON.parse(cached);
    if (Date.now() - timestamp < CACHE_TTL) {
      // 同步到内存缓存
      memoryCache = { result, timestamp };
      return result;
    }
    // 缓存过期，清除
    sessionStorage.removeItem(CACHE_KEY);
  } catch {
    // 忽略解析错误
  }
  return null;
}

/**
 * 缓存检测结果到 sessionStorage
 */
function setCachedResult(result: VersionCheckResult): void {
  if (typeof window === 'undefined') return;

  const timestamp = Date.now();
  memoryCache = { result, timestamp };

  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ result, timestamp }));
  } catch {
    // 忽略存储错误
  }
}

/**
 * 格式化时间戳为可读日期
 */
export function formatTimestamp(timestamp: string): string {
  return timestampToDisplay(timestamp);
}

/**
 * 验证时间戳格式是否正确 (14位数字)
 */
function isValidTimestamp(timestamp: string): boolean {
  return /^\d{14}$/.test(timestamp);
}

function pickNewestTimestamp(
  ...values: Array<string | null | undefined>
): string {
  return values.reduce<string>((newest, value) => {
    if (!value || !isValidTimestamp(value)) return newest;
    if (!newest || BigInt(value) > BigInt(newest)) return value;
    return newest;
  }, '');
}

/**
 * 带超时的 fetch
 */
async function fetchWithTimeout(
  url: string,
  timeout: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      cache: 'no-store',
      headers: {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        Pragma: 'no-cache',
      },
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * 策略1: 通过 API 获取版本信息（推荐，同源无 CORS 问题）
 */
async function checkViaApi(): Promise<VersionCheckResult | null> {
  try {
    const response = await fetchWithTimeout(
      `/api/version/check?_t=${Date.now()}`,
      API_TIMEOUT,
    );

    if (!response.ok) {
      console.warn('API 版本检测返回非 200:', response.status);
      return null;
    }

    const data = await response.json();

    if (!data.success || !data.localTimestamp) {
      console.warn('API 返回数据无效:', data);
      return null;
    }

    // API 返回了完整的检测结果
    return {
      status: data.hasUpdate ? UpdateStatus.HAS_UPDATE : UpdateStatus.NO_UPDATE,
      localVersion: data.current?.version || data.version,
      remoteVersion: data.remote?.version,
      localTimestamp: data.localTimestamp,
      remoteTimestamp: data.remoteTimestamp,
      localCommit: data.current?.shortCommit || data.localCommit,
      remoteCommit: data.remote?.shortCommit || data.remoteCommit,
      localCommitDate: data.current?.commitDate,
      remoteCommitDate: data.remote?.commitDate,
      updateReason: data.updateReason || 'none',
      formattedLocalTime: formatTimestamp(data.localTimestamp),
      formattedRemoteTime: data.remote?.commitDate
        ? isoToDisplay(data.remote.commitDate)
        : data.remoteTimestamp
          ? formatTimestamp(data.remoteTimestamp)
          : undefined,
    };
  } catch (error) {
    console.warn('API 版本检测失败:', error);
    return null;
  }
}

async function fetchJsonWithFallback<T>(
  urls: string[],
  timeout = FETCH_TIMEOUT,
): Promise<T | null> {
  const fetchPromises = urls.map(async (url) => {
    try {
      const cacheBuster = `_t=${Date.now()}`;
      const urlWithCache = url.includes('?')
        ? `${url}&${cacheBuster}`
        : `${url}?${cacheBuster}`;

      const response = await fetchWithTimeout(urlWithCache, timeout);
      if (!response.ok) return null;

      return (await response.json()) as T;
    } catch {
      return null;
    }
  });

  const results = await Promise.allSettled(fetchPromises);

  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) {
      return result.value;
    }
  }

  return null;
}

/**
 * 获取远程版本时间戳 - 尝试多个镜像源
 */
async function fetchRemoteTimestamp(): Promise<string | null> {
  // 并行请求所有源，使用 Promise.race 获取最快的有效结果
  const fetchPromises = REMOTE_VERSION_URLS.map(async (url) => {
    try {
      const cacheBuster = `_t=${Date.now()}`;
      const urlWithCache = url.includes('?')
        ? `${url}&${cacheBuster}`
        : `${url}?${cacheBuster}`;

      const response = await fetchWithTimeout(urlWithCache, FETCH_TIMEOUT);
      if (!response.ok) return null;

      const text = (await response.text()).trim();
      if (isValidTimestamp(text)) {
        return text;
      }
      return null;
    } catch {
      return null;
    }
  });

  // 等待所有请求完成，返回第一个有效结果
  const results = await Promise.allSettled(fetchPromises);

  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) {
      return result.value;
    }
  }

  return null;
}

async function fetchRemotePackageVersion(): Promise<string | null> {
  const packageJson = await fetchJsonWithFallback<{ version?: string }>(
    REMOTE_PACKAGE_URLS,
  );

  return packageJson?.version ? normalizeVersion(packageJson.version) : null;
}

async function fetchRemoteCommit(): Promise<Partial<BuildMetadata> | null> {
  try {
    const response = await fetchWithTimeout(REMOTE_COMMIT_URL, FETCH_TIMEOUT);
    if (!response.ok) return null;

    const data = await response.json();
    const commitSha = normalizeCommitSha(data.sha);
    const commitDate =
      data.commit?.committer?.date || data.commit?.author?.date || '';

    return {
      commitSha,
      shortCommit: shortCommit(commitSha),
      commitDate,
      timestamp: timestampFromIso(commitDate),
    };
  } catch {
    return null;
  }
}

/**
 * 获取本地版本时间戳
 */
async function fetchLocalTimestamp(): Promise<string | null> {
  // 尝试多个路径
  const paths = ['/VERSION.txt', './VERSION.txt'];

  for (const path of paths) {
    try {
      const response = await fetchWithTimeout(`${path}?_t=${Date.now()}`, 3000);
      if (response.ok) {
        const text = (await response.text()).trim();
        if (isValidTimestamp(text)) {
          return text;
        }
      }
    } catch {
      continue;
    }
  }

  return null;
}

async function fetchLocalMetadata(): Promise<BuildMetadata | null> {
  const metadata = await fetchJsonWithFallback<Partial<BuildMetadata>>(
    ['/version.json', './version.json'],
    3000,
  );
  const timestamp = pickNewestTimestamp(
    metadata?.timestamp,
    await fetchLocalTimestamp(),
  );

  if (!timestamp) return null;

  const commitSha = normalizeCommitSha(metadata?.commitSha);
  return {
    version: normalizeVersion(metadata?.version) || '',
    timestamp,
    buildTime: metadata?.buildTime,
    commitSha,
    shortCommit: shortCommit(commitSha),
    commitDate: metadata?.commitDate,
    ref: metadata?.ref,
    repo: metadata?.repo,
    source: metadata?.source,
  };
}

async function fetchRemoteMetadata(): Promise<BuildMetadata | null> {
  const [metadata, version, timestamp, commit] = await Promise.all([
    fetchJsonWithFallback<Partial<BuildMetadata>>(REMOTE_VERSION_METADATA_URLS),
    fetchRemotePackageVersion(),
    fetchRemoteTimestamp(),
    fetchRemoteCommit(),
  ]);

  const commitSha = normalizeCommitSha(
    commit?.commitSha || metadata?.commitSha,
  );
  const remoteTimestamp =
    commit?.timestamp || metadata?.timestamp || timestamp || '';

  if (!version && !remoteTimestamp && !commitSha) {
    return null;
  }

  return {
    version: version || normalizeVersion(metadata?.version) || '',
    timestamp: remoteTimestamp,
    buildTime: metadata?.buildTime,
    commitSha,
    shortCommit: shortCommit(commitSha),
    commitDate: commit?.commitDate || metadata?.commitDate,
    ref: UPDATE_REF,
    repo: UPDATE_REPO,
    source: commit?.commitSha ? 'github-commit' : 'remote-file',
  };
}

/**
 * 策略2: 客户端直接获取并比较（回退方案）
 */
async function checkViaClientDirect(): Promise<VersionCheckResult> {
  try {
    // 并行获取本地和远程构建元数据
    const [localMetadata, remoteMetadata] = await Promise.all([
      fetchLocalMetadata(),
      fetchRemoteMetadata(),
    ]);

    // 检查本地版本
    if (!localMetadata) {
      console.error('无法获取本地版本信息');
      return {
        status: UpdateStatus.FETCH_FAILED,
        error: '无法读取本地版本信息',
      };
    }

    // 检查远程版本
    if (!remoteMetadata) {
      console.error('无法获取远程版本信息');
      return {
        status: UpdateStatus.FETCH_FAILED,
        localVersion: localMetadata.version,
        localTimestamp: localMetadata.timestamp,
        localCommit: localMetadata.shortCommit,
        localCommitDate: localMetadata.commitDate,
        formattedLocalTime: formatTimestamp(localMetadata.timestamp),
        error: '无法连接到更新服务器',
      };
    }

    const comparison = compareBuildMetadata(localMetadata, remoteMetadata);
    const remoteVersion =
      remoteMetadata.commitSha &&
      compareSemanticVersions(localMetadata.version, remoteMetadata.version) > 0
        ? localMetadata.version
        : remoteMetadata.version;

    if (comparison.hasUpdate) {
      return {
        status: UpdateStatus.HAS_UPDATE,
        localVersion: localMetadata.version,
        remoteVersion,
        localTimestamp: localMetadata.timestamp,
        remoteTimestamp: remoteMetadata.timestamp,
        localCommit: localMetadata.shortCommit,
        remoteCommit: remoteMetadata.shortCommit,
        localCommitDate: localMetadata.commitDate,
        remoteCommitDate: remoteMetadata.commitDate,
        updateReason: comparison.reason,
        formattedLocalTime: formatTimestamp(localMetadata.timestamp),
        formattedRemoteTime: remoteMetadata.commitDate
          ? isoToDisplay(remoteMetadata.commitDate)
          : formatTimestamp(remoteMetadata.timestamp),
      };
    } else {
      return {
        status: UpdateStatus.NO_UPDATE,
        localVersion: localMetadata.version,
        remoteVersion,
        localTimestamp: localMetadata.timestamp,
        remoteTimestamp: remoteMetadata.timestamp,
        localCommit: localMetadata.shortCommit,
        remoteCommit: remoteMetadata.shortCommit,
        localCommitDate: localMetadata.commitDate,
        remoteCommitDate: remoteMetadata.commitDate,
        updateReason: 'none',
        formattedLocalTime: formatTimestamp(localMetadata.timestamp),
        formattedRemoteTime: remoteMetadata.commitDate
          ? isoToDisplay(remoteMetadata.commitDate)
          : formatTimestamp(remoteMetadata.timestamp),
      };
    }
  } catch (error) {
    console.error('客户端版本检测发生错误:', error);
    return {
      status: UpdateStatus.FETCH_FAILED,
      error: error instanceof Error ? error.message : '未知错误',
    };
  }
}

/**
 * 检查版本更新 - 主入口函数
 * 使用混合策略：优先 API，回退客户端直接获取
 *
 * 性能优化：
 * - 单例模式，结果缓存 5 分钟
 * - 防止并发重复请求
 */
export async function checkForUpdates(
  options: CheckOptions = {},
): Promise<VersionCheckResult> {
  // 1. 优先返回缓存结果，避免重复请求
  const cached = options.force ? null : getCachedResult();
  if (cached) {
    console.log('版本检测 (缓存命中):', cached.status);
    return cached;
  }

  // 2. 如果有正在进行的请求，复用它（防止并发）
  if (!options.force && pendingRequest) {
    console.log('版本检测 (复用进行中的请求)');
    return pendingRequest;
  }

  // 3. 发起新请求
  pendingRequest = (async () => {
    try {
      // 策略1: 优先尝试 API（同源请求，最稳定）
      const apiResult = await checkViaApi();
      if (apiResult) {
        console.log('版本检测成功 (via API):', apiResult.status);
        setCachedResult(apiResult);
        return apiResult;
      }

      // 策略2: API 失败，回退到客户端直接获取
      console.log('API 检测失败，尝试客户端直接获取...');
      const clientResult = await checkViaClientDirect();
      console.log('版本检测结果 (via Client):', clientResult.status);
      setCachedResult(clientResult);
      return clientResult;
    } finally {
      // 请求完成后清除 pending 状态
      pendingRequest = null;
    }
  })();

  return pendingRequest;
}
