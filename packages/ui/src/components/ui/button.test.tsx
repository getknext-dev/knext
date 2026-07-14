import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Button, buttonVariants } from './button';

/**
 * v4-P5 render-smoke floor for @knext/ui (ADR-0020 component lib).
 * Pure happy-dom render assertions — no jest-dom matchers (kept consistent with
 * the repo's existing WebVitalsReporter.test.tsx pattern), no visual-regression rig.
 */
describe('Button', () => {
  it('renders without throwing and shows its children', () => {
    const { getByRole } = render(<Button>Click me</Button>);
    const btn = getByRole('button');
    expect(btn.textContent).toBe('Click me');
    expect(btn.tagName).toBe('BUTTON');
  });

  it('applies the default variant classes', () => {
    const { getByRole } = render(<Button>Default</Button>);
    // load-bearing prop: default variant → primary background utility class
    expect(getByRole('button').className).toContain('bg-primary');
  });

  it('applies a non-default variant when the variant prop is set', () => {
    const { getByRole } = render(<Button variant="destructive">Delete</Button>);
    // load-bearing prop: variant="destructive" swaps the background utility
    const cls = getByRole('button').className;
    expect(cls).toContain('bg-destructive');
    expect(cls).not.toContain('bg-primary');
  });

  it('renders as a child element when asChild is set (Slot)', () => {
    const { getByRole, queryByRole } = render(
      <Button asChild>
        <a href="/home">Home</a>
      </Button>,
    );
    // load-bearing prop: asChild renders the <a>, not a <button>, keeping variant classes
    const link = getByRole('link');
    expect(link.tagName).toBe('A');
    expect(link.className).toContain('bg-primary');
    expect(queryByRole('button')).toBeNull();
  });

  it('exposes buttonVariants that produce a class string', () => {
    expect(typeof buttonVariants()).toBe('string');
    expect(buttonVariants({ size: 'sm' })).toContain('h-8');
  });
});
