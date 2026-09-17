/* ============================================================
   crt-warp.js —— CRT 扭曲波（首页首屏的底）

   来源：React Bits 的 <CRTWarp />，剥掉 React 重写成 vanilla。
   原版依赖 **three@0.180**，这里用原生 WebGL2，零依赖。

   相对原版的三处偏离：

   1. **不走 three。** three 在这件事上只做三样：建上下文、编译程序、
      画一个全屏三角形 —— 跟 Plasma 那边是同一笔账，不值得为它
      再拖 1.3MB。而且首页的 three 是给头颅用的，两边不互相欠。
   2. **着色器逐字照抄**，只动了三个语法点：
      `varying` → `in`、`gl_FragColor` → 自己声明的 `out`、
      `uv` / `position` 自己声明自己绑 ——
      ⚠️ 后一条是原版**看不见**的：那两个属性是 three 自动注入的，
      原作者的 shader 里根本没有。同一个坑 GridScan 踩过一次。
   3. **颜色走 sRGB → 线性。** 原版 uColor 是 `new THREE.Color(hex)`，
      three 的颜色管理会先把 hex 转进线性工作空间再喂给 shader，
      而它的 ShaderMaterial **不会把结果转回来** ——
      所以照抄 `#c755f7` 会明显偏亮偏艳。跟 plasma 的 hex2lin 同一件事。

   ⚠️ 这个 shader 很重：每个像素要算 17 次 referencePlasma
      （本体 1 次 + 泛光 8 次 + RGB 分离 2 次…… 每次含 7 个 sin
      和 3 个 sqrt）。原版限 30fps、dpr 压到 1 就是被它逼的。
      这里同样限帧，并且在离开视口 / 页面隐藏时直接停掉不画。
   ============================================================ */

