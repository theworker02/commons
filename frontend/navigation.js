(() => {
  const template = window.CommonsNavigationTemplate;
  if (!template) return;

  const all = (root, selector) => [...root.querySelectorAll(selector)];
  const closeableRoots = [];

  const bindNavigation = (mount) => {
    let root = mount;
    if (!root.classList.contains('site-header') || !root.querySelector('[data-nav-menu]')) {
      root.innerHTML = template.renderNavigation({ active: root.dataset.navActive, currentPath: window.location.pathname, query: new URLSearchParams(window.location.search).get('q') || '' });
      root = root.querySelector('.site-header');
    }
    if (!root || root.dataset.navigationBound === 'true') return;
    root.dataset.navigationBound = 'true';

    const menu = root.querySelector('[data-nav-menu]');
    const menuToggle = root.querySelector('[data-nav-menu-toggle]');
    const groups = all(root, '[data-nav-group]');
    const groupButtons = all(root, '[data-nav-group-toggle]');
    const search = root.querySelector('.site-nav-search input');

    const setGroup = (group, open) => {
      const button = group.querySelector('[data-nav-group-toggle]');
      const panel = group.querySelector('[data-nav-group-panel]');
      if (!button || !panel) return;
      panel.hidden = !open;
      button.setAttribute('aria-expanded', String(open));
      group.classList.toggle('is-open', open);
    };
    const closeGroups = () => groups.forEach((group) => setGroup(group, false));
    const closeMenu = () => {
      closeGroups();
      menu?.classList.remove('is-open');
      menuToggle?.setAttribute('aria-expanded', 'false');
    };
    const openGroup = (target) => groups.forEach((group) => setGroup(group, group === target));

    groupButtons.forEach((button, index) => {
      const group = button.closest('[data-nav-group]');
      const panel = group?.querySelector('[data-nav-group-panel]');
      button.addEventListener('click', () => {
        const isOpen = button.getAttribute('aria-expanded') === 'true';
        if (isOpen) setGroup(group, false);
        else openGroup(group);
      });
      button.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          openGroup(group);
          const links = all(panel, 'a');
          links[event.key === 'ArrowUp' ? links.length - 1 : 0]?.focus();
        }
        if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
          event.preventDefault();
          groupButtons[(index + (event.key === 'ArrowRight' ? 1 : -1) + groupButtons.length) % groupButtons.length]?.focus();
        }
      });
    });

    menuToggle?.addEventListener('click', () => {
      const open = menuToggle.getAttribute('aria-expanded') === 'true';
      menuToggle.setAttribute('aria-expanded', String(!open));
      menu?.classList.toggle('is-open', !open);
      if (open) closeGroups();
    });
    all(root, 'a').forEach((link) => link.addEventListener('click', closeMenu));
    document.addEventListener('click', (event) => {
      if (!root.contains(event.target)) closeMenu();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        const open = groups.find((group) => group.classList.contains('is-open'));
        closeMenu();
        (open?.querySelector('[data-nav-group-toggle]') || menuToggle)?.focus();
      }
      if ((event.key === 'k' && (event.metaKey || event.ctrlKey)) || (event.key === '/' && !/input|textarea|select/i.test(document.activeElement?.tagName || ''))) {
        if (!search) return;
        event.preventDefault();
        search.focus();
        search.select();
      }
    });

    const refresh = () => {
      groups.forEach((group) => {
        const active = Boolean(group.querySelector('a[aria-current="page"]'));
        group.querySelector('[data-nav-group-toggle]')?.classList.toggle('is-active', active);
      });
    };
    refresh();
    closeableRoots.push({ close: closeMenu, refresh });
  };

  const initialize = () => all(document, '[data-site-navigation]').forEach(bindNavigation);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
  else initialize();
  window.CommonsNavigation = { close: () => closeableRoots.forEach((item) => item.close()), refresh: () => closeableRoots.forEach((item) => item.refresh()) };
})();
