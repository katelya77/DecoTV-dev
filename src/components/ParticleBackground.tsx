/* eslint-disable @typescript-eslint/no-explicit-any */

'use client';

import { usePathname } from 'next/navigation';
import React, { useEffect, useMemo, useRef } from 'react';

export default function ParticleBackground() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const pathname = usePathname();
  const lastFrameTime = useRef<number>(0);
  const FPS_LIMIT = 30; // 限制帧率到 30fps，降低 CPU 占用

  // 使用 useMemo 缓存主题配置，避免每帧重新计算
  const themeConfig = useMemo(() => {
    if (pathname.startsWith('/search')) return { hue: 240, saturation: 85 };
    if (pathname.startsWith('/douban') && typeof window !== 'undefined') {
      const type = new URLSearchParams(window.location.search).get('type');
      if (type === 'movie') return { hue: 330, saturation: 80 };
      if (type === 'tv') return { hue: 270, saturation: 85 };
      if (type === 'anime') return { hue: 170, saturation: 75 };
      if (type === 'show') return { hue: 50, saturation: 90 };
    }
    if (pathname.startsWith('/live')) return { hue: 330, saturation: 85 };
    return { hue: 200, saturation: 80 };
  }, [pathname]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d', {
      alpha: true,
      desynchronized: true, // 性能优化：允许异步渲染
    });
    if (!ctx) return;

    let width = (canvas.width = window.innerWidth);
    let height = (canvas.height = window.innerHeight);

    const onResize = () => {
      width = canvas.width = window.innerWidth;
      height = canvas.height = window.innerHeight;
    };
    window.addEventListener('resize', onResize);

    // 大幅减少粒子数量：最多 40 个（原来 120 个），降低 66% CPU 负担
    const P = Math.min(40, Math.floor((width * height) / 40000));
    const particles: {
      x: number;
      y: number;
      vx: number;
      vy: number;
      r: number;
      hue: number;
      alpha: number;
      fadeDirection: number;
    }[] = [];

    for (let i = 0; i < P; i++) {
      particles.push({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 0.4, // 降低速度（原来 0.6）
        vy: (Math.random() - 0.5) * 0.4,
        r: Math.random() * 2 + 1,
        hue: themeConfig.hue + (Math.random() - 0.5) * 60, // 围绕主题色变化
        alpha: Math.random() * 0.5 + 0.3,
        fadeDirection: Math.random() > 0.5 ? 1 : -1,
      });
    }

    const draw = (currentTime: number) => {
      // 限制帧率到 30fps，降低 50% CPU 占用
      const elapsed = currentTime - lastFrameTime.current;
      if (elapsed < 1000 / FPS_LIMIT) {
        rafRef.current = requestAnimationFrame(draw);
        return;
      }
      lastFrameTime.current = currentTime;

      // 每一帧都检测当前主题模式，确保实时响应
      const isDarkMode =
        typeof window !== 'undefined' &&
        document.documentElement.classList.contains('dark');

      // 获取主题渐变色 - 根据亮暗模式调整
      const theme = (() => {
        const h = themeConfig.hue;
        const s = themeConfig.saturation;

        if (isDarkMode) {
          // 暗色模式：深色背景
          return {
            a: `hsla(${h}, ${s}%, 60%, 0.09)`,
            b: `hsla(${(h + 40) % 360}, ${s - 10}%, 55%, 0.08)`,
            clearColor: 'rgba(0, 0, 0, 0.05)',
          };
        } else {
          // 亮色模式：浅色背景，更高亮度
          return {
            a: `hsla(${h}, ${s - 30}%, 95%, 0.4)`,
            b: `hsla(${(h + 40) % 360}, ${s - 35}%, 92%, 0.35)`,
            clearColor: 'rgba(255, 255, 255, 0.1)',
          };
        }
      })();

      // 使用半透明清除创建拖尾效果 - 根据主题调整
      ctx.fillStyle = theme.clearColor;
      ctx.fillRect(0, 0, width, height);

      // 静态渐变背景
      const gradient = ctx.createLinearGradient(0, 0, width, height);
      gradient.addColorStop(0, theme.a);
      gradient.addColorStop(1, theme.b);
      ctx.globalCompositeOperation = 'destination-over';
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, width, height);
      ctx.globalCompositeOperation = 'source-over';

      // 更新和绘制粒子
      for (const p of particles) {
        // 更新位置
        p.x += p.vx;
        p.y += p.vy;

        // 边界反弹
        if (p.x < 0 || p.x > width) p.vx *= -1;
        if (p.y < 0 || p.y > height) p.vy *= -1;

        // 呼吸效果 - 透明度渐变
        p.alpha += p.fadeDirection * 0.005;
        if (p.alpha > 0.8) {
          p.alpha = 0.8;
          p.fadeDirection = -1;
        } else if (p.alpha < 0.2) {
          p.alpha = 0.2;
          p.fadeDirection = 1;
        }

        // 绘制粒子 - 亮色模式使用更深的颜色
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.closePath();
        const particleColor = isDarkMode
          ? `hsla(${p.hue}, 85%, 65%, ${p.alpha})` // 暗色模式：高亮度
          : `hsla(${p.hue}, 70%, 50%, ${p.alpha * 0.6})`; // 亮色模式：中等亮度 + 降低透明度
        const shadowColor = isDarkMode
          ? `hsla(${p.hue}, 90%, 70%, ${p.alpha * 0.8})`
          : `hsla(${p.hue}, 60%, 45%, ${p.alpha * 0.3})`;
        ctx.fillStyle = particleColor;
        ctx.shadowColor = shadowColor;
        ctx.shadowBlur = 8;
        ctx.fill();
        ctx.shadowBlur = 0;
      }

      // 优化的连接线 - 每个粒子最多 3 条连接，降低复杂度从 O(n²) 到 O(n)
      ctx.lineWidth = 0.5;
      const maxConnections = 3;
      const maxDist = 100; // 减少连接距离（原来 120）

      for (let i = 0; i < particles.length; i++) {
        const a = particles[i];
        let connections = 0;

        for (
          let j = i + 1;
          j < particles.length && connections < maxConnections;
          j++
        ) {
          const b = particles[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const d2 = dx * dx + dy * dy;

          if (d2 < maxDist * maxDist) {
            const alpha = (1 - d2 / (maxDist * maxDist)) * 0.2;
            const lineColor = isDarkMode
              ? `hsla(${themeConfig.hue}, 70%, 60%, ${alpha})` // 暗色模式
              : `hsla(${themeConfig.hue}, 50%, 40%, ${alpha * 0.5})`; // 亮色模式：更深 + 降低透明度
            ctx.strokeStyle = lineColor;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
            connections++;
          }
        }
      }

      rafRef.current = requestAnimationFrame(draw);
    };

    rafRef.current = requestAnimationFrame(draw);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      window.removeEventListener('resize', onResize);
    };
  }, [pathname, themeConfig, FPS_LIMIT, lastFrameTime]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden='true'
      className='fixed inset-0 -z-10 h-full w-full opacity-30 dark:opacity-60'
    />
  );
}
