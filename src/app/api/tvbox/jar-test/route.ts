/**
 * TVBox JAR 诊断可视化页面
 * 提供友好的 HTML 界面展示诊断结果
 */

export async function GET() {
  const html = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>TVBox JAR 源诊断工具</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
        }

        .container {
            max-width: 1200px;
            margin: 0 auto;
        }

        .header {
            text-align: center;
            color: white;
            margin-bottom: 30px;
        }

        .header h1 {
            font-size: 2.5rem;
            margin-bottom: 10px;
            text-shadow: 0 2px 4px rgba(0,0,0,0.2);
        }

        .header p {
            font-size: 1.1rem;
            opacity: 0.9;
        }

        .card {
            background: white;
            border-radius: 12px;
            padding: 30px;
            margin-bottom: 20px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.2);
        }

        .btn-container {
            text-align: center;
            margin-bottom: 30px;
        }

        .btn-primary {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border: none;
            padding: 15px 40px;
            font-size: 1.1rem;
            border-radius: 8px;
            cursor: pointer;
            transition: transform 0.2s, box-shadow 0.2s;
            box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4);
        }

        .btn-primary:hover {
            transform: translateY(-2px);
            box-shadow: 0 6px 20px rgba(102, 126, 234, 0.6);
        }

        .btn-primary:active {
            transform: translateY(0);
        }

        .btn-primary:disabled {
            opacity: 0.6;
            cursor: not-allowed;
            transform: none;
        }

        .loading {
            text-align: center;
            padding: 40px;
            color: #667eea;
        }

        .spinner {
            border: 3px solid #f3f3f3;
            border-top: 3px solid #667eea;
            border-radius: 50%;
            width: 40px;
            height: 40px;
            animation: spin 1s linear infinite;
            margin: 0 auto 20px;
        }

        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }

        .env-info {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 15px;
            margin-bottom: 20px;
        }

        .info-item {
            padding: 15px;
            background: #f8f9fa;
            border-radius: 8px;
            border-left: 4px solid #667eea;
        }

        .info-label {
            font-size: 0.9rem;
            color: #6c757d;
            margin-bottom: 5px;
        }

        .info-value {
            font-size: 1.1rem;
            font-weight: 600;
            color: #333;
        }

        .summary {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
            gap: 15px;
            margin-bottom: 30px;
        }

        .stat-card {
            text-align: center;
            padding: 20px;
            background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%);
            border-radius: 8px;
        }

        .stat-value {
            font-size: 2rem;
            font-weight: 700;
            color: #667eea;
            margin-bottom: 5px;
        }

        .stat-label {
            font-size: 0.9rem;
            color: #6c757d;
        }

        .recommendations {
            background: #fff3cd;
            border: 1px solid #ffc107;
            border-radius: 8px;
            padding: 20px;
            margin-bottom: 30px;
        }

        .recommendations h3 {
            color: #856404;
            margin-bottom: 15px;
        }

        .recommendations ul {
            list-style: none;
        }

        .recommendations li {
            padding: 8px 0;
            color: #856404;
            line-height: 1.6;
        }

        .test-results {
            margin-top: 30px;
        }

        .test-item {
            border: 1px solid #e0e0e0;
            border-radius: 8px;
            padding: 20px;
            margin-bottom: 15px;
            transition: all 0.3s;
        }

        .test-item:hover {
            box-shadow: 0 4px 12px rgba(0,0,0,0.1);
        }

        .test-item.success {
            border-left: 4px solid #28a745;
            background: #f8fff9;
        }

        .test-item.failed {
            border-left: 4px solid #dc3545;
            background: #fff8f8;
        }

        .test-item.timeout {
            border-left: 4px solid #ffc107;
            background: #fffef8;
        }

        .test-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 10px;
        }

        .test-url {
            font-family: 'Courier New', monospace;
            font-size: 0.9rem;
            color: #495057;
            word-break: break-all;
            flex: 1;
            margin-right: 15px;
        }

        .test-status {
            padding: 5px 15px;
            border-radius: 20px;
            font-size: 0.85rem;
            font-weight: 600;
            white-space: nowrap;
        }

        .status-success {
            background: #28a745;
            color: white;
        }

        .status-failed {
            background: #dc3545;
            color: white;
        }

        .status-timeout {
            background: #ffc107;
            color: #333;
        }

        .status-invalid {
            background: #6c757d;
            color: white;
        }

        .test-details {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
            gap: 10px;
            margin-top: 15px;
            padding-top: 15px;
            border-top: 1px solid #e0e0e0;
        }

        .detail-item {
            font-size: 0.9rem;
        }

        .detail-label {
            color: #6c757d;
            margin-right: 5px;
        }

        .detail-value {
            font-weight: 600;
            color: #333;
        }

        .error-message {
            margin-top: 10px;
            padding: 10px;
            background: #f8d7da;
            border: 1px solid #f5c6cb;
            border-radius: 4px;
            color: #721c24;
            font-size: 0.9rem;
        }

        @media (max-width: 768px) {
            .header h1 {
                font-size: 1.8rem;
            }

            .card {
                padding: 20px;
            }

            .env-info,
            .summary {
                grid-template-columns: 1fr;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🔍 TVBox JAR 源诊断工具</h1>
            <p>深度测试 JAR 文件源的可用性和性能</p>
        </div>

        <div class="card">
            <div class="btn-container">
                <button id="startTest" class="btn-primary">开始诊断测试</button>
            </div>
            <div id="result"></div>
        </div>
    </div>

    <script>
        const startBtn = document.getElementById('startTest');
        const resultDiv = document.getElementById('result');

        startBtn.addEventListener('click', async () => {
            startBtn.disabled = true;
            startBtn.textContent = '测试中...';

            resultDiv.innerHTML = \`
                <div class="loading">
                    <div class="spinner"></div>
                    <p>正在测试所有 JAR 源，请稍候...</p>
                    <p style="font-size: 0.9rem; color: #6c757d; margin-top: 10px;">这可能需要 10-30 秒</p>
                </div>
            \`;

            try {
                const response = await fetch('/api/tvbox/jar-diagnostic');
                const data = await response.json();

                renderResults(data);
            } catch (error) {
                resultDiv.innerHTML = \`
                    <div class="error-message">
                        <strong>错误：</strong> \${error.message}
                    </div>
                \`;
            } finally {
                startBtn.disabled = false;
                startBtn.textContent = '重新测试';
            }
        });

        function renderResults(data) {
            const { environment, summary, recommendations, jarTests } = data;

            let html = \`
                <h2 style="margin-bottom: 20px; color: #333;">📊 诊断报告</h2>

                <div class="env-info">
                    <div class="info-item">
                        <div class="info-label">网络环境</div>
                        <div class="info-value">\${environment.isDomestic ? '🇨🇳 国内' : '🌐 海外'}</div>
                    </div>
                    <div class="info-item">
                        <div class="info-label">时区</div>
                        <div class="info-value">\${environment.timezone}</div>
                    </div>
                    <div class="info-item">
                        <div class="info-label">测试时间</div>
                        <div class="info-value">\${new Date(data.timestamp).toLocaleString('zh-CN')}</div>
                    </div>
                </div>

                <div class="summary">
                    <div class="stat-card">
                        <div class="stat-value">\${summary.totalTested}</div>
                        <div class="stat-label">总测试源</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value" style="color: #28a745;">\${summary.successCount}</div>
                        <div class="stat-label">可用源</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value" style="color: #dc3545;">\${summary.failedCount}</div>
                        <div class="stat-label">失败源</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value">\${summary.averageResponseTime.toFixed(0)}ms</div>
                        <div class="stat-label">平均响应</div>
                    </div>
                </div>

                <div class="recommendations">
                    <h3>💡 诊断建议</h3>
                    <ul>
                        \${recommendations.map(rec => \`<li>\${rec}</li>\`).join('')}
                    </ul>
                </div>

                <div class="test-results">
                    <h3 style="margin-bottom: 20px; color: #333;">详细测试结果</h3>
                    \${jarTests.map(test => renderTestItem(test)).join('')}
                </div>
            \`;

            resultDiv.innerHTML = html;
        }

        function renderTestItem(test) {
            const statusClass = test.status;
            const statusText = {
                'success': '✅ 可用',
                'failed': '❌ 失败',
                'timeout': '⏱️ 超时',
                'invalid': '⚠️ 无效'
            }[test.status];

            return \`
                <div class="test-item \${statusClass}">
                    <div class="test-header">
                        <div class="test-url">\${test.url}</div>
                        <div class="test-status status-\${statusClass}">\${statusText}</div>
                    </div>
                    <div class="test-details">
                        <div class="detail-item">
                            <span class="detail-label">响应时间:</span>
                            <span class="detail-value">\${test.responseTime}ms</span>
                        </div>
                        \${test.httpStatus ? \`
                            <div class="detail-item">
                                <span class="detail-label">HTTP 状态:</span>
                                <span class="detail-value">\${test.httpStatus}</span>
                            </div>
                        \` : ''}
                        \${test.fileSize ? \`
                            <div class="detail-item">
                                <span class="detail-label">文件大小:</span>
                                <span class="detail-value">\${(test.fileSize / 1024).toFixed(2)} KB</span>
                            </div>
                        \` : ''}
                        \${test.isValidJar !== undefined ? \`
                            <div class="detail-item">
                                <span class="detail-label">有效 JAR:</span>
                                <span class="detail-value">\${test.isValidJar ? '✓ 是' : '✗ 否'}</span>
                            </div>
                        \` : ''}
                        \${test.md5 ? \`
                            <div class="detail-item">
                                <span class="detail-label">MD5:</span>
                                <span class="detail-value">\${test.md5}</span>
                            </div>
                        \` : ''}
                    </div>
                    \${test.error ? \`
                        <div class="error-message">
                            <strong>错误信息:</strong> \${test.error}
                        </div>
                    \` : ''}
                </div>
            \`;
        }
    </script>
</body>
</html>
  `;

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
    },
  });
}
