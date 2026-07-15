const RELEASE_URL = 'https://github.com/Zeragorn-ru/stardust/releases/latest';
const RELEASE_API_URL = 'https://api.github.com/repos/Zeragorn-ru/stardust/releases/latest';
const MAP_ATTRIBUTE = 'data-server-map-url';
const ADMIN_API_ATTRIBUTE = 'data-admin-api-url';
const AUTH_API_ATTRIBUTE = 'data-auth-api-url';
const STEVE_SKIN_URL = '/steve.png';

document.addEventListener('DOMContentLoaded', () => {
  const navbar = document.querySelector('.navbar');
  const mobileBtn = document.querySelector('.mobile-menu-btn');
  const navLinks = document.querySelector('.nav-links');
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const mapDialog = document.querySelector('.map-dialog');
  const mapFrame = mapDialog?.querySelector('iframe');
  const mapUrl = document.documentElement.getAttribute(MAP_ATTRIBUTE)?.trim() || '';
  const adminApiUrl = normalizeBaseUrl(document.documentElement.getAttribute(ADMIN_API_ATTRIBUTE));
  const authApiUrl = normalizeBaseUrl(document.documentElement.getAttribute(AUTH_API_ATTRIBUTE));

  const closeMenu = () => {
    navLinks?.classList.remove('open');
    mobileBtn?.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('menu-open');
  };

  if (mobileBtn && navLinks) {
    mobileBtn.addEventListener('click', () => {
      const isOpen = navLinks.classList.toggle('open');
      mobileBtn.setAttribute('aria-expanded', String(isOpen));
      document.body.classList.toggle('menu-open', isOpen);
    });

    document.addEventListener('click', (event) => {
      if (!navLinks.classList.contains('open')) return;
      if (navLinks.contains(event.target) || mobileBtn.contains(event.target)) return;
      closeMenu();
    });
  }

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeMenu();
      if (mapDialog?.open) closeMapDialog(mapDialog);
    }
  });

  document.querySelectorAll('a[href^="#"]').forEach((anchor) => {
    anchor.addEventListener('click', (event) => {
      const selector = anchor.getAttribute('href');
      const target = selector === '#' ? document.body : document.querySelector(selector);
      if (!target) return;
      event.preventDefault();
      target.scrollIntoView({ behavior: prefersReducedMotion ? 'auto' : 'smooth', block: 'start' });
      closeMenu();
    });
  });

  let lastScrollY = window.scrollY;
  window.addEventListener('scroll', () => {
    const currentScrollY = window.scrollY;
    if (!navbar) return;
    navbar.classList.toggle('scrolled', currentScrollY > 16);
    navbar.classList.toggle('hidden', !prefersReducedMotion && currentScrollY > lastScrollY && currentScrollY > 180);
    lastScrollY = currentScrollY;
  }, { passive: true });

  document.querySelectorAll('.faq-question').forEach((button) => {
    button.addEventListener('click', () => {
      const item = button.closest('.faq-item');
      const isOpen = item.classList.contains('active');
      document.querySelectorAll('.faq-item').forEach((faq) => setFaqState(faq, false));
      setFaqState(item, !isOpen);
    });
  });

  if (!prefersReducedMotion) {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('visible');
        observer.unobserve(entry.target);
      });
    }, { threshold: 0.14 });

    document.querySelectorAll('.reveal').forEach((element) => observer.observe(element));
  } else {
    document.querySelectorAll('.reveal').forEach((element) => element.classList.add('visible'));
  }

  createParticles(prefersReducedMotion);
  applyPlatformHint();
  applyReleaseLinks().finally(applyPlatformHint);
  wireMapDialog({ mapUrl, mapDialog, mapFrame });
  wireServerAddressCopy();
  decoratePixelAvatar();
  hydrateBackendStatus({ adminApiUrl, authApiUrl });
});

