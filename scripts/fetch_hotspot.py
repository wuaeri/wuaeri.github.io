#!/usr/bin/env python3
"""抓热点区的讯息，写成 hotspot/<topic>.json。

由 .github/workflows/hotspot.yml 定时跑，结果提交回仓库 ——
静态站做"实时"的正路：**在服务器端抓，客户端只读同源的一个 JSON。**
（浏览器里直接抓 RSS 会被 CORS 挡死，这是这条路唯一的理由。）

═══ 成本（2026-09-17 核过，嘉豪的红线是 ¥0.5/天）═══

    源                                      成本
    Google News RSS（任意语言、任意条查询）    ¥0   不要 key、不要登录
    YouTube 频道 RSS                         ¥0
    Reddit .rss                              ¥0   会 429，靠退避重试
    YouTube Data API（按时间搜全量）          ¥0   免费配额 10000 单位/天，一次搜索 100
    Naver 新闻搜索 API                        ¥0   免费，注册给 key
    RSSHub 自建（接 X / Weverse / Ins）       ¥0   Vercel/Cloudflare 免费层够个人用
    GitHub Actions（公开仓库）                ¥0   定时任务额度无限
    GitHub Pages                             ¥0
    ──────────────────────────────────────────────
    合计                                     ¥0/天

    唯一会花钱的是"在 Action 里挂 LLM 做筛选/摘要"：一天约 300 条 × 200 token，
    用最便宜的模型约 **¥0.18/天** —— 也在红线内，但那是可选项，不是必需品。

═══ 设计上的第一要务：抓不到的时候说实话 ═══

  · 每个源单独记 ok / count / error / skipped / checked，**失败的源照样写进 JSON**；
  · 整份文件带 updated 时间戳；
  · 页面上的检查点读这两样，如实报"网络通不通""库里多久没更新""哪个源挂了"。

这样页面就不会在抓挂的时候显示"暂无讯息"让人以为是真没有 ——
**静默失败比失败难查得多。**

只用标准库，不需要 pip install 任何东西。
需要 key 的源：有 key 就跑，没 key 就如实记为 skipped，**不假装抓过**。
"""
import html, json, os, re, sys, time
import urllib.request, urllib.error, urllib.parse
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " \
     "(KHTML, like Gecko) Chrome/120 Safari/537.36 wuaeri-hotspot/1.0"

TOPIC = "aespa"
# 关键词：aespa 本身 + 四个成员，中英韩三种写法都收
# （免得漏掉只提成员的稿子，也免得韩文/中文标题被纯拉丁关键词筛掉）
KEYWORDS = re.compile(
    r"aespa|karina|giselle|winter|ningning|yizhuo|"
    r"에스파|카리나|지젤|윈터|닝닝|"
    r"柳智敏|金冬天|宁艺卓|内永亚绘里", re.I)

STRIP_TAGS = re.compile(r"<[^>]+>")

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(HERE), "hotspot", TOPIC + ".json")

GN = "https://news.google.com/rss/search?q=%s&hl=%s&gl=%s&ceid=%s"


def gn(q, hl, gl, ceid):
    return GN % (urllib.parse.quote(q), hl, gl, ceid)


