# OrionTV 使用指南

## 📱 关于 OrionTV

OrionTV 是一个基于 React Native TVOS 和 Expo 构建的播放器，支持 Apple TV 和 Android TV。

**重要提示**：从 OrionTV 1.2.x 版本开始，需要配合 MoonTV/LunaTV 后端使用。DecoTV 基于 LunaTV 二次开发，完全兼容 OrionTV。

## ✅ 支持的版本

- ✅ **OrionTV 1.3.11**（最新版本，推荐）
- ✅ **OrionTV 1.3.7**
- ✅ **OrionTV 1.2.x 及以上所有版本**

## 🚀 快速开始

### 步骤 1：配置 API 地址

1. 打开 OrionTV 应用
2. 进入 **设置** 页面
3. 找到 **API 地址** 配置项
4. 输入你的 DecoTV 部署地址（**完整 URL，包括 https://**）
   ```
   https://your-domain.com
   ```
5. 点击 **保存**

### 步骤 2：登录认证

DecoTV 支持两种认证模式：

#### LocalStorage 模式（访问密码）

适用于个人使用、单用户场景：

1. 在 OrionTV 登录页面
2. **用户名**：留空或随意填写
3. **密码**：输入你在环境变量中设置的 `PASSWORD`
4. 点击 **登录**

#### 数据库模式（用户名+密码）

如果使用了 Redis/Upstash/KVRocks 存储：

1. 在 OrionTV 登录页面
2. **用户名**：输入你的用户名
3. **密码**：输入对应的密码
4. 点击 **登录**

### 步骤 3：开始使用

登录成功后即可：

- 🏠 浏览首页推荐内容
- 🔍 搜索影视资源
- ▶️ 播放视频
- ⭐ 管理收藏和播放记录

## 🔧 DecoTV 提供的 API

DecoTV 为 OrionTV 提供完整的 LunaTV 兼容 API：

| API 端点                | 用途           | 需要认证 |
| ----------------------- | -------------- | -------- |
| `/api/login`            | 用户登录       | ❌       |
| `/api/server-config`    | 获取服务器配置 | ✅       |
| `/api/search/resources` | 获取视频源列表 | ✅       |
| `/api/search/one`       | 在指定源搜索   | ✅       |
| `/api/detail`           | 获取视频详情   | ✅       |
| `/api/douban`           | 获取豆瓣数据   | ✅       |
| `/api/favorites`        | 收藏管理       | ✅       |
| `/api/playrecords`      | 播放记录       | ✅       |
| `/api/searchhistory`    | 搜索历史       | ✅       |
| `/api/image-proxy`      | 图片代理       | ✅       |

### API 示例

**获取视频源列表**：

```http
GET https://your-domain.com/api/search/resources
```

**搜索视频**：

```http
GET https://your-domain.com/api/search/one?q=斗罗大陆&resourceId=dyttzy
```

## 🐛 常见问题

### Q1: OrionTV 提示"请检查网络或者服务器地址是否可用"

**可能原因**：

1. ❌ API 地址填写错误
2. ❌ 未登录或登录失败
3. ❌ 网络连接问题
4. ❌ DecoTV 后端未正常运行

**解决方法**：

1. ✅ 检查 API 地址是否包含 `https://` 前缀
2. ✅ 确认已成功登录（查看 OrionTV 设置页面）
3. ✅ 在浏览器中访问 `https://your-domain.com/api/server-config` 测试后端
4. ✅ 检查 DecoTV 后端日志（Vercel/ClawCloud 控制台）

### Q2: 登录失败，提示 401 Unauthorized

**LocalStorage 模式**：

- 确认密码与环境变量 `PASSWORD` 一致

**数据库模式**：

- 确认用户名和密码正确
- 检查环境变量 `NEXT_PUBLIC_STORAGE_TYPE` 是否正确配置

### Q3: 可以登录但看不到视频源

**解决方法**：

1. 在 DecoTV 管理后台配置视频源（配置文件中的 `api_site`）
2. 确认用户有权限访问这些视频源
3. 在浏览器中访问 `https://your-domain.com/api/search/resources` 测试

### Q4: 视频播放失败

**可能原因**：

- 视频源失效
- 网络问题
- 视频格式不兼容

**解决方法**：

1. 尝试切换其他视频源
2. 检查网络连接
3. 更新 OrionTV 到最新版本

### Q5: 播放记录能同步吗？

✅ **完全支持**！OrionTV 和 DecoTV Web 端的收藏、播放记录、搜索历史实时同步。

## 🔐 安全说明

### 认证机制

OrionTV 使用 Cookie-based 认证：

1. 登录时通过 `/api/login` 获取认证 Cookie
2. 后续请求自动携带 Cookie
3. Cookie 有效期 7 天（默认）

### CORS 支持

DecoTV 的 OrionTV 兼容 API 已添加完整 CORS 支持：

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS
Access-Control-Allow-Headers: Content-Type, Cookie
```

## 🎯 与 TVBox 配置的区别

| 特性         | OrionTV（LunaTV API） | TVBox/CatVodBox     |
| ------------ | --------------------- | ------------------- |
| 配置方式     | API 地址 + 登录       | TVBox 配置 JSON     |
| 认证         | 需要登录              | 无需登录            |
| UI           | 现代化原生 App        | WebView/原生混合    |
| 支持平台     | Apple TV, Android TV  | Android, Android TV |
| 播放记录同步 | ✅ 支持               | ❌ 不支持           |

### 同时支持两者

DecoTV 同时提供两种方式：

1. **OrionTV API** - 适合 Apple TV 和追求现代化体验的用户
2. **TVBox 配置** (`/api/tvbox/config`) - 适合 Android 用户和传统 TVBox 客户端

你可以根据设备选择合适的客户端。

## 📝 技术细节

### 数据同步

- 收藏、播放记录、搜索历史在 OrionTV 和 DecoTV Web 端之间实时同步
- 使用相同的存储后端（LocalStorage/Redis/Upstash/KVRocks）
- 多设备登录同一账号，数据自动同步

### API 响应格式

所有 API 返回标准 JSON 格式，示例：

```json
{
  "results": [
    {
      "id": "123",
      "title": "斗罗大陆",
      "poster": "https://...",
      "episodes": ["第1集$https://...", "第2集$https://..."],
      "source": "dyttzy",
      "source_name": "电影天堂"
    }
  ]
}
```

## 📞 获取帮助

如果遇到问题，请提供以下信息：

1. OrionTV 版本号
2. DecoTV 部署方式（Vercel/ClawCloud/自托管）
3. 具体错误提示截图
4. 能否在浏览器中访问 DecoTV

## 🔗 参考链接

- [OrionTV GitHub](https://github.com/orion-lib/OrionTV)
- [LunaTV GitHub](https://github.com/MoonTechLab/LunaTV)
- [DecoTV GitHub](https://github.com/Decohererk/DecoTV)

---

**最后更新**：2025 年 10 月 26 日
