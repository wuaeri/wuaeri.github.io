/* ============================================================
   hotspot.js —— 热点区

   顺序：**先检查，再放人。**

   检查点要报的是**真话**：网络通不通、讯息库多久没更新、
   哪个源挂了、抓回来多少条 —— 全部来自那一次真实的 fetch。
   不编数字，不假装一切正常。

   ⚠️ 抓不到的时候**照样放人**，但把失败如实写在脸上。
      把访客挡在门外解决不了任何问题，而且他会以为是站坏了。
   ============================================================ */
(function () {
  'use strict';

  var DATA = './aespa.json';
  var $ = function (s) { return document.querySelector(s); };

  /* ── 分层：同一个话题，三个来源层，读起来是不一样的 ──
     媒体 = 别人写的稿子；社区 = 粉丝自己在聊；官方 = 本人/公司发的。
     用户想看的是哪一层，取决于他此刻关心什么 —— 所以给筛选。 */
  function layerOf(src) {
    if (/Reddit|카페/.test(src)) return 'community';
    if (/YouTube/.test(src)) return 'official';
    return 'media';
  }
  var LAYER_NAME = { media: '媒体', community: '社区', official: '官方' };

  /* 相对时间。用真实时间戳算，算不出来就老老实实空着。 */
  function ago(iso) {
    if (!iso) return '';
    var t = Date.parse(iso);
    if (isNaN(t)) return '';
    var h = (Date.now() - t) / 3600000;
    if (h < 0) return '刚刚';
    if (h < 1) return Math.max(1, Math.round(h * 60)) + ' 分钟前';
    if (h < 24) return Math.round(h) + ' 小时前';
    var d = Math.round(h / 24);
    return d === 1 ? '昨天' : d + ' 天前';
  }
  function hoursAgo(iso) {
    var t = Date.parse(iso);
    return isNaN(t) ? null : (Date.now() - t) / 3600000;
  }

  var state = { items: [], filter: 'all' };

  /* ══════════ 检查点 ══════════ */
  function row(id, val, cls) {
    var el = document.getElementById(id);
    el.classList.add('on');
    el.classList.remove('ok', 'bad');
    if (cls) el.classList.add(cls);
    el.querySelector('.v').innerHTML = val;
    return new Promise(function (r) { setTimeout(r, 260); });   // 逐条点亮，别一瞬间全出来
  }

  function startGrid() {
    if (!window.GridScan) return null;
    try {
      return window.GridScan.init(document.getElementById('grid'), {
        sensitivity: 0.55, lineThickness: 1, linesColor: '#2F293A', gridScale: 0.1,
        scanColor: '#FF9FFC', scanOpacity: 0.4, bloomIntensity: 0.6,
        noiseIntensity: 0.01, lineJitter: 0.1, scanGlow: 0.5, scanSoftness: 2
      });
    } catch (e) { return null; }
  }

  var plasma = null;
  function enter() {
    var check = document.getElementById('check');
    check.classList.add('gone');
    document.body.classList.add('in');

    /* 等离子**进门之后才启动**。
       放在检查点前面启动的话，它会跟 GridScan 抢 GPU，
       而且进门之前根本看不见 —— 白烧。 */
    if (!plasma && window.Plasma) {
      try {
        plasma = window.Plasma.init(document.getElementById('plasma'), {
          color: '#C6CCD4',   // 铬色：冷调银，跟站内 --pulse/--warm 同一个语系
          speed: 1, direction: 'forward', scale: 1, opacity: 1,
          mouseInteractive: false, renderScale: 0.55, maxDpr: 1.5,
          targetFps: 30, iterations: 60
        });
        if (plasma && !plasma.ok) console.warn('[hotspot] 等离子没起来：', plasma.why);
      } catch (e) { console.warn('[hotspot] 等离子没起来：', e); }
    }
    setTimeout(function () {
      check.style.display = 'none';
      document.body.style.overflow = '';
    }, 1000);
  }

  function boot() {
    document.body.style.overflow = 'hidden';
    var grid = startGrid();
    var check = document.getElementById('check');
    if (grid) check.classList.add('scanning');

    /* ═══ 两道兜底：绝不允许空白 ═══
       ① fetch 加超时 —— 没超时的话网络一挂，检查点会永远转下去；
       ② 6 秒还没进门就强制放人 —— 跟首页那条同一个道理：
          **内容永远比效果重要**。 */
    var ctl = window.AbortController ? new AbortController() : null;
    var to = setTimeout(function () { if (ctl) ctl.abort(); }, 5000);
    setTimeout(function () {
      if (!document.body.classList.contains('in')) {
        console.warn('[hotspot] 检查点没走完，强制放人');
        enter();
      }
    }, 6000);

    fetch(DATA, { cache: 'no-store', signal: ctl ? ctl.signal : undefined })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (d) {
        clearTimeout(to);
        state.items = d.items || [];
        var srcs = d.sources || [];
        var okN = srcs.filter(function (s) { return s.ok; }).length;
        var failN = srcs.filter(function (s) { return !s.ok && !s.skipped; }).length;
        var skipN = srcs.filter(function (s) { return s.skipped; }).length;
        var h = hoursAgo(d.updated);

        render(d, srcs, okN, failN, skipN);

        return row('r-net', '✓ 通', 'ok')
          .then(function () {
            var txt = h == null ? '时间未知' : (h < 1 ? '刚刚更新' : Math.round(h) + ' 小时前更新');
            var cls = (h != null && h > 24) ? 'bad' : 'ok';
            return row('r-fresh', txt, cls);
          })
          .then(function () {
            var t = okN + ' / ' + srcs.length + ' 可用';
            if (failN) t += '　' + failN + ' 个挂了';
            if (skipN) t += '　' + skipN + ' 个未配';
            return row('r-src', t, failN ? 'bad' : 'ok');
          })
          .then(function () { return row('r-items', state.items.length + ' 条', 'ok'); })
          .then(function () {
            /* ═══ 手动进入 ═══
               检查跑完**不自动放人** —— 要访客自己按。
               自动通过的话这一屏就只是段 loading 动画；
               按一下，这一屏才成为一道"门"。
               （跟作品页那道来客验证门是同一套做法。） */
            var p = document.getElementById('pass');
            p.textContent = '进入热点区';
            p.classList.add('on', 'ready');
            p.addEventListener('click', enter);
            p.addEventListener('keydown', function (e) {
              if (e.key === 'Enter' || e.key === ' ') enter();
            });
            p.setAttribute('tabindex', '0');
            p.setAttribute('role', 'button');
            p.focus();
          });
      })
      .catch(function (e) {
        clearTimeout(to);
        // **抓不到也放人**，但要说清楚。挡在门外解决不了问题。
        row('r-net', '✗ 连不上站内数据', 'bad')
          .then(function () {
            return row('r-fresh', '（' + String(e.message || e).slice(0, 40) + '）', 'bad');
          })
          .then(function () { return row('r-src', '—', 'bad'); })
          .then(function () { return row('r-items', '—', 'bad'); })
          .then(function () {
            var p = document.getElementById('pass');
            p.textContent = '仍然进入';
            p.classList.add('on');
            p.style.color = '#ff8f8f';
            document.getElementById('meta').innerHTML =
              '<span class="warn">数据没读到</span>';
            document.getElementById('feed').innerHTML =
              '<div class="empty">讯息库没能读出来 —— 是站内文件的问题，不是你的网。<br>' +
              '下一次定时更新（最多两小时）会自己好。</div>';
            p.addEventListener('click', enter);
            p.setAttribute('tabindex', '0');
            p.setAttribute('role', 'button');
            p.focus();
          });
      });
  }

  /* ══════════ 渲染 ══════════ */
  function render(d, srcs, okN, failN, skipN) {
    var h = hoursAgo(d.updated);
    $('#meta').innerHTML =
      '更新于 <b>' + (d.updated ? d.updated.slice(0, 16).replace('T', ' ') + ' UTC' : '未知') + '</b>' +
      (h == null ? '' : '　·　<b>' + (h < 1 ? '刚刚' : Math.round(h) + ' 小时前') + '</b>') +
      '<br>共 <b>' + state.items.length + '</b> 条　·　来源 <b>' + okN + '/' + srcs.length + '</b>' +
      (failN ? '　·　<span class="warn">' + failN + ' 个挂了</span>' : '');

    /* 源状态：**只把有问题的拎出来说，好的收成一句。**
       18 个芯片全铺出来会占三行、把正文压下去，
       而读的人真正关心的是"哪个挂了"，不是"哪些好了"。
       好的那个芯片的 title 里挂着完整名单，想核的时候 hover 就有。 */
    var fail = srcs.filter(function (s) { return !s.ok && !s.skipped; });
    var skip = srcs.filter(function (s) { return s.skipped; });
    var okNames = srcs.filter(function (s) { return s.ok; })
      .map(function (s) { return s.name + ' ' + s.count; }).join('　');
    var chips = [];
    chips.push('<span class="' + (fail.length ? 'fail' : 'ok') + '">' +
      (fail.length ? fail.length + ' 个源挂了' : srcs.filter(function (s) { return s.ok; }).length + ' 个源全部正常') +
      '</span>');
    fail.forEach(function (s) {
      chips.push('<span class="fail" title="' + esc(s.error) + '">' + esc(s.name) + '</span>');
    });
    if (skip.length) {
      chips.push('<span class="skip" title="' +
        esc(skip.map(function (s) { return s.name + '：' + s.error; }).join('\n')) + '">' +
        skip.length + ' 个未配置</span>');
    }
    chips.push('<span class="ok" title="' + esc(okNames) + '">' +
      srcs.filter(function (s) { return s.ok; }).length + ' 个正常 ✓</span>');
    $('#srcs').innerHTML = chips.join('');

    // 筛选
    var count = function (k) {
      return k === 'all' ? state.items.length
        : state.items.filter(function (i) { return layerOf(i.source) === k; }).length;
    };
    $('#filters').innerHTML = ['all', 'media', 'community', 'official'].map(function (k) {
      return '<button data-f="' + k + '"' + (k === 'all' ? ' class="on"' : '') + '>' +
             (k === 'all' ? '全部' : LAYER_NAME[k]) + '<span>' + count(k) + '</span></button>';
    }).join('');
    $('#filters').addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      state.filter = b.dataset.f;
      [].forEach.call(this.querySelectorAll('button'), function (x) {
        x.classList.toggle('on', x === b);
      });
      paint();
    });

    paint();
  }

  function paint() {
    var list = state.items
      .filter(function (i) { return state.filter === 'all' || layerOf(i.source) === state.filter; })
      .sort(function (a, b) { return (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0); });

    if (!list.length) {
      $('#feed').innerHTML = '<div class="empty">这一层暂时没有条目</div>';
      return;
    }
    $('#feed').innerHTML = list.map(function (i) {
      var L = layerOf(i.source);
      return '<li><a href="' + esc(i.url) + '" target="_blank" rel="noopener">' +
        '<div class="f-top">' +
          '<span class="tag ' + L + '">' + LAYER_NAME[L] + '</span>' +
          '<span>' + esc(i.source) + '</span>' +
          (i.date ? '<span class="f-time">' + ago(i.date) + '</span>' : '') +
        '</div>' +
        '<div class="f-title">' + esc(i.title) + '</div>' +
        (i.excerpt ? '<div class="f-ex">' + esc(i.excerpt) + '</div>' : '') +
      '</a></li>';
    }).join('');
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else boot();
})();