function setFaqState(item, expanded) {
  const button = item?.querySelector('.faq-question');
  const answer = item?.querySelector('.faq-answer');
  if (!item || !button || !answer) return;
  item.classList.toggle('active', expanded);
  button.setAttribute('aria-expanded', String(expanded));
  answer.style.maxHeight = expanded ? `${answer.scrollHeight}px` : '0px';
}

function createParticles(prefersReducedMotion) {
  if (prefersReducedMotion) return;
  const container = document.getElementById('particles');
  if (!container) return;

  for (let i = 0; i < 22; i += 1) {
    const particle = document.createElement('span');
    const size = 2 + Math.random() * 4;
    particle.className = 'particle';
    particle.style.left = `${Math.random() * 100}%`;
    particle.style.top = `${68 + Math.random() * 32}%`;
    particle.style.width = `${size}px`;
    particle.style.height = `${size}px`;
    particle.style.animationDelay = `${Math.random() * 14}s`;
    particle.style.animationDuration = `${12 + Math.random() * 10}s`;
    container.appendChild(particle);
  }
}

async function applyReleaseLinks() {
  const releaseStatus = document.querySelector('[data-release-status]');
  const links = [...document.querySelectorAll('[data-platform]')];
  links.forEach((link) => {
    link.href = RELEASE_URL;
  });

  try {
    const release = await fetchJson(RELEASE_API_URL);
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const assetLinks = {
      windows: findAssetUrl(assets, [/\.exe$/i, /setup/i]) || findAssetUrl(assets, [/\.msi$/i]) || findAssetUrl(assets, [/\.exe$/i]),
      macos: findAssetUrl(assets, [/\.dmg$/i]),
      linux: findAssetUrl(assets, [/\.AppImage$/i]) || findAssetUrl(assets, [/\.deb$/i]) || findAssetUrl(assets, [/\.rpm$/i]),
    };

    links.forEach((link) => {
      const url = assetLinks[link.dataset.platform];
      if (url) link.href = url;
    });

    const readyCount = Object.values(assetLinks).filter(Boolean).length;
    if (releaseStatus) releaseStatus.textContent = readyCount > 0 ? `Прямые ссылки обновлены из ${release.tag_name || 'последнего релиза'}.` : 'Прямые asset-ссылки не найдены, откроем страницу последнего релиза.';
  } catch {
    if (releaseStatus) releaseStatus.textContent = 'GitHub не ответил, откроем страницу последнего релиза.';
  }
}

function applyPlatformHint() {
  const platform = detectPlatform();
  const label = platformLabels[platform] || 'Windows, macOS или Linux';
  const platformBadge = document.querySelector('[data-detected-platform]');
  const downloadTitle = document.querySelector('[data-download-title]');
  const downloadHint = document.querySelector('[data-download-hint]');
  const primaryDownload = document.querySelector('[data-primary-download]');
  const buttons = [...document.querySelectorAll('[data-platform]')];
  const activeButton = buttons.find((button) => button.dataset.platform === platform) || buttons[0];

  buttons.forEach((button) => {
    button.classList.toggle('platform-button--active', button === activeButton);
    if (button === activeButton) button.setAttribute('aria-current', 'true');
    else button.removeAttribute('aria-current');
  });

  if (platformBadge) platformBadge.textContent = platform ? `${label} определена` : 'Выбери платформу';
  if (downloadTitle) downloadTitle.textContent = platform ? `Скачать для ${label}` : 'Скачать лаунчер';
  if (downloadHint) downloadHint.textContent = platform ? `Похоже, тебе нужен установщик для ${label}. Если это не так, выбери другую платформу.` : 'Выбери платформу вручную. Все варианты ведут к последнему релизу.';
  if (primaryDownload && activeButton) primaryDownload.href = activeButton.href;
}

