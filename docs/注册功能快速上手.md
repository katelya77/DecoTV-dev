# 用户注册功能

## 启用方法

### 本地开发

配置 `.env.local`：

```bash
NEXT_PUBLIC_STORAGE_TYPE=redis
NEXT_PUBLIC_ENABLE_REGISTRATION=true
REDIS_URL=redis://localhost:6379
```

### 生产部署

在部署平台添加环境变量：

```bash
NEXT_PUBLIC_STORAGE_TYPE=upstash
NEXT_PUBLIC_ENABLE_REGISTRATION=true
UPSTASH_URL=your_upstash_url
UPSTASH_TOKEN=your_token
```

然后重新部署。

## 功能说明

- 图形验证码防护
- 实时表单验证
- 用户名：3-20 字符
- 密码：至少 6 位

## 使用建议

注册完成后建议关闭：

```bash
NEXT_PUBLIC_ENABLE_REGISTRATION=false
```