export function createCRTWarp(container, opts) {
  opts = opts || {};

  var VERT = `#version 300 es
precision highp float;
in vec2 position;
in vec2 uv;
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position, 0.0, 1.0);
}`;

  var FRAG = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;
uniform vec2 uResolution;
uniform float uTime;
uniform vec3 uColor;
uniform vec3 uBackgroundColor;
uniform float uCurvature;
uniform float uScanlineStrength;
uniform float uScanlineFrequency;
uniform float uWaveAmplitude;
uniform float uWaveFrequency;
uniform float uBloom;
uniform float uBloomRadius;
uniform float uNoise;
uniform float uVignette;
uniform float uBrightness;
uniform float uPixelation;
uniform float uRgbShift;
uniform vec2 uPointer;
uniform float uMouseStrength;
uniform float uMouseReact;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

vec2 crtCurve(vec2 uv, float radius) {
  vec2 p = (uv - 0.5) * 2.0;
  float safeRadius = max(radius, 1.415);
  float cornerScale = safeRadius / sqrt(max(safeRadius * safeRadius - 2.0, 0.001));
  p = safeRadius * p / sqrt(max(safeRadius * safeRadius - dot(p, p), 0.001));
  p /= cornerScale;
  return p * 0.5 + 0.5;
}

float referencePlasma(vec2 uv, float t) {
  float frequencyScale = max(uWaveFrequency / 2.2, 0.001);
  uv = (uv - 0.5) * frequencyScale + 0.5;

  float scanline = 0.5 - 0.5 * cos(uv.y * 3.14159265 * uScanlineFrequency);
  scanline = mix(1.0, scanline, uScanlineStrength);

  uv *= vec2(80.0, 24.0);
  uv = ceil(uv);
  uv /= vec2(80.0, 24.0);

  float amplitude = uWaveAmplitude / 0.28;
  float field = 0.0;
  field += 0.7 * sin(0.5 * uv.x + t / 5.0);
  field += 3.0 * sin(1.6 * uv.y + t / 5.0);
  field += sin(10.0 * (uv.y * sin(t / 2.0) + uv.x * cos(t / 5.0)) + t / 2.0);

  float cx = uv.x + 0.5 * sin(t / 2.0);
  float cy = uv.y + 0.5 * cos(t / 4.0);
  field += 0.4 * sin(sqrt(100.0 * cx * cx + 100.0 * cy * cy + 1.0) + t);
  field += 0.9 * sin(sqrt(75.0 * cx * cx + 25.0 * cy * cy + 1.0) + t);
  field -= 1.4 * sin(sqrt(256.0 * cx * cx + 25.0 * cy * cy + 1.0) + t);
  field += 0.3 * sin(0.5 * uv.y + uv.x + sin(t));

  return scanline * floor(3.0 * (0.5 + 0.499 * sin(field * amplitude))) / 3.0;
}

void main() {
  vec2 uv = vUv;
  if (uPixelation > 1.001) {
    vec2 cells = max(uResolution / uPixelation, vec2(1.0));
    uv = (floor(uv * cells) + 0.5) / cells;
  }

  float curveRadius = 1.1 + 0.42 / max(uCurvature, 0.001);
  if (uMouseReact > 0.5) {
    curveRadius *= exp(-uPointer.y * uMouseStrength * 0.4);
  }
  vec2 curvedUv = crtCurve(uv, curveRadius);
  if (uMouseReact > 0.5) {
    curvedUv.x -= uPointer.x * uMouseStrength * 0.035;
  }

  float signal = referencePlasma(curvedUv, uTime);
  float radius = 0.01 * uBloomRadius;
  float glow = signal * 0.2;
  glow += referencePlasma(curvedUv + vec2(radius, 0.0), uTime) * 0.12;
  glow += referencePlasma(curvedUv - vec2(radius, 0.0), uTime) * 0.12;
  glow += referencePlasma(curvedUv + vec2(0.0, radius), uTime) * 0.12;
  glow += referencePlasma(curvedUv - vec2(0.0, radius), uTime) * 0.12;
  glow += referencePlasma(curvedUv + vec2(radius), uTime) * 0.08;
  glow += referencePlasma(curvedUv - vec2(radius), uTime) * 0.08;
  glow += referencePlasma(curvedUv + vec2(radius, -radius), uTime) * 0.08;
  glow += referencePlasma(curvedUv + vec2(-radius, radius), uTime) * 0.08;

  float redSignal = referencePlasma(curvedUv + vec2(uRgbShift, 0.0), uTime);
  float blueSignal = referencePlasma(curvedUv - vec2(uRgbShift, 0.0), uTime);
  vec3 channelSignal = vec3(redSignal, signal, blueSignal);
  vec3 waveColor = uColor * (0.3 + signal * 0.7 + glow * uBloom * 0.65);
  waveColor += (channelSignal - signal) * 0.42;

  float edge = clamp(1.0 - dot(vUv - 0.5, vUv - 0.5) * 2.0, 0.0, 1.0);
  float edgeFade = mix(1.0, smoothstep(0.0, 1.0, edge), uVignette);
  float waveMask = clamp(signal * 0.82 + glow * 0.52, 0.0, 1.0) * edgeFade;

  float grain = hash21(gl_FragCoord.xy + vec2(fract(uTime) * 173.0));
  waveColor = max(waveColor * uBrightness, vec3(0.0));
  vec3 color = mix(uBackgroundColor, waveColor, waveMask);
  color += (grain - 0.5) * uNoise;
  fragColor = vec4(max(color, vec3(0.0)), 1.0);
}`;

  /* sRGB → 线性。理由见文件头第 3 条：
     原版是把 hex 交给 THREE.Color 之后才进 shader 的。 */
  function hex2lin(h, fallback) {
    var m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(h || '');
    if (!m) return fallback || [1, 1, 1];
    return [0, 1, 2].map(function (i) {
      var v = parseInt(m[i + 1], 16) / 255;
      return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
  }

  function num(v, d) { return typeof v === 'number' || typeof v === 'string' ? Number(v) : d; }

  var P = {
    color:        opts.color        != null ? opts.color        : '#c755f7',
    background:   opts.backgroundColor != null ? opts.backgroundColor : '#05010a',
    speed:        num(opts.speed, 0.5),
    curvature:    num(opts.curvature, 0.25),
    scanStrength: num(opts.scanlineStrength, 0.25),
    scanFreq:     num(opts.scanlineFrequency, 200),
    waveAmp:      num(opts.waveAmplitude, 0.3),
    waveFreq:     num(opts.waveFrequency, 2.5),
    bloom:        num(opts.bloom, 1.5),
    bloomRadius:  num(opts.bloomRadius, 1),
    noise:        num(opts.noise, 0.1),
    vignette:     num(opts.vignette, 0),
    brightness:   num(opts.brightness, 1.25),
    pixelation:   num(opts.pixelation, 1),
    rgbShift:     num(opts.rgbShift, 0.015),
    mouseReact:   opts.mouseReact !== false,
    mouseStrength:num(opts.mouseStrength, 0.5),
    dpr:          num(opts.dpr, 1),
    fps:          Math.max(1, num(opts.fps, 30))
  };

  var canvas = document.createElement('canvas');
  canvas.style.cssText = 'display:block;width:100%;height:100%';
  container.appendChild(canvas);

  var gl = canvas.getContext('webgl2', {
    antialias: false, alpha: true, premultipliedAlpha: false,
    powerPreference: 'low-power'
  });
  if (!gl) { canvas.remove(); return { ok: false, why: '没有 WebGL2' }; }

  function sh(type, src) {
    var o = gl.createShader(type);
    gl.shaderSource(o, src); gl.compileShader(o);
    if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) {
      var log = (gl.getShaderInfoLog(o) || '') +
                ' ||首||' + String(src).slice(0, 50) +
                ' ||尾||' + String(src).slice(-50);
      console.warn('[crt] 编译失败：', log);
      return { err: (type === gl.VERTEX_SHADER ? '顶点' : '片元') + ': ' + log.slice(0, 260) };
    }
    return o;
  }
  var vs = sh(gl.VERTEX_SHADER, VERT), fs = sh(gl.FRAGMENT_SHADER, FRAG);
  if (vs && vs.err) { canvas.remove(); return { ok: false, why: vs.err }; }
  if (fs && fs.err) { canvas.remove(); return { ok: false, why: fs.err }; }

  var prog = gl.createProgram();
  gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    var pl = gl.getProgramInfoLog(prog) || '';
    canvas.remove(); return { ok: false, why: '链接: ' + pl.slice(0, 260) };
  }
  gl.useProgram(prog);

  /* 一个盖满屏幕的三角形。三个顶点，两个在屏幕外。
     ⚠️ 每组是**四个 float**：x, y, u, v —— 所以跨距是 4*4 = 16 字节。
     第一版这里写成了 3*4，从第二个顶点开始整个错位读取
     （position 读到 0,0、uv 读到 3,-1），三角形根本盖不满屏幕，
     出来的是一堆斜的几何块 —— 嘉豪一眼就看出来了："一团鬼畜的
     几何图形"。**照着 plasma.js 抄的时候我"以为"position 是 vec2
     所以跨距该是 3 个 float，但数据格式就摆在这行 bufferData 里，
     数一遍就知道。** */
  var buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 0, 0, 3, -1, 2, 0, -1, 3, 0, 2]), gl.STATIC_DRAW);
  var STR = 4 * 4;
  var lp = gl.getAttribLocation(prog, 'position');
  gl.enableVertexAttribArray(lp);
  gl.vertexAttribPointer(lp, 2, gl.FLOAT, false, STR, 0);
  var lu = gl.getAttribLocation(prog, 'uv');
  if (lu >= 0) {
    gl.enableVertexAttribArray(lu);
    gl.vertexAttribPointer(lu, 2, gl.FLOAT, false, STR, 2 * 4);
  }

  var U = {};
  function u(n) { if (!(n in U)) U[n] = gl.getUniformLocation(prog, n); return U[n]; }

  gl.uniform3fv(u('uColor'), new Float32Array(hex2lin(P.color, [1, 1, 1])));
  gl.uniform3fv(u('uBackgroundColor'), new Float32Array(hex2lin(P.background, [0, 0, 0])));
  gl.uniform1f(u('uCurvature'), P.curvature);
  gl.uniform1f(u('uScanlineStrength'), P.scanStrength);
  gl.uniform1f(u('uScanlineFrequency'), P.scanFreq);
  gl.uniform1f(u('uWaveAmplitude'), P.waveAmp);
  gl.uniform1f(u('uWaveFrequency'), P.waveFreq);
  gl.uniform1f(u('uBloom'), P.bloom);
  gl.uniform1f(u('uBloomRadius'), P.bloomRadius);
  gl.uniform1f(u('uNoise'), P.noise);
  gl.uniform1f(u('uVignette'), P.vignette);
  gl.uniform1f(u('uBrightness'), P.brightness);
  gl.uniform1f(u('uPixelation'), P.pixelation);
  gl.uniform1f(u('uRgbShift'), P.rgbShift);
  gl.uniform1f(u('uMouseStrength'), P.mouseStrength);
  gl.uniform1f(u('uMouseReact'), P.mouseReact ? 1 : 0);
  gl.uniform2f(u('uPointer'), 0, 0);

  var dpr = Math.min(window.devicePixelRatio || 1, P.dpr);
  function resize() {
    var w = container.clientWidth || 1, h = container.clientHeight || 1;
    if (!w || !h) return;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(u('uResolution'), canvas.width, canvas.height);
  }
  resize();
  var ro = window.ResizeObserver ? new ResizeObserver(resize) : null;
  if (ro) ro.observe(container);
  window.addEventListener('resize', resize);

  /* 指针 —— ⚠️ 这一层是 pointer-events:none（它垫在最底下，
     不能让滚轮和点击归它管），所以事件**收不到**，只能听 window。
     坐标按视口归一化到 -1..1，跟原版用 container rect 是同一个结果。 */
  var px = 0, py = 0, tx = 0, ty = 0;
  function onMove(e) {
    tx = (e.clientX / Math.max(window.innerWidth, 1)) * 2 - 1;
    ty = -(((e.clientY / Math.max(window.innerHeight, 1)) * 2) - 1);
  }
  if (P.mouseReact) window.addEventListener('pointermove', onMove, { passive: true });

  /* 离开视口 / 页面隐藏就不画。这个 shader 每像素 17 次 plasma，
     在背后空转是在烧电（尤其这台机器今天在跑电池）。 */
  var visible = true;
  var io = window.IntersectionObserver
    ? new IntersectionObserver(function (es) { visible = es[0].isIntersecting; })
    : null;
  if (io) io.observe(container);

  /* startTime 是给无头截图用的：直接跳到第 N 秒，省得等它慢慢涨。 */
  var raf = 0, last = -1e9, t = num(opts.startTime, 0), prev = performance.now(), dead = false;
  var paused = !!opts.paused;
  var minGap = 1000 / P.fps;
  function frame(now) {
    if (dead) return;
    raf = requestAnimationFrame(frame);
    /* 限帧要放在取 delta **之前**：跳过的那些帧不该进时间轴，
       否则 30fps 下的速度和 120fps 下会不一样。原版也是这个顺序。 */
    if (now - last < minGap) return;
    last = now;
    var dt = Math.min((now - prev) / 1000, 0.1);
    prev = now;
    if (!visible || document.hidden || paused) return;   // 时间轴也一起冻住
    t += dt * P.speed;
    px += (tx - px) * 0.08;
    py += (ty - py) * 0.08;
    gl.uniform1f(u('uTime'), t);
    gl.uniform2f(u('uPointer'), px, py);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  raf = requestAnimationFrame(frame);

  return {
    ok: true,
    /* 显式叫停。⚠️ IntersectionObserver 对**全屏 fixed 层**永远返回
       "在视口里" —— 它压根不会滚出视口。所以滚过首屏之后，
       光靠 IO 是停不下来的，得由外面按透明度告诉它"没人看得见了"。 */
    setPaused: function (v) { paused = !!v; },

    /* 运行时改参数。给 crt/lab.html 那套滑块用的 ——
       "多亮才像底"这件事我看不见浏览器，只能他眼睛说了算。 */
    set: function (o) {
      o = o || {};
      function f(key, uni) {
        if (o[key] == null) return;
        P[key] = Number(o[key]);
        gl.uniform1f(u(uni), P[key]);
      }
      f('brightness', 'uBrightness');
      f('bloom', 'uBloom');
      f('curvature', 'uCurvature');
      f('scanStrength', 'uScanlineStrength');
      f('scanFreq', 'uScanlineFrequency');
      f('waveAmp', 'uWaveAmplitude');
      f('waveFreq', 'uWaveFrequency');
      f('noise', 'uNoise');
      f('vignette', 'uVignette');
      f('rgbShift', 'uRgbShift');
      f('pixelation', 'uPixelation');
      f('speed', 'uSpeed');           // 这个只进时间轴，没有对应的 uniform
      if (o.color) {
        gl.uniform3fv(u('uColor'), new Float32Array(hex2lin(o.color, [1, 1, 1])));
      }
      if (o.background) {
        gl.uniform3fv(u('uBackgroundColor'), new Float32Array(hex2lin(o.background, [0, 0, 0])));
      }
    },
    destroy: function () {
      dead = true;
      cancelAnimationFrame(raf);
      if (ro) ro.disconnect();
      if (io) io.disconnect();
      window.removeEventListener('resize', resize);
      window.removeEventListener('pointermove', onMove);
      gl.deleteProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.deleteBuffer(buf);
      var lose = gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
      canvas.remove();
    }
  };
}
