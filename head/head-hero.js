/* ═══════════════════════════════════════════════════════════════════════
   head-hero.js —— 首屏头颅拆解

   从 head-demo/demo.html 抽出来的自包含组件。剥掉了面板、滑块、HUD、
   调试口，只留一件事：**给我一个容器和一条进度，我把它渲染出来。**

     import { createHeadHero } from './head/head-hero.js';
     const hero = createHeadHero(document.querySelector('#head'), {
       progress: () => scrollProgress,   // 每帧问一次，0..1
     });

   为什么是"每帧问一次"而不是 `setProgress()`：
   滚动事件在移动端会节流、在惯性滚动里还会延迟，用它驱动动画一定会抖。
   读一个变量的当前值则永远跟得上。这也是课室游戏那条
   "世界是时间的函数"的同一件事 —— 外部只提供一个数，内部自己插值。

   参数默认值是嘉豪 2026-09-16 23:54 调定的那一组
   （layers=6 split=0.290 gap=0.000 holo=0.800 sep=1）。
   ⚠️ gap = 0 是刻意的：六层完全相同的拷贝，不做"往里推"。
   往里推会让内层壳从外层壳里穿出来（法线朝内的顶点被推向外面），
   出来的是一堆彩色尖角碎片。归零之后结构上就没有这个问题。
   ═══════════════════════════════════════════════════════════════════════ */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/* ── 每一层的颜色 ──
   色相从冰蓝(198°)绕一整圈到金(401°≡41°)，六层正好落进六个色区：
     冰蓝 → 靛 → 紫 → 洋红 → 朱红 → 金
   方向跟站点原来的"冷蓝→暖米"一致，收尾那格的金就是 --warm。
   明度做了一道很浅的弧（中间最亮、两头略沉）—— 六个色明度完全相同
   会看起来像"生成"的，有一点起伏才像挑过的。 */
const _pal = new THREE.Color();
function layerColor(s) {
  const h = ((198 + 203 * s) % 360) / 360;
  return _pal.setHSL(h, 0.82, 0.60 + 0.06 * Math.sin(s * Math.PI));
}

/* ── 每层一套材质 ──
   只换色相加不了多少东西，"质感"的差别要落在材质参数上。
   顺带：不要有一层是 100% 金属。metalness 1 的物体没有漫反射，
   某个角度反射到环境暗处会整块黑掉、跟视角绑死。 */
const RECIPES = [
  { metalness: 0.92, roughness: 0.03, clearcoat: 0.50, clearcoatRoughness: 0.04 }, // 镜面铬
  { metalness: 0.88, roughness: 0.38, clearcoat: 0.25, clearcoatRoughness: 0.25 }, // 缎面金属
  { metalness: 0.45, roughness: 0.28, clearcoat: 1.0, clearcoatRoughness: 0.05,
    sheen: 0.85, sheenRoughness: 0.35 },                                           // 珠光漆
  { metalness: 0.04, roughness: 0.58, clearcoat: 0.45, clearcoatRoughness: 0.38 }, // 磨砂陶
  { metalness: 0.82, roughness: 0.10, irid: 1.00, iridSpan: 0.42 },                // 全息膜
  { metalness: 0.15, roughness: 0.03, clearcoat: 1.0, clearcoatRoughness: 0.02,
    sheen: 0.50, sheenRoughness: 0.20, irid: 0.60, iridSpan: 0.30 }                // 琉璃
];

/* ── 环境：自制"摄影棚" ──
   不用 RoomEnvironment：它的平均值偏暗，而高金属度的物体拉远之后
   屏幕导数变大、会采样到最糊那级 mip（=整张图的平均值）→ 越远越黑。
   自己画一张**不会暗**的：上白、中带站点的冷蓝、下压到 #23272f 不给纯黑。 */
