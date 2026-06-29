/* eslint-disable no-console */
import { promises as fs } from 'fs';
import { NextResponse } from 'next/server';
import path from 'path';

import { BUILD_TIMESTAMP, CURRENT_VERSION } from '@/lib/version';
import {
  BuildMetadata,
  compareBuildMetadata,
  compareSemanticVersions,
  normalizeCommitSha,
  normalizeVersion,
  shortCommit,
  timestampFromIso,
} from '@/lib/version-metadata';

export const dynamic = 'force-dynamic';

// 远程版本源配置
const UPDATE_REPO = process.env.NEXT_PUBLIC_UPDATE_REPO || 'Decohererk/DecoTV';
const UPDATE_REF = process.env.NEXT_PUBLIC_UPDATE_REF || 'main';

// 多个镜像源
const REMOTE_VERSION_URLS = [
  `https://cdn.jsdelivr.net/gh/${UPDATE_REPO}@${UPDATE_REF}/VERSION.txt`,
  `https://fastly.jsdelivr.net/gh/${UPDATE_REPO}@${UPDATE_REF}/VERSION.txt`,
  `https://raw.githubusercontent.com/${UPDATE_REPO}/${UPDATE_REF}/VERSION.txt`,
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
const FETCH_TIMEOUT = 5000;
const REMOTE_CACHE_TTL = 5 * 60 * 1000;

let remoteMetadataCache: {
  value: BuildMetadata | null;
  timestamp: number;
} | null = null;

function noStoreJson(
  payload: unknown,
  init?: Parameters<typeof NextResponse.json>[1],
) {
  const response = NextResponse.json(payload, init);
  response.headers.set(
    'Cache-Control',
    'no-store, no-cache, max-age=0, must-revalidate',
  );
  response.headers.set('Pragma', 'no-cache');
  response.headers.set('Expires', '0');
  return response;
}

/**
 * 带超时的 fetch（服务端版本）
 */
async function fetchWithTimeout(
  url: string,
  timeout: number,
  accept = 'text/plain',
): Promise<string | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(`${url}?_t=${Date.now()}`, {
      signal: controller.signal,
      cache: 'no-store',
      headers: {
        'User-Agent': 'DecoTV-VersionCheck/1.0',
        Accept: accept,
      },
    });

    if (!response.ok) return null;
    return (await response.text()).trim();
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

function isTimestamp(value?: string | null) {
  return /^\d{14}$/.test(value || '');
}

function pickTimestamp(...values: Array<string | null | undefined>): string {
  return values.find((value) => isTimestamp(value)) || '';
}

function timestampValue(value?: string | null): bigint | null {
  return isTimestamp(value) ? BigInt(value as string) : null;
}

function pickNewestTimestamp(
  ...values: Array<string | null | undefined>
): string {
  return values.reduce<string>((newest, value) => {
    const currentValue = timestampValue(value);
    if (!currentValue) return newest;

    const newestValue = timestampValue(newest);
    return !newestValue || currentValue > newestValue ? value || '' : newest;
  }, '');
}

function preferNewerMetadata(
  envMetadata: Partial<BuildMetadata>,
  fileMetadata: Partial<BuildMetadata>,
) {
  const envTimestamp = timestampValue(envMetadata.timestamp);
  const fileTimestamp = timestampValue(fileMetadata.timestamp);

  if (!fileTimestamp) return envMetadata;
  if (!envTimestamp) return fileMetadata;

  if (fileTimestamp > envTimestamp) return fileMetadata;
  if (fileTimestamp < envTimestamp) return envMetadata;

  const fileCommit = normalizeCommitSha(fileMetadata.commitSha);
  const envCommit = normalizeCommitSha(envMetadata.commitSha);

  if (fileCommit && !envCommit) return fileMetadata;
  if (!fileCommit && envCommit) return envMetadata;

  return fileMetadata;
}

/**
 * 获取本地构建元数据
 */
async function getLocalMetadata(): Promise<BuildMetadata> {
  const metadataPaths = [
    path.join(process.cwd(), 'public', 'version.json'),
    path.join(process.cwd(), 'version.json'),
  ];

  let fileMetadata: Partial<BuildMetadata> = {};
  for (const filePath of metadataPaths) {
    const metadata = await readJsonFile<Partial<BuildMetadata>>(filePath);
    if (metadata) {
      fileMetadata = metadata;
      break;
    }
  }

  const possiblePaths = [
    path.join(process.cwd(), 'public', 'VERSION.txt'),
    path.join(process.cwd(), 'VERSION.txt'),
    path.join(process.cwd(), '.next', 'static', 'VERSION.txt'),
  ];

  let fileTimestamp = '';
  for (const filePath of possiblePaths) {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const timestamp = content.trim();
      if (isTimestamp(timestamp)) {
        fileTimestamp = timestamp;
        break;
      }
    } catch {
      continue;
    }
  }

  const envCommitSha = normalizeCommitSha(
    process.env.GIT_COMMIT_SHA ||
      process.env.NEXT_PUBLIC_BUILD_COMMIT_SHA ||
      process.env.GITHUB_SHA ||
      process.env.VERCEL_GIT_COMMIT_SHA,
  );

  const envTimestamp =
    pickTimestamp(
      process.env.BUILD_TIMESTAMP,
      process.env.NEXT_PUBLIC_BUILD_TIMESTAMP,
      BUILD_TIMESTAMP,
    ) || BUILD_TIMESTAMP;

  const fileTimestampValue = pickNewestTimestamp(
    fileMetadata.timestamp,
    fileTimestamp,
  );
  const envMetadata: Partial<BuildMetadata> = {
    timestamp: envTimestamp,
    commitSha: envCommitSha,
    commitDate:
      process.env.GIT_COMMIT_DATE || process.env.NEXT_PUBLIC_BUILD_COMMIT_DATE,
    ref:
      process.env.GIT_REF_NAME ||
      process.env.NEXT_PUBLIC_BUILD_REF ||
      process.env.GITHUB_REF_NAME ||
      process.env.VERCEL_GIT_COMMIT_REF,
    source:
      process.env.GITHUB_ACTIONS === 'true'
        ? 'github-actions'
        : process.env.VERCEL
          ? 'vercel'
          : process.env.DOCKER_ENV === 'true' ||
              process.env.DOCKER_BUILD === 'true'
            ? 'docker'
            : undefined,
  };
  const selectedMetadata = preferNewerMetadata(envMetadata, {
    ...fileMetadata,
    timestamp: fileTimestampValue,
  });
  const commitSha = normalizeCommitSha(selectedMetadata.commitSha);
  const timestamp =
    pickTimestamp(selectedMetadata.timestamp, fileTimestamp, BUILD_TIMESTAMP) ||
    BUILD_TIMESTAMP;

  return {
    version: CURRENT_VERSION,
    timestamp,
    buildTime: selectedMetadata.buildTime,
    commitSha,
    shortCommit: shortCommit(commitSha),
    commitDate: selectedMetadata.commitDate || fileMetadata.commitDate,
    ref: selectedMetadata.ref || fileMetadata.ref,
    repo: selectedMetadata.repo || fileMetadata.repo || UPDATE_REPO,
    source: selectedMetadata.source || fileMetadata.source,
  };
}

