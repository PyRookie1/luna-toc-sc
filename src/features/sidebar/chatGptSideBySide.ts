/**
 * Reserves space for the LunaTOC sidebar in ChatGPT's app layout without
 * changing window.matchMedia, the document body, or message scroll offsets.
 */
const ROOT_CLASS = 'luna-toc-chat-side-by-side';
const WIDTH_PROPERTY = '--luna-toc-reserved-sidebar-width';
const MIN_AVAILABLE_CHAT_WIDTH_PX = 720;

let sidebar: HTMLElement | null = null;
let currentAppRoot: HTMLElement | null = null;
let sidebarSizeObserver: ResizeObserver | null = null;
let bodyChildObserver: MutationObserver | null = null;

/**
 * Finds ChatGPT's outer application container, without selecting any extension
 * portal or dialog. A missing host is a deliberate signal to keep overlay mode.
 */
function getChatGptAppRoot(): HTMLElement | null {
  if (!document.body) return null;

  for (const id of ['root', '__next']) {
    const knownRoot = document.getElementById(id);
    if (knownRoot instanceof HTMLElement &&
        document.body.contains(knownRoot) &&
        !sidebar?.contains(knownRoot)) {
      return findBodyChild(knownRoot);
    }
  }

  const main = document.body.querySelector('main');
  if (!(main instanceof HTMLElement) || sidebar?.contains(main)) return null;
  const candidate = findBodyChild(main);
  if (candidate === sidebar || candidate.id.startsWith('luna-toc-')) return null;
  return candidate;
}

/** Returns the top-level host child containing a recognized app element. */
function findBodyChild(element: HTMLElement): HTMLElement {
  let current = element;
  while (current.parentElement && current.parentElement !== document.body) {
    current = current.parentElement;
  }
  return current;
}

/** Returns the rendered or configured width during sidebar resize. */
function getSidebarWidthPx(element: HTMLElement): number {
  const renderedWidth = element.getBoundingClientRect().width;
  if (renderedWidth > 0) return Math.ceil(renderedWidth);

  const configuredWidth = Number.parseFloat(
    element.style.getPropertyValue('--navigator-width')
  );
  return Number.isFinite(configuredWidth) && configuredWidth > 0
    ? Math.ceil(configuredWidth)
    : 0;
}

/** Restores ChatGPT's native width when overlay mode is appropriate. */
function restoreAppRoot(): void {
  currentAppRoot?.classList.remove(ROOT_CLASS);
  currentAppRoot?.style.removeProperty(WIDTH_PROPERTY);
  currentAppRoot = null;
}

/**
 * Recomputes reserved space on sidebar open/close, drag resizing, viewport
 * changes, and host app replacement. Narrow windows retain overlay behavior.
 */
export function syncChatGptSideBySide(): void {
  const appRoot = getChatGptAppRoot();
  const width = sidebar ? getSidebarWidthPx(sidebar) : 0;
  const sidebarOpen = Boolean(
    sidebar &&
    !sidebar.classList.contains('luna-toc-navigator-hidden') &&
    sidebar.getAttribute('aria-hidden') !== 'true'
  );
  const canReserve = sidebarOpen && width > 0 &&
    window.innerWidth - width >= MIN_AVAILABLE_CHAT_WIDTH_PX &&
    Boolean(appRoot) &&
    appRoot !== sidebar;

  if (!canReserve || !appRoot) {
    restoreAppRoot();
    return;
  }
  if (currentAppRoot !== appRoot) {
    restoreAppRoot();
    currentAppRoot = appRoot;
  }
  currentAppRoot.style.setProperty(WIDTH_PROPERTY, `${width}px`);
  currentAppRoot.classList.add(ROOT_CLASS);
}

/**
 * Starts the isolated host-layout adapter for the current sidebar. Its
 * observers track changes without scanning conversation messages.
 */
export function initializeChatGptSideBySide(element: HTMLElement): void {
  disposeChatGptSideBySide();
  sidebar = element;
  window.addEventListener('resize', syncChatGptSideBySide);

  if (typeof ResizeObserver !== 'undefined') {
    sidebarSizeObserver = new ResizeObserver(syncChatGptSideBySide);
    sidebarSizeObserver.observe(element);
  }
  if (document.body) {
    bodyChildObserver = new MutationObserver(syncChatGptSideBySide);
    bodyChildObserver.observe(document.body, { childList: true });
  }
  syncChatGptSideBySide();
}

/** Disconnects listeners and returns the original ChatGPT app sizing. */
export function disposeChatGptSideBySide(): void {
  window.removeEventListener('resize', syncChatGptSideBySide);
  sidebarSizeObserver?.disconnect();
  bodyChildObserver?.disconnect();
  sidebarSizeObserver = null;
  bodyChildObserver = null;
  restoreAppRoot();
  sidebar = null;
}