function findAssetUrl(assets, patterns) {
  const asset = assets.find((item) => {
    const name = item.name || '';
    if (/\.sha256$/i.test(name) || /bootstrap/i.test(name)) return false;
    return patterns.every((pattern) => pattern.test(name));
  });
  return asset?.browser_download_url || '';
}

const platformLabels = {
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux',
};

function detectPlatform() {
  const userAgent = window.navigator.userAgent.toLowerCase();
  const platform = window.navigator.platform?.toLowerCase() || '';
  if (userAgent.includes('windows') || platform.includes('win')) return 'windows';
  if (userAgent.includes('mac os') || platform.includes('mac')) return 'macos';
  if (userAgent.includes('linux') || platform.includes('linux')) return 'linux';
  return '';
}

function wireMapDialog({ mapUrl, mapDialog, mapFrame }) {
  if (!mapDialog) return;

  const closeButton = mapDialog.querySelector('.map-dialog-close');
  const openButtons = document.querySelectorAll('[data-map-open]');

  if (mapUrl) {
    mapDialog.classList.add('has-map');
    if (mapFrame) mapFrame.src = mapUrl;
  }

  openButtons.forEach((button) => {
    button.addEventListener('click', () => {
      if (mapUrl) {
        window.open(mapUrl, '_blank', 'noopener');
        return;
      }
      openMapDialog(mapDialog, button);
    });
  });

  closeButton?.addEventListener('click', () => closeMapDialog(mapDialog));
  mapDialog.addEventListener('click', (event) => {
    const rect = mapDialog.getBoundingClientRect();
    const inside = rect.top <= event.clientY && event.clientY <= rect.bottom && rect.left <= event.clientX && event.clientX <= rect.right;
    if (!inside) closeMapDialog(mapDialog);
  });
}

let lastMapTrigger = null;

function openMapDialog(mapDialog, trigger) {
  lastMapTrigger = trigger;
  mapDialog.showModal();
  mapDialog.querySelector('.map-dialog-close')?.focus();
}

function closeMapDialog(mapDialog) {
  mapDialog.close();
  lastMapTrigger?.focus();
  lastMapTrigger = null;
}

function wireServerAddressCopy() {
  const copyButton = document.querySelector('[data-copy-server]');
  const address = document.querySelector('[data-server-address]')?.textContent?.trim() || '';
  if (!copyButton || !address) return;

  copyButton.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(address);
      copyButton.textContent = 'Скопировано';
      window.setTimeout(() => {
        copyButton.textContent = 'Скопировать';
      }, 1800);
    } catch {
      copyButton.textContent = address;
    }
  });
}

function decoratePixelAvatar() {
  const avatar = document.querySelector('.pixel-avatar');
  if (!avatar) return;

  const image = new Image();
  image.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width = 8;
    canvas.height = 8;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.imageSmoothingEnabled = false;
    context.drawImage(image, 8, 8, 8, 8, 0, 0, 8, 8);
    context.drawImage(image, 40, 8, 8, 8, 0, 0, 8, 8);
    avatar.style.backgroundImage = `url(${canvas.toDataURL()})`;
    avatar.style.backgroundSize = 'cover';
    avatar.style.backgroundPosition = 'center';
  };
  image.src = STEVE_SKIN_URL;
}

