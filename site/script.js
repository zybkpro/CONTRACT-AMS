/* ============================================================
   CONTRACT-AMS 官网交互脚本

   下载按钮指向 site/downloads/ 本地包（部署时可改为网盘 / Releases）。
   本脚本负责：移动端菜单、按系统静默高亮一张下载卡、滚动动画。
   ============================================================ */

/* ===== 移动端菜单 ===== */
const navToggle = document.querySelector('.nav-toggle');
const navLinks = document.querySelector('.nav-links');
if (navToggle && navLinks) {
  navToggle.addEventListener('click', () => {
    const open = navLinks.classList.toggle('open');
    navToggle.setAttribute('aria-expanded', String(open));
  });
  navLinks.querySelectorAll('a').forEach(a =>
    a.addEventListener('click', () => {
      navLinks.classList.remove('open');
      navToggle.setAttribute('aria-expanded', 'false');
    })
  );
}

/* ===== 按系统静默高亮一张下载卡（不展示检测文案） ===== */
/**
 * 注意：macOS 上 navigator.platform 几乎总是 "MacIntel"（含 M 芯片），
 * Chrome 在 Rosetta 下 userAgentData.architecture 也会报 x86，不能当依据。
 * 优先用 WebGL 渲染器是否含 "Apple"；判不出时默认 Apple Silicon。
 */
function isAppleSiliconMac() {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (gl) {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      if (dbg) {
        const renderer = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '');
        if (/Apple\s*M\d|Apple GPU|Apple/i.test(renderer)) return true;
        if (/Intel|AMD|Radeon|GeForce|NVIDIA/i.test(renderer)) return false;
      }
    }
  } catch (_) {}
  return true; // 2024+ Mac 默认按 M 芯片处理
}

function detectDownloadPlatform() {
  const uad = navigator.userAgentData || {};
  const platform = (uad.platform || navigator.platform || '').toLowerCase();
  const ua = (navigator.userAgent || '').toLowerCase();

  if (/windows|win32|win64/.test(platform + ' ' + ua)) return 'windows';

  const isMac = /mac/.test(platform) || /macintosh|mac os x/.test(ua);
  if (isMac) return isAppleSiliconMac() ? 'mac-arm' : 'mac-intel';

  return 'windows';
}

function highlightDownloadCard(platform) {
  document.querySelectorAll('.dl-card').forEach(card => {
    const match = card.dataset.platform === platform;
    card.classList.toggle('featured', match);
    card.classList.toggle('os-match', match);
    const btn = card.querySelector('.dl-btn');
    if (!btn) return;
    btn.classList.toggle('btn-primary', match);
    btn.classList.toggle('btn-outline', !match);
  });
}

highlightDownloadCard(detectDownloadPlatform());

/* ===== 滚动进入动画 ===== */
const revealEls = document.querySelectorAll(
  '.pain-card, .feature-card, .sync-step, .tech-wrap, .road-card, .dl-card, .faq-item, .section-head'
);
if ('IntersectionObserver' in window) {
  revealEls.forEach(el => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(18px)';
    el.style.transition = 'opacity .6s ease, transform .6s ease';
  });
  const io = new IntersectionObserver((entries) => {
    entries.forEach((entry, i) => {
      if (entry.isIntersecting) {
        setTimeout(() => {
          entry.target.style.opacity = '1';
          entry.target.style.transform = 'none';
        }, i * 60);
        io.unobserve(entry.target);
      }
    });
  }, { threshold: 0.12 });
  revealEls.forEach(el => io.observe(el));
}
