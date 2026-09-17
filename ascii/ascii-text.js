/* ============================================================
   ascii-text.js —— ASCII 艺术字（首屏那个 wuaeri）

   来源：React Bits 的 <ASCIIText />，剥掉 React + three 重写成 vanilla，
   原生 WebGL2，零依赖。（源码 reactbits.dev/r/ASCIIText-JS-CSS.json）

   ═══ 它其实不是"一个 shader"，是三段串起来的 ═══

   ① CanvasTxt —— 把文字画到一张 canvas 上，当纹理用
   ② WebGL —— 一张 36×36 网格的平面贴这张纹理，顶点做正弦波位移，
      相机在 z=30 用透视看它，跟着鼠标轻微转
   ③ AsciiFilter —— 把 ②渲染出的画面 drawImage 缩到 cols×rows 那么大，
      **逐像素读回来**（getImageData），按灰度映射成一个字符，
      拼成整块字符串塞进 <pre>，每帧重写一次 DOM

   味道来自三样叠加：波纹起伏 + 透视倾斜 + 字符化的颗粒，
   外面再套 mix-blend-mode: difference 和一条彩虹渐变文字。

   ═══ DOM 长什么样（这一条最容易搞错，原版没写在显眼处）═══

   box
    ├─ canvas.ascii-gl   ← WebGL 那张。**不进 DOM**，纯离屏源
    ├─ canvas.ascii-px   ← cols×rows 的极小画布，CSS 拉到 100%×100%
    │                       + image-rendering:pixelated ⇒ 一块马赛克
    ├─ pre.ascii-pre     ← 字符。**z-index:9，压在马赛克上面**
    └─ span.ascii-sr     ← 真文字，视觉上藏起来，给读屏和复制用

   味道 = 底下那层"字的色块" ＋ 上面那层"字的字符"，
   中间靠 pre 的 `mix-blend-mode:difference` 咬在一起。
   ⚠️ 我第一版把 gl 画布直接摆出来了 —— 那是**平滑的字**，
   不是字符画。gl 画布在 DOM 里出现的那一刻，马赛克就被完美盖住了。

   ═══ 相对原版的五处偏离 ═══

   1. **不走 three。** three 在这件事上干的是：建透视相机、铺一张
      36×36 的平面、上传 canvas 纹理、逐帧渲染。这些原生都能做，
      而这个站已经为头颅背了 1.3MB 的 three（还默认不加载），
      不该再为一个字母平面把它拖回来。
   2. **字体不用 Google Fonts。** 原版 `@import url('https://fonts.googleapis.com/...')`
      拉 IBM Plex Mono —— 国内打不开，而且**字体加载晚于首帧的话，
      等宽度量会错、整块 ASCII 会散**。这里用系统等宽字体兜住。
   3. **文字纹理只画一次。** 原版每帧重画 canvas + 重传纹理，
      但文字是静态的。省掉这份开销。
   4. **平面尺寸自适应。** 原版写死 planeBaseHeight = 8，而相机
      z=30 / fov 45 ⇒ 可视高度 24.85 —— 平面只占容器的 32%，
      也就是说**你给多大容器都没用，字就是那么小**。原版的 demo
      是全屏容器所以看不出来。这里给了一个 fit 模式，按容器反推。
   5. **hue 的圆心。** 原版拿 `clientX`（视口坐标）去减容器中心的
      `width/2`（容器坐标）—— 两个坐标系，量出来的是"鼠标离容器
      左上角多远"，角度基本是常数，转不太动。这里改用容器内坐标。

   ⚠️ 我按 three 的源码逐条对过的地方（上一回把顶点跨距"以为"成 3×4
      就是这么炸的）：
      · PlaneGeometry 顶点是 `push(x, -y, 0)` ⇒ **iy=0 落在 +h/2**，
        uv 是 `(ix/gridX, 1 - iy/gridY)`
      · 索引两组：`(a,b,d)` 和 `(b,c,d)`，`a = ix + gridX1*iy`
      · CanvasTexture 默认 `flipY = true` ⇒ 原生要显式 UNPACK_FLIP_Y_WEBGL
      · mesh.rotation 默认顺序 'XYZ' ⇒ model = rotX * rotY
   ============================================================ */

