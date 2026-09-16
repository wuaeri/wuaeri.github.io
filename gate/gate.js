/* ============================================================
   gate.js —— 来客验证门

   进作品页之前先过一道门：**把来客本人印在一张金属证上**，
   走一遍扫描，然后放人进去。

   这不是特效，是"验明来客"的字面做法 —— 用的是摄像头，
   而 React Bits 那张卡正好就是这个（详见 gate.css 顶部的说明）。

   用法（放 <head> 里，越早越好）：
       <link rel="stylesheet" href="../gate/gate.css">
       <script src="../gate/gate.js"></script>
   可选项，放在它前面：
       <script>window.VISITOR_GATE = { name:'瞬', skip:false };</script>

   ═══ 两条硬规矩 ═══

   ① **门是 JS 亲手建的。脚本没加载出来 = 没有门 = 页面照常显示。**
      所以 vg-gating 这个类是由本脚本自己加的，不是写在 HTML 里。
      （站内别的地方是"CSS 先藏、JS 再放"，那种写法脚本一挂整页就白。）

   ② **确认是手动的，但兜底是自动的。** 扫描走完**不自动通过** ——
      要访客自己按下去，门才开（自动通过的话这就只是 loading 动画）。
      另有 30 秒兜底，只防"门根本没建出来"把人困住；
      节奏归访客，兜底不替他做决定。
   ============================================================ */