# ── 免费源 ──
# 加源就在这里加一行。**不保证它们一直活着** —— 这正是要逐条记状态的原因。
SOURCES = [
    # ★ 主角是聚合器，不是单站 feed。
    #   单站 RSS 覆盖一个话题永远稀（Soompi 60 条里只有 1 条提 aespa）；
    #   Google News 的搜索 RSS 一家就聚合几千家媒体，而且能按语言分别查。
    #   trust=True 表示"这条查询本身就是筛选"，不再过关键词。
    {"name": "GNews 英",   "trust": True, "url": gn("aespa", "en-US", "US", "US:en")},
    {"name": "GNews 韩",   "trust": True, "url": gn("aespa", "ko", "KR", "KR:ko")},
    {"name": "GNews 中",   "trust": True, "url": gn("aespa", "zh-CN", "CN", "CN:zh-Hans")},
    {"name": "GNews 日",   "trust": True, "url": gn("aespa", "ja", "JP", "JP:ja")},
    # 再加两条"窄查询"：按时间窗、按成员名，抓通用稿写不到的角度
    {"name": "GNews 近两日", "trust": True,
     "url": gn("aespa when:2d", "en-US", "US", "US:en")},
    {"name": "GNews 成员",  "trust": True,
     "url": gn("aespa (Karina OR Winter OR Giselle OR Ningning)", "en-US", "US", "US:en")},

    # ★ 韩文关键词。之前只查拉丁文 `aespa`，但韩国人写「에스파」——
    #   这是把"韩国媒体"那条线真正做厚的一刀。
    {"name": "GNews 에스파", "trust": True, "url": gn("에스파", "ko", "KR", "KR:ko")},
    {"name": "GNews 에스파·成员", "trust": True,
     "url": gn("에스파 (카리나 OR 윈터 OR 지젤 OR 닝닝)", "ko", "KR", "KR:ko")},
    {"name": "GNews 近一日", "trust": True, "url": gn("에스파 when:1d", "ko", "KR", "KR:ko")},

    # 官方直发
    {"name": "YouTube · aespa", "url":
     "https://www.youtube.com/feeds/videos.xml?channel_id=UC9GtSLeksfK4yuJ_g1lgQbg"},

    # 粉丝社区。⚠️ 它的 .json 接口是 403，**.rss 通**，但会 429 —— 靠退避重试。
    {"name": "Reddit r/aespa", "trust": True, "retry": 3,
     "url": "https://www.reddit.com/r/aespa/.rss"},

    # ★ Naver 搜索直抓 —— 韩文线的正路。
    #   **不需要 API key、不需要注册、没有反爬。**
    #   嘉豪在 Naver 开放平台那个韩文表单上卡了半小时，结果是根本不用填。
    #   nso=so%3Add = 按时间倒序，所以拿到的就是最新的。
    {"name": "Naver 뉴스", "trust": True, "type": "naver", "cat": "news"},
    {"name": "Naver 카페", "trust": True, "type": "naver_cafe"},

    # 行业媒体（覆盖宽且稀疏，留着兜底）
    {"name": "Soompi",    "url": "https://www.soompi.com/feed"},
    {"name": "Billboard", "url": "https://www.billboard.com/feed/"},
    # 韩国媒体直连 —— 大部分韩国站这几年把 RSS 关了
    # （newsen 404 / news1 403 / osen 返 8 字节空壳），这家还活着。
    {"name": "体育东亚", "url": "https://sports.donga.com/rss/"},
]

# ── RSSHub 自建实例（填了 RSSHUB_BASE 才启用）──
# 为什么要自建：**公共实例 rsshub.app 被 Cloudflare 挡了**（403），
# 脚本和 Actions 都连不上。
# 为什么它值钱：Weverse 的接口要 wpf/wmd/wmsgpad 三个**请求签名参数**
# （直接 curl 得到 wam_403 Malformed parameters），而 RSSHub 把那套签名实现掉了。
# 成员在 Weverse 上发的帖是一手得不能再一手的东西。
RSSHUB = os.environ.get("RSSHUB_BASE", "").rstrip("/")
if RSSHUB:
    SOURCES += [
        # ⚠️ Weverse 已放弃（嘉豪：成员除了直播不用它）。
        #    现在要的是**韩国人真正在讨论的地方** —— theqoo / instiz 那种，
        #    它们没有 API、没有 RSS、反爬，是 RSSHub 唯一还值钱的理由。
        #    这两条我**没法在本地验**（公共实例被 Cloudflare 挡），
        #    部署完跑一次就知道 —— 跑不通它会如实报 FAIL，不会假装。
        {"name": "RSSHub · theqoo", "trust": True, "url": RSSHUB + "/theqoo/jungbo"},
        {"name": "RSSHub · instiz", "trust": True, "url": RSSHUB + "/instiz/chart"},
        # ⚠️ X 路由需要 TWITTER_AUTH_TOKEN，而且登录态会过期 —— 能通，但要照看。
        {"name": "RSSHub · X", "trust": True, "url": RSSHUB + "/twitter/user/aespa_official"},
    ]


