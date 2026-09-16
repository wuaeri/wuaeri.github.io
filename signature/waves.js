/* ============================================================
   Waves —— Perlin 噪声点阵波纹背景
   源自 React Bits 的 <Waves />，剥掉 React 之后重写为 vanilla。

   相对原版的三处改动：
   1. 彩色流动
      原版 `ctx.strokeStyle = lineColor` 后一次性 stroke() 所有线，
      结构上只能单色。改成每条线各自 beginPath/stroke，
      色相沿线条索引铺开、再随时间整体偏移 —— 这就是"流动"。
   2. 上下边缘虚化
      原来的做法由 CSS mask 承担（见 waves.css），
      这样背景能嵌进任意高度的容器，不必为每页调尺寸。
   3. touchmove 改被动
      原版 window.addEventListener('touchmove', ..., { passive: false })
      会让整页滚不动。当背景用时这是事故，必须 passive。
   ============================================================ */
(function () {
  function Grad(x, y, z) {
    this.x = x;
    this.y = y;
    this.z = z;
  }
  Grad.prototype.dot2 = function (x, y) {
    return this.x * x + this.y * y;
  };

  var GRAD_3D = [
    new Grad(1, 1, 0), new Grad(-1, 1, 0), new Grad(1, -1, 0), new Grad(-1, -1, 0),
    new Grad(1, 0, 1), new Grad(-1, 0, 1), new Grad(1, 0, -1), new Grad(-1, 0, -1),
    new Grad(0, 1, 1), new Grad(0, -1, 1), new Grad(0, 1, -1), new Grad(0, -1, -1)
  ];

  var P = [
    151, 160, 137, 91, 90, 15, 131, 13, 201, 95, 96, 53, 194, 233, 7, 225, 140, 36, 103, 30, 69, 142, 8, 99, 37, 240,
    21, 10, 23, 190, 6, 148, 247, 120, 234, 75, 0, 26, 197, 62, 94, 252, 219, 203, 117, 35, 11, 32, 57, 177, 33, 88,
    237, 149, 56, 87, 174, 20, 125, 136, 171, 168, 68, 175, 74, 165, 71, 134, 139, 48, 27, 166, 77, 146, 158, 231, 83,
    111, 229, 122, 60, 211, 133, 230, 220, 105, 92, 41, 55, 46, 245, 40, 244, 102, 143, 54, 65, 25, 63, 161, 1, 216,
    80, 73, 209, 76, 132, 187, 208, 89, 18, 169, 200, 196, 135, 130, 116, 188, 159, 86, 164, 100, 109, 198, 173, 186,
    3, 64, 52, 217, 226, 250, 124, 123, 5, 202, 38, 147, 118, 126, 255, 82, 85, 212, 207, 206, 59, 227, 47, 16, 58,
    17, 182, 189, 28, 42, 223, 183, 170, 213, 119, 248, 152, 2, 44, 154, 163, 70, 221, 153, 101, 155, 167, 43, 172, 9,
    129, 22, 39, 253, 19, 98, 108, 110, 79, 113, 224, 232, 178, 185, 112, 104, 218, 246, 97, 228, 251, 34, 242, 193,
    238, 210, 144, 12, 191, 179, 162, 241, 81, 51, 145, 235, 249, 14, 239, 107, 49, 192, 214, 31, 181, 199, 106, 157,
    184, 84, 204, 176, 115, 121, 50, 45, 127, 4, 150, 254, 138, 236, 205, 93, 222, 114, 67, 29, 24, 72, 243, 141, 128,
    195, 78, 66, 215, 61, 156, 180
  ];

  function Noise(seed) {
    this.grad3 = GRAD_3D;
    this.p = P;          // 只读，共享安全
    this.perm = new Array(512);
    this.gradP = new Array(512);
    this.seed(seed || 0);
  }

  Noise.prototype.seed = function (seed) {
    if (seed > 0 && seed < 1) seed *= 65536;
    seed = Math.floor(seed);
    if (seed < 256) seed |= seed << 8;
    for (var i = 0; i < 256; i++) {
      var v = i & 1 ? this.p[i] ^ (seed & 255) : this.p[i] ^ ((seed >> 8) & 255);
      this.perm[i] = this.perm[i + 256] = v;
      this.gradP[i] = this.gradP[i + 256] = this.grad3[v % 12];
    }
  };

  Noise.prototype.fade = function (t) {
    return t * t * t * (t * (t * 6 - 15) + 10);
  };

  Noise.prototype.lerp = function (a, b, t) {
    return (1 - t) * a + t * b;
  };

  Noise.prototype.perlin2 = function (x, y) {
    var X = Math.floor(x), Y = Math.floor(y);
    x -= X; y -= Y;
    X &= 255; Y &= 255;
    var g = this.gradP, pm = this.perm;
    var n00 = g[X + pm[Y]].dot2(x, y);
    var n01 = g[X + pm[Y + 1]].dot2(x, y - 1);
    var n10 = g[X + 1 + pm[Y]].dot2(x - 1, y);
    var n11 = g[X + 1 + pm[Y + 1]].dot2(x - 1, y - 1);
    var u = this.fade(x);
    return this.lerp(this.lerp(n00, n10, u), this.lerp(n01, n11, u), this.fade(y));
  };

  var DEFAULTS = {
    // 色彩：色相带（0-360 的起止）、饱和度、明度、透明度
    hueStart: 190,      // 青
    hueEnd: 300,        // 紫
    sat: 62,
    light: 75,          // 微调：70 → 75，彩色本身更透亮
    alpha: 0.18,        // 微调：0.16 → 0.18，线条站得住一点
    hueDrift: 0.004,    // 每秒色相整体偏移量 —— "流动"的来源

    waveSpeedX: 0.0125,
    waveSpeedY: 0.005,
    waveAmpX: 32,
    waveAmpY: 16,
    xGap: 10,
    yGap: 32,
    friction: 0.925,
    tension: 0.005,
    maxCursorMove: 100
  };

  function createWaves(container, options) {
    if (!container || container.dataset.wavesInit) return;
    container.dataset.wavesInit = '1';

    var cfg = {};
    for (var k in DEFAULTS) { if (DEFAULTS.hasOwnProperty(k)) cfg[k] = DEFAULTS[k]; }
    for (var k2 in (options || {})) { if (options.hasOwnProperty(k2)) cfg[k2] = options[k2]; }

    var doc = container.ownerDocument;
    var canvas = doc.createElement('canvas');
    canvas.className = 'sig-waves-canvas';
    container.appendChild(canvas);
    var ctx = canvas.getContext('2d');

    var noise = new Noise(1);
    var lines = [];
    var bounds = { width: 0, height: 0, left: 0, top: 0 };
    /* 初始位置扔到天边。原版给的是 x:-10, y:0 —— 那正好在画面左上角，
       而下面 `l = Math.max(175, mouse.vs)` 那个影响半径会把左上角一小片罩住，
       于是刚加载时左上角有一坨没有来由的扰动。挪远就没这回事了。 */
    var mouse = { x: -9999, y: -9999, lx: 0, ly: 0, sx: -9999, sy: -9999, v: 0, vs: 0, a: 0, set: false };
    var frameId = null;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);

    function setSize() {
      bounds = container.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(bounds.width * dpr));
      canvas.height = Math.max(1, Math.round(bounds.height * dpr));
      canvas.style.width = bounds.width + 'px';
      canvas.style.height = bounds.height + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function setLines() {
      var width = bounds.width, height = bounds.height;
      lines = [];
      var oWidth = width + 200, oHeight = height + 30;
      var totalLines = Math.ceil(oWidth / cfg.xGap);
      var totalPoints = Math.ceil(oHeight / cfg.yGap);
      var xStart = (width - cfg.xGap * totalLines) / 2;
      var yStart = (height - cfg.yGap * totalPoints) / 2;
      for (var i = 0; i <= totalLines; i++) {
        var pts = [];
        for (var j = 0; j <= totalPoints; j++) {
          pts.push({
            x: xStart + cfg.xGap * i,
            y: yStart + cfg.yGap * j,
            wave: { x: 0, y: 0 },
            cursor: { x: 0, y: 0, vx: 0, vy: 0 }
          });
        }
        lines.push(pts);
      }
    }

    function movePoints(time) {
      for (var li = 0; li < lines.length; li++) {
        var pts = lines[li];
        for (var pi = 0; pi < pts.length; pi++) {
          var p = pts[pi];
          var move = noise.perlin2(
            (p.x + time * cfg.waveSpeedX) * 0.002,
            (p.y + time * cfg.waveSpeedY) * 0.0015
          ) * 12;
          p.wave.x = Math.cos(move) * cfg.waveAmpX;
          p.wave.y = Math.sin(move) * cfg.waveAmpY;

          var dx = p.x - mouse.sx, dy = p.y - mouse.sy;
          var dist = Math.sqrt(dx * dx + dy * dy);
          var l = Math.max(175, mouse.vs);
          if (dist < l) {
            var s = 1 - dist / l;
            var f = Math.cos(dist * 0.001) * s;
            p.cursor.vx += Math.cos(mouse.a) * f * l * mouse.vs * 0.00065;
            p.cursor.vy += Math.sin(mouse.a) * f * l * mouse.vs * 0.00065;
          }

          p.cursor.vx += (0 - p.cursor.x) * cfg.tension;
          p.cursor.vy += (0 - p.cursor.y) * cfg.tension;
          p.cursor.vx *= cfg.friction;
          p.cursor.vy *= cfg.friction;
          p.cursor.x += p.cursor.vx * 2;
          p.cursor.y += p.cursor.vy * 2;
          p.cursor.x = Math.min(cfg.maxCursorMove, Math.max(-cfg.maxCursorMove, p.cursor.x));
          p.cursor.y = Math.min(cfg.maxCursorMove, Math.max(-cfg.maxCursorMove, p.cursor.y));
        }
      }
    }

    function moved(point, withCursor) {
      var x = point.x + point.wave.x + (withCursor ? point.cursor.x : 0);
      var y = point.y + point.wave.y + (withCursor ? point.cursor.y : 0);
      return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 };
    }

    var hueSpan = cfg.hueEnd - cfg.hueStart;

    function drawLines(time) {
      var width = bounds.width, height = bounds.height;
      ctx.clearRect(0, 0, width, height);
      ctx.lineWidth = 1;

      var total = lines.length || 1;
      // 整体色相偏移 —— 让彩带缓慢流动，不是静止的彩虹
      var drift = time * cfg.hueDrift;

      for (var li = 0; li < lines.length; li++) {
        var points = lines[li];
        // 每条线一个色相，沿索引铺开
        var hue = ((cfg.hueStart + (li / total) * hueSpan + drift) % 360 + 360) % 360;
        ctx.strokeStyle = 'hsla(' + hue.toFixed(1) + ',' + cfg.sat + '%,' + cfg.light + '%,' + cfg.alpha + ')';
        ctx.beginPath();

        var p1 = moved(points[0], false);
        ctx.moveTo(p1.x, p1.y);
        for (var pi = 0; pi < points.length; pi++) {
          var isLast = pi === points.length - 1;
          p1 = moved(points[pi], !isLast);
          var next = points[pi + 1] || points[points.length - 1];
          var p2 = moved(next, !isLast);
          ctx.lineTo(p1.x, p1.y);
          if (isLast) ctx.moveTo(p2.x, p2.y);
        }
        ctx.stroke();
      }
    }

    function tick(t) {
      mouse.sx += (mouse.x - mouse.sx) * 0.1;
      mouse.sy += (mouse.y - mouse.sy) * 0.1;
      var dx = mouse.x - mouse.lx, dy = mouse.y - mouse.ly;
      var d = Math.sqrt(dx * dx + dy * dy);
      mouse.v = d;
      mouse.vs += (d - mouse.vs) * 0.1;
      mouse.vs = Math.min(100, mouse.vs);
      mouse.lx = mouse.x;
      mouse.ly = mouse.y;
      mouse.a = Math.atan2(dy, dx);

      container.style.setProperty('--x', mouse.sx + 'px');
      container.style.setProperty('--y', mouse.sy + 'px');

      movePoints(t);
      drawLines(t);
      frameId = requestAnimationFrame(tick);
    }

    /* ⚠️ 这里必须每次现取 rect，不能用 setSize() 缓存的那一份。

       getBoundingClientRect() 的 top/left 是相对**视口**的，页面一滚它就变；
       而 setSize() 只在初始化和 window resize 时跑 —— 桌面 Safari 滚动
       **不触发** resize。于是页面顶部那一刻算出的 top（落款区在最底下时
       是个几千的值）会被一直用下去：mouse.y = clientY - 5000 ≈ -4600，
       离任何一个点都十万八千里，`if (dist < l)` 永不成立，光标效果
       一次都不触发。表现就是**波纹自己在动，但对鼠标毫无反应**。

       至于"从随便另一个网页重新进入才有互动" —— Safari 会恢复滚动位置，
       重新进入时初始化那一瞬间 rect 恰好是准的（容器就在视口里，top≈0），
       所以只有那条路径能work。这也反证了根因就是这个。 */
    function updateMouse(x, y) {
      var r = container.getBoundingClientRect();
      mouse.x = x - r.left;
      mouse.y = y - r.top;
      if (!mouse.set) {
        mouse.sx = mouse.x; mouse.sy = mouse.y;
        mouse.lx = mouse.x; mouse.ly = mouse.y;
        mouse.set = true;
      }
    }

    function onResize() { setSize(); setLines(); }
    function onMouseMove(e) { updateMouse(e.clientX, e.clientY); }
    function onTouchMove(e) {
      var t = e.touches[0];
      if (t) updateMouse(t.clientX, t.clientY);
    }

    // 只在指针进入本容器附近时才吃事件，别把整页的移动都截走
    setSize();
    setLines();
    frameId = requestAnimationFrame(tick);
    window.addEventListener('resize', onResize);
    // passive —— 原版这里给的是 { passive: false }，会锁死整页滚动
    window.addEventListener('mousemove', onMouseMove, { passive: true });
    window.addEventListener('touchmove', onTouchMove, { passive: true });

    // 页面上没交互时就停下来，别空转烧电
    var visible = true;
    var io = null;
    var sizedOnce = false;
    if (window.IntersectionObserver) {
      io = new IntersectionObserver(function (entries) {
        var now = entries[0].isIntersecting;
        /* 第一次真正进入视口时补算一次尺寸。
           这一刻布局必然已经稳定 —— 不管初始化时外部 CSS、字体、图片
           加载到哪一步，在这里都能一次掰回来。而且这个时机只会有一次，
           反复滚进滚出不会重建点阵、不会抖。 */
        if (now && !sizedOnce) { sizedOnce = true; setSize(); setLines(); }
        visible = now;
        if (now && frameId === null) frameId = requestAnimationFrame(tick);
        if (!now && frameId !== null) { cancelAnimationFrame(frameId); frameId = null; }
      }, { threshold: 0 });
      io.observe(container);
    }

    return function destroy() {
      if (frameId !== null) cancelAnimationFrame(frameId);
      if (io) io.disconnect();
      window.removeEventListener('resize', onResize);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('touchmove', onTouchMove);
      if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
      delete container.dataset.wavesInit;
    };
  }

  function boot() {
    document.querySelectorAll('.sig-waves').forEach(function (el) {
      createWaves(el);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  window.SigWaves = { create: createWaves, boot: boot };
})();
