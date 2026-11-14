import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Dialog, DialogContent, DialogTitle } from './dialog';

describe('DialogContent', () => {
  it('caps its height to the viewport and scrolls, so tall forms work on a phone', () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Tall form</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    const popup = screen.getByRole('dialog');
    expect(popup.className).toContain('max-h-[calc(100dvh-2rem)]');
    expect(popup.className).toContain('overflow-y-auto');
  });
});
