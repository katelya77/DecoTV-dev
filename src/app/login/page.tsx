/* eslint-disable @typescript-eslint/no-explicit-any */

'use client';

import { AlertCircle, CheckCircle } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';

import { CURRENT_VERSION } from '@/lib/version';
import { checkForUpdates, UpdateStatus } from '@/lib/version_check';

import { useSite } from '@/components/SiteProvider';
import { ThemeToggle } from '@/components/ThemeToggle';

// 版本显示组件
function VersionDisplay() {
  const [updateStatus, setUpdateStatus] = useState<{
    status: UpdateStatus;
    currentTimestamp?: string;
    remoteTimestamp?: string;
  } | null>(null);
  const [isChecking, setIsChecking] = useState(true);

  useEffect(() => {
    const checkUpdate = async () => {
      try {
        const status = await checkForUpdates();
        setUpdateStatus(status);
      } catch (_) {
        // do nothing
      } finally {
        setIsChecking(false);
      }
    };

    checkUpdate();
  }, []);

  return (
    <button
      onClick={() =>
        window.open(
          (process.env.NEXT_PUBLIC_REPO_URL as string) ||
            (process.env.NEXT_PUBLIC_UPDATE_REPO
              ? `https://github.com/${process.env.NEXT_PUBLIC_UPDATE_REPO}`
              : '#'),
          '_blank'
        )
      }
      className='absolute bottom-4 left-1/2 transform -translate-x-1/2 flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400 transition-colors cursor-pointer'
    >
      <span className='font-mono'>v{CURRENT_VERSION}</span>
      {!isChecking && updateStatus?.status !== UpdateStatus.FETCH_FAILED && (
        <div
          className={`flex items-center gap-1.5 ${
            updateStatus?.status === UpdateStatus.HAS_UPDATE
              ? 'text-yellow-600 dark:text-yellow-400'
              : updateStatus?.status === UpdateStatus.NO_UPDATE
              ? 'text-purple-500 dark:text-purple-400'
              : ''
          }`}
        >
          {updateStatus?.status === UpdateStatus.HAS_UPDATE && (
            <>
              <AlertCircle className='w-3.5 h-3.5' />
              <span className='font-semibold text-xs'>有新版本</span>
            </>
          )}
          {updateStatus?.status === UpdateStatus.NO_UPDATE && (
            <>
              <CheckCircle className='w-3.5 h-3.5' />
              <span className='font-semibold text-xs'>当前为最新版本</span>
            </>
          )}
        </div>
      )}
    </button>
  );
}

function LoginPageClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [password, setPassword] = useState('');
  const [username, setUsername] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [shouldAskUsername, setShouldAskUsername] = useState(false);
  const [registrationEnabled, setRegistrationEnabled] = useState(false);

  const { siteName } = useSite();

  // 在客户端挂载后设置配置
  useEffect(() => {
    // 从服务端获取配置
    fetch('/api/server-config')
      .then((res) => res.json())
      .then((data) => {
        const storageType = data.StorageType;
        setShouldAskUsername(!!storageType && storageType !== 'localstorage');
        setRegistrationEnabled(
          data.EnableRegistration && storageType !== 'localstorage'
        );
      })
      .catch(() => {
        // 失败时使用默认值
        setShouldAskUsername(false);
        setRegistrationEnabled(false);
      });
  }, []);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);

    if (!password || (shouldAskUsername && !username)) return;

    try {
      setLoading(true);
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          password,
          ...(shouldAskUsername ? { username } : {}),
        }),
      });

      if (res.ok) {
        const redirect = searchParams.get('redirect') || '/';
        router.replace(redirect);
      } else if (res.status === 401) {
        setError('密码错误');
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? '服务器错误');
      }
    } catch (error) {
      setError('网络错误，请稍后重试');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className='relative min-h-screen flex items-center justify-center px-4 overflow-hidden login-bg'>
      {/* Animated background gradient */}
      <div className='absolute inset-0 bg-gradient-to-br from-purple-900/20 via-blue-900/20 to-pink-900/20 dark:from-purple-900/40 dark:via-blue-900/40 dark:to-pink-900/40 animate-gradient-shift'></div>

      {/* Floating orbs */}
      <div className='absolute top-1/4 left-1/4 w-32 h-32 bg-purple-500/30 rounded-full blur-xl animate-float-slow'></div>
      <div className='absolute top-3/4 right-1/4 w-24 h-24 bg-blue-500/30 rounded-full blur-xl animate-float-slower'></div>
      <div className='absolute bottom-1/4 left-1/3 w-20 h-20 bg-pink-500/30 rounded-full blur-xl animate-float'></div>

      <div className='absolute top-4 right-4 z-20'>
        <ThemeToggle />
      </div>

      <div className='relative z-10 w-full max-w-md rounded-3xl bg-gradient-to-b from-white/90 via-white/70 to-white/40 dark:from-zinc-900/90 dark:via-zinc-900/70 dark:to-zinc-900/40 backdrop-blur-xl shadow-2xl p-10 dark:border dark:border-zinc-800 login-card'>
        <h1 className='tracking-tight text-center text-4xl font-extrabold mb-8 bg-clip-text neon-text neon-flicker'>
          {siteName}
        </h1>
        <form onSubmit={handleSubmit} className='space-y-8'>
          {shouldAskUsername && (
            <div>
              <label htmlFor='username' className='sr-only'>
                用户名
              </label>
              <input
                id='username'
                type='text'
                autoComplete='username'
                className='block w-full rounded-lg border-0 py-3 px-4 text-gray-900 dark:text-gray-100 shadow-sm ring-1 ring-white/60 dark:ring-white/20 placeholder:text-gray-500 dark:placeholder:text-gray-400 focus:ring-2 focus:ring-purple-500 focus:outline-none sm:text-base bg-white/60 dark:bg-zinc-800/60 backdrop-blur transition-all duration-300 hover:ring-purple-400 focus:shadow-lg focus:shadow-purple-500/25 login-input'
                placeholder='输入用户名'
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </div>
          )}

          <div>
            <label htmlFor='password' className='sr-only'>
              密码
            </label>
            <input
              id='password'
              type='password'
              autoComplete='current-password'
              className='block w-full rounded-lg border-0 py-3 px-4 text-gray-900 dark:text-gray-100 shadow-sm ring-1 ring-white/60 dark:ring-white/20 placeholder:text-gray-500 dark:placeholder:text-gray-400 focus:ring-2 focus:ring-purple-500 focus:outline-none sm:text-base bg-white/60 dark:bg-zinc-800/60 backdrop-blur transition-all duration-300 hover:ring-purple-400 focus:shadow-lg focus:shadow-purple-500/25 login-input'
              placeholder='输入访问密码'
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          {error && (
            <p className='text-sm text-red-600 dark:text-red-400'>{error}</p>
          )}

          {/* 登录按钮 */}
          <button
            type='submit'
            disabled={!password || loading || (shouldAskUsername && !username)}
            className='inline-flex w-full justify-center rounded-lg bg-gradient-to-r from-purple-600 via-fuchsia-600 to-pink-600 py-3 text-base font-semibold text-white shadow-lg transition-all duration-300 hover:brightness-110 hover:scale-105 disabled:cursor-not-allowed disabled:opacity-50 neon-pulse login-button'
          >
            {loading ? '登录中...' : '登录'}
          </button>

          {/* 注册链接 */}
          {registrationEnabled && (
            <div className='text-center'>
              <Link
                href='/register'
                className='text-sm text-purple-600 dark:text-purple-400 hover:text-purple-700 dark:hover:text-purple-300 transition-colors'
              >
                没有账号？立即注册
              </Link>
            </div>
          )}
        </form>
      </div>

      {/* 版本信息显示 */}
      <VersionDisplay />
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <LoginPageClient />
    </Suspense>
  );
}
