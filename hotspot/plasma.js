/* ============================================================
   plasma.js —— 等离子流（热点区正文的底）

   来源：React Bits 的 <Plasma />，剥掉 React 重写成 vanilla。
   原版依赖 **ogl**（一个极简 WebGL 库），这里用原生 WebGL2，零依赖。

   相对原版的三处偏离：

   1. **不走 ogl。** 那个库在这件事上只做三样：建上下文、编译程序、
      画一个全屏三角形 —— 不到 60 行，没必要为它多拖一个依赖。
   2. **着色器逐字照抄**，一个字没改。跟 GridScan 不同的是
      **它本来就是 `#version 300 es`**，不用折腾 ES1/ES3 兼容预处理。
   3. **拿不到 WebGL2 就安静地什么都不做**，容器留空。背景板不该有资格把页面搞坏。

   ⚠️ 顶点着色器里的 `in vec2 position` / `in vec2 uv` 是框架**自动注入**的，
      原作者的 shader 里看不见。原生 WebGL 必须自己声明、自己绑缓冲
      —— 同一个坑 GridScan 那边踩过一次，这里没再踩。
   ============================================================ */
(function () {
  'use strict';

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
uniform vec2 iResolution;
uniform float iTime;
uniform vec3 uCustomColor;
uniform float uUseCustomColor;
uniform float uSpeed;
uniform float uDirection;
uniform float uScale;
uniform float uOpacity;
uniform vec2 uMouse;
uniform float uMouseInteractive;
uniform float uQuality;
uniform float uStepScale;
uniform float uLightMode;
out vec4 fragColor;

void mainImage(out vec4 o, vec2 C) {
  vec2 center = iResolution.xy * 0.5;
  C = (C - center) / uScale + center;
  
  vec2 mouseOffset = (uMouse - center) * 0.0002;
  C += mouseOffset * length(C - center) * step(0.5, uMouseInteractive);
  
  float i, d, z, T = iTime * uSpeed * uDirection;
  vec3 O, p, S;

  for (vec2 r = iResolution.xy, Q; ++i < 60.0; O += o.w/d*o.xyz) {
    p = z*normalize(vec3(C-.5*r,r.y)); 
    p.z -= 4.; 
    S = p;
    d = p.y-T;
    
    p.x += .4*(1.+p.y)*sin(d + p.x*0.1)*cos(.34*d + p.x*0.05); 
    Q = p.xz *= mat2(cos(p.y+vec4(0,11,33,0)-T)); 
    z += d = (abs(sqrt(length(Q*Q)) - .25*(5.+S.y))/3.+8e-4) * uStepScale;
    o = 1.+sin(S.y+p.z*.5+S.z-length(S-p)+vec4(2,1,0,8));
    if (i >= uQuality) break;
  }
  
  o.xyz = tanh(O/1e4);
}

bool finite1(float x){ return !(isnan(x) || isinf(x)); }
vec3 sanitize(vec3 c){
  return vec3(
    finite1(c.r) ? c.r : 0.0,
    finite1(c.g) ? c.g : 0.0,
    finite1(c.b) ? c.b : 0.0
  );
}

void main() {
  vec4 o = vec4(0.0);
  mainImage(o, gl_FragCoord.xy);
  vec3 rgb = sanitize(o.rgb);
  
  float intensity = (rgb.r + rgb.g + rgb.b) / 3.0;
  vec3 customColor = intensity * uCustomColor;
  vec3 finalColor = mix(rgb, customColor, step(0.5, uUseCustomColor));
  
  float alpha = length(rgb) * uOpacity;
  if (uLightMode > 0.5) {
    vec3 source = clamp(finalColor, 0.0, 1.0);
    float peak = max(source.r, max(source.g, source.b));
    float floorColor = min(source.r, min(source.g, source.b));
    vec3 chroma = (source - vec3(floorColor)) / max(peak - floorColor, 0.0001);
    vec3 pigment = mix(source / max(peak, 0.0001), chroma, 0.68) * 0.72;
    float energy = clamp(length(rgb) / 1.7320508, 0.0, 1.0);
    float coverage = pow(smoothstep(0.035, 0.72, energy), 0.76) * min(uOpacity, 1.0) * 0.9;
    fragColor = vec4(mix(vec3(1.0), pigment, coverage), 1.0);
  } else {
    fragColor = vec4(finalColor, alpha);
  }
}`;

  function hex2lin(h) {
    var m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(h || '');
    if (!m) return [1, 1, 1];
    // sRGB → 线性。等离子是**加法**混色，不转的话会糊成一片白。
    return [0, 1, 2].map(function (i) {
      var v = parseInt(m[i + 1], 16) / 255;
      return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
  }

  function init(container, opts) {
    opts = opts || {};
    var canvas = document.createElement('canvas');
    canvas.style.cssText = 'display:block;width:100%;height:100%';
    container.appendChild(canvas);

    var gl = canvas.getContext('webgl2',
      { antialias: false, alpha: true, premultipliedAlpha: false });
    if (!gl) { canvas.remove(); return { ok: false, why: '没有 WebGL2' }; }

    function sh(type, src) {
      var o = gl.createShader(type);
      gl.shaderSource(o, src); gl.compileShader(o);
      if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) {
        var log = (gl.getShaderInfoLog(o) || '') +
                  ' ||首||' + String(src).slice(0, 50) +
                  ' ||尾||' + String(src).slice(-50);
        console.warn('[plasma] 编译失败：', log);
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

    var iterations = opts.iterations != null ? opts.iterations : 60;
    gl.uniform3fv(u('uCustomColor'), new Float32Array(hex2lin(opts.color || '#B497CF')));
    gl.uniform1f(u('uUseCustomColor'), 1.0);
    gl.uniform1f(u('uSpeed'), (opts.speed != null ? opts.speed : 1) * 0.4);
    gl.uniform1f(u('uDirection'), opts.direction === 'reverse' ? -1 : 1);
    gl.uniform1f(u('uScale'), opts.scale != null ? opts.scale : 1);
    gl.uniform1f(u('uOpacity'), opts.opacity != null ? opts.opacity : 1);
    gl.uniform2f(u('uMouse'), 0, 0);
    gl.uniform1f(u('uMouseInteractive'), 0);
    gl.uniform1f(u('uQuality'), iterations);
    gl.uniform1f(u('uStepScale'), 60 / iterations);
    gl.uniform1f(u('uLightMode'), 0);

    var dpr = Math.min(window.devicePixelRatio || 1, opts.maxDpr != null ? opts.maxDpr : 1.5);
    var budget = opts.renderScale != null ? opts.renderScale : 0.55;
    function resize() {
      var w = container.clientWidth || 1, h = container.clientHeight || 1;
      if (!w || !h) return;
      var sc = Math.max(0.25, Math.min(1, budget));
      canvas.width = Math.round(w * dpr * sc);
      canvas.height = Math.round(h * dpr * sc);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform2f(u('iResolution'), canvas.width, canvas.height);
    }
    resize();
    var ro = window.ResizeObserver ? new ResizeObserver(resize) : null;
    if (ro) ro.observe(container);
    window.addEventListener('resize', resize);

    /* 限帧。等离子是纯底图，跑满 120fps 只是白烧电 —— 原版也有限帧参数。 */
    var minGap = 1000 / Math.max(1, opts.targetFps != null ? opts.targetFps : 30);
    var raf = 0, t0 = performance.now(), last = -1e9, dead = false;
    function frame(now) {
      if (dead) return;
      raf = requestAnimationFrame(frame);
      if (now - last < minGap) return;
      last = now;
      gl.uniform1f(u('iTime'), (now - t0) / 1000);
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
        canvas.remove();
      }
    };
  }

  window.Plasma = { init: init };
})();
