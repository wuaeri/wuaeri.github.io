/* ============================================================
   落款卡 · 指针跟随
   React Bits 那版是个 React 组件，剥掉框架之后真正要干的事
   只有一件：把鼠标在卡面上的位置写进一组 CSS 变量。
   剩下的旋转、光泽、眩光，全是 CSS 自己算的。

   变量分工：
     --pointer-x / -y       光斑和高光的落点
     --pointer-from-*       归一化的位置，0~1，CSS 拿它算偏移量
     --rotate-x / -y        3D 倾角
     --background-x / -y    全息条纹的流动相位
   ============================================================ */
(function () {
  var MAX_TILT = 20;   // 最大倾角，超过就是一晃一晃的廉价感

  function init(wrap) {
    var card = wrap.querySelector('.sig-card');
    if (!card) return;

    function set(e) {
      var r = card.getBoundingClientRect();
      if (!r.width || !r.height) return;

      var px = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      var py = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
      var cx = px - 0.5, cy = py - 0.5;

      wrap.style.setProperty('--pointer-x', (px * 100) + '%');
      wrap.style.setProperty('--pointer-y', (py * 100) + '%');
      wrap.style.setProperty('--pointer-from-left', px.toFixed(4));
      wrap.style.setProperty('--pointer-from-top', py.toFixed(4));
      wrap.style.setProperty('--pointer-from-center',
        Math.min(1, Math.hypot(cx, cy) * 2).toFixed(4));
      wrap.style.setProperty('--rotate-x', (cx * MAX_TILT).toFixed(2) + 'deg');
      wrap.style.setProperty('--rotate-y', (-cy * MAX_TILT).toFixed(2) + 'deg');
      wrap.style.setProperty('--background-x', (px * 100) + '%');
      wrap.style.setProperty('--background-y', (py * 100) + '%');
    }

    function reset() {
      wrap.classList.remove('active');
      card.classList.remove('active');
      ['--pointer-x', '--pointer-y', '--background-x', '--background-y'].forEach(function (v) {
        wrap.style.setProperty(v, '50%');
      });
      ['--pointer-from-left', '--pointer-from-top'].forEach(function (v) {
        wrap.style.setProperty(v, '0.5');
      });
      wrap.style.setProperty('--pointer-from-center', '0');
      wrap.style.setProperty('--rotate-x', '0deg');
      wrap.style.setProperty('--rotate-y', '0deg');
    }

    wrap.addEventListener('pointermove', function (e) {
      wrap.classList.add('active');
      card.classList.add('active');
      set(e);
    });
    wrap.addEventListener('pointerenter', function (e) {
      wrap.classList.add('active');
      card.classList.add('active');
      set(e);
    });
    wrap.addEventListener('pointerleave', reset);

    // 触屏：手指离开后回正
    wrap.addEventListener('touchstart', function (e) {
      wrap.classList.add('active');
      card.classList.add('active');
      if (e.touches[0]) set(e.touches[0]);
    }, { passive: true });
    wrap.addEventListener('touchmove', function (e) {
      if (e.touches[0]) set(e.touches[0]);
    }, { passive: true });
    wrap.addEventListener('touchend', reset);
    wrap.addEventListener('touchcancel', reset);

    /* 兜底：触摸端 .active 一旦漏摘就永久定格流光。
       pointerleave 在触摸上靠不住 —— 手指抬起时指针"位置"没变，
       浏览器不认为它离开了元素，那条 reset 就未必来。
       所以触摸的收尾按 pointer 事件自己再兜一层。 */
    function resetIfTouch(e) {
      if (e.pointerType === 'touch') reset();
    }
    wrap.addEventListener('pointerup', resetIfTouch);
    wrap.addEventListener('pointercancel', resetIfTouch);

    // 入场时归位一次，避免继承上一页残留的变量
    reset();

    wireContact(wrap);
  }

  /* 联系按钮 → 微信号气泡。
     点按钮开合，点气泡本体复制。file:// 下 navigator.clipboard 不一定可用，
     所以留着 execCommand 那条老路兜底。 */
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(
        function () { return true; },
        function () { return fallbackCopy(text); }
      );
    }
    return Promise.resolve(fallbackCopy(text));
  }

  function fallbackCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (err) {
      return false;
    }
  }

  function wireContact(wrap) {
    var btn = wrap.querySelector('.sig-contact-btn');
    var pop = wrap.querySelector('.sig-contact-pop');
    if (!btn || !pop) return;

    function close() {
      pop.classList.remove('on');
      pop.setAttribute('aria-hidden', 'true');
    }

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = pop.classList.toggle('on');
      pop.setAttribute('aria-hidden', open ? 'false' : 'true');
    });

    pop.addEventListener('click', function () {
      var idEl = pop.querySelector('.sig-contact-id');
      var tip = pop.querySelector('.sig-contact-tip');
      var text = idEl ? idEl.textContent.trim() : '';
      if (!text) return;
      copyText(text).then(function (ok) {
        if (!tip) return;
        tip.textContent = ok ? '已复制' : '复制失败，手动选中';
        pop.classList.add('done');
        setTimeout(function () {
          tip.textContent = '点击复制';
          pop.classList.remove('done');
        }, 1800);
      });
    });

    // 点卡片别处收起来
    document.addEventListener('click', function (e) {
      if (pop.classList.contains('on') && !pop.contains(e.target)) close();
    });
  }

  function boot() {
    document.querySelectorAll('.sig-wrap').forEach(function (w) {
      if (!w.dataset.sigInit) { w.dataset.sigInit = '1'; init(w); }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
  window.SigCard = { boot: boot };
})();
