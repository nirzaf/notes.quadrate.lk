import * as DialogPrimitive from '@radix-ui/react-dialog';
import type { ComponentPropsWithoutRef, ElementRef } from 'react';
import * as React from 'react';
import { cn } from '../../lib/utils';

export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;

type SheetContentProps = ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { side?: 'top' | 'right' | 'bottom' | 'left' };

export const SheetContent = React.forwardRef<ElementRef<typeof DialogPrimitive.Content>, SheetContentProps>(({ className, side = 'right', children, ...props }, ref) => (
  <DialogPrimitive.Portal>
    <DialogPrimitive.Overlay className="q-dialog-overlay" />
    <DialogPrimitive.Content ref={ref} className={cn('q-sheet-content', `q-sheet-${side}`, className)} {...props}>
      {children}
      <DialogPrimitive.Close className="q-dialog-close" aria-label="Close">×</DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
));
SheetContent.displayName = DialogPrimitive.Content.displayName;
