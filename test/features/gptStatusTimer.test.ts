/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startGptStatusTimer } from '@/features/gptStatusTimer/gptStatusTimer';
import { getActivePlatform } from '@/platforms';
import {
  GPT_STATUS_COMPLETED,
  GPT_STATUS_REQUEST_STARTED,
  GPT_STATUS_RESPONSE_RECEIVED,
  GPT_STATUS_STREAM_ACTIVITY,
} from '@/features/gptStatusTimer/protocol';

const ROUTE_KEY = 'timer-test-conversation';
let cleanup: (() => void) | undefined;

function emit(data: Record<string, unknown>): void {
  window.dispatchEvent(new MessageEvent('message', {
    source: window,
    origin: location.origin,
    data,
  }));
}

function labelText(): string {
  return document.getElementById('luna-gpt-status-timer')
    ?.shadowRoot?.querySelector('#label')?.textContent || '';
}

function elapsedText(): string {
  return document.getElementById('luna-gpt-status-timer')
    ?.shadowRoot?.querySelector('#elapsed')?.textContent || '';
}

function sendStarted(requestId: number): void {
  emit({ type: GPT_STATUS_REQUEST_STARTED, requestId, routeKey: ROUTE_KEY });
}

beforeEach(() => {
  history.replaceState(null, '', '/c/' + ROUTE_KEY);
  vi.useFakeTimers();
  cleanup = startGptStatusTimer(getActivePlatform('chatgpt.com'));
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  document.getElementById('luna-gpt-status-timer')?.remove();
  vi.useRealTimers();
});

describe('independent GPT status timer', () => {
  it('shows elapsed time while waiting for a response and hides after completion', () => {
    sendStarted(1);
    const host = document.getElementById('luna-gpt-status-timer') as HTMLElement;
    expect(host.hidden).toBe(false);
    expect(labelText()).toBe('正在等待 GPT 响应');

    vi.advanceTimersByTime(2_000);
    expect(elapsedText()).toBe('00:02');

    emit({ type: GPT_STATUS_RESPONSE_RECEIVED, requestId: 1, routeKey: ROUTE_KEY });
    emit({ type: GPT_STATUS_STREAM_ACTIVITY, requestId: 1, routeKey: ROUTE_KEY });
    expect(labelText()).toBe('GPT 正在生成');

    emit({ type: GPT_STATUS_COMPLETED, requestId: 1, routeKey: ROUTE_KEY });
    expect(labelText()).toBe('生成完成');
    vi.advanceTimersByTime(8_000);
    expect(host.hidden).toBe(true);
  });

  it('reports missing response activity without claiming the model has stopped', () => {
    sendStarted(1);
    emit({ type: GPT_STATUS_RESPONSE_RECEIVED, requestId: 1, routeKey: ROUTE_KEY });
    emit({ type: GPT_STATUS_STREAM_ACTIVITY, requestId: 1, routeKey: ROUTE_KEY });

    vi.advanceTimersByTime(10_000);
    expect(labelText()).toBe('暂无新响应数据');

    emit({ type: GPT_STATUS_STREAM_ACTIVITY, requestId: 1, routeKey: ROUTE_KEY });
    expect(labelText()).toBe('GPT 正在生成');
  });

  it('does not allow a late event from an older request to replace the newer state', () => {
    sendStarted(1);
    sendStarted(2);
    emit({ type: GPT_STATUS_RESPONSE_RECEIVED, requestId: 1, routeKey: ROUTE_KEY });
    expect(labelText()).toBe('正在等待 GPT 响应');

    emit({ type: GPT_STATUS_RESPONSE_RECEIVED, requestId: 2, routeKey: ROUTE_KEY });
    expect(labelText()).toBe('已收到响应，等待生成内容');
  });

  it('recognizes a stop-generation button and ignores later completion for that request', () => {
    sendStarted(1);
    emit({ type: GPT_STATUS_RESPONSE_RECEIVED, requestId: 1, routeKey: ROUTE_KEY });
    document.body.insertAdjacentHTML('beforeend', '<button data-testid="stop-button">Stop generating</button>');
    document.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(labelText()).toBe('生成已停止');
    emit({ type: GPT_STATUS_COMPLETED, requestId: 1, routeKey: ROUTE_KEY });
    expect(labelText()).toBe('生成已停止');
  });

  it('keeps the first prompt timer when ChatGPT changes the new-chat URL to a conversation URL', () => {
    history.replaceState(null, '', '/');
    emit({ type: GPT_STATUS_REQUEST_STARTED, requestId: 1, routeKey: 'new-chat:/' });
    expect((document.getElementById('luna-gpt-status-timer') as HTMLElement).hidden).toBe(false);

    history.pushState(null, '', '/c/created-conversation');
    emit({ type: 'CHATGPT_ROUTE_CHANGED' });
    expect((document.getElementById('luna-gpt-status-timer') as HTMLElement).hidden).toBe(false);

    emit({
      type: GPT_STATUS_RESPONSE_RECEIVED,
      requestId: 1,
      routeKey: 'new-chat:/',
    });
    expect(labelText()).toBe('已收到响应，等待生成内容');
  });

  it('clears the indicator after a normal SPA route change', () => {
    sendStarted(1);
    history.pushState(null, '', '/c/another-conversation');
    emit({ type: 'CHATGPT_ROUTE_CHANGED' });
    expect((document.getElementById('luna-gpt-status-timer') as HTMLElement).hidden).toBe(true);
  });
});
