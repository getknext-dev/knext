import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from './card';

/**
 * v4-P5 render-smoke floor for @knext/ui (ADR-0020 component lib).
 * Pure happy-dom render assertions — no jest-dom matchers, no visual-regression rig.
 */
describe('Card', () => {
  it('renders a full card composition without throwing and shows its content', () => {
    const { getByText } = render(
      <Card>
        <CardHeader>
          <CardTitle>Title text</CardTitle>
          <CardDescription>Description text</CardDescription>
        </CardHeader>
        <CardContent>Body text</CardContent>
        <CardFooter>Footer text</CardFooter>
      </Card>,
    );

    // load-bearing: children of every sub-component render into the DOM
    expect(getByText('Title text').textContent).toBe('Title text');
    expect(getByText('Description text').textContent).toBe('Description text');
    expect(getByText('Body text').textContent).toBe('Body text');
    expect(getByText('Footer text').textContent).toBe('Footer text');
  });

  it('applies base card classes and merges a caller className', () => {
    const { getByTestId } = render(
      <Card data-testid="card" className="custom-class">
        content
      </Card>,
    );
    const card = getByTestId('card');
    // load-bearing: base variant class is applied AND caller className is merged (cn)
    expect(card.className).toContain('rounded-lg');
    expect(card.className).toContain('custom-class');
  });

  it('forwards a ref to the underlying element', () => {
    let node: HTMLDivElement | null = null;
    render(
      <Card
        ref={(el) => {
          node = el;
        }}
      >
        ref card
      </Card>,
    );
    expect(node).toBeInstanceOf(HTMLDivElement);
  });
});
