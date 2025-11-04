/* eslint-disable @typescript-eslint/no-explicit-any */

'use client';

import { AlertCircle, CheckCircle, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
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

function RegisterPageClient() {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [captcha, setCaptcha] = useState('');
  const [captchaSvg, setCaptchaSvg] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [captchaLoading, setCaptchaLoading] = useState(false);
  const [registrationEnabled, setRegistrationEnabled] = useState(false);
  const [storageType, setStorageType] = useState('localstorage');

  const { siteName } = useSite();

  // 加载验证码
  const loadCaptcha = async () => {
    try {
      setCaptchaLoading(true);
      const res = await fetch('/api/register?action=captcha');
      if (res.ok) {
        const data = await res.json();
        setCaptchaSvg(data.svg);
        setSessionId(data.sessionId);
        setCaptcha(''); // 清空验证码输入
      } else {
        setError('加载验证码失败');
      }
    } catch (err) {
      setError('网络错误，请稍后重试');
    } finally {
      setCaptchaLoading(false);
    }
  };

  // 检查注册是否启用
  useEffect(() => {
    // 从服务端获取配置
    fetch('/api/server-config')
      .then((res) => res.json())
      .then((data) => {
        const storage = data.StorageType || 'localstorage';
        const enabled = data.EnableRegistration === true;
        setRegistrationEnabled(enabled);
        setStorageType(storage);

        if (enabled && storage !== 'localstorage') {
          loadCaptcha();
        }
      })
      .catch(() => {
        // 失败时使用默认值
        setRegistrationEnabled(false);
        setStorageType('localstorage');
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 用户名验证提示
  const getUsernameError = (): string | null => {
    if (!username) return null;
    if (username.length < 3) return '用户名至少3个字符';
    if (username.length > 20) return '用户名最多20个字符';
    if (!/^[a-zA-Z0-9_]+$/.test(username)) return '只能包含字母、数字和下划线';
    if (/^\d+$/.test(username)) return '不能全是数字';
    return null;
  };

  // 密码验证提示
  const getPasswordError = (): string | null => {
    if (!password) return null;
    if (password.length < 6) return '密码至少6个字符';
    if (password.length > 50) return '密码最多50个字符';
    if (/^\d+$/.test(password)) return '密码不能全是数字';
    return null;
  };

  // 确认密码验证
  const getConfirmPasswordError = (): string | null => {
    if (!confirmPassword) return null;
    if (password !== confirmPassword) return '两次密码不一致';
    return null;
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    // 前端验证
    const usernameError = getUsernameError();
    const passwordError = getPasswordError();
    const confirmPasswordError = getConfirmPasswordError();

    if (usernameError) {
      setError(usernameError);
      return;
    }
    if (passwordError) {
      setError(passwordError);
      return;
    }
    if (confirmPasswordError) {
      setError(confirmPasswordError);
      return;
    }
    if (!captcha) {
      setError('请输入验证码');
      return;
    }

    try {
      setLoading(true);
      const res = await fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username,
          password,
          confirmPassword,
          captcha,
          sessionId,
        }),
      });

      const data = await res.json();

      if (res.ok) {
        setSuccess(data.message || '注册成功！');
        // 2秒后跳转到登录页
        setTimeout(() => {
          router.push('/login');
        }, 2000);
      } else {
        setError(data.error || '注册失败');
        // 如果是验证码错误，刷新验证码
        if (
          data.error?.includes('验证码') ||
          data.error?.includes('过期') ||
          data.error?.includes('错误次数')
        ) {
          loadCaptcha();
        }
      }
    } catch (err) {
      setError('网络错误，请稍后重试');
    } finally {
      setLoading(false);
    }
  };

  // 如果未启用注册
  if (!registrationEnabled) {
    return (
      <div className='relative min-h-screen flex items-center justify-center px-4 overflow-hidden login-bg'>
        <div className='absolute inset-0 bg-gradient-to-br from-purple-900/20 via-blue-900/20 to-pink-900/20 dark:from-purple-900/40 dark:via-blue-900/40 dark:to-pink-900/40 animate-gradient-shift'></div>
        <div className='absolute top-4 right-4 z-20'>
          <ThemeToggle />
        </div>
        <div className='relative z-10 w-full max-w-md rounded-3xl bg-gradient-to-b from-white/90 via-white/70 to-white/40 dark:from-zinc-900/90 dark:via-zinc-900/70 dark:to-zinc-900/40 backdrop-blur-xl shadow-2xl p-10 dark:border dark:border-zinc-800 text-center'>
          <AlertCircle className='w-16 h-16 mx-auto mb-4 text-yellow-500' />
          <h2 className='text-2xl font-bold mb-4 text-gray-900 dark:text-gray-100'>
            注册功能未开启
          </h2>
          <p className='text-gray-600 dark:text-gray-400 mb-6'>
            管理员未启用用户注册功能，请联系管理员或使用已有账号登录。
          </p>
          <Link
            href='/login'
            className='inline-block px-6 py-3 bg-gradient-to-r from-purple-600 via-fuchsia-600 to-pink-600 text-white rounded-lg font-semibold hover:brightness-110 transition-all'
          >
            返回登录
          </Link>
        </div>
        <VersionDisplay />
      </div>
    );
  }

  // 如果存储模式不支持
  if (storageType === 'localstorage') {
    return (
      <div className='relative min-h-screen flex items-center justify-center px-4 overflow-hidden login-bg'>
        <div className='absolute inset-0 bg-gradient-to-br from-purple-900/20 via-blue-900/20 to-pink-900/20 dark:from-purple-900/40 dark:via-blue-900/40 dark:to-pink-900/40 animate-gradient-shift'></div>
        <div className='absolute top-4 right-4 z-20'>
          <ThemeToggle />
        </div>
        <div className='relative z-10 w-full max-w-md rounded-3xl bg-gradient-to-b from-white/90 via-white/70 to-white/40 dark:from-zinc-900/90 dark:via-zinc-900/70 dark:to-zinc-900/40 backdrop-blur-xl shadow-2xl p-10 dark:border dark:border-zinc-800 text-center'>
          <AlertCircle className='w-16 h-16 mx-auto mb-4 text-red-500' />
          <h2 className='text-2xl font-bold mb-4 text-gray-900 dark:text-gray-100'>
            不支持用户注册
          </h2>
          <p className='text-gray-600 dark:text-gray-400 mb-6'>
            当前存储模式为 LocalStorage，不支持多用户注册。
            <br />
            请联系管理员配置 Redis/Upstash/Kvrocks 存储。
          </p>
          <Link
            href='/login'
            className='inline-block px-6 py-3 bg-gradient-to-r from-purple-600 via-fuchsia-600 to-pink-600 text-white rounded-lg font-semibold hover:brightness-110 transition-all'
          >
            返回登录
          </Link>
        </div>
        <VersionDisplay />
      </div>
    );
  }

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
        <div className='text-center mb-6'>
          <h1 className='tracking-tight text-4xl font-extrabold mb-2 bg-clip-text neon-text neon-flicker'>
            {siteName}
          </h1>
          <p className='text-sm text-gray-600 dark:text-gray-400'>创建新账号</p>
        </div>

        <form onSubmit={handleSubmit} className='space-y-5'>
          {/* 用户名 */}
          <div>
            <label htmlFor='username' className='sr-only'>
              用户名
            </label>
            <input
              id='username'
              type='text'
              autoComplete='username'
              className={`block w-full rounded-lg border-0 py-3 px-4 text-gray-900 dark:text-gray-100 shadow-sm ring-1 ${
                getUsernameError()
                  ? 'ring-red-500 focus:ring-red-500'
                  : 'ring-white/60 dark:ring-white/20 focus:ring-purple-500'
              } placeholder:text-gray-500 dark:placeholder:text-gray-400 focus:ring-2 focus:outline-none sm:text-base bg-white/60 dark:bg-zinc-800/60 backdrop-blur transition-all duration-300 hover:ring-purple-400 focus:shadow-lg focus:shadow-purple-500/25 login-input`}
              placeholder='用户名 (3-20字符)'
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
            {getUsernameError() && (
              <p className='mt-1 text-xs text-red-600 dark:text-red-400'>
                {getUsernameError()}
              </p>
            )}
          </div>

          {/* 密码 */}
          <div>
            <label htmlFor='password' className='sr-only'>
              密码
            </label>
            <input
              id='password'
              type='password'
              autoComplete='new-password'
              className={`block w-full rounded-lg border-0 py-3 px-4 text-gray-900 dark:text-gray-100 shadow-sm ring-1 ${
                getPasswordError()
                  ? 'ring-red-500 focus:ring-red-500'
                  : 'ring-white/60 dark:ring-white/20 focus:ring-purple-500'
              } placeholder:text-gray-500 dark:placeholder:text-gray-400 focus:ring-2 focus:outline-none sm:text-base bg-white/60 dark:bg-zinc-800/60 backdrop-blur transition-all duration-300 hover:ring-purple-400 focus:shadow-lg focus:shadow-purple-500/25 login-input`}
              placeholder='密码 (至少6位)'
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {getPasswordError() && (
              <p className='mt-1 text-xs text-red-600 dark:text-red-400'>
                {getPasswordError()}
              </p>
            )}
          </div>

          {/* 确认密码 */}
          <div>
            <label htmlFor='confirmPassword' className='sr-only'>
              确认密码
            </label>
            <input
              id='confirmPassword'
              type='password'
              autoComplete='new-password'
              className={`block w-full rounded-lg border-0 py-3 px-4 text-gray-900 dark:text-gray-100 shadow-sm ring-1 ${
                getConfirmPasswordError()
                  ? 'ring-red-500 focus:ring-red-500'
                  : 'ring-white/60 dark:ring-white/20 focus:ring-purple-500'
              } placeholder:text-gray-500 dark:placeholder:text-gray-400 focus:ring-2 focus:outline-none sm:text-base bg-white/60 dark:bg-zinc-800/60 backdrop-blur transition-all duration-300 hover:ring-purple-400 focus:shadow-lg focus:shadow-purple-500/25 login-input`}
              placeholder='确认密码'
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
            />
            {getConfirmPasswordError() && (
              <p className='mt-1 text-xs text-red-600 dark:text-red-400'>
                {getConfirmPasswordError()}
              </p>
            )}
          </div>

          {/* 验证码 */}
          <div>
            <label htmlFor='captcha' className='sr-only'>
              验证码
            </label>
            <div className='flex items-center gap-2'>
              <input
                id='captcha'
                type='text'
                autoComplete='off'
                className='block flex-1 rounded-lg border-0 py-3 px-4 text-gray-900 dark:text-gray-100 shadow-sm ring-1 ring-white/60 dark:ring-white/20 placeholder:text-gray-500 dark:placeholder:text-gray-400 focus:ring-2 focus:ring-purple-500 focus:outline-none sm:text-base bg-white/60 dark:bg-zinc-800/60 backdrop-blur transition-all duration-300 hover:ring-purple-400 focus:shadow-lg focus:shadow-purple-500/25 login-input uppercase'
                placeholder='验证码'
                value={captcha}
                onChange={(e) => setCaptcha(e.target.value.toUpperCase())}
                maxLength={4}
              />
              {/* 验证码图片 */}
              <div className='relative'>
                {captchaLoading ? (
                  <div className='w-[120px] h-[40px] bg-gray-200 dark:bg-gray-700 rounded-lg flex items-center justify-center'>
                    <RefreshCw className='w-5 h-5 animate-spin text-gray-400' />
                  </div>
                ) : (
                  <div
                    className='w-[120px] h-[40px] rounded-lg overflow-hidden cursor-pointer hover:opacity-80 transition-opacity'
                    onClick={loadCaptcha}
                    dangerouslySetInnerHTML={{ __html: captchaSvg }}
                  />
                )}
                <button
                  type='button'
                  onClick={loadCaptcha}
                  disabled={captchaLoading}
                  className='absolute -bottom-1 -right-1 p-1 bg-white dark:bg-zinc-800 rounded-full shadow-lg hover:bg-gray-100 dark:hover:bg-zinc-700 transition-colors disabled:opacity-50'
                  title='刷新验证码'
                >
                  <RefreshCw
                    className={`w-3 h-3 text-gray-600 dark:text-gray-400 ${
                      captchaLoading ? 'animate-spin' : ''
                    }`}
                  />
                </button>
              </div>
            </div>
            <p className='mt-1 text-xs text-gray-500 dark:text-gray-400'>
              点击验证码图片可刷新
            </p>
          </div>

          {/* 错误提示 */}
          {error && (
            <div className='p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg'>
              <p className='text-sm text-red-600 dark:text-red-400'>{error}</p>
            </div>
          )}

          {/* 成功提示 */}
          {success && (
            <div className='p-3 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg'>
              <p className='text-sm text-green-600 dark:text-green-400'>
                {success}
              </p>
            </div>
          )}

          {/* 注册按钮 */}
          <button
            type='submit'
            disabled={
              !username ||
              !password ||
              !confirmPassword ||
              !captcha ||
              loading ||
              !!getUsernameError() ||
              !!getPasswordError() ||
              !!getConfirmPasswordError()
            }
            className='inline-flex w-full justify-center rounded-lg bg-gradient-to-r from-purple-600 via-fuchsia-600 to-pink-600 py-3 text-base font-semibold text-white shadow-lg transition-all duration-300 hover:brightness-110 hover:scale-105 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:scale-100 neon-pulse login-button'
          >
            {loading ? '注册中...' : '注册账号'}
          </button>

          {/* 登录链接 */}
          <div className='text-center'>
            <Link
              href='/login'
              className='text-sm text-purple-600 dark:text-purple-400 hover:text-purple-700 dark:hover:text-purple-300 transition-colors'
            >
              已有账号？立即登录
            </Link>
          </div>
        </form>
      </div>

      {/* 版本信息显示 */}
      <VersionDisplay />
    </div>
  );
}

export default function RegisterPage() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <RegisterPageClient />
    </Suspense>
  );
}