/**
 * 获取远程版本时间戳
 */
async function getRemoteTimestamp(): Promise<string | null> {
  // 并行请求所有源
  const results = await Promise.allSettled(
    REMOTE_VERSION_URLS.map((url) => fetchWithTimeout(url, FETCH_TIMEOUT)),
  );

  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) {
      const timestamp = result.value;
      if (/^\d{14}$/.test(timestamp)) {
        return timestamp;
      }
    }
  }

  return null;
}

async function getRemoteMetadataFile(): Promise<Partial<BuildMetadata> | null> {
  const results = await Promise.allSettled(
    REMOTE_VERSION_METADATA_URLS.map((url) =>
      fetchWithTimeout(url, FETCH_TIMEOUT, 'application/json'),
    ),
  );

  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) {
      try {
        return JSON.parse(result.value) as Partial<BuildMetadata>;
      } catch {
        continue;
      }
    }
  }

  return null;
}

async function getRemoteSemanticVersion(): Promise<string | null> {
  const results = await Promise.allSettled(
    REMOTE_PACKAGE_URLS.map((url) =>
      fetchWithTimeout(url, FETCH_TIMEOUT, 'application/json'),
    ),
  );

  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) {
      try {
        const packageJson = JSON.parse(result.value);
        if (typeof packageJson.version === 'string') {
          return normalizeVersion(packageJson.version);
        }
      } catch {
        continue;
      }
    }
  }

  return null;
}

