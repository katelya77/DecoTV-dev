/* eslint-disable no-console */

'use client';

// 版本检查工具 - 基于时间戳比较

// 版本检查结果枚举
export enum UpdateStatus {
  HAS_UPDATE = 'has_update', // 有新版本
  NO_UPDATE = 'no_update', // 无新版本
  FETCH_FAILED = 'fetch_failed', // 获取失败
}

// 远程版本检查URL配置（可通过 NEXT_PUBLIC_UPDATE_REPO 指定形如 "owner/repo"）
const UPDATE_REPO = process.env.NEXT_PUBLIC_UPDATE_REPO || 'Decohererk/DecoTV';
const VERSION_CHECK_URLS = UPDATE_REPO
  ? [`https://raw.githubusercontent.com/${UPDATE_REPO}/main/VERSION.txt`]
  : [];

/**
 * 检查是否有新版本可用
 * @returns Promise<UpdateStatus> - 返回版本检查状态
 */
export async function checkForUpdates(): Promise<{
  status: UpdateStatus;
  currentTimestamp?: string;
  remoteTimestamp?: string;
}> {
  try {
    if (VERSION_CHECK_URLS.length === 0) {
      return { status: UpdateStatus.FETCH_FAILED };
    }

    // 获取当前时间戳
    let currentTimestamp: string;
    try {
      const response = await fetch('/VERSION.txt');
      currentTimestamp = (await response.text()).trim();
    } catch {
      currentTimestamp = '20251006163200'; // 默认值
    }

    // 获取远程时间戳
    const remoteTimestamp = await fetchVersionFromUrl(VERSION_CHECK_URLS[0]);

    if (!remoteTimestamp) {
      return {
        status: UpdateStatus.FETCH_FAILED,
        currentTimestamp,
      };
    }

    const status = compareVersionsByTimestamp(
      remoteTimestamp,
      currentTimestamp
    );

    return {
      status,
      currentTimestamp,
      remoteTimestamp,
    };
  } catch (error) {
    return { status: UpdateStatus.FETCH_FAILED };
  }
}

/**
 * 从指定URL获取版本信息
 * @param url - 版本信息URL
 * @returns Promise<string | null> - 版本字符串或null
 */
async function fetchVersionFromUrl(url: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000); // 5秒超时

    // 添加时间戳参数以避免缓存
    const timestamp = Date.now();
    const urlWithTimestamp = url.includes('?')
      ? `${url}&_t=${timestamp}`
      : `${url}?_t=${timestamp}`;

    const response = await fetch(urlWithTimestamp, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'Content-Type': 'text/plain',
      },
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const version = await response.text();
    return version.trim();
  } catch (error) {
    console.warn(`从 ${url} 获取版本信息失败:`, error);
    return null;
  }
}

/**
 * 比较时间戳版本号
 * @param remoteTimestamp - 远程时间戳版本
 * @param currentTimestamp - 当前时间戳版本
 * @returns UpdateStatus - 返回版本比较结果
 */
export function compareVersionsByTimestamp(
  remoteTimestamp: string,
  currentTimestamp: string
): UpdateStatus {
  // 如果时间戳相同，无需更新
  if (remoteTimestamp === currentTimestamp) {
    return UpdateStatus.NO_UPDATE;
  }

  try {
    // 验证时间戳格式
    if (
      !/^\d{14}$/.test(remoteTimestamp) ||
      !/^\d{14}$/.test(currentTimestamp)
    ) {
      throw new Error('无效的时间戳格式');
    }

    // 直接比较时间戳数值：远程时间戳大于当前时间戳则有更新
    const remoteNum = parseInt(remoteTimestamp, 10);
    const currentNum = parseInt(currentTimestamp, 10);

    if (remoteNum > currentNum) {
      return UpdateStatus.HAS_UPDATE;
    } else {
      return UpdateStatus.NO_UPDATE;
    }
  } catch (error) {
    // 如果时间戳格式无效，认为没有更新
    return UpdateStatus.NO_UPDATE;
  }
}
