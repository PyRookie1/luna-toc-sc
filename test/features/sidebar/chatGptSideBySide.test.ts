/**
 * @vitest-environment jsdom
 * Tests host layout reservation and safe fallback without a real ChatGPT DOM.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error Vitest runs on Node; browser tsconfig intentionally omits Node typings.
import { readFileSync } from 'node:fs';
import {
  initializeChatGptSideBySide,
  syncChatGptSideBySide,
  disposeChatGptSideBySide,
} from '@/features/sidebar/chatGptSideBySide';

const appStylesheet = readFileSync(
  new URL('../../../src/styles/content.css', import.meta.url),
  'utf8'
);

function setupHost(): { root: HTMLElement; sidebar: HTMLElement } {
  document.body.innerHTML = `
    <div id="root">
      <nav id="chatgpt-native-nav"></nav>
      <main><article id="chatgpt-thread"></article><form id="chatgpt-composer"></form></main>
    </div>
    <aside id="luna-toc-sidebar" class="luna-toc-navigator-hidden" aria-hidden="true"></aside>
    <div id="luna-toc-react-host"></div>
  `;
  const root = document.getElementById('root')!;
  const sidebar = document.getElementById('luna-toc-sidebar')!;
  sidebar.style.setProperty('--navigator-width', '300px');
  return { root, sidebar };
}

function openSidebar(sidebar: HTMLElement): void {
  sidebar.classList.remove('luna-toc-navigator-hidden');
  sidebar.setAttribute('aria-hidden', 'false');
  syncChatGptSideBySide();
}

function closeSidebar(sidebar: HTMLElement): void {
  sidebar.classList.add('luna-toc-navigator-hidden');
  sidebar.setAttribute('aria-hidden', 'true');
  syncChatGptSideBySide();
}

const originalInnerWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth');

function setViewportWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true, value: width,
  });
  window.dispatchEvent(new Event('resize'));
}

beforeEach(() => setViewportWidth(1200));

afterEach(() => {
  disposeChatGptSideBySide();
  if (originalInnerWidth) {
    Object.defineProperty(window, 'innerWidth', originalInnerWidth);
  }
  document.body.textContent = '';
});

describe('ChatGPT app beside LunaTOC sidebar', () => {
  it('reserves exactly the current sidebar width only while open', () => {
    const { root, sidebar } = setupHost();
    initializeChatGptSideBySide(sidebar);
    expect(root.classList.contains('luna-toc-chat-side-by-side')).toBe(false);

    openSidebar(sidebar);
    expect(root.classList.contains('luna-toc-chat-side-by-side')).toBe(true);
    expect(root.style.getPropertyValue('--luna-toc-reserved-sidebar-width')).toBe('300px');
    expect(root.querySelector('#chatgpt-composer')).not.toBeNull();
    expect(root.querySelector('#chatgpt-native-nav')).not.toBeNull();
    expect(sidebar.style.getPropertyValue('--luna-toc-reserved-sidebar-width')).toBe('');

    sidebar.style.setProperty('--navigator-width', '450px');
    syncChatGptSideBySide();
    expect(root.style.getPropertyValue('--luna-toc-reserved-sidebar-width')).toBe('450px');

    closeSidebar(sidebar);
    expect(root.classList.contains('luna-toc-chat-side-by-side')).toBe(false);
    expect(root.style.getPropertyValue('--luna-toc-reserved-sidebar-width')).toBe('');
  });

  it('falls back to overlay in narrow windows and returns to side-by-side on resize', () => {
    const { root, sidebar } = setupHost();
    initializeChatGptSideBySide(sidebar);
    openSidebar(sidebar);

    setViewportWidth(1019);
    expect(root.classList.contains('luna-toc-chat-side-by-side')).toBe(false);

    setViewportWidth(1020);
    expect(root.classList.contains('luna-toc-chat-side-by-side')).toBe(true);

    setViewportWidth(700);
    expect(root.classList.contains('luna-toc-chat-side-by-side')).toBe(false);
    expect(root.style.getPropertyValue('--luna-toc-reserved-sidebar-width')).toBe('');
  });

  it('does not resize the document body, extension portals, or an unknown host', () => {
    document.body.innerHTML = `
      <aside id="luna-toc-sidebar" aria-hidden="false"></aside>
      <div id="luna-toc-react-host"></div>
      <div id="unrelated-web-app"></div>
    `;
    const sidebar = document.getElementById('luna-toc-sidebar')!;
    sidebar.style.setProperty('--navigator-width', '300px');
    initializeChatGptSideBySide(sidebar);
    expect(document.querySelector('.luna-toc-chat-side-by-side')).toBeNull();
    expect(document.body.style.width).toBe('');
    expect(document.getElementById('luna-toc-react-host')?.className).toBe('');
    expect(document.getElementById('unrelated-web-app')?.className).toBe('');
  });

  it('updates a replaced ChatGPT app root without retaining stale classes', async () => {
    const { root, sidebar } = setupHost();
    initializeChatGptSideBySide(sidebar);
    openSidebar(sidebar);

    const replacement = document.createElement('div');
    replacement.id = '__next';
    replacement.innerHTML = '<main><form id="new-chatgpt-composer"></form></main>';
    root.replaceWith(replacement);

    await Promise.resolve();
    expect(root.classList.contains('luna-toc-chat-side-by-side')).toBe(false);
    expect(replacement.classList.contains('luna-toc-chat-side-by-side')).toBe(true);
    expect(replacement.style.getPropertyValue('--luna-toc-reserved-sidebar-width')).toBe('300px');
  });

  it('defines a width-limited host rule, without any global body transform', () => {
    expect(appStylesheet).toMatch(
      /\.luna-toc-chat-side-by-side\s*\{[^}]*width:\s*calc\(100vw - var\(--luna-toc-reserved-sidebar-width\)\)\s*!important;/s
    );
    expect(appStylesheet).toMatch(
      /\.luna-toc-chat-side-by-side\s*\{[^}]*max-width:\s*calc\(100vw - var\(--luna-toc-reserved-sidebar-width\)\)\s*!important;/s
    );
  });
});
