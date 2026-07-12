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
});
