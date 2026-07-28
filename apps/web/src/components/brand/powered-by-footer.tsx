import { cn } from '@/lib/utils';
import { LogoMark } from './logo';

/**
 * Small attribution mark for pages that represent a CLIENT business's own
 * brand first (QR feedback/loyalty check-in/loyalty customer login) --
 * deliberately not the full Logo lockup used on Echo Grid's own auth pages.
 * Owner decision: these pages get light attribution, not zero branding and
 * not full branding, since a customer scanning a QR code is interacting
 * with the business they visited, not with Echo Grid directly.
 */
export function PoweredByFooter({ className }: { className?: string | undefined }) {
  return (
    <p className={cn('flex items-center justify-center gap-1.5 text-xs text-neutral-400', className)}>
      Powered by
      <span className="inline-flex items-center gap-1 font-medium text-neutral-500">
        <LogoMark size={14} monochrome />
        Echo Grid
      </span>
    </p>
  );
}
