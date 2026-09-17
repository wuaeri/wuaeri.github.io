#!/usr/bin/env python3
"""从 hotspot/<topic>.json 里派生出 hotspot/latest.json —— 首屏那条切片专用的瘦身版。

═══ 为什么要单独一份，而不是首页直接拉那 300K ═══

  hotspot/aespa.json 是给热点区**完整页**用的：500 条、每条带 excerpt、
  还带 18 个源的逐条健康报告。它的职责是"什么都在里面"。
  压在首屏上不合适 —— 首屏已经有 ASCII 大字、CRT 底、那颗头颅，
  再加一个 300K 的 JSON，等于让第一屏替第二屏付账。

  latest.json 只干一件事：**让不点进去的人也看得见它在动。**
  所以只留最新的一小撮、砍掉 excerpt、源报告压成两个数。

  ⚠️ 两份文件必须同源同一次生成 —— 否则切片显示的条数
     和完整页里的对不上，看起来像"首页在骗人"。

由 .github/workflows/hotspot.yml 在抓取之后紧接着跑。
本地想重新生成：python3 scripts/make_latest.py
"""
import json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
TOPIC = "aespa"
SRC = os.path.join(ROOT, "hotspot", TOPIC + ".json")
DST = os.path.join(ROOT, "hotspot", "latest.json")

# 切片取几条。前端要把它复制两份做无缝循环，所以这个数直接决定
# marquee 那条合成层有多宽 —— 12 条约 6000px，一份滚完要两分半，
# 已经够"看不到头"了。再多只是让宽到 20000px 的元素在那儿平移。
N = 12


def main():
    with open(SRC, encoding="utf-8") as f:
        doc = json.load(f)

    items = doc.get("items") or []
    status = doc.get("sources") or []
    ok_n = sum(1 for s in status if s.get("ok") and not s.get("skipped"))

    out = {
        "topic": doc.get("topic", TOPIC),
        "updated": doc.get("updated", ""),
        "total": doc.get("total", len(items)),
        # 健康度压成两个数。前端拿这两个数跟 updated 一起判断
        # "这条带该不该显得还活着" —— 源全挂的时候不该还在那儿优雅地滚。
        "ok": ok_n,
        "sources": len(status),
        "items": [
            {
                "title": it.get("title", ""),
                "url": it.get("url", ""),
                "date": it.get("date", ""),
                "source": it.get("source", ""),
            }
            for it in items[:N]
        ],
    }

    with open(DST, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
        f.write("\n")

    size = os.path.getsize(DST)
    print("→ %s  %d 条 / %d 源可用 / %.1f KB"
          % (DST, len(out["items"]), ok_n, size / 1024.0))
    return 0


if __name__ == "__main__":
    sys.exit(main())
