import { useDesign } from '@/app/theme';
import { cn } from './cn';

/** Logo tile in header and login. Colors come from the design tokens; the Kallysoft design shows «KS:» like kallysoft.ch. */
export function BrandMark({ size = 'md', className }: { size?: 'md' | 'lg'; className?: string }) {
  const design = useDesign();
  const corporate = design === 'kallysoft';
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex shrink-0 items-center justify-center bg-[var(--kls-brand-bg)] font-semibold tracking-[-0.02em] text-[var(--kls-brand-fg)] select-none',
        size === 'md' ? 'size-7 rounded-[7px]' : 'size-10 rounded-[10px]',
        corporate ? (size === 'md' ? 'text-[11px]' : 'text-[15px]') : size === 'md' ? 'text-[15px]' : 'text-[20px]',
        className,
      )}
    >
      {corporate ? 'KS:' : 'K'}
    </span>
  );
}
