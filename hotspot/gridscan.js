/* ============================================================
   gridscan.js —— 网格扫描（热点区的检查点视觉）

   来源：React Bits 的 <GridScan />，剥掉 React 重写成 vanilla。
   原版 942 行，依赖 **three.js + postprocessing + face-api.js** 三个包。
   这里只做一件事：**把那段着色器原样跑起来。**

   相对原版的三处偏离：

   1. **不走 three.js，用原生 WebGL2。**
      原版为一块背景板拖了三个依赖：three 负责全屏四边形，
      postprocessing 负责 bloom 和色散，face-api 负责人脸检测。
      但 `enableWebcam=false` 时那 400 行人脸检测一行都不跑 —— 白拖。
      而 bloom 那段其实**着色器自己已经算了**（`halo` + uBloomOpacity，
      见片元末尾），色散 0.002 在视网膜上根本分辨不出来。
      所以：一个全屏三角形 + 一段 shader，零依赖。

   2. **着色器逐字照抄，没有重写。**
      下面这段是从原版 tsx 里**整段抽出来**的，一个字没改。
      重写就等于"我觉得它应该长这样"，那是发明不是移植。
      参数名也照抄（uSkew / uTilt / uYaw / uScanStarts…），
      这样以后对不上时能直接跟原版逐个比。

   3. **顶点着色器里那两行 attribute 是我补的。**
      原版用 three.js，three 会自动注入 `attribute vec3 position` /
      `attribute vec2 uv`，所以原作者的 shader 里看不见它们。
      原生 WebGL 没这待遇，得自己声明、自己绑缓冲。
      ——这是"照抄着色器"的边界：**GLSL 抄得到，宿主框架替你加的东西抄不到。**

   4. **拿不到 WebGL2 就退 WebGL1，再不行就安静地什么都不做。**
      容器留空，页面照常。检查点不能因为一块背景板而变成事故。
   ============================================================ */