function makeStudioEnv(renderer) {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0.00, '#ffffff');
  grad.addColorStop(0.34, '#d3e7fb');
  grad.addColorStop(0.50, '#86aecb');
  grad.addColorStop(0.72, '#3d4753');
  grad.addColorStop(1.00, '#23272f');
  g.fillStyle = grad; g.fillRect(0, 0, 64, 256);
  const hl = g.createRadialGradient(18, 44, 0, 18, 44, 36);
  hl.addColorStop(0, 'rgba(255,255,255,1)');
  hl.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = hl; g.fillRect(0, 0, 64, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  const pm = new THREE.PMREMGenerator(renderer);
  const env = pm.fromEquirectangular(tex).texture;
  pm.dispose(); tex.dispose();
  return env;
}

/* ── 法线兜底 ──
   这个模型导出来**没有 NORMAL 属性**，自己算还有一批顶点是零长法线
   （退化三角形）。GLSL 里 normalize(vec3(0)) = NaN，而 NaN 会传染 ——
   整块渲染成纯黑，连自发光拉满都救不回来。
   （2026-09-16 为这个黑了三小时，别再删。） */
function ensureNormals(geo) {
  if (!geo.attributes.normal) geo.computeVertexNormals();
  const nrm = geo.attributes.normal, pos = geo.attributes.position;
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const cx = (bb.min.x + bb.max.x) / 2,
        cy = (bb.min.y + bb.max.y) / 2,
        cz = (bb.min.z + bb.max.z) / 2;
  const a = nrm.array, p = pos.array;
  for (let i = 0; i < a.length; i += 3) {
    if (a[i] === 0 && a[i + 1] === 0 && a[i + 2] === 0) {
      const dx = p[i] - cx, dy = p[i + 1] - cy, dz = p[i + 2] - cz;
      const L = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      a[i] = dx / L; a[i + 1] = dy / L; a[i + 2] = dz / L;
    }
  }
  nrm.needsUpdate = true;
}

/* ── 档次 ──
   同一份代码换参数，不是另写一版。以后调了效果，三档一起变。 */
export function tier() {
  const w = innerWidth;
  const cores = navigator.hardwareConcurrency || 4;
  const mem = navigator.deviceMemory || 4;
  const coarse = matchMedia('(pointer: coarse)').matches;
  if (coarse && (w < 700 || cores <= 4 || mem <= 4)) return 'low';
  if (coarse || w < 1100) return 'mid';
  return 'high';
}
const TIERS = {
  high: { layers: 6, dpr: 2.0,  holo: 0.80, irid: 1.0, auto: true  },
  mid:  { layers: 4, dpr: 1.75, holo: 0.55, irid: 0.5, auto: true  },
  low:  { layers: 3, dpr: 1.35, holo: 0.40, irid: 0.0, auto: false },
};

