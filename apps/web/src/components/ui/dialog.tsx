import * as React from 'react';
import { Dialog as BaseDialog } from '@base-ui-components/react/dialog';
import { cn } from '@/lib/utils';

/**
 * Thin styling layer over Base UI's Dialog primitive. Base UI was chosen
 * over Radix UI for this project (see docs/ARCHITECTURE.md once Block 7
 * lands): broader component coverage and a more active maintenance rhythm
 * as of mid-2026, at the cost of Base UI still being pre-1.0 (currently
 * 1.0.0-beta.0) -- a real trade-off, not a free upgrade, flagged here on
 * purpose. Re-exported under our own names so the rest of the app never
 * imports @base-ui-components/react directly; if this library ever needs
 * swapping, only this one file changes.
 */
export const Dialog = BaseDialog.Root;
export const DialogTrigger = BaseDialog.Trigger;
export const DialogClose = BaseDialog.Close;

export function DialogContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof BaseDialog.Popup>) {
  return (
    <BaseDialog.Portal>
      <BaseDialog.Backdrop className="fixed inset-0 bg-neutral-950/40" />
      <BaseDialog.Popup
        className={cn(
          'fixed left-1/2 top-1/2 w-full max-w-md -translate-x-1/2 -translate-y-1/2',
          'rounded-lg border border-neutral-200 bg-white p-6 shadow-lg',
          className,
        )}
        {...props}
      >
        {children}
      </BaseDialog.Popup>
    </BaseDialog.Portal>
  );
}

export function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof BaseDialog.Title>) {
  return (
    <BaseDialog.Title className={cn('text-lg font-semibold text-neutral-900', className)} {...props} />
  );
}

export function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof BaseDialog.Description>) {
  return (
    <BaseDialog.Description className={cn('mt-1 text-sm text-neutral-500', className)} {...props} />
  );
}

// Base UI exposes data-attributes for enter/exit transition states (e.g. an
// open/closed equivalent). Deliberately not wired up here -- the exact
// attribute names weren't confirmed against installed-version docs, and
// guessing at them in a shared primitive is worse than shipping without
// animation for now. Add once verified after `pnpm install`.
