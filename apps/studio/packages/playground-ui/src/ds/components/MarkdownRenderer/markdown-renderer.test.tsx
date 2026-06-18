// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TooltipProvider } from '../Tooltip';
import { MarkdownRenderer } from './markdown-renderer';

vi.mock('@/ds/components/CodeEditor/highlight', () => ({
  highlight: vi.fn(async () => [
    [
      {
        content: 'const',
        htmlStyle: {
          '--shiki-light': '#24292f',
          '--shiki-dark': '#c9d1d9',
        },
      },
    ],
  ]),
}));

afterEach(() => {
  cleanup();
  window.history.pushState({}, '', '/');
});

describe('MarkdownRenderer', () => {
  it('renders fenced code blocks through the shared Code renderer', async () => {
    render(
      <TooltipProvider>
        <MarkdownRenderer>{'```typescript\nconst ok = true;\n```'}</MarkdownRenderer>
      </TooltipProvider>,
    );

    const token = await screen.findByText('const');

    expect(token.classList.contains('shiki-token')).toBe(true);
    expect(token.style.getPropertyValue('--shiki-light')).toBe('#24292f');
    expect(token.style.getPropertyValue('--shiki-dark')).toBe('#c9d1d9');
    expect(token.closest('pre')).not.toBeNull();
  });

  it('renders inline code as a plain non-copyable <code> element', () => {
    render(
      <TooltipProvider>
        <MarkdownRenderer>{'Use the `MASTRA_API_KEY` env var.'}</MarkdownRenderer>
      </TooltipProvider>,
    );

    const inline = screen.getByText('MASTRA_API_KEY');

    expect(inline.tagName).toBe('CODE');
    expect(inline.closest('pre')).toBeNull();
    expect(inline.querySelector('.shiki-token')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy to clipboard' })).toBeNull();
  });

  it('maps sandbox image paths to the thread artifact endpoint', () => {
    window.history.pushState({}, '', '/agents/feishu-agent/chat/thread-123');

    render(
      <TooltipProvider>
        <MarkdownRenderer>{'![授权二维码](sandbox:/workspace/auth_qr.png)'}</MarkdownRenderer>
      </TooltipProvider>,
    );

    expect(screen.getByAltText('授权二维码').getAttribute('src')).toBe(
      '/manifex/threads/thread-123/artifacts?path=%2Fworkspace%2Fauth_qr.png',
    );
  });

  it('does not rewrite normal remote image URLs', () => {
    window.history.pushState({}, '', '/agents/feishu-agent/chat/thread-123');

    render(
      <TooltipProvider>
        <MarkdownRenderer>{'![remote](https://example.com/image.png)'}</MarkdownRenderer>
      </TooltipProvider>,
    );

    expect(screen.getByAltText('remote').getAttribute('src')).toBe('https://example.com/image.png');
  });
});
