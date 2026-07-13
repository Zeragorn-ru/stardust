import { SkinViewer } from 'skinview3d';

document.addEventListener('DOMContentLoaded', () => {
    const navbar = document.querySelector('.navbar');
    const mobileBtn = document.querySelector('.mobile-menu-btn');
    const navLinks = document.querySelector('.nav-links');
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const closeMobileMenu = () => {
        navLinks?.classList.remove('open');
        mobileBtn?.setAttribute('aria-expanded', 'false');
    };

    const setFaqState = (item, expanded) => {
        const button = item.querySelector('.faq-question');
        const answer = item.querySelector('.faq-answer');
        item.classList.toggle('active', expanded);
        button?.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        answer.style.maxHeight = expanded ? `${answer.scrollHeight}px` : null;
    };

    document.querySelectorAll('.faq-question').forEach(btn => {
        btn.addEventListener('click', () => {
            const item = btn.closest('.faq-item');
            const isOpen = item.classList.contains('active');

            document.querySelectorAll('.faq-item').forEach(i => setFaqState(i, false));
            if (!isOpen) setFaqState(item, true);
        });
    });

    const particlesContainer = document.getElementById('particles');
    if (particlesContainer && !prefersReducedMotion) {
        for (let i = 0; i < 24; i++) {
            const particle = document.createElement('div');
            const size = 2 + Math.random() * 4;
            particle.className = 'particle';
            particle.style.left = `${Math.random() * 100}%`;
            particle.style.top = `${80 + Math.random() * 30}%`;
            particle.style.animationDelay = `${Math.random() * 18}s`;
            particle.style.animationDuration = `${16 + Math.random() * 18}s`;
            particle.style.width = `${size}px`;
            particle.style.height = `${size}px`;
            particlesContainer.appendChild(particle);
        }
    }

    if (!prefersReducedMotion) {
        const revealObserver = new IntersectionObserver(entries => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    entry.target.classList.add('visible');
                    revealObserver.unobserve(entry.target);
                }
            });
        }, { threshold: 0.12 });

        document.querySelectorAll('.reveal').forEach(el => revealObserver.observe(el));
    } else {
        document.querySelectorAll('.reveal').forEach(el => el.classList.add('visible'));
    }

    let lastScrollY = window.scrollY;
    window.addEventListener('scroll', () => {
        const currentScrollY = window.scrollY;

        if (navbar) {
            navbar.style.background = currentScrollY > 80 ? 'rgba(8, 8, 16, 0.92)' : 'rgba(8, 8, 16, 0.75)';
            navbar.classList.toggle('hidden', !prefersReducedMotion && currentScrollY > lastScrollY && currentScrollY > 160);
        }

        lastScrollY = currentScrollY;
    }, { passive: true });

    if (mobileBtn && navLinks) {
        mobileBtn.addEventListener('click', () => {
            const isOpen = navLinks.classList.toggle('open');
            mobileBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
        });

        document.addEventListener('click', event => {
            if (!navLinks.classList.contains('open')) return;
            if (navLinks.contains(event.target) || mobileBtn.contains(event.target)) return;
            closeMobileMenu();
        });

        window.addEventListener('keydown', event => {
            if (event.key === 'Escape') closeMobileMenu();
        });
    }

    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', event => {
            const selector = anchor.getAttribute('href');
            const target = selector === '#' ? document.body : document.querySelector(selector);

            if (target) {
                event.preventDefault();
                target.scrollIntoView({ behavior: prefersReducedMotion ? 'auto' : 'smooth', block: 'start' });
                closeMobileMenu();
            }
        });
    });

    initAvatarPreview();
    initSkinPreview(prefersReducedMotion).catch(() => {
        document.querySelector('.launcher-preview-skin')?.classList.remove('skinview-ready');
    });
});

let steveSkinDataUrl = '';

