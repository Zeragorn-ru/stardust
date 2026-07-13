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

    initSkinPreview(prefersReducedMotion).catch(() => {
        document.querySelector('.launcher-preview-skin')?.classList.remove('skinview-ready');
    });
});

function createPreviewSkinDataUrl() {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    if (!ctx) return '';
    ctx.imageSmoothingEnabled = false;

    const skin = '#d9a36d';
    const skinDark = '#b98659';
    const hair = '#4b2a1d';
    const hairDark = '#2e1a13';
    const shirt = '#4f8cff';
    const shirtDark = '#3159b7';
    const pants = '#243f84';
    const pantsDark = '#172655';
    const sole = '#111827';

    const rect = (x, y, w, h, color) => {
        ctx.fillStyle = color;
        ctx.fillRect(x, y, w, h);
    };

    // Head, all faces in the 64x64 Minecraft skin layout.
    rect(0, 8, 32, 8, skinDark);
    rect(8, 0, 16, 8, hair);
    rect(8, 8, 8, 8, skin);
    rect(0, 8, 8, 8, skinDark);
    rect(16, 8, 8, 8, skinDark);
    rect(24, 8, 8, 8, hairDark);
    rect(8, 8, 8, 3, hair);
    rect(9, 12, 2, 2, sole);
    rect(13, 12, 2, 2, sole);
    rect(11, 15, 3, 1, '#6b3a2f');

    // Body.
    rect(16, 20, 24, 12, shirtDark);
    rect(20, 16, 16, 4, shirtDark);
    rect(20, 20, 8, 12, shirt);
    rect(23, 20, 2, 12, 'rgba(255,255,255,0.18)');

    // Right arm.
    rect(40, 20, 16, 12, shirtDark);
    rect(44, 16, 8, 4, shirtDark);
    rect(44, 20, 4, 6, shirt);
    rect(44, 26, 4, 6, skin);

    // Right leg.
    rect(0, 20, 16, 12, pantsDark);
    rect(4, 16, 8, 4, pantsDark);
    rect(4, 20, 4, 10, pants);
    rect(4, 30, 4, 2, sole);

    // Left leg (1.8+ layer layout).
    rect(16, 52, 16, 12, pantsDark);
    rect(20, 48, 8, 4, pantsDark);
    rect(20, 52, 4, 10, pants);
    rect(20, 62, 4, 2, sole);

    // Left arm (1.8+ layer layout).
    rect(32, 52, 16, 12, shirtDark);
    rect(36, 48, 8, 4, shirtDark);
    rect(36, 52, 4, 6, shirt);
    rect(36, 58, 4, 6, skin);

    return canvas.toDataURL('image/png');
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

    await viewer.loadSkin(createPreviewSkinDataUrl(), { model: 'default' });
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