async function getRemoteCommitMetadata(): Promise<Partial<BuildMetadata> | null> {
  const payload = await fetchWithTimeout(
    REMOTE_COMMIT_URL,
    FETCH_TIMEOUT,
    'application/vnd.github+json',
  );

  if (!payload) return null;

  try {
    const data = JSON.parse(payload);
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
 * 获取远程 main/ref 最新构建元数据。
 *
 * 优先使用 GitHub commit API 判断同一语义版本内的新提交；
 * VERSION.txt 只作为旧部署和网络异常时的兼容回退。
 */
async function getRemoteMetadata(): Promise<BuildMetadata | null> {
  if (
    remoteMetadataCache &&
    Date.now() - remoteMetadataCache.timestamp < REMOTE_CACHE_TTL
  ) {
    return remoteMetadataCache.value;
  }

  const [metadataFile, semanticVersion, timestamp, commitMetadata] =
    await Promise.all([
      getRemoteMetadataFile(),
      getRemoteSemanticVersion(),
      getRemoteTimestamp(),
      getRemoteCommitMetadata(),
    ]);

  const remoteTimestamp =
    pickTimestamp(
      commitMetadata?.timestamp,
      metadataFile?.timestamp,
      timestamp || undefined,
    ) || '';

  const commitSha = normalizeCommitSha(
    commitMetadata?.commitSha || metadataFile?.commitSha,
  );

  const metadata: BuildMetadata | null =
    semanticVersion || remoteTimestamp || commitSha
      ? {
          version: (() => {
            const detectedVersion =
              semanticVersion ||
              normalizeVersion(metadataFile?.version) ||
              CURRENT_VERSION;

            return commitSha &&
              compareSemanticVersions(CURRENT_VERSION, detectedVersion) > 0
              ? CURRENT_VERSION
              : detectedVersion;
          })(),
          timestamp: remoteTimestamp,
          buildTime: metadataFile?.buildTime,
          commitSha,
          shortCommit: shortCommit(commitSha),
          commitDate: commitMetadata?.commitDate || metadataFile?.commitDate,
          ref: UPDATE_REF,
          repo: UPDATE_REPO,
          source: commitMetadata?.commitSha ? 'github-commit' : 'remote-file',
        }
      : null;

  remoteMetadataCache = {
    value: metadata,
    timestamp: Date.now(),
  };

  return metadata;
}

/**
 * 版本检查 API
 * GET /api/version/check - 完整版本检测，包含语义版本、构建时间和 Git commit 比较
 *
 * 此 API 在服务端执行版本检测，解决客户端 CORS 和网络问题。
 */
export async function GET() {
  try {
    const local = await getLocalMetadata();
    const remote = await getRemoteMetadata();
    const comparison = remote
      ? compareBuildMetadata(local, remote)
      : { hasUpdate: false, reason: 'none' as const };

    return noStoreJson({
      success: true,
      version: local.version,
      localTimestamp: local.timestamp,
      remoteTimestamp: remote?.timestamp,
      localCommit: local.shortCommit,
      remoteCommit: remote?.shortCommit,
      hasUpdate: comparison.hasUpdate,
      updateReason: comparison.reason,
      displayVersion: `v${local.version}`,
      current: {
        version: local.version,
        timestamp: local.timestamp,
        commitSha: local.commitSha,
        shortCommit: local.shortCommit,
        commitDate: local.commitDate,
        source: local.source,
        displayVersion: `v${local.version}`,
        updateAvailable: comparison.hasUpdate,
      },
      remote: remote
        ? {
            version: remote.version,
            timestamp: remote.timestamp,
            commitSha: remote.commitSha,
            shortCommit: remote.shortCommit,
            commitDate: remote.commitDate,
            source: remote.source,
            displayVersion: `v${remote.version}`,
            downloadUrl: `https://github.com/${UPDATE_REPO}`,
            releaseNotes: [
              comparison.reason === 'commit'
                ? 'main 分支已有新的构建提交'
                : '发现新版本可用',
              `最新版本: v${remote.version}`,
              remote.shortCommit ? `最新提交: ${remote.shortCommit}` : '',
            ].filter(Boolean),
          }
        : undefined,
      serverTime: Date.now(),
    });
  } catch (error) {
    console.error('版本检查 API 错误:', error);
    return noStoreJson(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: Date.now(),
      },
      { status: 500 },
    );
  }
}
