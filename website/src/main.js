const RELEASE_URL = 'https://github.com/Zeragorn-ru/stardust/releases/latest';
const RELEASE_API_URL = 'https://api.github.com/repos/Zeragorn-ru/stardust/releases/latest';

const html = document.documentElement;
const adminBase = (html.getAttribute('data-admin-api-url') || '').replace(/\/$/, '');
const mapUrl = html.getAttribute('data-server-map-url')?.trim() || '';

/** Иконка из спрайта в index.html: цвет наследуется через currentColor. */
function icon(id, thin = false) {
  return `<svg class="icon${thin ? ' icon--thin' : ''}" aria-hidden="true"><use href="#i-${id}" /></svg>`;
}

/** Заменяет скелетоны готовой разметкой и снимает состояние загрузки. */
function settle(target, markup) {
  target.innerHTML = markup;
  target.removeAttribute('aria-busy');
  // Класс запускает «приезд» строк (row-arrive); при reduced-motion анимация отключена в CSS.
  target.classList.add('settle-in');
}

window.addEventListener('DOMContentLoaded', () => {
  const menu = document.querySelector('.menu-button');
  const nav = document.querySelector('nav');
  const closeMenu = () => {
    nav?.classList.remove('open');
    menu?.setAttribute('aria-expanded', 'false');
    menu?.setAttribute('aria-label', 'Открыть меню');
  };
  menu?.addEventListener('click', () => {
    const open = nav.classList.toggle('open');
    menu.setAttribute('aria-expanded', String(open));
    menu.setAttribute('aria-label', open ? 'Закрыть меню' : 'Открыть меню');
  });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeMenu(); });
  document.querySelectorAll('nav a, .site-header a[href^="#"], footer a[href^="#"], .hero a[href^="#"]').forEach((link) => link.addEventListener('click', closeMenu));
  document.querySelectorAll('[data-map-link]').forEach((link) => { if (mapUrl) link.href = mapUrl; });
  initCopyButtons();
  applyReleaseLinks();
  hydrateStatus();
  if (location.pathname.startsWith('/guides/') && location.pathname !== '/guides/') renderGuideDetail(decodeURIComponent(location.pathname.slice('/guides/'.length)));
  else loadGuides();
  loadLeaderboards();
});

/** Кнопка копирования адреса сервера: label и иконка переключаются на время подтверждения. */
function initCopyButtons() {
  document.querySelectorAll('[data-copy-value]').forEach((button) => {
    button.addEventListener('click', async () => {
      const value = button.dataset.copyValue || '';
      const label = button.querySelector('[data-copy-label]');
      const use = button.querySelector('use');
      const ok = await copyText(value);
      if (!ok || !label) return;
      const original = label.textContent;
      label.textContent = 'Скопировано';
      button.classList.add('copy-button--done');
      if (use) use.setAttribute('href', '#i-check');
      window.setTimeout(() => {
        label.textContent = original;
        button.classList.remove('copy-button--done');
        if (use) use.setAttribute('href', '#i-copy');
      }, 1800);
    });
  });
}

async function copyText(value) {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(value); return true; }
  } catch { /* переходим к запасному пути */ }
  try {
    const area = document.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch { return false; }
}

async function applyReleaseLinks() {
  const links = [...document.querySelectorAll('[data-platform]')];
  links.forEach((link) => { link.href = RELEASE_URL; });
  const platform = detectPlatform();
  const active = links.find((link) => link.dataset.platform === platform) || links[0];
  active?.classList.add('active');
  const primary = document.querySelector('[data-primary-download]');
  if (primary && active) primary.href = active.href;
  try {
    const release = await fetchJson(RELEASE_API_URL);
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const urls = {
      windows: findAsset(assets, /\.(exe|msi)$/i),
      macos: findAsset(assets, /\.dmg$/i),
      linux: findAsset(assets, /\.(AppImage|deb|rpm)$/i),
    };
    links.forEach((link) => { if (urls[link.dataset.platform]) link.href = urls[link.dataset.platform]; });
    if (primary && active && urls[active.dataset.platform]) primary.href = urls[active.dataset.platform];
    const status = document.querySelector('[data-release-status]');
    if (status) status.textContent = `Последний релиз ${release.tag_name || 'готов'} · прямые ссылки обновлены из GitHub.`;
  } catch {
    const status = document.querySelector('[data-release-status]');
    if (status) status.textContent = 'GitHub временно не ответил — откроется страница последнего релиза.';
  }
}

