/**
 * Independent, page-local indicator for ChatGPT request and response-stream status.
 * It never reads or modifies ChatGPT's native thinking text.
 */
import { getActivePlatform } from '@/platforms';
import {
  GPT_STATUS_COMPLETED,
  GPT_STATUS_FAILED,
  GPT_STATUS_INTERRUPTED,
  GPT_STATUS_REQUEST_STARTED,
  GPT_STATUS_RESPONSE_RECEIVED,
  GPT_STATUS_STOPPED,
  GPT_STATUS_STREAM_ACTIVITY,
  GPT_STATUS_STREAM_ENDED,
} from './protocol';

const HOST_ID = 'luna-gpt-status-timer';
const STALE_AFTER_MS = 10_000;
const TERMINAL_LINGER_MS = 8_000;
const TICK_INTERVAL_MS = 1_000;

type RequestState =
  | 'waiting-response'
  | 'connected'
  | 'receiving'
  | 'completed'
  | 'ended'
  | 'failed'
  | 'stopped'
  | 'interrupted';

interface ActiveRequest {
  requestId: number;
  routeKey: string;
  sourceRouteKey?: string;
  startedAt: number;
  lastActivityAt: number;
  state: RequestState;
  terminal: boolean;
  statusCode?: number;
}

interface StatusMessage {
  type?: unknown;
  requestId?: unknown;
  routeKey?: unknown;
  statusCode?: unknown;
}

function formatElapsed(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const remainder = safeSeconds % 60;
  const pad = (value: number): string => String(value).padStart(2, '0');
  return hours > 0
    ? pad(hours) + ':' + pad(minutes) + ':' + pad(remainder)
    : pad(minutes) + ':' + pad(remainder);
}

function isStopControl(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const button = target.closest('button, [role="button"]');
  if (!button) return false;

  const testId = button.getAttribute('data-testid') || '';
  const label = button.getAttribute('aria-label') || '';
  const title = button.getAttribute('title') || '';
  const text = (button.textContent || '').replace(/\s+/g, ' ').trim();
  const combined = [testId, label, title, text].join(' ').toLowerCase();

  return /stop[- ]?(?:generating|streaming|button|response)/i.test(combined) ||
    /(?:stop generating|stop streaming|stop response|停止生成|停止响应|停止回答)/i.test(combined) ||
    /^(?:stop|停止)$/i.test(label.trim());
}

