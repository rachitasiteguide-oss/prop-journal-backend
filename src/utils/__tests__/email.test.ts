import { describe, it, expect } from 'vitest';
import { buildWelcomeHtml } from '../email';

describe('buildWelcomeHtml', () => {
  it('greets by name when provided', () => {
    const html = buildWelcomeHtml('Alice', 'https://propjournal.test/dashboard');
    expect(html).toContain('Welcome, Alice');
  });

  it('uses a generic greeting when no name is on file', () => {
    const html = buildWelcomeHtml(null, 'https://propjournal.test/dashboard');
    expect(html).toContain('Welcome to Prop Journal');
    expect(html).not.toContain('Welcome, ');
  });

  it('embeds the dashboard URL in the CTA button href', () => {
    const html = buildWelcomeHtml('Bob', 'https://example.com/dashboard');
    expect(html).toContain('href="https://example.com/dashboard"');
  });

  it('renders core onboarding steps so users land with a clear next action', () => {
    const html = buildWelcomeHtml(null, 'https://propjournal.test/dashboard');
    expect(html).toMatch(/MT4\s*\/\s*MT5/i);
    expect(html).toMatch(/prop firm template/i);
    expect(html).toMatch(/AI coach/i);
  });
});