function findAsset(assets, pattern) {
  return assets.find((asset) => pattern.test(asset.name || '') && !/bootstrap|sha256/i.test(asset.name || ''))?.browser_download_url || '';
}

function detectPlatform() {
  const value = `${navigator.userAgent} ${navigator.platform}`.toLowerCase();
  if (value.includes('win')) return 'windows';
  if (value.includes('mac')) return 'macos';
  if (value.includes('linux')) return 'linux';
  return '';
}

async function hydrateStatus() {
  const dot = document.querySelector('[data-health-dot]');
  const label = document.querySelector('[data-health-label]');
  const server = document.querySelector('[data-server-status]');
  const players = document.querySelector('[data-server-players]');
  const version = document.querySelector('[data-build-version]');
  const summary = document.querySelector('[data-build-summary]');
  const [health, manifest] = await Promise.allSettled([fetchJson(`${adminBase}/health`), fetchJson(`${adminBase}/manifest`)]);
  const online = health.status === 'fulfilled';
  if (dot) dot.classList.toggle('offline', !online);
  if (label) label.textContent = online ? 'Сервер доступен' : 'Статус временно недоступен';
  if (server) server.textContent = online ? 'Онлайн' : 'Нет ответа';
  if (manifest.status === 'fulfilled' && manifest.value) {
    const data = manifest.value;
    const build = data.version || data.name || 'актуальна';
    if (version) version.textContent = build;
    const minecraft = data.loader?.minecraft;
    if (summary) summary.textContent = minecraft ? `Minecraft ${minecraft} · сборка ${build}` : `${data.name || 'StarDust'} · ${build}`;
    renderBuildPanel(data);
  } else {
    if (version) version.textContent = 'Проверит лаунчер';
    renderBuildPanelFallback();
  }
  if (players) players.textContent = 'см. в лаунчере';
}

/** Панель состава сборки в hero: строки из живого манифеста (/admin/manifest). */
function renderBuildPanel(manifest) {
  const name = document.querySelector('[data-build-name]');
  const tag = document.querySelector('[data-build-tag]');
  const rows = document.querySelector('[data-build-rows]');
  if (name && manifest.name) name.textContent = manifest.name;
  if (tag && manifest.version) tag.textContent = manifest.version;
  if (!rows) return;
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  const mods = files.filter((file) => file.kind === 'mod').length;
  const optionalMods = files.filter((file) => file.kind === 'mod' && file.optional).length;
  const bytes = files.reduce((sum, file) => sum + (Number(file.size) || 0), 0);
  const loaderKind = manifest.loader?.kind ? formatLoaderKind(manifest.loader.kind) : '';
  const loaderVersion = manifest.loader?.version || '';
  const profiles = Array.isArray(manifest.modProfiles) ? manifest.modProfiles : [];
  const entries = [
    ['Minecraft', manifest.loader?.minecraft || '—'],
    ['Загрузчик', loaderKind ? `${loaderKind}${loaderVersion ? ` ${loaderVersion}` : ''}` : '—'],
    ['Модов в сборке', `${mods}${optionalMods ? ` · ${optionalMods} на выбор` : ''}`],
    ['Всего файлов', `${files.length} · ${formatBytes(bytes)}`],
  ];
  if (profiles.length) entries.push(['Профили модов', profiles.map((profile) => profile.name).filter(Boolean).join(' / ') || '—']);
  settle(rows, entries.map(([key, value]) => `<div class="build-row"><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd></div>`).join(''));
}

/** Манифест недоступен: вместо вечных скелетонов показываем, что состав подтянет лаунчер. */
function renderBuildPanelFallback() {
  const rows = document.querySelector('[data-build-rows]');
  const tag = document.querySelector('[data-build-tag]');
  if (tag) tag.textContent = 'актуальна в лаунчере';
  if (!rows) return;
  settle(rows, '<div class="build-row"><dt>Состав</dt><dd>Проверит лаунчер</dd></div><div class="build-row"><dt>Обновление</dt><dd>При следующем запуске</dd></div>');
}

function formatLoaderKind(kind) {
  const names = { vanilla: 'Vanilla', fabric: 'Fabric', quilt: 'Quilt', forge: 'Forge', neoforge: 'NeoForge' };
  return names[String(kind).toLowerCase()] || String(kind);
}