(function () {
  'use strict';

  var VERT = `attribute vec3 position;
attribute vec2 uv;
varying vec2 vUv;
void main(){
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;
  var FRAG = `
precision highp float;
uniform vec3 iResolution;
uniform float iTime;
uniform vec2 uSkew;
uniform float uTilt;
uniform float uYaw;
uniform float uLineThickness;
uniform vec3 uLinesColor;
uniform vec3 uScanColor;
uniform float uGridScale;
uniform float uLineStyle;
uniform float uLineJitter;
uniform float uScanOpacity;
uniform float uScanDirection;
uniform float uNoise;
uniform float uBloomOpacity;
uniform float uScanGlow;
uniform float uScanSoftness;
uniform float uPhaseTaper;
uniform float uScanDuration;
uniform float uScanDelay;
uniform float uLightMode;
varying vec2 vUv;

uniform float uScanStarts[8];
uniform float uScanCount;

const int MAX_SCANS = 8;

float smoother01(float a, float b, float x){
  float t = clamp((x - a) / max(1e-5, (b - a)), 0.0, 1.0);
  return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord)
{
    vec2 p = (2.0 * fragCoord - iResolution.xy) / iResolution.y;

    vec3 ro = vec3(0.0);
    vec3 rd = normalize(vec3(p, 2.0));

    float cR = cos(uTilt), sR = sin(uTilt);
    rd.xy = mat2(cR, -sR, sR, cR) * rd.xy;

    float cY = cos(uYaw), sY = sin(uYaw);
    rd.xz = mat2(cY, -sY, sY, cY) * rd.xz;

    vec2 skew = clamp(uSkew, vec2(-0.7), vec2(0.7));
    rd.xy += skew * rd.z;

    vec3 color = vec3(0.0);
  float minT = 1e20;
  float gridScale = max(1e-5, uGridScale);
    float fadeStrength = 2.0;
    vec2 gridUV = vec2(0.0);

  float hitIsY = 1.0;
    for (int i = 0; i < 4; i++)
    {
        float isY = float(i < 2);
        float pos = mix(-0.2, 0.2, float(i)) * isY + mix(-0.5, 0.5, float(i - 2)) * (1.0 - isY);
        float num = pos - (isY * ro.y + (1.0 - isY) * ro.x);
        float den = isY * rd.y + (1.0 - isY) * rd.x;
        float t = num / den;
        vec3 h = ro + rd * t;

        float depthBoost = smoothstep(0.0, 3.0, h.z);
        h.xy += skew * 0.15 * depthBoost;

    bool use = t > 0.0 && t < minT;
    gridUV = use ? mix(h.zy, h.xz, isY) / gridScale : gridUV;
    minT = use ? t : minT;
    hitIsY = use ? isY : hitIsY;
    }

    vec3 hit = ro + rd * minT;
    float dist = length(hit - ro);

  float jitterAmt = clamp(uLineJitter, 0.0, 1.0);
  if (jitterAmt > 0.0) {
    vec2 j = vec2(
      sin(gridUV.y * 2.7 + iTime * 1.8),
      cos(gridUV.x * 2.3 - iTime * 1.6)
    ) * (0.15 * jitterAmt);
    gridUV += j;
  }
  float fx = fract(gridUV.x);
  float fy = fract(gridUV.y);
  float ax = min(fx, 1.0 - fx);
  float ay = min(fy, 1.0 - fy);
  float wx = fwidth(gridUV.x);
  float wy = fwidth(gridUV.y);
  float halfPx = max(0.0, uLineThickness) * 0.5;

  float tx = halfPx * wx;
  float ty = halfPx * wy;

  float aax = wx;
  float aay = wy;

  float lineX = 1.0 - smoothstep(tx, tx + aax, ax);
  float lineY = 1.0 - smoothstep(ty, ty + aay, ay);
  if (uLineStyle > 0.5) {
    float dashRepeat = 4.0;
    float dashDuty = 0.5;
    float vy = fract(gridUV.y * dashRepeat);
    float vx = fract(gridUV.x * dashRepeat);
    float dashMaskY = step(vy, dashDuty);
    float dashMaskX = step(vx, dashDuty);
    if (uLineStyle < 1.5) {
      lineX *= dashMaskY;
      lineY *= dashMaskX;
    } else {
      float dotRepeat = 6.0;
      float dotWidth = 0.18;
      float cy = abs(fract(gridUV.y * dotRepeat) - 0.5);
      float cx = abs(fract(gridUV.x * dotRepeat) - 0.5);
      float dotMaskY = 1.0 - smoothstep(dotWidth, dotWidth + fwidth(gridUV.y * dotRepeat), cy);
      float dotMaskX = 1.0 - smoothstep(dotWidth, dotWidth + fwidth(gridUV.x * dotRepeat), cx);
      lineX *= dotMaskY;
      lineY *= dotMaskX;
    }
  }
  float primaryMask = max(lineX, lineY);

  vec2 gridUV2 = (hitIsY > 0.5 ? hit.xz : hit.zy) / gridScale;
  if (jitterAmt > 0.0) {
    vec2 j2 = vec2(
      cos(gridUV2.y * 2.1 - iTime * 1.4),
      sin(gridUV2.x * 2.5 + iTime * 1.7)
    ) * (0.15 * jitterAmt);
    gridUV2 += j2;
  }
  float fx2 = fract(gridUV2.x);
  float fy2 = fract(gridUV2.y);
  float ax2 = min(fx2, 1.0 - fx2);
  float ay2 = min(fy2, 1.0 - fy2);
  float wx2 = fwidth(gridUV2.x);
  float wy2 = fwidth(gridUV2.y);
  float tx2 = halfPx * wx2;
  float ty2 = halfPx * wy2;
  float aax2 = wx2;
  float aay2 = wy2;
  float lineX2 = 1.0 - smoothstep(tx2, tx2 + aax2, ax2);
  float lineY2 = 1.0 - smoothstep(ty2, ty2 + aay2, ay2);
  if (uLineStyle > 0.5) {
    float dashRepeat2 = 4.0;
    float dashDuty2 = 0.5;
    float vy2m = fract(gridUV2.y * dashRepeat2);
    float vx2m = fract(gridUV2.x * dashRepeat2);
    float dashMaskY2 = step(vy2m, dashDuty2);
    float dashMaskX2 = step(vx2m, dashDuty2);
    if (uLineStyle < 1.5) {
      lineX2 *= dashMaskY2;
      lineY2 *= dashMaskX2;
    } else {
      float dotRepeat2 = 6.0;
      float dotWidth2 = 0.18;
      float cy2 = abs(fract(gridUV2.y * dotRepeat2) - 0.5);
      float cx2 = abs(fract(gridUV2.x * dotRepeat2) - 0.5);
      float dotMaskY2 = 1.0 - smoothstep(dotWidth2, dotWidth2 + fwidth(gridUV2.y * dotRepeat2), cy2);
      float dotMaskX2 = 1.0 - smoothstep(dotWidth2, dotWidth2 + fwidth(gridUV2.x * dotRepeat2), cx2);
      lineX2 *= dotMaskY2;
      lineY2 *= dotMaskX2;
    }
  }
    float altMask = max(lineX2, lineY2);

    float edgeDistX = min(abs(hit.x - (-0.5)), abs(hit.x - 0.5));
    float edgeDistY = min(abs(hit.y - (-0.2)), abs(hit.y - 0.2));
    float edgeDist = mix(edgeDistY, edgeDistX, hitIsY);
    float edgeGate = 1.0 - smoothstep(gridScale * 0.5, gridScale * 2.0, edgeDist);
    altMask *= edgeGate;

  float lineMask = max(primaryMask, altMask);

    float fade = exp(-dist * fadeStrength);

    float dur = max(0.05, uScanDuration);
    float del = max(0.0, uScanDelay);
    float scanZMax = 2.0;
    float widthScale = max(0.1, uScanGlow);
    float sigma = max(0.001, 0.18 * widthScale * uScanSoftness);
    float sigmaA = sigma * 2.0;

    float combinedPulse = 0.0;
    float combinedAura = 0.0;

    float cycle = dur + del;
    float tCycle = mod(iTime, cycle);
    float scanPhase = clamp((tCycle - del) / dur, 0.0, 1.0);
    float phase = scanPhase;
    if (uScanDirection > 0.5 && uScanDirection < 1.5) {
      phase = 1.0 - phase;
    } else if (uScanDirection > 1.5) {
      float t2 = mod(max(0.0, iTime - del), 2.0 * dur);
      phase = (t2 < dur) ? (t2 / dur) : (1.0 - (t2 - dur) / dur);
    }
    float scanZ = phase * scanZMax;
    float dz = abs(hit.z - scanZ);
    float lineBand = exp(-0.5 * (dz * dz) / (sigma * sigma));
    float taper = clamp(uPhaseTaper, 0.0, 0.49);
    float headW = taper;
    float tailW = taper;
    float headFade = smoother01(0.0, headW, phase);
    float tailFade = 1.0 - smoother01(1.0 - tailW, 1.0, phase);
    float phaseWindow = headFade * tailFade;
    float pulseBase = lineBand * phaseWindow;
    combinedPulse += pulseBase * clamp(uScanOpacity, 0.0, 1.0);
    float auraBand = exp(-0.5 * (dz * dz) / (sigmaA * sigmaA));
    combinedAura += (auraBand * 0.25) * phaseWindow * clamp(uScanOpacity, 0.0, 1.0);

    for (int i = 0; i < MAX_SCANS; i++) {
      if (float(i) >= uScanCount) break;
      float tActiveI = iTime - uScanStarts[i];
      float phaseI = clamp(tActiveI / dur, 0.0, 1.0);
      if (uScanDirection > 0.5 && uScanDirection < 1.5) {
        phaseI = 1.0 - phaseI;
      } else if (uScanDirection > 1.5) {
        phaseI = (phaseI < 0.5) ? (phaseI * 2.0) : (1.0 - (phaseI - 0.5) * 2.0);
      }
      float scanZI = phaseI * scanZMax;
      float dzI = abs(hit.z - scanZI);
      float lineBandI = exp(-0.5 * (dzI * dzI) / (sigma * sigma));
      float headFadeI = smoother01(0.0, headW, phaseI);
      float tailFadeI = 1.0 - smoother01(1.0 - tailW, 1.0, phaseI);
      float phaseWindowI = headFadeI * tailFadeI;
      combinedPulse += lineBandI * phaseWindowI * clamp(uScanOpacity, 0.0, 1.0);
      float auraBandI = exp(-0.5 * (dzI * dzI) / (sigmaA * sigmaA));
      combinedAura += (auraBandI * 0.25) * phaseWindowI * clamp(uScanOpacity, 0.0, 1.0);
    }

  float lineVis = lineMask;
  vec3 gridCol = uLinesColor * lineVis * fade;
  vec3 scanCol = uScanColor * combinedPulse;
  vec3 scanAura = uScanColor * combinedAura;

    color = gridCol + scanCol + scanAura;

  float n = fract(sin(dot(gl_FragCoord.xy + vec2(iTime * 123.4), vec2(12.9898,78.233))) * 43758.5453123);
  color += (n - 0.5) * uNoise;
  color = clamp(color, 0.0, 1.0);
  float alpha = clamp(max(lineVis, combinedPulse), 0.0, 1.0);
  float gx = 1.0 - smoothstep(tx * 2.0, tx * 2.0 + aax * 2.0, ax);
  float gy = 1.0 - smoothstep(ty * 2.0, ty * 2.0 + aay * 2.0, ay);
  float halo = max(gx, gy) * fade;
  alpha = max(alpha, halo * clamp(uBloomOpacity, 0.0, 1.0));
  if (uLightMode > 0.5) {
    float energy = max(max(color.r, color.g), color.b);
    float coverage = clamp(max(alpha, smoothstep(0.0, 0.55, energy) * 0.82), 0.0, 0.9);
    coverage *= smoothstep(0.015, 0.12, energy);
    vec3 chroma = clamp(color / max(energy, 0.0001), 0.0, 1.0);
    chroma = pow(chroma, vec3(1.2));
    fragColor = vec4(mix(vec3(1.0), chroma, coverage * 0.94), 1.0);
  } else {
    fragColor = vec4(color, alpha);
  }
}

void main(){
  vec4 c;
  mainImage(c, vUv * iResolution.xy);
  gl_FragColor = c;
}
`;

  function hex2rgb(h) {
    var m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(h || '');
    if (!m) return [1, 1, 1];
    return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255];
  }

  function init(container, opts) {
    opts = opts || {};
    var canvas = document.createElement('canvas');
    canvas.className = 'gs-canvas';
    container.appendChild(canvas);

    /* WebGL2 拿不到就退到 WebGL1。
       这段着色器本来就是 ES 1.00 的写法（gl_FragColor、没有 in/out），
       两个版本都能编译 —— 没有理由只认 2。
       （无头 SwiftShader 里 webgl2 是拿不到的，这个兜底顺手也让它能被我验。） */
    var attrs = { antialias: false, alpha: true, premultipliedAlpha: false };
    var gl = canvas.getContext('webgl2', attrs) || canvas.getContext('webgl', attrs);
    if (!gl) { canvas.remove(); return { ok: false, why: '这个环境没有 WebGL' }; }

    function sh(type, src) {
      var o = gl.createShader(type);
      gl.shaderSource(o, src); gl.compileShader(o);
      if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) {
        var log = gl.getShaderInfoLog(o) || '';
        var kind = (type === gl.VERTEX_SHADER ? '顶点' : '片元') + (isGL2 ? '[GL2]' : '[GL1]');
        console.warn('[gridscan] ' + kind + '着色器编译失败：', log);
        // 把首尾也带上：多半是抽取时截头去尾了，看一眼就知道
        return { err: kind + '着色器: ' + log.slice(0, 300) +
                       ' ‖首‖' + String(src).slice(0, 60) +
                       ' ‖尾‖' + String(src).slice(-60) };
      }
      return o;
    }
    /* fwidth / dFdx / dFdy 是**导数函数**：WebGL2 里是核心功能，
       WebGL1 里要靠 GL_OES_standard_derivatives 扩展。
       three.js 在 WebGL1 下会自动去要这个扩展，所以我们抄来的这段 shader
       里没有任何痕迹 —— 手写 GL 就得自己处理：先要扩展，再把
       #extension 指令顶到最前面（它必须出现在所有非预处理记号之前，
       也就是 precision 那行之前）。 */
    var isGL2 = typeof WebGL2RenderingContext !== 'undefined' && (gl instanceof WebGL2RenderingContext);
    var fragSrc = FRAG, vertSrc = VERT;
    /* ═══ fwidth 这一关（踩明白了记下来）═══
       fwidth / dFdx 是导数函数。原版跑在 three.js 上从没操心过它，
       因为 three 会按环境替你选版本。手写 GL 就得自己选，而且**只能二选一**：

         · 按 ES 1.00 编：导数要靠 GL_OES_standard_derivatives 扩展。
           WebGL1 认得这个扩展名；**WebGL2 不认**（它说"extension is not
           supported"），于是 fwidth 直接没有 —— 死结。
         · 按 ES 3.00 编：导数是核心功能，不用扩展。
           代价是语法变了，得配一段兼容预处理。

       所以：GL2 走 ES3 + 预处理，GL1 走 ES1 + 扩展。 */
    var PRE_V = '#version 300 es\n#define attribute in\n#define varying out\n';
    if (isGL2) {
      vertSrc = PRE_V + vertSrc;
      fragSrc = '#version 300 es\n' +
                '#define varying in\n' +
                '#define texture2D texture\n' +
                'precision highp float;\n' +
                'out vec4 _outColor;\n' +
                '#define gl_FragColor _outColor\n' + fragSrc;
    } else {
      if (!gl.getExtension('OES_standard_derivatives')) {
        canvas.remove();
        return { ok: false, why: 'WebGL1 且拿不到 OES_standard_derivatives' };
      }
      fragSrc = '#extension GL_OES_standard_derivatives : enable\n' + fragSrc;
    }
    /* ?dbg=pulse —— 把输出直接换成 combinedPulse（扫描脉冲本身）。
       用来判定"扫描根本没算出来"还是"算出来了但被后面的合成吃掉了"。
       线上没有任何影响。 */
    /* ?dbg —— 把 lineBand / phase / phaseWindow 塞进 RGB 通道。
       ⚠️ 必须插在**块里面**：这三个变量都声明在扫描那个 { } 里，
       出了块就没了，插在外面会让着色器编译失败、整块什么都不画。
       （我第一版就插错了，看到"全黑"以为是脉冲为零，其实是没编译过。）
       触发条件是 uLightMode > 1.5 —— 这个值归我控制。 */
    if (opts.debugPulse) {
      fragSrc = fragSrc.replace(
        'float phaseWindow = headFade * tailFade;',
        'float phaseWindow = headFade * tailFade;\n' +
        '    if (uLightMode > 1.5) { fragColor = vec4(lineBand, phase, phaseWindow, 1.0); return; }'
      );
    }
    var vs = sh(gl.VERTEX_SHADER, vertSrc), fs = sh(gl.FRAGMENT_SHADER, fragSrc);
    if (vs && vs.err) { canvas.remove(); return { ok: false, why: vs.err }; }
    if (fs && fs.err) { canvas.remove(); return { ok: false, why: fs.err }; }
    var prog = gl.createProgram();
    gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      var pl = gl.getProgramInfoLog(prog) || '';
      console.warn('[gridscan] 链接失败：', pl);
      canvas.remove(); return { ok: false, why: '链接: ' + pl.slice(0, 300) };
    }
    gl.useProgram(prog);

    /* 全屏三角形 —— 比四边形省一个顶点，也不需要索引。 */
    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    // 全屏三角形。position(vec3) 与 uv 交错放：x,y,z,u,v
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1, 0, 0, 0,
       3, -1, 0, 2, 0,
      -1,  3, 0, 0, 2
    ]), gl.STATIC_DRAW);
    var STRIDE = 5 * 4;
    var lp = gl.getAttribLocation(prog, 'position');
    gl.enableVertexAttribArray(lp);
    gl.vertexAttribPointer(lp, 3, gl.FLOAT, false, STRIDE, 0);
    var lu = gl.getAttribLocation(prog, 'uv');
    if (lu >= 0) {
      gl.enableVertexAttribArray(lu);
      gl.vertexAttribPointer(lu, 2, gl.FLOAT, false, STRIDE, 3 * 4);
    }

    var U = {};
    function u(n) { if (!(n in U)) U[n] = gl.getUniformLocation(prog, n); return U[n]; }

    // ── 参数：名字和默认值都照抄原版 ──
    var S = {
      sensitivity:        opts.sensitivity        != null ? opts.sensitivity        : 0.55,
      lineThickness:      opts.lineThickness      != null ? opts.lineThickness      : 1,
      linesColor:         opts.linesColor         || '#2F293A',
      scanColor:          opts.scanColor          || '#FF9FFC',
      scanOpacity:        opts.scanOpacity        != null ? opts.scanOpacity        : 0.4,
      gridScale:          opts.gridScale          != null ? opts.gridScale          : 0.1,
      lineJitter:         opts.lineJitter         != null ? opts.lineJitter         : 0.1,
      scanGlow:           opts.scanGlow           != null ? opts.scanGlow           : 0.5,
      scanSoftness:       opts.scanSoftness       != null ? opts.scanSoftness       : 2,
      noiseIntensity:     opts.noiseIntensity     != null ? opts.noiseIntensity     : 0.01,
      bloomIntensity:     opts.bloomIntensity     != null ? opts.bloomIntensity     : 0.6,
      scanDuration:       opts.scanDuration       != null ? opts.scanDuration       : 3.0,
      scanDelay:          opts.scanDelay          != null ? opts.scanDelay          : 0.0,
      scanDirection:      opts.scanDirection      || 'pingpong',
      lineStyle:          opts.lineStyle === 'dashed' ? 1 : opts.lineStyle === 'dotted' ? 2 : 0
    };
    var s = Math.max(0, Math.min(1, S.sensitivity));
    var skewScale = 0.06 + (0.2 - 0.06) * s;
    var tiltScale = 0.12 + (0.3 - 0.12) * s;
    var yawScale  = 0.10 + (0.5 - 0.10) * s;

    gl.uniform1f(u('uLineThickness'), S.lineThickness);
    gl.uniform3fv(u('uLinesColor'), hex2rgb(S.linesColor));
    gl.uniform3fv(u('uScanColor'), hex2rgb(S.scanColor));
    gl.uniform1f(u('uGridScale'), S.gridScale);
    gl.uniform1f(u('uLineStyle'), S.lineStyle);
    gl.uniform1f(u('uLineJitter'), S.lineJitter);
    gl.uniform1f(u('uScanOpacity'), S.scanOpacity);
    gl.uniform1f(u('uNoise'), S.noiseIntensity);
    gl.uniform1f(u('uBloomOpacity'), S.bloomIntensity);
    gl.uniform1f(u('uScanGlow'), S.scanGlow);
    gl.uniform1f(u('uScanSoftness'), S.scanSoftness);
    gl.uniform1f(u('uScanDuration'), S.scanDuration);
    gl.uniform1f(u('uScanDelay'), S.scanDelay);
    gl.uniform1f(u('uScanDirection'), S.scanDirection === 'backward' ? 1 : S.scanDirection === 'pingpong' ? 2 : 0);
    gl.uniform1f(u('uPhaseTaper'), 0.08);
    gl.uniform1fv(u('uScanStarts'), new Float32Array(8));   // 一次性扫描，由 iTime 循环
    gl.uniform1f(u('uScanCount'), 1);
    gl.uniform1f(u('uLightMode'), opts.lightMode ? 1 : 0);
    if (opts.debugPulse) gl.uniform1f(u('uLightMode'), 2.0);   // 2 = 调试通道

    var W = 1, H = 1, dpr = Math.min(window.devicePixelRatio || 1, 2);
    function resize() {
      var w = container.clientWidth || 1, h = container.clientHeight || 1;
      W = w; H = h;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform3f(u('iResolution'), w, h, dpr);
    }
    resize();
    var ro = window.ResizeObserver ? new ResizeObserver(resize) : null;
    if (ro) ro.observe(container);
    window.addEventListener('resize', resize);

    /* 鼠标 → 相机。跟原版同一套缩放（sensitivity 越小动得越少）。 */
    var mx = 0, my = 0, tx = 0, ty = 0;
    function onMove(e) {
      var r = container.getBoundingClientRect();
      tx = ((e.clientX - r.left) / r.width) * 2 - 1;
      ty = ((e.clientY - r.top) / r.height) * 2 - 1;
    }
    container.addEventListener('pointermove', onMove, { passive: true });

    var raf = 0, t0 = performance.now(), dead = false;
    var FIXED_T = /[?&]t=([\d.]+)/.exec(location.search)
      ? parseFloat(/[?&]t=([\d.]+)/.exec(location.search)[1]) : null;
    var scanStarts = new Float32Array(8);
    function frame(now) {
      if (dead) return;
      raf = requestAnimationFrame(frame);
      /* ?t=NN —— 把时间钉死在这个值上。
         无头浏览器里 rAF 的时间戳几乎不前进（虚拟时间只快进 setTimeout），
         所以扫描永远停在相位 0.05、光带贴在镜头跟前 ——
         拍出来的"没有光带"是测法的锅，不是效果的锅。
         钉住时间才能逐相位看。 */
      var t = FIXED_T != null ? FIXED_T : (now - t0) / 1000;
      mx += (tx - mx) * 0.06;                 // 跟随带惯性，不然鼠标一动画面就抽
      my += (ty - my) * 0.06;
      gl.uniform2f(u('uSkew'), mx * skewScale, my * skewScale);
      gl.uniform1f(u('uTilt'), my * tiltScale);
      gl.uniform1f(u('uYaw'), mx * yawScale);
      /* 让扫描一直循环。
         原版是把若干次扫描的起始时刻塞进 uScanStarts[8]；
         我们只要"永远在扫"，所以每帧把起点推到**本周期的开始**：
           tActive = iTime - 起点  ∈ [0, 周期)
         周期一到就归零重来。
         （之前喂的是常量 0：扫完 3 秒后 phaseWindow 头尾都收成 0，
           整个画面就空了 —— 这个坑记下来。） */
      var cycle = S.scanDuration + S.scanDelay;
      scanStarts[0] = Math.floor(t / cycle) * cycle;
      gl.uniform1fv(u('uScanStarts'), scanStarts);
      gl.uniform1f(u('iTime'), t);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    raf = requestAnimationFrame(frame);

    return {
      ok: true, gl: gl,
      destroy: function () {
        dead = true;
        cancelAnimationFrame(raf);
        window.removeEventListener('resize', resize);
        if (ro) ro.disconnect();
        container.removeEventListener('pointermove', onMove);
        canvas.remove();
      }
    };
  }

  window.GridScan = { init: init };
})();