def fetch(url, timeout=25, retry=0):
    """带退避的重试。只有 429 / 5xx 才重试 —— 其它 4xx 是真错，重试没意义。"""
    last = None
    for i in range(retry + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            last = e
            if e.code not in (429, 500, 502, 503, 504):
                raise
        except Exception as e:
            last = e
        if i < retry:
            time.sleep(2 ** i)          # 1s, 2s, 4s…
    raise last


def local(tag):
    return tag.rsplit("}", 1)[-1]


def parse_feed(raw):
    """RSS 2.0 / Atom 通吃。返回 [{title,url,date,excerpt}]。

    ⚠️ 按**本地名**匹配，不按命名空间。
       Atom 的标签是 `{http://www.w3.org/2005/Atom}entry`，
       写 `.//entry` 是匹配不到的 —— YouTube 那 15 条就是这么被吃掉过的
       （症状是"连上了但 0 条"）。各家 feed 的命名空间五花八门，认本地名最省事。
    """
    root = ET.fromstring(raw)
    A = "{http://www.w3.org/2005/Atom}"

    def find(el, name):
        v = el.findtext(name)
        if v is None:
            v = el.findtext(A + name)
        return (v or "").strip()

    out = []
    for el in root.iter():
        if local(el.tag) not in ("item", "entry"):
            continue
        link = find(el, "link")
        if not link:                       # Atom 的链接在属性里
            for l in el.iter():
                if local(l.tag) == "link" and l.get("href"):
                    link = l.get("href")
                    break
        out.append({
            "title":   find(el, "title"),
            "url":     link,
            "date":    find(el, "pubDate") or find(el, "published") or find(el, "updated"),
            "excerpt": STRIP_TAGS.sub(" ", find(el, "description") or find(el, "summary"))
                       [:280].strip(),
        })
    return [x for x in out if x["title"]]


NAVER_CAT = {
    "news": ("m_news", "뉴스"),
    "cafe": ("m_cafe", "카페"),
    "blog": ("m_blog", "블로그"),
}
NAVER_UA = ("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
            "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1")


def naver_rel_to_iso(txt):
    """Naver 给的是相对时间（'3시간 전' / '2일 전'）。转成 ISO。
    转不了就返回空 —— 不编一个假时间。"""
    m = re.match(r"\s*(\d+)\s*(분|시간|일|주|개월|년)\s*전", txt or "")
    if not m:
        return ""
    n, u = int(m.group(1)), m.group(2)
    secs = {"분": 60, "시간": 3600, "일": 86400, "주": 604800,
            "개월": 2592000, "년": 31536000}.get(u)
    if not secs:
        return ""
    return datetime.fromtimestamp(time.time() - n * secs, timezone.utc).isoformat(timespec="seconds")


def parse_naver(html, cat):
    """解析 m.search.naver.com 的搜索结果页。

    ★ 这条路是 2026-09-17 挖出来的，**它是 Naver 官方 API 的完全替代**：
      不需要 Client ID / Secret、不需要注册、没有反爬、没有分页 key。
      页面里嵌着结构化 JSON（templateId: newsItem），逐条能拆出
      标题 / 链接 / 媒体 / 相对时间 / 摘要。
      URL 里的 `nso=so%3Add` 是**按时间倒序** —— 所以拿到的就是最新的。

    做法：每遇到一个 "templateId":"newsItem" 就往前开一个窗口，
    在窗口里取**最后出现的**那组 title/titleHref（那就是这条自己的，
    前面那些是上一条的）。窗口式解析对结构微调有容忍度，比整体 JSON.parse 稳。
    """
    out = []
    for m in re.finditer(r'"templateId":"newsItem"', html):
        seg = html[max(0, m.start() - 8000):m.start()]
        ts = list(re.finditer(r'"title":"((?:[^"\\]|\\.)*)","titleHref":"([^"]*)"', seg))
        if not ts:
            continue
        raw_title, href = ts[-1].group(1), ts[-1].group(2)
        sm = list(re.finditer(r'"subTexts":\[\{"text":"([^"]*)"\}\],"title":"([^"]*)"', seg))
        press, when = (sm[-1].group(2), sm[-1].group(1)) if sm else ("", "")
        cm = list(re.finditer(r'"content":"((?:[^"\\]|\\.)*)"', seg))
        excerpt = cm[-1].group(1) if cm else ""
        try:                                    # JSON 转义还原
            raw_title = json.loads('"' + raw_title + '"')
            excerpt = json.loads('"' + excerpt + '"')
        except Exception:
            pass
        title = STRIP_TAGS.sub("", raw_title).replace("<mark>", "").replace("</mark>", "").strip()
        if not title or not href:
            continue
        out.append({
            "title": title[:160],
            "url": href,
            "date": naver_rel_to_iso(when),
            "excerpt": STRIP_TAGS.sub(" ", excerpt)[:280].strip(),
            "source": "Naver %s" % NAVER_CAT[cat][1],
        })
    return out


def fetch_naver(cat):
    mtab, _ = NAVER_CAT[cat]
    u = ("https://m.search.naver.com/search.naver?ssc=tab.%s.all&where=%s"
         "&sm=mtb_jum&query=%s&nso=so%%3Add" % (mtab, mtab, urllib.parse.quote("에스파")))
    req = urllib.request.Request(u, headers={
        "User-Agent": NAVER_UA, "Referer": "https://m.search.naver.com/",
        "Accept-Language": "ko-KR,ko;q=0.9"})
    with urllib.request.urlopen(req, timeout=25) as r:
        return parse_naver(r.read().decode("utf-8", "replace"), cat)


# ── Naver 카페 ──
# 这是**社区层**：粉丝真正在聊什么。跟 뉴스 是两套页面结构。
# 뉴스 用内嵌 JSON（templateId），카페 用服务端渲染的 HTML。
# 容器：<ul class="lst_view"> 里的 <li class="bx" data-index="N">
# ▼ 二手交易板要滤掉 —— 중고나라（跳蚤市场）会混进来一堆"卖小卡 20000원"，
#   那不是讨论，是噪音。实测 30 条里能占 2 条左右。
MARKETPLACE = {"joonggonara", "joongna", "cafe_alba", "bunjang"}


def parse_naver_cafe(page):
    out = []
    idx = [m.start() for m in re.finditer(r'<li class="bx" data-index="\d+"', page)]
    for k, i in enumerate(idx):
        j = idx[k + 1] if k + 1 < len(idx) else i + 6000
        seg = page[i:j]

        m = re.search(r'data-url="https://cafe\.naver\.com/([\w-]+)/(\d+)"', seg)
        if not m:
            continue
        cafe, aid = m.group(1), m.group(2)
        if cafe.lower() in MARKETPLACE:
            continue                       # 二手交易，不是讨论

        t = re.search(r'class="title_link"[^>]*>(.*?)</a>', seg, re.S)
        if not t:
            t = re.search(r'class="tit"[^>]*>(.*?)</a>', seg, re.S)
        if not t:
            continue
        title = STRIP_TAGS.sub("", t.group(1))
        title = re.sub(r'\s+', ' ', html.unescape(title)).strip()

        txt = re.sub(r'\s+', ' ', html.unescape(STRIP_TAGS.sub(" ", seg)))
        when = ""
        tm = re.search(r'(\d+)\s*(분|시간|일|주)\s*전', txt)
        if tm:
            when = tm.group(0)

        # 摘要：跳过前面那截 Keep 收藏按钮的 UI
        body = txt.split("레이어 닫기", 1)[-1] if "레이어 닫기" in txt else txt
        body = body.strip()
        excerpt = body[len(title):].strip()[:280] if body.startswith(title) else body[:280]

        if not title:
            continue
        out.append({
            "title": title[:160],
            "url": "https://cafe.naver.com/%s/%s" % (cafe, aid),
            "date": naver_rel_to_iso(when),
            "excerpt": excerpt,
            "source": "Naver 카페",
        })
    return out


def norm_date(s):
    """尽量转成 ISO。转不了就原样留着 —— 不编一个假日期出来。"""
    if not s:
        return ""
    for fmt in ("%a, %d %b %Y %H:%M:%S %z", "%a, %d %b %Y %H:%M:%S %Z",
                "%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%dT%H:%M:%SZ"):
        try:
            return datetime.strptime(s.strip(), fmt).astimezone(timezone.utc).isoformat()
        except ValueError:
            pass
    return s.strip()


# ── 需要 key 的源 ──
# 有 key 就跑；没 key 就如实记 skipped —— **不假装抓过**。
def keysrc_youtube(now):
    """YouTube Data API：按时间搜"aespa"，比频道 RSS 的最近 15 条全得多。
    免费配额 10000 单位/天，一次 search 花 100 —— 一天跑十几次都够。"""
    key = os.environ.get("YOUTUBE_API_KEY")
    rec = {"name": "YouTube API", "trust": True, "checked": now, "skipped": not bool(key),
           "ok": False, "count": 0, "error": "", "url": "youtube/v3/search"}
    if not key:
        rec["error"] = "没有 YOUTUBE_API_KEY"
        return rec, []
    try:
        u = ("https://www.googleapis.com/youtube/v3/search?part=snippet&type=video"
             "&order=date&maxResults=25&q=" + urllib.parse.quote("aespa") + "&key=" + key)
        d = json.loads(fetch(u))
        items = [{
            "title": (it["snippet"]["title"] or "")[:160],
            "url": "https://www.youtube.com/watch?v=" + it["id"]["videoId"],
            "date": it["snippet"]["publishedAt"],
            "excerpt": it["snippet"].get("channelTitle", ""),
            "source": "YouTube API",
        } for it in d.get("items", [])]
        rec["ok"] = True
        rec["count"] = len(items)
        return rec, items
    except Exception as ex:
        rec["error"] = "%s: %s" % (type(ex).__name__, str(ex)[:160])
        return rec, []


def keysrc_naver(now):
    """Naver 新闻搜索：韩国媒体覆盖最全的一路。免费，注册给 key。"""
    cid, csec = os.environ.get("NAVER_CLIENT_ID"), os.environ.get("NAVER_CLIENT_SECRET")
    rec = {"name": "Naver 新闻", "trust": True, "checked": now,
           "skipped": not (cid and csec), "ok": False, "count": 0, "error": "",
           "url": "openapi.naver.com/v1/search/news.json"}
    if not (cid and csec):
        rec["error"] = "没有 NAVER_CLIENT_ID / SECRET"
        return rec, []
    try:
        u = ("https://openapi.naver.com/v1/search/news.json?display=50&sort=date&query="
             + urllib.parse.quote("에스파"))
        req = urllib.request.Request(u, headers={
            "X-Naver-Client-Id": cid, "X-Naver-Client-Secret": csec, "User-Agent": UA})
        with urllib.request.urlopen(req, timeout=25) as r:
            d = json.loads(r.read())
        items = [{
            "title": STRIP_TAGS.sub("", it.get("title", ""))[:160],
            "url": it.get("originallink") or it.get("link", ""),
            "date": norm_date(it.get("pubDate", "")),
            "excerpt": STRIP_TAGS.sub(" ", it.get("description", ""))[:280].strip(),
            "source": "Naver 新闻",
        } for it in d.get("items", [])]
        rec["ok"] = True
        rec["count"] = len(items)
        return rec, items
    except Exception as ex:
        rec["error"] = "%s: %s" % (type(ex).__name__, str(ex)[:160])
        return rec, []


def main():
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    status, items = [], []

    for s in SOURCES:
        rec = {"name": s["name"], "url": s.get("url", "naver search"), "checked": now,
               "trust": bool(s.get("trust")), "skipped": False,
               "ok": False, "count": 0, "error": ""}
        try:
            if s.get("type") == "naver":
                entries = fetch_naver(s["cat"])
            elif s.get("type") == "naver_cafe":
                req = urllib.request.Request(
                    "https://m.search.naver.com/search.naver?ssc=tab.m_cafe.all&where=m_cafe"
                    "&sm=mtb_jum&query=%s&nso=so%%3Add" % urllib.parse.quote("에스파"),
                    headers={"User-Agent": NAVER_UA, "Referer": "https://m.search.naver.com/",
                             "Accept-Language": "ko-KR,ko;q=0.9"})
                with urllib.request.urlopen(req, timeout=25) as r:
                    entries = parse_naver_cafe(r.read().decode("utf-8", "replace"))
                if not entries:
                    # 连上了但一条没解出来 —— 这**不是**"没新闻"，
                    # 是我的解析器不认这张页面。必须如实报失败：
                    # 记成 OK 0 读起来像"源是好的、只是没内容"，那是假的。
                    raise RuntimeError("结构没解析出条目（카페/블로그 是服务端渲染的 HTML，"
                                       "跟 뉴스 的内嵌 JSON 不是一套，还需再对模板）")
            else:
                entries = parse_feed(fetch(s["url"], retry=s.get("retry", 0)))
            rec["ok"] = True
            rec["count"] = len(entries)
            for e in entries:
                if s.get("trust") or KEYWORDS.search(e["title"] + " " + e["excerpt"]):
                    items.append({
                        "title":   e["title"][:160],
                        "url":     e["url"],
                        "date":    norm_date(e["date"]),
                        "excerpt": e["excerpt"],
                        "source":  s["name"],
                    })
        except Exception as ex:
            rec["error"] = "%s: %s" % (type(ex).__name__, str(ex)[:160])
        status.append(rec)
        print("  %-18s %s  %s" % (s["name"], "OK" if rec["ok"] else "FAIL",
                                  rec["count"] if rec["ok"] else rec["error"]))

    for fn in (keysrc_naver, keysrc_youtube):
        rec, got = fn(now)
        status.append(rec)
        items.extend(got)
        print("  %-18s %s  %s" % (rec["name"],
              "SKIP" if rec["skipped"] else ("OK" if rec["ok"] else "FAIL"),
              rec["count"] if rec["ok"] else rec["error"]))

    # 去重（去掉查询串，同一个链接只留一条）+ 按日期倒序
    seen, uniq = set(), []
    for it in items:
        k = (it["url"] or it["title"]).split("?")[0]
        if k in seen:
            continue
        seen.add(k)
        uniq.append(it)
    uniq.sort(key=lambda x: x["date"] or "", reverse=True)

    # 条目上限：原来写死 120，是随手留的，结果页面上只有 120 条、
    # 而库里其实有 686 —— 嘉豪一眼就看出来了。
    # 现在放宽到 500：JSON 从 76K 涨到约 430K，静态站压一下没问题。
    doc = {"topic": TOPIC, "updated": now, "rsshub": bool(RSSHUB),
           "total": len(uniq), "sources": status, "items": uniq[:500]}
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)
        f.write("\n")

    ok_n = sum(1 for s in status if s["ok"])
    skip_n = sum(1 for s in status if s["skipped"])
    print("→ %s  %d 可用 / %d 跳过 / 共 %d 源，%d 条"
          % (OUT, ok_n, skip_n, len(status), len(uniq)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