function formatBytes(bytes) {
  if (!bytes) return '0 Б';
  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  const power = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** power;
  return `${value.toLocaleString('ru-RU', { maximumFractionDigits: power === 0 ? 0 : 1 })} ${units[power]}`;
}

async function loadGuides() {
  const target = document.querySelector('[data-guides]');
  if (!target || !adminBase) return;
  try {
    const guides = await fetchJson(`${adminBase}/public/guides`);
    if (!guides.length) { settle(target, '<p class="muted grid-note">Гайды скоро появятся.</p>'); return; }
    settle(target, guides.slice(0, 6).map((guide) => `<a class="guide-card" href="/guides/${encodeURIComponent(guide.slug)}"><span>${escapeHtml(guide.category)}</span><h3>${escapeHtml(guide.title)}</h3><p>${escapeHtml(guide.excerpt || '')}</p><small>Читать гайд ${icon('arrow-out')}</small></a>`).join(''));
  } catch { settle(target, '<p class="muted grid-note">Не удалось загрузить гайды. Попробуй обновить страницу.</p>'); }
}

async function loadLeaderboards() {
  const targets = [...document.querySelectorAll('[data-leaderboard]')];
  if (!targets.length || !adminBase) return;
  try {
    const data = await fetchJson(`${adminBase}/public/leaderboards`);
    targets.forEach((target) => {
      const rows = data[target.dataset.leaderboard] || [];
      if (!rows.length) { settle(target, '<p class="muted">Пока недостаточно данных.</p>'); return; }
      settle(target, rows.map((entry) => `<div class="leaderboard-row"><span class="leaderboard-rank">${entry.rank}</span><strong>${escapeHtml(entry.username)}</strong><span>${formatLeaderboardValue(target.dataset.leaderboard, entry.value)}</span></div>`).join(''));
    });
  } catch { targets.forEach((target) => { settle(target, '<p class="muted">Лидерборд пока недоступен.</p>'); }); }
}

function formatLeaderboardValue(category, value) {
  const amount = Number(value || 0);
  if (category === 'playtime') return `${Math.floor(amount / 3600)} ч`;
  if (category === 'blocksMined') return `${amount.toLocaleString('ru-RU')} шт.`;
  if (category === 'distance') return `${Math.floor(amount / 100)} м`;
  return `${amount.toLocaleString('ru-RU')} раз`;
}

async function renderGuideDetail(slug) {
  const main = document.querySelector('main');
  if (!main || !adminBase) return;
  try {
    const guide = await fetchJson(`${adminBase}/public/guides/${encodeURIComponent(slug)}`);
    const author = guide.authorName || guide.author_name || 'Команда StarDust';
    main.innerHTML = `<section class="guide-detail container"><a class="back-link" href="/#guides">${icon('arrow-left', true)} Все гайды</a><p class="kicker"><span class="tick" aria-hidden="true"></span>${escapeHtml(guide.category)}</p><h1>${escapeHtml(guide.title)}</h1><p class="guide-detail__excerpt">${escapeHtml(guide.excerpt || '')}</p><div class="guide-meta">${escapeHtml(author)} · обновлено ${formatDate(guide.updatedAt || guide.updated_at)}</div><article class="guide-content">${renderMarkdown(guide.markdown)}</article></section>`;
  } catch {
    main.innerHTML = `<section class="guide-detail container"><a class="back-link" href="/#guides">${icon('arrow-left', true)} Все гайды</a><h1>Гайд не найден</h1><p class="muted">Проверь ссылку или вернись к списку гайдов.</p></section>`;
  }
}

function renderMarkdown(markdown) {
  return escapeHtml(markdown).split(/\n{2,}/).map((block) => {
    if (/^### /.test(block)) return `<h3>${block.slice(4)}</h3>`;
    if (/^## /.test(block)) return `<h2>${block.slice(3)}</h2>`;
    if (/^# /.test(block)) return `<h2>${block.slice(2)}</h2>`;
    if (/^(?:- |\* )/m.test(block)) return `<ul>${block.split('\n').map((line) => `<li>${line.replace(/^(?:- |\* )/, '')}</li>`).join('')}</ul>`;
    return `<p>${block.replace(/\n/g, '<br />')}</p>`;
  }).join('');
}

function formatDate(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }); }
function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char])); }
async function fetchJson(url) { const response = await fetch(url, { headers: { Accept: 'application/json' } }); if (!response.ok) throw new Error(`Request failed: ${response.status}`); return response.json(); }