(function () {
  'use strict';

  var CFG = window.VISITOR_GATE || {};
  var RM = window.matchMedia('(prefers-reduced-motion:reduce)').matches;
  var root = document.documentElement;
  var gate = null, video = null, stream = null, revealed = false;

  /* 先按住页面，避免"内容先闪一下再被盖住"。try 是因为这一段
     跑在 <head> 里，任何意外都不该连累后面的解析。 */
  try { if (!CFG.skip) root.classList.add('vg-gating'); } catch (e) {}

  function code() {
    // 编号由**真实入内时刻**推出来 —— 不是编的，它记录的就是此刻
    var t = Date.now().toString(36).toUpperCase();
    while (t.length < 8) t = '0' + t;
    return t.slice(-4) + '-' + t.slice(-8, -4) + '-' + ('000' + (Date.now() % 4096).toString(16).toUpperCase()).slice(-3);
  }

  function build() {
    var wall = document.createElement('div');
    wall.className = 'visitor-gate';
    wall.setAttribute('aria-hidden', 'true');
    wall.innerHTML =
      '<div class="vg-wrap">' +
        '<div class="vg-card">' +
          /* SVG 滤镜链 —— 金属感全在这里。
             原版是 React 里的内联 <svg>，这里原样搬过来。 */
          '<svg class="vg-filters" aria-hidden="true"><defs>' +
            '<filter id="vg-metal" x="-20%" y="-20%" width="140%" height="140%">' +
              '<feTurbulence type="turbulence" baseFrequency="0.03" numOctaves="2" result="n"/>' +
              '<feColorMatrix in="n" type="luminanceToAlpha" result="na"/>' +
              '<feDisplacementMap in="SourceGraphic" in2="n" scale="20"' +
                ' xChannelSelector="R" yChannelSelector="G" result="rip"/>' +
              '<feSpecularLighting in="na" surfaceScale="20" specularConstant="5"' +
                ' specularExponent="20" lightingColor="#ffffff" result="lt">' +
                '<fePointLight x="0" y="0" z="300"/>' +
              '</feSpecularLighting>' +
              '<feComposite in="lt" in2="rip" operator="in" result="le"/>' +
              '<feBlend in="le" in2="rip" mode="screen" result="metal"/>' +
              '<feColorMatrix in="SourceAlpha" type="matrix"' +
                ' values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="sa"/>' +
              '<feMorphology in="sa" operator="erode" radius="45" result="er"/>' +
              '<feGaussianBlur in="er" stdDeviation="10" result="bl"/>' +
              '<feComponentTransfer in="bl" result="gm">' +
                '<feFuncA type="linear" slope="0.5" intercept="0"/>' +
              '</feComponentTransfer>' +
              '<feDisplacementMap in="metal" in2="gm" scale="30"' +
                ' xChannelSelector="A" yChannelSelector="A"/>' +
            '</filter>' +
          '</defs></svg>' +
          '<video class="vg-video" autoplay playsinline muted></video>' +
          '<div class="vg-noise"></div>' +
          '<div class="vg-sheen"></div>' +
          '<div class="vg-scan"></div>' +
          '<div class="vg-border"></div>' +
          '<div class="vg-content">' +
            '<div class="vg-head">' +
              '<div class="vg-badge"><span class="vg-dot"></span>身份确认</div>' +
              '<svg width="18" height="18" viewBox="0 0 24 24" fill="none"' +
                ' stroke="rgba(255,255,255,.65)" stroke-width="1.6"' +
                ' stroke-linecap="round" stroke-linejoin="round">' +
                '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>' +
            '</div>' +
            '<div class="vg-body">' +
              '<h2 class="vg-name">来客</h2>' +
              '<p class="vg-role">未登记</p>' +
            '</div>' +
            '<div class="vg-foot">' +
              '<div class="vg-id"><span class="vg-label">来客编号</span>' +
                '<span class="vg-val">' + code() + '</span></div>' +
              '<svg width="30" height="30" viewBox="0 0 24 24" fill="none"' +
                ' stroke="rgba(255,255,255,.4)" stroke-width="1.4"' +
                ' stroke-linecap="round" stroke-linejoin="round">' +
                '<path d="M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4"/>' +
                '<path d="M14 13.12c0 2.38 0 6.38-1 8.88"/>' +
                '<path d="M17.29 21.02c.12-.6.43-2.3.5-3.02"/>' +
                '<path d="M2 12a10 10 0 0 1 18-6"/>' +
                '<path d="M2 16h.01"/><path d="M21.8 16c.2-2 .131-5.354 0-6"/>' +
                '<path d="M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2"/>' +
                '<path d="M8.65 22c.21-.66.45-1.32.57-2"/>' +
                '<path d="M9 6.8a6 6 0 0 1 9 5.2v2"/></svg>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<button class="vg-confirm" type="button" disabled>确认来客</button>';
    document.body.appendChild(wall);
    return wall;
  }

  /* 摄像头：**不阻塞仪式**。
     授权弹窗可能永远不点（也可能直接拒绝），门不能等它。
     拿不到就当没有 —— 噪声 + 高光 + 描边照样是一张完整的金属卡。 */
  function camera(wall) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
    if (!window.isSecureContext) return;   // http 非本地环境下 API 直接不可用
    navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' }
    }).then(function (s) {
      stream = s;
      video.srcObject = s;
      video.play().catch(function () {});
      wall.classList.add('vg-has-cam');
      // 页面被卸载时兜一道（正常路径是门一结束就停，见 stopCam）
      window.addEventListener('pagehide', stopCam);
    }).catch(function () { /* 拒绝授权完全正常，什么都不做 */ });
  }

  /* ═══ 门一结束就把摄像头放掉 ═══
     之前只在 pagehide 停，等于整个会话里摄像头一直开着 ——
     **苹果那颗绿灯就一直亮着。** 那是硬件指示灯，不是我们能画的：
     只有真的把所有 track 停掉它才灭。

     反过来这条也成立：灯亮着 = 摄像头在工作。门已经不需要它了，
     让它继续开着既费电，也是在没经过任何同意的情况下持续取景。 */
  function stopCam() {
    if (stream) {
      stream.getTracks().forEach(function (t) { t.stop(); });
      stream = null;
    }
    if (video) video.srcObject = null;
    window.removeEventListener('pagehide', stopCam);
  }

  function reveal() {
    if (revealed) return;
    revealed = true;
    stopCam();          // ← 先放摄像头：绿灯跟门一起灭，别多亮一秒
    root.classList.add('vg-entered');
    root.classList.remove('vg-gating');
    if (gate) {
      gate.classList.add('vg-out');
      setTimeout(function () {
        if (gate && gate.parentNode) gate.parentNode.removeChild(gate);
        gate = null;
      }, 800);
    }
  }

  function run() {
    gate = build();
    video = gate.querySelector('.vg-video');
    camera(gate);
    if (CFG.skip) { reveal(); return; }

    var btn  = gate.querySelector('.vg-confirm');
    var role = gate.querySelector('.vg-role');
    var confirmed = false;

    requestAnimationFrame(function () { gate.classList.add('vg-show'); });

    /* ═══ 确认是手动的 ═══
       自动通过的话，这道门就只是一段 loading 动画 —— 访客什么都不用做，
       "验明来客"也就不成立。要他自己按下去，门才开。 */
    function ask() {
      gate.classList.add('vg-waiting');
      role.textContent = '待确认';
      btn.disabled = false;
      btn.textContent = '按此确认来客';
      btn.classList.add('vg-ready');
      try { btn.focus({ preventScroll: true }); } catch (e) { btn.focus(); }
    }
    function confirm() {
      if (confirmed || btn.disabled) return;
      confirmed = true;
      gate.classList.remove('vg-waiting');
      btn.classList.add('vg-done');
      btn.classList.remove('vg-ready');
      btn.disabled = true;
      btn.textContent = '已验证';
      gate.classList.add('vg-ok');
      role.textContent = '身份成立';
      setTimeout(reveal, 460);
    }
    btn.addEventListener('click', confirm);

    /* ?vgauto=NNNN —— 到点自动按一下。无头截图验不了"人手点"，
       有了它整条流程（扫描 → 待确认 → 通过 → 放人）就能一次跑完。
       线上没有任何影响。 */
    var AUTO = parseFloat(new URLSearchParams(location.search).get('vgauto') || '0');
    if (AUTO > 0) setTimeout(function () { btn.click(); }, AUTO);

    if (RM) {                        // 减弱动效：不扫描，直接等确认
      setTimeout(ask, 200);
      return;
    }

    // 1 扫描（1.5s 走完，跟 CSS 里那条 keyframes 对齐）
    setTimeout(function () {
      gate.classList.add('vg-scanning');
      btn.textContent = '读取中';
      role.textContent = '读取中';
    }, 520);

    // 2 扫完**不自动通过**，把决定交回访客
    setTimeout(function () {
      gate.classList.remove('vg-scanning');
      ask();
    }, 2120);
  }

  function boot() {
    if (CFG.skip) { root.classList.remove('vg-gating'); return; }
    try { run(); } catch (e) { reveal(); }   // 出任何岔子，放人
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  /* 兜底：防止门根本没建出来把人困住。
     手动确认时节奏归访客，但**8 秒**是个更合理的上限 ——
     嘉豪 2026-09-17 报过一次"网页什么都没有"，
     宁可让门提前让开，也不能让人对着一片黑等 30 秒。 */
  setTimeout(reveal, 8000);

  window.VisitorGate = { open: boot, reveal: reveal };
})();
