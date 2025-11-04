/* eslint-disable no-console,@typescript-eslint/no-explicit-any */

import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { getConfig, refineConfig } from '@/lib/config';
import { db } from '@/lib/db';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const storageType = process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage';
  if (storageType === 'localstorage') {
    return NextResponse.json(
      {
        error: '不支持本地存储进行管理员配置',
      },
      { status: 400 }
    );
  }

  const authInfo = getAuthInfoFromCookie(request);
  if (!authInfo || !authInfo.username) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const username = authInfo.username;

  try {
    // 检查用户权限
    let adminConfig = await getConfig();

    // 仅站长可以修改配置文件
    if (username !== process.env.USERNAME) {
      return NextResponse.json(
        { error: '权限不足，只有站长可以修改配置文件' },
        { status: 401 }
      );
    }

    // 获取请求体
    const body = await request.json();
    const { configFile, subscriptionUrl, autoUpdate, lastCheckTime } = body;

    // 允许空内容，表示清空配置
    if (configFile !== undefined && typeof configFile !== 'string') {
      return NextResponse.json(
        { error: '配置文件内容格式错误' },
        { status: 400 }
      );
    }

    // 如果不为空，验证 JSON 格式
    if (configFile && configFile.trim()) {
      try {
        JSON.parse(configFile);
      } catch (e) {
        return NextResponse.json(
          { error: '配置文件格式错误，请检查 JSON 语法' },
          { status: 400 }
        );
      }
    }

    // 如果配置文件被清空，删除所有 from='config' 的视频源（保留 from='custom'）
    if (!configFile || !configFile.trim()) {
      adminConfig.SourceConfig = adminConfig.SourceConfig.filter(
        (source) => source.from === 'custom'
      );
      console.log('配置文件已清空，已删除所有系统预设视频源，保留自定义源');
    }

    adminConfig.ConfigFile = configFile || '';
    if (!adminConfig.ConfigSubscribtion) {
      adminConfig.ConfigSubscribtion = {
        URL: '',
        AutoUpdate: false,
        LastCheck: '',
      };
    }

    // 更新订阅配置
    if (subscriptionUrl !== undefined) {
      adminConfig.ConfigSubscribtion.URL = subscriptionUrl;
    }
    if (autoUpdate !== undefined) {
      adminConfig.ConfigSubscribtion.AutoUpdate = autoUpdate;
    }
    adminConfig.ConfigSubscribtion.LastCheck = lastCheckTime || '';

    adminConfig = refineConfig(adminConfig);
    // 更新配置文件
    await db.saveAdminConfig(adminConfig);
    return NextResponse.json({
      success: true,
      message: '配置文件更新成功',
    });
  } catch (error) {
    console.error('更新配置文件失败:', error);
    return NextResponse.json(
      {
        error: '更新配置文件失败',
        details: (error as Error).message,
      },
      { status: 500 }
    );
  }
}