async function hydrateBackendStatus({ adminApiUrl, authApiUrl }) {
  const healthBadge = document.querySelector('[data-health-badge]');
  const healthLabel = document.querySelector('[data-health-label]');
  const healthStatus = document.querySelector('[data-health-status]');
  const launcherStatus = document.querySelector('[data-launcher-status]');
  const launcherPlayers = document.querySelector('[data-launcher-players]');
  const buildLoader = document.querySelector('[data-build-loader]');
  const buildVersion = document.querySelector('[data-build-version]');
  const buildSummary = document.querySelector('[data-build-summary]');
  const serverStatusPanel = document.querySelector('[data-server-status-panel]');
  const serverStatusTitle = document.querySelector('[data-server-status-title]');
  const serverStatusText = document.querySelector('[data-server-status-text]');
  const authStatus = document.querySelector('[data-status-auth]');
  const adminStatus = document.querySelector('[data-status-admin]');
  const buildStatus = document.querySelector('[data-status-build]');
  const buildMeta = document.querySelector('[data-status-build-meta]');

  const [adminHealth, authHealth, manifest] = await Promise.allSettled([
    fetchText(`${adminApiUrl}/health`),
    fetchText(`${authApiUrl}/health`),
    fetchJson(`${adminApiUrl}/manifest`),
  ]);

  const adminOnline = adminHealth.status === 'fulfilled' && adminHealth.value.trim().toLowerCase() === 'ok';
  const authOnline = authHealth.status === 'fulfilled' && authHealth.value.trim().toLowerCase() === 'ok';
  const online = adminOnline || authOnline;

  healthBadge?.classList.toggle('live-badge--offline', !online);
  serverStatusPanel?.classList.toggle('server-status-panel--offline', !online);
  if (healthLabel) healthLabel.textContent = online ? 'backend online' : 'backend status unavailable';
  if (healthStatus) healthStatus.textContent = online ? 'Онлайн' : 'Недоступен';
  if (launcherStatus) launcherStatus.textContent = online ? 'Онлайн' : '—';
  if (launcherPlayers) launcherPlayers.textContent = online ? 'play.stardust-mc.xyz' : 'статус не отдан';
  if (serverStatusTitle) serverStatusTitle.textContent = online ? 'Сервисы отвечают' : 'Backend временно недоступен';
  if (serverStatusText) serverStatusText.textContent = online ? 'Лаунчер, авторизация и выдача сборки доступны. Если Minecraft-сервер перезапускается, попробуй зайти ещё раз через минуту.' : 'Можно скачать лаунчер сейчас. Если сайт не получил статус, лаунчер повторит проверку при запуске.';
  if (authStatus) authStatus.textContent = authOnline ? 'Онлайн' : 'Нет ответа';
  if (adminStatus) adminStatus.textContent = adminOnline ? 'Онлайн' : 'Нет ответа';

  if (manifest.status === 'fulfilled' && manifest.value) {
    const loader = manifest.value.loader;
    const loaderLabel = loader ? `${formatLoader(loader.kind)} ${loader.minecraft}` : 'активная сборка';
    const versionLabel = manifest.value.version ? `build ${manifest.value.version}` : manifest.value.name;
    if (buildLoader) buildLoader.textContent = loaderLabel;
    if (buildVersion) buildVersion.textContent = versionLabel || 'активная сборка';
    if (buildSummary) buildSummary.textContent = `${manifest.value.name || 'Активная сборка'} · ${versionLabel || 'версия актуальна'}`;
    if (buildStatus) buildStatus.textContent = manifest.value.name || 'Готова';
    if (buildMeta) buildMeta.textContent = versionLabel || 'версия актуальна';
  } else {
    if (buildSummary) buildSummary.textContent = 'Активная сборка будет загружена лаунчером';
    if (buildStatus) buildStatus.textContent = 'Fallback';
    if (buildMeta) buildMeta.textContent = 'лаунчер проверит сам';
  }
}

function normalizeBaseUrl(value) {
  const base = value?.trim();
  return base ? base.replace(/\/$/, '') : '';
}

async function fetchText(url) {
  const response = await fetchWithTimeout(url, { headers: { Accept: 'text/plain' } });
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return response.text();
}

async function fetchJson(url) {
  const response = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return response.json();
}

async function fetchWithTimeout(url, options = {}) {
  if (!url) throw new Error('Request URL is empty');
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 2500);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    window.clearTimeout(timeout);
  }
}

function formatLoader(kind) {
  if (!kind) return 'Loader';
  if (kind.toLowerCase() === 'neoforge') return 'NeoForge';
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}
