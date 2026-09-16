# 热点区 · 信息源配置

三步，全部 **¥0**。做完填进 GitHub Secrets，代码会自动认，**不用改一行**。

---

## 一、Naver 新闻 API —— 你最看重的那条线，先做这个

**韩国媒体覆盖最全的一路，而且最稳。** 去 https://developers.naver.com/apps/#/register

1. 应用名随便填
2. **권한(权限)勾「검색」(搜索)** ← 别勾错，勾错拿不到新闻
3. 建完拿 **Client ID** 和 **Client Secret**

填进 Secrets：
```
NAVER_CLIENT_ID     = ...
NAVER_CLIENT_SECRET = ...
```

**成本 ¥0**，免费配额一天 25000 次，我们一天跑 12 次。

> 顺带说一个实测结论：**韩国媒体直接抓这条路基本已经死了。**
> newsen 404 / news1 403 / osen 返 8 字节空壳 / mydaily 302，
> 还活着的只有 `sports.donga.com`（已加进源）。
> **所以 Naver API 不是"锦上添花"，它是韩文线的正路。**

---

## 二、RSSHub 自建 —— 现在只为韩国的**社区层**

### ⚠️ 先更正我之前说错的地方

我原来推荐它是因为 **Weverse**。嘉豪指出：**成员除了直播基本不用 Weverse**，
那条路由的价值不成立。**Weverse 已从源里拿掉。**

那 RSSHub 现在还剩什么用？**韩国的社区层** —— theqoo、instiz、dcinside 这些
韩国人真正在讨论的地方。它们**没有 API、没有 RSS、反爬**，
是 RSSHub 唯一还站得住的价值。

### 公共实例用不了

**`rsshub.app` 被 Cloudflare 挡了**（403 `Just a moment...`）——
不是慢，是脚本和 GitHub Actions 都**根本连不上**。所以自建是必须的。

### 部署（选一个）

**A · Vercel** —— fork `https://github.com/DIYgod/RSSHub` → Vercel New Project
→ 选你 fork 的仓库 → Deploy。拿到形如 `https://rsshub-xxx.vercel.app` 的域名。

**B · Docker** —— `docker run -d -p 1200:1200 diygod/rsshub`

### 填进 Secrets

```
RSSHUB_BASE = https://rsshub-xxx.vercel.app
```

填了会自动加上 `theqoo` / `instiz` 两条源（也已经预留了 X 的位置）。

### ⚠️ 这两条我验不了

公共实例被挡，我本地也没有实例，所以 **theqoo / instiz 的路由我没法在本地验**。
部署完跑一次就知道 —— **跑不通它会如实报 FAIL 连原因一起写进 JSON，不会假装。**

### 关于 X

**X 在 2023 年掐了免费接口之后，RSSHub 的 Twitter 路由要配 `TWITTER_AUTH_TOKEN`**
（你自己的登录态），而且**会过期、会掉**。
能通，但它是"需要照看的东西"，不是设完不管。**想要就配，做好它会时不时挂的准备。**

---

## 三、YouTube Data API —— 按时间搜全量，不止最近 15 条

1. 去 https://console.cloud.google.com/ → 新建项目
2. 「API 和服务」→ 启用 **YouTube Data API v3**
3. 「凭据」→ 创建 **API 密钥**

填进 Secrets：
```
YOUTUBE_API_KEY = ...
```

**成本：¥0。** 免费配额 10000 单位/天，一次 search 花 100 —— 一天跑十几次都够。

---

## 怎么填 GitHub Secrets

仓库 → **Settings → Secrets and variables → Actions → New repository secret**

每个 key 单独加一条，名字**必须**和上面写的完全一致（代码是按名字取的）。

---

## 填完怎么验

```bash
# 本地带 key 跑一遍，看那两个源从 SKIP 变成 OK
NAVER_CLIENT_ID=xxx NAVER_CLIENT_SECRET=yyy YOUTUBE_API_KEY=zzz \
RSSHUB_BASE=https://rsshub-xxx.vercel.app \
python3 scripts/fetch_hotspot.py
```

或者直接去 **Actions → hotspot → Run workflow** 手动触发一次。

**看输出的那几行就够了** —— 每个源都会打印 `OK` / `FAIL` / `SKIP`，
失败的还会带上原因。库里也会如实记下来，页面上的检查点读的就是这个。

---

## 成本总账

| 项 | 每天 |
|---|---|
| 现有 14 条免费源（Google News ×9 / YouTube / Reddit / Soompi / Billboard / 体育东亚） | **¥0** |
| RSSHub（Vercel 免费层或自建 Docker） | **¥0** |
| Naver 新闻 API | **¥0** |
| YouTube Data API | **¥0** |
| GitHub Actions + Pages（公开仓库） | **¥0** |
| **合计** | **¥0** |

嘉豪的红线是 ¥0.5/天。**全部打开也碰不到。**