export function startGptStatusTimer(platform = getActivePlatform()): () => void {
  const routeChangedType = platform.pageHook.messages.routeChanged;

  let activeRequest: ActiveRequest | null = null;
  let lastSeenRequestId = 0;
  let host: HTMLDivElement | null = null;
  let labelElement: HTMLSpanElement | null = null;
  let elapsedElement: HTMLSpanElement | null = null;
  let tickTimer: number | null = null;
  let hideTimer: number | null = null;
  let mountObserver: MutationObserver | null = null;
  let disposed = false;

  const currentRouteKey = (): string => platform.routing.getCurrentRouteKey();

  const clearHideTimer = (): void => {
    if (hideTimer === null) return;
    window.clearTimeout(hideTimer);
    hideTimer = null;
  };

  const mount = (): void => {
    if (disposed || host || !document.documentElement) return;

    // A previous content-script instance can leave its DOM node behind after
    // an extension reload. Replace that stale, unowned node instead of duplicating it.
    document.getElementById(HOST_ID)?.remove();

    host = document.createElement('div');
    host.id = HOST_ID;
    host.hidden = true;

    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = [
      ':host { all: initial; display: block; position: fixed; top: 76px; right: 14px; z-index: 2147483646; pointer-events: none; color-scheme: dark; }',
      ':host([hidden]) { display: none !important; }',
      '#pill { box-sizing: border-box; display: flex; align-items: center; gap: 8px; max-width: min(360px, calc(100vw - 24px)); padding: 9px 12px; border: 1px solid rgba(148, 163, 184, .42); border-radius: 999px; background: rgba(15, 23, 42, .95); color: #f8fafc; box-shadow: 0 8px 24px rgba(0, 0, 0, .22); backdrop-filter: blur(10px); font: 500 12px/1.25 system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif; white-space: nowrap; }',
      '#dot { width: 7px; height: 7px; flex: 0 0 7px; border-radius: 50%; background: #38bdf8; box-shadow: 0 0 0 3px rgba(56, 189, 248, .14); animation: pulse 1.5s ease-in-out infinite; }',
      '#label { min-width: 0; overflow: hidden; text-overflow: ellipsis; }',
      '#elapsed { flex: 0 0 auto; padding-left: 2px; color: #cbd5e1; font-variant-numeric: tabular-nums; font-weight: 650; }',
      ':host([data-state=\"waiting-response\"]) #dot, :host([data-stale=\"true\"]) #dot { background: #fbbf24; box-shadow: 0 0 0 3px rgba(251, 191, 36, .14); animation: none; }',
      ':host([data-state=\"completed\"]) #dot { background: #34d399; box-shadow: 0 0 0 3px rgba(52, 211, 153, .14); animation: none; }',
      ':host([data-state=\"failed\"]) #dot, :host([data-state=\"interrupted\"]) #dot { background: #fb7185; box-shadow: 0 0 0 3px rgba(251, 113, 133, .14); animation: none; }',
      ':host([data-state=\"stopped\"]) #dot, :host([data-state=\"ended\"]) #dot { background: #94a3b8; box-shadow: none; animation: none; }',
      '@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .38; } }',
      '@media (max-width: 600px) { :host { top: 70px; left: 8px; right: 8px; } #pill { max-width: 100%; } }',
      '@media (prefers-reduced-motion: reduce) { #dot { animation: none; } }',
    ].join('\n');

    const pill = document.createElement('div');
    pill.id = 'pill';
    pill.setAttribute('role', 'status');
    pill.setAttribute('aria-live', 'polite');
    pill.setAttribute('aria-atomic', 'false');

    const dot = document.createElement('span');
    dot.id = 'dot';
    dot.setAttribute('aria-hidden', 'true');

    labelElement = document.createElement('span');
    labelElement.id = 'label';

    elapsedElement = document.createElement('span');
    elapsedElement.id = 'elapsed';
    elapsedElement.setAttribute('aria-hidden', 'true');

    pill.append(dot, labelElement, elapsedElement);
    shadow.append(style, pill);
    document.documentElement.appendChild(host);
    render();
  };

  const render = (): void => {
    if (!host || !labelElement || !elapsedElement) return;
    const request = activeRequest;
    if (!request) {
      host.hidden = true;
      host.removeAttribute('data-state');
      host.removeAttribute('data-stale');
      return;
    }

    const now = Date.now();
    const elapsedSeconds = Math.floor((now - request.startedAt) / 1000);
    let label = '';
    let stale = false;

    switch (request.state) {
      case 'waiting-response':
        stale = now - request.startedAt >= STALE_AFTER_MS;
        label = stale ? '等待响应时间较长' : '正在等待 GPT 响应';
        break;
      case 'connected':
      case 'receiving':
        stale = now - request.lastActivityAt >= STALE_AFTER_MS;
        label = stale
          ? '暂无新响应数据'
          : request.state === 'connected'
            ? '已收到响应，等待生成内容'
            : 'GPT 正在生成';
        break;
      case 'completed':
        label = '生成完成';
        break;
      case 'ended':
        label = '响应流已结束，未收到明确完成信号';
        break;
      case 'failed':
        label = typeof request.statusCode === 'number'
          ? '请求失败 · HTTP ' + request.statusCode
          : '请求失败';
        break;
      case 'stopped':
        label = '生成已停止';
        break;
      case 'interrupted':
        label = '响应流中断';
        break;
    }

    host.hidden = false;
    host.dataset.state = request.state;
    host.dataset.stale = stale ? 'true' : 'false';
    if (labelElement.textContent !== label) labelElement.textContent = label;
    const elapsed = formatElapsed(elapsedSeconds);
    if (elapsedElement.textContent !== elapsed) elapsedElement.textContent = elapsed;
  };

  const finish = (
    state: 'completed' | 'ended' | 'failed' | 'stopped' | 'interrupted',
    statusCode?: number
  ): void => {
    const request = activeRequest;
    if (!request || request.terminal) return;

    request.state = state;
    request.terminal = true;
    if (typeof statusCode === 'number') request.statusCode = statusCode;
    render();

    clearHideTimer();
    const finishedRequestId = request.requestId;
    hideTimer = window.setTimeout(() => {
      if (activeRequest?.requestId !== finishedRequestId || !activeRequest.terminal) return;
      activeRequest = null;
      hideTimer = null;
      render();
    }, TERMINAL_LINGER_MS);
  };

  const resetForRoute = (): void => {
    const request = activeRequest;
    const currentRoute = currentRouteKey();
    // ChatGPT may replace the new-chat URL with /c/<id> while the first
    // prompt is being submitted. Rebind only this short initial transition.
    if (
      request &&
      !request.terminal &&
      request.routeKey.startsWith('new-chat:') &&
      !currentRoute.startsWith('new-chat:') &&
      Date.now() - request.startedAt <= 10_000
    ) {
      request.sourceRouteKey = request.routeKey;
      request.routeKey = currentRoute;
      render();
      return;
    }

    clearHideTimer();
    activeRequest = null;
    render();
  };

  const onMessage = (event: MessageEvent): void => {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data as StatusMessage | null;
    if (!message || typeof message.type !== 'string') return;

    if (message.type === routeChangedType) {
      resetForRoute();
      return;
    }

    const routeKey = message.routeKey;
    const requestId = message.requestId;
    if (typeof routeKey !== 'string') return;
    if (typeof requestId !== 'number' || !Number.isSafeInteger(requestId) || requestId < 1) return;

    if (message.type === GPT_STATUS_REQUEST_STARTED) {
      const currentRoute = currentRouteKey();
      const isInitialNewChatTransition =
        routeKey.startsWith('new-chat:') && !currentRoute.startsWith('new-chat:');
      if (routeKey !== currentRoute && !isInitialNewChatTransition) return;
      if (requestId <= lastSeenRequestId) return;
      lastSeenRequestId = requestId;
      clearHideTimer();
      const now = Date.now();
      activeRequest = {
        requestId,
        routeKey: currentRoute,
        sourceRouteKey: routeKey !== currentRoute ? routeKey : undefined,
        startedAt: now,
        lastActivityAt: now,
        state: 'waiting-response',
        terminal: false,
      };
      render();
      return;
    }

    const request = activeRequest;
    if (
      !request ||
      request.requestId !== requestId ||
      (request.routeKey !== routeKey && request.sourceRouteKey !== routeKey) ||
      request.routeKey !== currentRouteKey() ||
      request.terminal
    ) {
      return;
    }

    switch (message.type) {
      case GPT_STATUS_RESPONSE_RECEIVED:
        request.state = 'connected';
        request.lastActivityAt = Date.now();
        render();
        break;
      case GPT_STATUS_STREAM_ACTIVITY:
        request.state = 'receiving';
        request.lastActivityAt = Date.now();
        render();
        break;
      case GPT_STATUS_COMPLETED:
        finish('completed');
        break;
      case GPT_STATUS_STREAM_ENDED:
        finish('ended');
        break;
      case GPT_STATUS_FAILED:
        finish('failed', typeof message.statusCode === 'number' ? message.statusCode : undefined);
        break;
      case GPT_STATUS_STOPPED:
        finish('stopped');
        break;
      case GPT_STATUS_INTERRUPTED:
        finish('interrupted');
        break;
    }
  };

  const onClick = (event: MouseEvent): void => {
    if (!activeRequest || activeRequest.terminal || !isStopControl(event.target)) return;
    finish('stopped');
  };

  const onPopState = (): void => {
    resetForRoute();
  };

  mount();
  if (!host && typeof MutationObserver !== 'undefined') {
    mountObserver = new MutationObserver(() => {
      if (!document.documentElement) return;
      mountObserver?.disconnect();
      mountObserver = null;
      mount();
    });
    mountObserver.observe(document, { childList: true, subtree: true });
  }

  window.addEventListener('message', onMessage);
  window.addEventListener('popstate', onPopState);
  document.addEventListener('click', onClick, true);
  tickTimer = window.setInterval(() => {
    if (activeRequest && activeRequest.routeKey !== currentRouteKey()) resetForRoute();
    render();
  }, TICK_INTERVAL_MS);

  return () => {
    disposed = true;
    clearHideTimer();
    if (tickTimer !== null) window.clearInterval(tickTimer);
    mountObserver?.disconnect();
    window.removeEventListener('message', onMessage);
    window.removeEventListener('popstate', onPopState);
    document.removeEventListener('click', onClick, true);
    host?.remove();
    host = null;
    labelElement = null;
    elapsedElement = null;
    activeRequest = null;
  };
}