/* ═══════════════════════════════════════════════════════════════════════ */
export function createHeadHero(container, opts = {}) {
  const T        = TIERS[opts.tier || tier()];
  const readProg = opts.progress || (() => 0);
  const modelURL = opts.model || new URL('./head.glb', import.meta.url).href;

  const renderer = new THREE.WebGLRenderer({ antialias: T.layers > 3, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, T.dpr));
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;
  renderer.domElement.style.display = 'block';
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.environment = makeStudioEnv(renderer);

  const camera = new THREE.PerspectiveCamera(32, 1, 0.01, 100);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;
  controls.enableZoom = false;
  controls.enablePan = false;
  controls.autoRotate = false;   // 姿态改由模型自己走（setPose），相机不动 —— 节奏要精确控制就得自己拿着时间轴
  controls.autoRotateSpeed = 0.55;
  controls.enabled = opts.draggable !== false;

  scene.add(new THREE.AmbientLight(0xffffff, 0.45));
  const key = new THREE.DirectionalLight(0x9fd8ff, 2.4); key.position.set(-1.2, 1.6, 1.6); scene.add(key);
  const rim = new THREE.DirectionalLight(0xe8c9a0, 1.4); rim.position.set(1.5, -0.8, -1.6); scene.add(rim);

  /* 全局 uniform —— 六层共享 */
  const G = {
    uProgress: { value: 0 },
    uGap:      { value: 0.00 },   // 嘉豪定稿在 0：六层完全相同，不做往里推
    uSpread:   { value: 1 },
    uMin:      { value: new THREE.Vector3() },
    uMax:      { value: new THREE.Vector3() },
    uCenter:   { value: new THREE.Vector3() },
    uTurns:    { value: 0.42 },
    uUp:       { value: 0.95 },
    uTime:     { value: 0 },
    uHolo:     { value: T.holo },
    uShear:    { value: 0 }   // 层间绕竖直轴的错开（只在转动时不为 0）
  };

  const group = new THREE.Group();
  scene.add(group);
  let meshes = [], modelCenter = null, baseGeo = null, dead = false;

  function rebuild(n) {
    meshes.forEach((m) => { group.remove(m); m.material.dispose(); });
    meshes = [];
    for (let i = 0; i < n; i++) {
      const s = n === 1 ? 0 : i / (n - 1);
      const u = { uShell: { value: s }, uPhase: { value: s },
                  uTint: { value: layerColor(s).clone() } };
      const mat = new THREE.MeshPhysicalMaterial();
      const tint = layerColor(s);
      mat.color.copy(tint);

      const rc = RECIPES[Math.round(s * (RECIPES.length - 1))];
      mat.metalness = rc.metalness;
      mat.roughness = rc.roughness;
      if (rc.clearcoat !== undefined) mat.clearcoat = rc.clearcoat;
      if (rc.clearcoatRoughness !== undefined) mat.clearcoatRoughness = rc.clearcoatRoughness;
      if (rc.sheen !== undefined) {
        mat.sheen = rc.sheen; mat.sheenRoughness = rc.sheenRoughness;
        mat.sheenColor.copy(tint);
      }
      mat.iridescence = (rc.irid !== undefined ? rc.irid : 0.42) * T.irid;
      mat.iridescenceIOR = 1.34;
      mat.iridescenceThicknessRange =
        [180 + s * 260, (700 + s * 300) * (rc.iridSpan !== undefined ? rc.iridSpan : 1)];
      mat.envMapIntensity = 1.45;
      mat.side = THREE.DoubleSide;
      mat.emissive.copy(tint);
      mat.emissiveIntensity = 0.05;   // 极弱的自发光兜底：任何角度都还看得见这一层的颜色

      mat.onBeforeCompile = (sh) => {
        Object.assign(sh.uniforms, G, u);
        sh.vertexShader = sh.vertexShader
          .replace('#include <common>', `#include <common>
            uniform float uShell, uProgress, uGap, uSpread, uUp, uTurns, uTime, uPhase, uShear;
            uniform vec3  uMin, uMax, uCenter;
            varying float vUp; varying vec3 vN, vV;`)
          .replace('#include <begin_vertex>', `#include <begin_vertex>
            {
              vec3 P = transformed;
              vUp = -P.z;                       // 模型自身竖直方向（头顶在 -Z）

              // 层往里推。gap 现在是 0，但滑块留着 —— 一旦不为零，
              // 这里必须**只取法线里朝里的那一半**，否则法线朝内的顶点
              // （凹面、眼窝、碎片边缘）会被推向外面，内层壳从外层里穿出来，
              // 出来就是一堆彩色尖角碎片。
              vec3 radial = normalize(P - uCenter + vec3(1e-6));
              float dn = max(dot(objectNormal, radial), 0.0);
              vec3 pull = normalize(radial + objectNormal * dn * 0.8);
              P -= pull * (uShell * uGap * length(uMax - uMin) * 0.15);

              // 散开：层沿一条弧线绕着头转开
              float ang = uShell * 6.2831853 * uTurns;
              float rise = (uShell - 0.5) * 2.0;
              vec3 dir = normalize(vec3(cos(ang), rise * uUp, sin(ang)));
              P += dir * uSpread * uProgress * (0.35 + uShell * 0.65);

              /* 层间错位：每层绕**模型自身的竖直轴**（局部 Z）多转一点点。
                 静止时 uShear 是 0，六层严格重合、看不出有层；
                 一转起来才拉开几度，层与层的边缘错开，
                 出现一圈彩色的位移 —— 全息质感就是从这儿来的。
                 这就是 anime.js 那个 stagger 的用法：
                 **差别不在幅度，在相位**。 */
              float sh = uShell * uShear;
              float cs = cos(sh), sn = sin(sh);
              P.xy = vec2(P.x * cs - P.y * sn, P.x * sn + P.y * cs);

              transformed = P;
            }`)
          .replace('#include <project_vertex>', `#include <project_vertex>
            vV = -mvPosition.xyz;
            vN = normalize(normalMatrix * objectNormal);`);
        sh.fragmentShader = sh.fragmentShader
          .replace('#include <common>', `#include <common>
            uniform float uTime, uHolo, uPhase, uProgress;
            uniform vec3  uTint;
            varying float vUp; varying vec3 vN, vV;`)
          .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
            {
              /* 三样叠出来的全息，缺一样就不像：
                 ① 扫描带 —— 一条窄光带沿竖直方向往上走，每层相位错开，
                    六层合起来是**一道穿过所有层的行进波**；
                 ② 菲涅尔边 —— 视线越掠射越亮，这是全息跟普通铬的分界；
                 ③ 虹彩 —— 色相被"层号/掠射角/高度"同时推着走，
                    长在几何上，不是糊在上面的一层膜。
                 强度乘 uProgress：层散得越开光越亮，光是**响应**，不是自播。
                 ⚠️ +1e-5 / max(0,·) 是防 NaN：零长法线或浮点误差会让
                 normalize/pow 出 NaN，NaN 一进 totalEmissiveRadiance
                 整块就是纯黑。 */
              float d = abs(fract(vUp * 1.15 - uTime * 0.16 + uPhase * 0.42) - 0.5);
              float band = exp(-d * d * 70.0);
              vec3  N = normalize(vN + vec3(1e-5));
              vec3  V = normalize(vV + vec3(1e-5));
              float fres = pow(max(0.0, 1.0 - abs(dot(N, V))), 2.6);
              float hue  = fract(uPhase * 0.7 + fres * 0.45 + vUp * 0.5 + uTime * 0.02);
              vec3  shift = 0.5 + 0.5 * cos(6.2831853 * (hue + vec3(0.0, 0.33, 0.67)));
              vec3  glow = mix(uTint, shift, 0.22);
              totalEmissiveRadiance += uHolo * (band * 0.85 + fres * 0.40) * glow
                                     * (0.55 + uProgress * 0.85);
            }`);
      };
      mat.needsUpdate = true;
      const mesh = new THREE.Mesh(baseGeo, mat);
      group.add(mesh);
      meshes.push(mesh);
    }
  }

  /* ═══ 朝向 + 节奏 ═══
     朝向：绕 X 转 +90°（量出来的：模型头朝 -Z、脸朝 +Y）。

     节奏：做法直接抄 anime.js 首屏那段 bob ——
         y:[{to:'+=.03', ease:'inQuad',  duration:500},
            {to:'-=.03', ease:'outQuad', duration:1000}]
       上去 500ms、下来 1000ms：**两段不等长、缓动也不同**。
       不对称才是节奏；等长等缓动的往复只是机械摆动。

       所以转头做成三段：
         去程 → 快（占周期 30%）
         顶端 → 定住一拍（6%）
         回程 → 慢（剩下 64%）
       "停一拍"是额外的：没有它，转头只是来回晃；有了它才像"看过去、
       停一下、再收回来"。

       再叠一层不同周期的呼吸浮动（7.5s 转头 / 5.3s 上下），
       两个周期互质 —— 永远不同步，看久了也找不到循环的接缝。 */
  const QX = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
  const QZ = new THREE.Quaternion();
  const QP = new THREE.Quaternion();
  const QC = new THREE.Quaternion();
  const AXIS_X = new THREE.Vector3(1, 0, 0);
  const AXIS_Z = new THREE.Vector3(0, 0, 1);

  /* 摆姿势 = 俯仰 × 转头，都用四元数合成而不是写 Euler：
     要的是"先在模型空间里抬/转，再摆正到世界"，Euler 的默认顺序给不了这个。
     乘法从右往左作用到顶点上，所以顺序是：先 pitch，再 spin，最后摆正。 */
  function setPose(spin, pitch) {
    QZ.setFromAxisAngle(AXIS_Z, spin);
    QP.setFromAxisAngle(AXIS_X, pitch);
    QC.copy(QX).multiply(QZ).multiply(QP);
    group.quaternion.copy(QC);
    // 居中跟着一起算：世界 = R·v + pos，要让它等于 R·(v − c)，所以 pos = −(R·c)
    group.position.copy(modelCenter).applyQuaternion(QC).negate();
  }

  /* ── 转头：每一轮的参数都重新抽一次 ──
     固定周期是最容易被看穿的 —— 两轮之后脑子就抓住节奏了，
     剩下的只是"在循环"。一旦看出循环，再顺的动作也变成机械。
     这就是"算不上动画"的来源。

     anime.js 那页给形状用的是
         rotate: random(-180,180), duration: random(500,1000)
     —— **每一轮重新抽参数**。照抄这个。

     用确定性伪随机（hash）而不是 Math.random()：
     同一时刻永远得到同一组参数，画面可复现 ——
     回头要按某一帧截图对参数的时候不会错位。 */
  const easeInOutQuad = (x) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);
  const hash = (n) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
  const pick = (i, k, a, b) => a + (b - a) * hash(i * 7.13 + k * 3.71);

  function cycleParams(i) {
    return {
      period: pick(i, 1, 5.0, 11.5),        // 每轮长短不一
      amp:    pick(i, 2, 0.55, 1.30),       // 幅度约 32°~75°
      go:     pick(i, 3, 0.20, 0.44),       // 去程占整轮的比例
      hold:   pick(i, 4, 0.02, 0.16),       // 顶端停多久
      dir:    pick(i, 5, 0, 1) < 0.5 ? -1 : 1   // 往左转还是往右转
    };
  }

  let seg = cycleParams(0), segStart = 0, segIdx = 0;
  function turnAt(t) {
    while (t >= segStart + seg.period) { segStart += seg.period; seg = cycleParams(++segIdx); }
    const p = (t - segStart) / seg.period;
    const GO = seg.go, HOLD = seg.hold;
    let v;
    if (p < GO)             v = easeInOutQuad(p / GO);
    else if (p < GO + HOLD) v = 1;
    else                    v = 1 - easeInOutQuad((p - GO - HOLD) / (1 - GO - HOLD));
    return v * seg.amp * seg.dir;   // 每轮结尾都回到 0，所以接得上下一次
  }

  /* 呼吸用两个**不可通约**的频率叠（0.83 / 1.31，比值接近黄金比）——
     永远不重合，所以也读不出周期。固定周期的问题跟转头是同一个。 */
  const bobAt = (t) => (Math.sin(t * 0.83) * 0.6 + Math.sin(t * 1.31) * 0.4) * 0.011;

  new GLTFLoader().load(modelURL, (gltf) => {
    if (dead) return;
    let src = null;
    gltf.scene.traverse((o) => { if (!src && o.isMesh) src = o; });
    if (!src) { opts.onError && opts.onError('模型里没有网格'); return; }
    baseGeo = src.geometry;
    ensureNormals(baseGeo);

    baseGeo.computeBoundingBox();
    const bb = baseGeo.boundingBox;
    const size = new THREE.Vector3(); bb.getSize(size);
    modelCenter = new THREE.Vector3(); bb.getCenter(modelCenter);
    const maxDim = Math.max(size.x, size.y, size.z);
    G.uMin.value.copy(bb.min); G.uMax.value.copy(bb.max);
    G.uSpread.value = maxDim * 0.52;
    G.uCenter.value.copy(modelCenter);

    setPose(0, 0);

    rebuild(T.layers);
    modelR = maxDim * 0.5;
    controls.target.set(0, 0, 0);
    frame();

    opts.onReady && opts.onReady();
    tick();
  }, undefined, (e) => { if (!dead) opts.onError && opts.onError(e); });

  /* ── 取景 ──
     距离**按视口宽高比算**，不是一个写死的倍数：
     横屏时以高度为准、手机竖屏时以宽度为准，整颗头才都进得了画面。
     写死的话，同一个数在桌面正好、在竖屏手机上脸会被切掉两侧。
     fit 是留白倍数（1.0 = 正好撑满）。 */
  let modelR = 0;
  function frame() {
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    if (!modelR) return;
    const vFov = THREE.MathUtils.degToRad(camera.fov);
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
    const d = Math.max(modelR / Math.tan(vFov / 2), modelR / Math.tan(hFov / 2));
    // 保住当前的环绕角度（用户拖过就按他的角度），只改距离
    const dir = camera.position.lengthSq() > 0
      ? camera.position.clone().normalize()
      : new THREE.Vector3(0, 0, 1);
    camera.position.copy(dir.multiplyScalar(d * (opts.fit || 1.55)));
  }
  addEventListener('resize', frame);

  let cur = 0;
  function tick() {
    if (dead) return;
    requestAnimationFrame(tick);
    G.uTime.value = performance.now() * 0.001;
    const t = G.uTime.value;

    /* ── 节奏（全部由这一个时间轴推出来，不另开计时器）──
       转头幅度约 54°，叠在每 19 秒一圈的慢漂上 ——
       慢漂保证"它一直在动"，转头保证"它有时候动得明显"。
       两者叠加才是活的；只有前一个是转盘，只有后一个是点头。 */
    /* ═══ 俯仰：跟着滚动走 ═══
       光有水平转头，角度是死的 —— 从任何滚动位置看都是同一个"平视"。
       这里让头随着向下滚**微微上仰**（满程约 11°），滚回去自己抬回来。
       注意它绑的是**滚动位置**（cur），不是另开一条时间轴 ——
       所以它是"你滚到哪、它抬到哪"，不是一个自己播的动画。

       符号：模型自身的上是 -Z、脸是 +Y。绕 +X 正转会把 +Y 推向 +Z
       （模型自己的"下"），所以**要上仰得用负角**。 */
    setPose(t * 0.055 + turnAt(t), -cur * 0.19);
    group.position.y += bobAt(t);

    /* ═══ 层间错位：试过，撤了 ═══
       本想"静止时六层严丝合缝、转起来才错开几度出彩边"，
       但**头不是旋转对称的** —— 两层相对转哪怕 2.8°，
       脸颊、耳朵、头发这些地方就会互相捅穿，
       出来的是大片金色从蓝色里冒出来，不是干净的彩边。
       这跟 gap 是同一个坑的另一种形式：**任何层间的相对位移，
       在非旋转对称的形体上都会变成插穿。**
       嘉豪用 gap=0 把这个问题从参数上关掉了，这里别再打开。
       （着色器里的 uShear 留着但恒为 0，真要试把下面这行放回来。）
       G.uShear.value = Math.min(1, Math.abs(turnCurve(t + 1 / 60) - tc) * 60) * 0.055;
       ─────────────────────────────────────────────────────────── */

    // 进度从外面读，内部平滑 —— 外部给的是"位置"，不是"事件"
    const raw = Math.max(0, Math.min(1, readProg() || 0));
    cur += (raw - cur) * 0.07;
    G.uProgress.value = cur;

    // 散开时整体收一点，把整摞留在画面里（缩 group 而不是退相机，
    // 相机归 OrbitControls 管，每帧动它会跟阻尼打架）
    group.scale.setScalar(1 / (1 + cur * 0.85));

    controls.update();
    renderer.render(scene, camera);
  }

  frame();
  return {
    setTierLayers(n) { rebuild(n); },
    dispose() {
      dead = true;
      removeEventListener('resize', frame);
      meshes.forEach((m) => m.material.dispose());
      baseGeo && baseGeo.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    }
  };
}
