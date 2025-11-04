/* eslint-disable @typescript-eslint/no-explicit-any */

'use client';

import { usePathname } from 'next/navigation';
import React from 'react';

import { getAuthInfoFromBrowserCookie } from '@/lib/auth';

export default function NavbarGate({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();

  // 如果在登录页或注册页且未登录，则不显示导航栏
  if (pathname === '/login' || pathname === '/register') {
    const auth = getAuthInfoFromBrowserCookie();
    if (!auth) return null;
  }

  return <>{children}</>;
}
