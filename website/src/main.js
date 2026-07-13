const RELEASE_URL = 'https://github.com/Zeragorn-ru/stardust/releases/latest';
const MAP_ATTRIBUTE = 'data-server-map-url';
const STEVE_SKIN_URL = '/steve.png';

document.addEventListener('DOMContentLoaded', () => {
  const navbar = document.querySelector('.navbar');
  const mobileBtn = document.querySelector('.mobile-menu-btn');
  const navLinks = document.querySelector('.nav-links');
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const mapDialog = document.querySelector('.map-dialog');
  const mapFrame = mapDialog?.querySelector('iframe');
  const mapHint = document.querySelector('[data-map-hint]');
  const mapUrl = document.documentElement.getAttribute(MAP_ATTRIBUTE)?.trim() || '';

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
      if (mapDialog?.open) mapDialog.close();
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
  applyReleaseLinks();
  wireMapDialog({ mapUrl, mapDialog, mapFrame, mapHint });
  decoratePixelAvatar();
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

function applyReleaseLinks() {
  document.querySelectorAll('a[href="https://github.com/Zeragorn-ru/stardust/releases/latest"]').forEach((link) => {
    link.href = RELEASE_URL;
  });
}

function wireMapDialog({ mapUrl, mapDialog, mapFrame, mapHint }) {
  if (!mapDialog) return;

  const closeButton = mapDialog.querySelector('.map-dialog-close');
  const openButtons = document.querySelectorAll('[data-map-open]');

  if (mapUrl) {
    mapDialog.classList.add('has-map');
    if (mapFrame) mapFrame.src = mapUrl;
    if (mapHint) mapHint.textContent = 'Карта откроется внутри сайта и в новой вкладке по той же ссылке.';
  }

  openButtons.forEach((button) => {
    button.addEventListener('click', () => {
      if (mapUrl && window.innerWidth < 900) {
        window.open(mapUrl, '_blank', 'noopener');
        return;
      }
      mapDialog.showModal();
    });
  });

  closeButton?.addEventListener('click', () => mapDialog.close());
  mapDialog.addEventListener('click', (event) => {
    const rect = mapDialog.getBoundingClientRect();
    const inside = rect.top <= event.clientY && event.clientY <= rect.bottom && rect.left <= event.clientX && event.clientX <= rect.right;
    if (!inside) mapDialog.close();
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
