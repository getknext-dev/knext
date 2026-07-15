import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';

/**
 * Shared layout options (nav, GitHub link) used by both the home and docs layouts.
 */
export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span style={{ fontWeight: 800, letterSpacing: '-0.04em' }}>
          kn<span style={{ color: 'var(--signal)' }}>e</span>xt
        </span>
      ),
    },
    githubUrl: 'https://github.com/getknext-dev/knext',
  };
}