function createSteveSkinDataUrl() {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    if (!ctx) return '';
    ctx.imageSmoothingEnabled = false;

    ctx.clearRect(0, 0, 64, 64);

    const skin = '#b77a56';
    const skinLight = '#c98b65';
    const skinDark = '#8f573c';
    const hair = '#3a271d';
    const hairDark = '#241711';
    const shirt = '#00a6a6';
    const shirtDark = '#007f7f';
    const shirtLight = '#18bcbc';
    const pants = '#3b47a7';
    const pantsDark = '#222c78';
    const shoes = '#2d1b14';

    const rect = (x, y, w, h, color) => {
        ctx.fillStyle = color;
        ctx.fillRect(x, y, w, h);
    };

    const noise = (x, y, w, h, colors) => {
        for (let yy = y; yy < y + h; yy++) {
            for (let xx = x; xx < x + w; xx++) {
                rect(xx, yy, 1, 1, colors[(xx + yy * 3) % colors.length]);
            }
        }
    };

    // Classic Steve 64x64 layout: head.
    noise(8, 0, 8, 8, [hair, hairDark]);
    noise(16, 0, 8, 8, [hair, hairDark]);
    noise(0, 8, 8, 8, [skinDark, skin]);
    noise(8, 8, 8, 8, [skin, skinLight]);
    noise(16, 8, 8, 8, [skin, skinDark]);
    noise(24, 8, 8, 8, [hair, hairDark]);
    rect(8, 8, 8, 3, hair);
    rect(8, 11, 1, 1, hairDark);
    rect(15, 11, 1, 1, hairDark);
    rect(9, 12, 2, 1, '#2a1d17');
    rect(13, 12, 2, 1, '#2a1d17');
    rect(11, 15, 3, 1, '#6b3a2f');

    // Body.
    noise(20, 16, 8, 4, [shirtDark, shirt]);
    noise(28, 16, 8, 4, [shirtDark, shirt]);
    noise(16, 20, 4, 12, [shirtDark, shirt]);
    noise(20, 20, 8, 12, [shirt, shirtLight]);
    noise(28, 20, 4, 12, [shirtDark, shirt]);
    noise(32, 20, 8, 12, [shirtDark, shirt]);
    rect(23, 20, 2, 12, 'rgba(255,255,255,0.12)');

    // Right arm.
    noise(44, 16, 4, 4, [skinDark, skin]);
    noise(48, 16, 4, 4, [skin, skinLight]);
    noise(40, 20, 4, 12, [skinDark, skin]);
    noise(44, 20, 4, 12, [shirt, shirtLight]);
    noise(48, 20, 4, 12, [skin, skinLight]);
    noise(52, 20, 4, 12, [skinDark, skin]);

    // Right leg.
    noise(4, 16, 4, 4, [pantsDark, pants]);
    noise(8, 16, 4, 4, [pants, pantsDark]);
    noise(0, 20, 4, 12, [pantsDark, pants]);
    noise(4, 20, 4, 10, [pants, pantsDark]);
    noise(8, 20, 4, 10, [pants, pantsDark]);
    noise(12, 20, 4, 12, [pantsDark, pants]);
    rect(4, 30, 8, 2, shoes);

    // Left leg (1.8+ layout).
    noise(20, 48, 4, 4, [pantsDark, pants]);
    noise(24, 48, 4, 4, [pants, pantsDark]);
    noise(16, 52, 4, 12, [pantsDark, pants]);
    noise(20, 52, 4, 10, [pants, pantsDark]);
    noise(24, 52, 4, 10, [pants, pantsDark]);
    noise(28, 52, 4, 12, [pantsDark, pants]);
    rect(20, 62, 8, 2, shoes);

    // Left arm (1.8+ layout).
    noise(36, 48, 4, 4, [skinDark, skin]);
    noise(40, 48, 4, 4, [skin, skinLight]);
    noise(32, 52, 4, 12, [skinDark, skin]);
    noise(36, 52, 4, 12, [shirt, shirtLight]);
    noise(40, 52, 4, 12, [skin, skinLight]);
    noise(44, 52, 4, 12, [skinDark, skin]);

    return canvas.toDataURL('image/png');
}

function getSteveSkinDataUrl() {
    if (!steveSkinDataUrl) steveSkinDataUrl = createSteveSkinDataUrl();
    return steveSkinDataUrl;
}

function initAvatarPreview() {
    const canvas = document.getElementById('launcher-avatar-canvas');
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    const img = new Image();
    img.onload = () => {
        ctx.imageSmoothingEnabled = false;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 8, 8, 8, 8, 0, 0, 8, 8);
        ctx.drawImage(img, 40, 8, 8, 8, 0, 0, 8, 8);
    };
    img.src = getSteveSkinDataUrl();
}

async function initSkinPreview(prefersReducedMotion) {
    const canvas = document.getElementById('launcher-skin-canvas');
    const container = canvas?.closest('.launcher-preview-skin');
    if (!canvas || !container) return;

    const viewer = new SkinViewer({
        canvas,
        width: 320,
        height: 500
    });

    viewer.controls.enabled = false;
    viewer.camera.fov = 70;
    viewer.camera.position.set(24.55, 20.85, 57.84);
    viewer.controls.target.set(-0.69, 3.91, -3.61);
    viewer.scene.position.x = 0.8;
    viewer.scene.position.y = -1.5;
    viewer.cameraLight.intensity = 1400;
    viewer.globalLight.intensity = 2.2;

    await viewer.loadSkin(getSteveSkinDataUrl(), { model: 'default' });
    container.classList.add('skinview-ready');

    if (!prefersReducedMotion) {
        let direction = 1;
        const animate = () => {
            const rot = viewer.playerWrapper.rotation.y;
            if (rot > 0.24) direction = -1;
            if (rot < -0.18) direction = 1;
            viewer.playerWrapper.rotation.y += direction * 0.002;
            requestAnimationFrame(animate);
        };
        requestAnimationFrame(animate);
    }
}