export function createAsciiText(container, opts) {
  opts = opts || {};

  var CFG = {
    text:           opts.text != null ? opts.text : 'wuaeri',
    asciiFontSize:  opts.asciiFontSize != null ? opts.asciiFontSize : 8,
    textFontSize:   opts.textFontSize != null ? opts.textFontSize : 200,
    textColor:      opts.textColor != null ? opts.textColor : '#fdf9f3',
    planeBaseHeight: opts.planeBaseHeight != null ? opts.planeBaseHeight : 8,
    enableWaves:    opts.enableWaves !== false,
    /* 原版是 'IBM Plex Mono'（Google Fonts）。国内拉不到，而且**字体要是
       晚于首帧到，等宽度量就变了、整块 ASCII 会散**。系统等宽先兜住。 */
    fontFamily:     opts.fontFamily || '"IBM Plex Mono","SF Mono",ui-monospace,Menlo,monospace',
    /* 每帧要重写一次 innerHTML（上万字符），不限帧纯属烧电。
       原版没有这个参数，是我们加的。 */
    fps:            opts.fps != null ? opts.fps : 30,
    charset:        opts.charset ||
      ' .\'`^",:;Il!i~+_-?][}{1)(|/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$',
    invert:         opts.invert !== false,

    /* ═══ 相机（原版写死的两个数）═══
       z = 30、fov = 45° ⇒ z=0 那个平面上能看见的高度是
       2 * 30 * tan(22.5°) = 24.85 个单位。平面的宽高都是在这把尺子上量的。 */
    camZ:           30,
    fovDeg:         45,

    /* ═══ 自适应（偏离 4）═══
       fit 为真时忽略 planeBaseHeight，改成"让文字占容器高度的 fitH"，
       再按 fitW 收一次宽度免得左右切边。 */
    fit:            opts.fit !== false,
    fitH:           opts.fitH != null ? opts.fitH : 0.92,
    fitW:           opts.fitW != null ? opts.fitW : 0.96,

    /* 自带一份藏起来的真文字（读屏 + 复制用）。见下面建 DOM 那段的注释。 */
    sr:             opts.sr !== false,

    /* 大字的字体。原版跟 ASCII 网格共用 IBM Plex Mono。
       这里分开：**网格必须等宽**（列宽是拿 measureText('A') 除出来的），
       大字不必 —— 用站里那套显示字体，字的形状才跟站上其他字是一家人。 */
    textFontFamily: opts.textFontFamily ||
      '-apple-system,"SF Pro Display","PingFang SC","Helvetica Neue",sans-serif'
  };

  /* ── 4×4 列主序矩阵。跟 GLSL 的 mat4 同一套（gl-matrix 风格），
        公式是标准的，逐条对着 gl-matrix 写。 ── */
  function m4() { return new Float32Array(16); }
  function m4Identity(o) {
    o[0]=1;o[1]=0;o[2]=0;o[3]=0; o[4]=0;o[5]=1;o[6]=0;o[7]=0;
    o[8]=0;o[9]=0;o[10]=1;o[11]=0; o[12]=0;o[13]=0;o[14]=0;o[15]=1;
    return o;
  }
  function m4Mul(o, a, b) {                 // o = a * b
    for (var c = 0; c < 4; c++) {
      var b0=b[c*4], b1=b[c*4+1], b2=b[c*4+2], b3=b[c*4+3];
      o[c*4+0] = a[0]*b0 + a[4]*b1 + a[8]*b2  + a[12]*b3;
      o[c*4+1] = a[1]*b0 + a[5]*b1 + a[9]*b2  + a[13]*b3;
      o[c*4+2] = a[2]*b0 + a[6]*b1 + a[10]*b2 + a[14]*b3;
      o[c*4+3] = a[3]*b0 + a[7]*b1 + a[11]*b2 + a[15]*b3;
    }
    return o;
  }
  function m4Perspective(o, fovy, aspect, near, far) {
    var f = 1 / Math.tan(fovy / 2);
    m4Identity(o);
    o[0] = f / aspect; o[5] = f;
    o[10] = (far + near) / (near - far);
    o[11] = -1;
    o[14] = 2 * far * near / (near - far);
    o[15] = 0;
    return o;
  }
  function m4Translate(o, x, y, z) {
    m4Identity(o); o[12] = x; o[13] = y; o[14] = z;
    return o;
  }
  function m4RotX(o, r) {
    var c = Math.cos(r), s = Math.sin(r);
    m4Identity(o);
    o[5] = c; o[6] = s; o[9] = -s; o[10] = c;
    return o;
  }
  function m4RotY(o, r) {
    var c = Math.cos(r), s = Math.sin(r);
    m4Identity(o);
    o[0] = c; o[2] = -s; o[8] = s; o[10] = c;
    return o;
  }

  /* ── ① CanvasTxt：把文字画到 canvas 上 ── */
  function makeTextCanvas(text, fontSize, fontFamily, color) {
    var canvas = document.createElement('canvas');
    var ctx = canvas.getContext('2d');
    var font = '600 ' + fontSize + 'px ' + fontFamily;

    ctx.font = font;
    var m = ctx.measureText(text);
    var tw = Math.ceil(m.width) + 20;
    var th = Math.ceil((m.actualBoundingBoxAscent || fontSize * 0.75) +
                       (m.actualBoundingBoxDescent || fontSize * 0.25)) + 20;

    canvas.width = tw; canvas.height = th;
    ctx.clearRect(0, 0, tw, th);
    ctx.fillStyle = color;
    ctx.font = font;
    m = ctx.measureText(text);
    var yPos = 10 + (m.actualBoundingBoxAscent || fontSize * 0.75);
    ctx.fillText(text, 10, yPos);

    return canvas;
  }

  /* ── ② WebGL：网格 + 纹理 + 波纹 ── */
  var VERT = `#version 300 es
precision highp float;
in vec3 position;
in vec2 uv;
uniform mat4 uViewProj;
uniform mat4 uModel;
uniform float uTime;
uniform float uEnableWaves;
out vec2 vUv;
void main() {
  vUv = uv;
  float time = uTime * 5.0;
  float waveFactor = uEnableWaves;
  vec3 transformed = position;
  transformed.x += sin(time + position.y) * 0.5 * waveFactor;
  transformed.y += cos(time + position.z) * 0.15 * waveFactor;
  transformed.z += sin(time + position.x) * waveFactor;
  gl_Position = uViewProj * uModel * vec4(transformed, 1.0);
}`;

  var FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform float uTime;
uniform sampler2D uTexture;
void main() {
  float time = uTime;
  vec2 pos = vUv;
  float r = texture(uTexture, pos + cos(time * 2.0 - time + pos.x) * 0.01).r;
  float g = texture(uTexture, pos + tan(time * 0.5 + pos.x - time) * 0.01).g;
  float b = texture(uTexture, pos - cos(time * 2.0 + time + pos.y) * 0.01).b;
  float a = texture(uTexture, pos).a;
  fragColor = vec4(r, g, b, a);
}`;

  /* 36×36 分段 —— 原版 PlaneGeometry(planeW, planeH, 36, 36)。
     分段是给顶点位移用的：格子太稀，波纹就成折线了。 */
  function buildGrid(w, h, seg) {
    var pos = [], uv = [], idx = [];
    var gx1 = seg + 1;
    for (var iy = 0; iy <= seg; iy++) {
      for (var ix = 0; ix <= seg; ix++) {
        // ⚠️ three 是 push(x, -y, 0)：iy=0 落在 +h/2（顶边）
        pos.push((ix / seg - 0.5) * w, (0.5 - iy / seg) * h, 0);
        uv.push(ix / seg, 1 - iy / seg);
      }
    }
    for (iy = 0; iy < seg; iy++) {
      for (ix = 0; ix < seg; ix++) {
        var a = ix + gx1 * iy;
        var b = ix + gx1 * (iy + 1);
        var c = (ix + 1) + gx1 * (iy + 1);
        var d = (ix + 1) + gx1 * iy;
        idx.push(a, b, d, b, c, d);
      }
    }
    return {
      pos: new Float32Array(pos),
      uv: new Float32Array(uv),
      idx: new Uint16Array(idx)
    };
  }

  function hexToRgb(h) {
    var m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(h || '');
    if (!m) return [253, 249, 243];
    return [parseInt(m[1],16), parseInt(m[2],16), parseInt(m[3],16)];
  }

  /* ── 建 DOM：一个装 canvas + pre 的盒子 ── */
  var box = document.createElement('div');
  box.className = 'ascii-box';
  container.appendChild(box);

  /* ⚠️ 这张**不进 DOM**。它是离屏源：只给下面那张极小画布当 drawImage 的料。
     摆出来的话，出来的是"平滑的字"，马赛克和字符全被它盖住了。 */
  var glCanvas = document.createElement('canvas');
  glCanvas.className = 'ascii-gl';

  /* 极小画布（cols×rows）。CSS 把它拉到 100%×100% + pixelated ⇒ 马赛克。 */
  var asciiCanvas = document.createElement('canvas');
  asciiCanvas.className = 'ascii-px';
  box.appendChild(asciiCanvas);

  var pre = document.createElement('pre');
  pre.className = 'ascii-pre';
  pre.setAttribute('aria-hidden', 'true');
  box.appendChild(pre);

  /* 无障碍 & 兜底：<pre> 里的字符对读屏和复制都是噪音，
     真文字放这儿。CSS 那边用 clip 藏起来但保留语义。
     ⚠️ 宿主元素自己要是已经有这段文字（比如站里那个 <h1>wuaeri</h1>，
     我们只是把它染成透明），就别再放一份 —— 否则读屏会念两遍。 */
  var sr = null;
  if (CFG.sr) {
    sr = document.createElement('span');
    sr.className = 'ascii-sr';
    sr.textContent = CFG.text;
    box.appendChild(sr);
  }

  var gl = glCanvas.getContext('webgl2', {
    antialias: false, alpha: true, premultipliedAlpha: false,
    preserveDrawingBuffer: true      // 要把它的画面 drawImage 出来，必须留缓冲
  });
  if (!gl) {
    container.removeChild(box);
    return { ok: false, why: '没有 WebGL2' };
  }

  /* ⚠️⚠️ 这里**绝不能**加 willReadFrequently，2026-09-17 为它白烧了一小时。
     我当初想的是"这张画布每帧都要 getImageData，加个提示让 Chrome 放软件层"。
     结果：**软件层的画布不参与 filter + mix-blend-mode 那个合成组，被整个丢掉**。
     症状极具迷惑性 ——
       · 画布单独看（把 pre 藏了）：好好的，奶油底 + 黄绿品红镶边
       · 字符层一压上来：画布凭空消失，difference 咬不到东西，
         字符退回成"纯渐变压在紫底上"
       · 而 getImageData 照样读得到像素（字符明明是从它里面读出来的）
     —— 也就是**"画得出来、读得出来、就是不合成"**。
     查法：把上游的 React Bits 原件拉下来逐行对，
     人家从构造函数到 render() 用的都是裸的 `getContext('2d')`。
     **该跟着原件走的时候别自作聪明。** */
  var actx = asciiCanvas.getContext('2d');
  actx.imageSmoothingEnabled = false;

  var width = 1, height = 1, cols = 1, rows = 1;
  var center = { x: 0.5, y: 0.5 };
  var mouse = { x: 0, y: 0 };
  var deg = 0;
  var prog = null, progLoc = {}, bufPos, bufUv, bufIdx, tex, meshW = 1, meshH = 1;
  var model = m4(), view = m4(), proj = m4(), viewProj = m4(), tmp = m4();
  var rotX = 0, rotY = 0;

  function sh(type, src) {
    var o = gl.createShader(type);
    gl.shaderSource(o, src); gl.compileShader(o);
    if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) {
      var log = (gl.getShaderInfoLog(o) || '') + ' ||' + String(src).slice(0, 60);
      console.warn('[ascii] 编译失败：', log);
      return { err: log.slice(0, 240) };
    }
    return o;
  }
  var vs = sh(gl.VERTEX_SHADER, VERT), fs = sh(gl.FRAGMENT_SHADER, FRAG);
  if (vs && vs.err) { container.removeChild(box); return { ok: false, why: vs.err }; }
  if (fs && fs.err) { container.removeChild(box); return { ok: false, why: fs.err }; }

  prog = gl.createProgram();
  gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    var pl = gl.getProgramInfoLog(prog) || '';
    container.removeChild(box);
    return { ok: false, why: '链接: ' + pl.slice(0, 240) };
  }
  gl.useProgram(prog);
  progLoc.uViewProj   = gl.getUniformLocation(prog, 'uViewProj');
  progLoc.uModel      = gl.getUniformLocation(prog, 'uModel');
  progLoc.uTime       = gl.getUniformLocation(prog, 'uTime');
  progLoc.uEnableWaves= gl.getUniformLocation(prog, 'uEnableWaves');
  progLoc.uTexture    = gl.getUniformLocation(prog, 'uTexture');

  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.CULL_FACE);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.clearColor(0, 0, 0, 0);

  /* 相机：原版 PerspectiveCamera(45, aspect, 1, 1000)，position.z = 30 */
  var FOV = CFG.fovDeg * Math.PI / 180;
  /* z=0 那个平面上，相机能看见多高 */
  function visibleH() { return 2 * CFG.camZ * Math.tan(FOV / 2); }
  function updateCamera() {
    var w = container.clientWidth || width || 1;
    var h = container.clientHeight || height || 1;
    m4Perspective(proj, FOV, w / Math.max(h, 1), 1, 1000);
    m4Translate(view, 0, 0, -CFG.camZ);
    m4Mul(viewProj, proj, view);
    gl.uniformMatrix4fv(progLoc.uViewProj, false, viewProj);
  }

  /* 平面该多大 —— 见头部「偏离 4」。
     自适应这条路：先按高度占满 fitH，宽度溢出了就改按宽度收。 */
  function planeSize(aspect) {
    if (!CFG.fit) {
      return { w: CFG.planeBaseHeight * aspect, h: CFG.planeBaseHeight };
    }
    var vh = visibleH();
    var w = container.clientWidth || width || 1;
    var h = container.clientHeight || height || 1;
    var planeH = vh * CFG.fitH;
    var planeW = planeH * aspect;
    var maxW = vh * (w / Math.max(h, 1)) * CFG.fitW;
    if (planeW > maxW) { planeW = maxW; planeH = planeW / aspect; }
    return { w: planeW, h: planeH };
  }

  /* 只重建顶点。文字没变、只是容器尺寸变了的时候走这条
     —— 省掉一次纹理上传（那才是贵的那个）。 */
  function rebuildGrid(aspect) {
    var ps = planeSize(aspect);
    meshW = ps.w;
    meshH = ps.h;

    var g = buildGrid(meshW, meshH, 36);
    if (bufPos) gl.deleteBuffer(bufPos);
    if (bufUv)  gl.deleteBuffer(bufUv);
    if (bufIdx) gl.deleteBuffer(bufIdx);

    bufPos = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, bufPos);
    gl.bufferData(gl.ARRAY_BUFFER, g.pos, gl.STATIC_DRAW);
    var lp = gl.getAttribLocation(prog, 'position');
    gl.enableVertexAttribArray(lp);
    gl.vertexAttribPointer(lp, 3, gl.FLOAT, false, 0, 0);

    bufUv = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, bufUv);
    gl.bufferData(gl.ARRAY_BUFFER, g.uv, gl.STATIC_DRAW);
    var lu = gl.getAttribLocation(prog, 'uv');
    gl.enableVertexAttribArray(lu);
    gl.vertexAttribPointer(lu, 2, gl.FLOAT, false, 0, 0);

    bufIdx = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, bufIdx);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, g.idx, gl.STATIC_DRAW);

    return g.idx.length;
  }

  var textCanvas = null;

  function setText(text, fontSize, color) {
    textCanvas = makeTextCanvas(text, fontSize, CFG.textFontFamily, color);
    var n = rebuildGrid(textCanvas.width / textCanvas.height);
    fitW0 = container.clientWidth || 1;
    fitH0 = container.clientHeight || 1;

    if (tex) gl.deleteTexture(tex);
    tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);   // three 的 CanvasTexture 默认就是 true
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, textCanvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);  // 原版 NearestFilter
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    gl.uniform1i(progLoc.uTexture, 0);
    gl.uniform1f(progLoc.uEnableWaves, CFG.enableWaves ? 1 : 0);

    return n;
  }

  var indexCount = 0;

  var fitW0 = 0, fitH0 = 0;      // 上次算平面时容器的尺寸
  /* 每次 resize 读到的尺寸都记一笔。这东西救过一次命（见下），
     留着 —— 它比 console.log 好在能事后从 DOM 里读出来。 */
  var TRACE = [];

  function resize() {
    var w = container.clientWidth || 1, h = container.clientHeight || 1;
    width = w; height = h;

    /* 容器尺寸一变，自适应那条路算出来的平面就不对了
       ——（窗口一窄，字会从左右切出去）。只重算顶点，不重传纹理。 */
    if (CFG.fit && textCanvas && started && (w !== fitW0 || h !== fitH0)) {
      fitW0 = w; fitH0 = h;
      indexCount = rebuildGrid(textCanvas.width / textCanvas.height);
    }

    glCanvas.width = w; glCanvas.height = h;
    gl.viewport(0, 0, w, h);
    updateCamera();

    // 原版的算法，逐字照抄：
    //   cols = floor(w / (fontSize * (charWidth / fontSize)))  → 就是 floor(w / charWidth)
    /* ⚠️⚠️ 这两行不是保险，是**必须**。2026-09-17 在作品站上炸过一次。

       Chrome 会把 canvas 元素上**计算后的 CSS letter-spacing 映射成
       ctx.letterSpacing**（这是规范行为，不是 bug）。而宿主 `.p1 .word`
       上挂着 `letter-spacing:-.045em`，字号 180px ⇒ 每个字符 -8.1px。
       于是 8px 的 'A'（本来宽 4.8px）量出来是 **-3.28**。

       再往下：cols = floor(1180 / -3.28) = max(1, -359) = **1**。
       整块 ASCII 被排成"每行一个字符"，屏幕上就是横着的几条杠。

       致命的地方在于：**-3.28 是真值**，所以原来那句
       `|| CFG.asciiFontSize * 0.6` 的兜底压根不触发 —— 负数和 0 不一样，
       0 才假。所以这里改成显式判 isFinite + 正数，而不是靠 || 兜。 */
    actx.font = CFG.asciiFontSize + 'px ' + CFG.fontFamily;
    if ('letterSpacing' in actx) actx.letterSpacing = '0px';
    if ('wordSpacing' in actx) actx.wordSpacing = '0px';
    var charWidth = actx.measureText('A').width;
    if (!isFinite(charWidth) || charWidth <= 0) charWidth = CFG.asciiFontSize * 0.6;
    if (TRACE.length < 50) TRACE.push([w, h, charWidth, actx.font]);
    cols = Math.max(1, Math.floor(w / (CFG.asciiFontSize * (charWidth / CFG.asciiFontSize))));
    rows = Math.max(1, Math.floor(h / CFG.asciiFontSize));
    asciiCanvas.width = cols;
    asciiCanvas.height = rows;
    actx.imageSmoothingEnabled = false;

    pre.style.fontFamily = CFG.fontFamily;
    pre.style.fontSize = CFG.asciiFontSize + 'px';

    center = { x: w / 2, y: h / 2 };
    mouse = { x: center.x, y: center.y };
  }

  /* ── ③ ASCII 化：读像素 → 字符 ── */
  function asciify() {
    if (!cols || !rows) return;
    var data = actx.getImageData(0, 0, cols, rows).data;
    var out = new Array(rows);
    var cs = CFG.charset, n = cs.length - 1;
    for (var y = 0; y < rows; y++) {
      var line = '';
      for (var x = 0; x < cols; x++) {
        var i = (x + y * cols) * 4;
        var a = data[i + 3];
        if (a === 0) { line += ' '; continue; }
        var gray = (0.3 * data[i] + 0.6 * data[i + 1] + 0.1 * data[i + 2]) / 255;
        var idx = Math.floor((1 - gray) * n);
        if (CFG.invert) idx = n - idx;
        line += cs[idx];
      }
      out[y] = line;
    }
    pre.textContent = out.join('\n');
  }

  function hue() {
    if (CFG.hue === false) return;
    var d = Math.atan2(mouse.y - center.y, mouse.x - center.x) * 180 / Math.PI;
    deg += (d - deg) * 0.075;
    box.style.filter = 'hue-rotate(' + deg.toFixed(1) + 'deg)';
  }

  function draw() {
    var t = Date.now() * 0.001;
    /* 原版把绝对时间塞进 sin 再当 uTime 用（uTime 在 shader 里再 ×5），
       照抄 —— 换成自己的累加器观感会不一样。 */
    gl.uniform1f(progLoc.uTime, Math.sin(t));

    rotX += (Math.max(0, Math.min(1, mouse.y / Math.max(height,1))) * (0.5 - -0.5) + -0.5 - rotX) * 0.05;
    rotY += (Math.max(0, Math.min(1, mouse.x / Math.max(width,1))) * (0.5 - -0.5) + -0.5 - rotY) * 0.05;

    m4RotX(tmp, rotX);
    m4RotY(model, rotY);
    m4Mul(model, tmp, model);          // three 的 XYZ 顺序 ⇒ rotX * rotY
    gl.uniformMatrix4fv(progLoc.uModel, false, model);

    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawElements(gl.TRIANGLES, indexCount, gl.UNSIGNED_SHORT, 0);

    // 把 GL 画面缩到 cols×rows，再逐像素读回来
    actx.clearRect(0, 0, cols, rows);
    actx.drawImage(glCanvas, 0, 0, cols, rows);
    asciify();
    hue();
  }

  var raf = 0, last = -1e9, minGap = 1000 / CFG.fps;
  var dead = false, visible = true, paused = false;
  function frame(now) {
    if (dead) return;
    raf = requestAnimationFrame(frame);
    if (now - last < minGap) return;
    last = now;
    if (!visible || document.hidden || paused) return;
    draw();
  }

  function onMove(e) {
    var b = container.getBoundingClientRect();
    mouse = { x: e.clientX - b.left, y: e.clientY - b.top };
  }

  var ro = null, io = null;
  var moveOpts = { passive: true };
  container.addEventListener('mousemove', onMove, moveOpts);
  container.addEventListener('touchmove', onMove, moveOpts);

  var started = false;
  function start() {
    if (started || dead) return;
    started = true;
    indexCount = setText(CFG.text, CFG.textFontSize, CFG.textColor);
    resize();
    ro = window.ResizeObserver ? new ResizeObserver(resize) : null;
    if (ro) ro.observe(container);
    window.addEventListener('resize', resize);
    io = window.IntersectionObserver
      ? new IntersectionObserver(function (es) { visible = es[0].isIntersecting; })
      : null;
    if (io) io.observe(container);
    raf = requestAnimationFrame(frame);
  }

  /* 字体得先就位 —— 等宽度量变了，整块 ASCII 的列数就变了。
     拿不到也别卡着：超时就直接开跑，用系统字体兜。 */
  var ready = false;
  function boot() {
    if (ready || dead) return;
    ready = true;
    start();
  }
  try {
    if (document.fonts && document.fonts.load) {
      Promise.all([
        document.fonts.load('600 ' + CFG.textFontSize + 'px ' + CFG.fontFamily),
        document.fonts.load('500 ' + CFG.asciiFontSize + 'px ' + CFG.fontFamily)
      ]).catch(function () {}).then(boot);
      setTimeout(boot, 1200);      // 兜底：字体永远不来也得开跑
    } else {
      boot();
    }
  } catch (e) { boot(); }

  /* 原版在容器尺寸为 0 时挂 IntersectionObserver 等它出现，
     这里 resize() 每次都会重算，不需要那一套。 */

  return {
    ok: true,
    setSize: resize,
    /* 调试口子：调用方 resize 过几次、每次读到的容器尺寸。
       万一又出现"列数是 1"这种鬼东西，先看这个。 */
    trace: function () { return TRACE.slice(); },
    state: function () {
      return { cols: cols, rows: rows, width: width, height: height,
               meshW: meshW, meshH: meshH, started: started, ready: ready };
    },
    setText: function (t) {
      if (t != null) CFG.text = String(t);
      if (sr) sr.textContent = CFG.text;
      if (started) indexCount = setText(CFG.text, CFG.textFontSize, CFG.textColor);
    },
    /* 跟 CRT 那边同一条理由：全屏 fixed 层不会被 IntersectionObserver
       判为"离开视口"，滚走了也停不下来。 */
    setPaused: function (v) { paused = !!v; },
    destroy: function () {
      dead = true;
      cancelAnimationFrame(raf);
      if (ro) ro.disconnect();
      if (io) io.disconnect();
      window.removeEventListener('resize', resize);
      container.removeEventListener('mousemove', onMove);
      container.removeEventListener('touchmove', onMove);
      if (gl) {
        if (tex) gl.deleteTexture(tex);
        if (bufPos) gl.deleteBuffer(bufPos);
        if (bufUv) gl.deleteBuffer(bufUv);
        if (bufIdx) gl.deleteBuffer(bufIdx);
        gl.deleteProgram(prog);
        gl.deleteShader(vs);
        gl.deleteShader(fs);
        var lose = gl.getExtension('WEBGL_lose_context');
        if (lose) lose.loseContext();
      }
      if (box.parentNode) box.parentNode.removeChild(box);
    }
  };
}
