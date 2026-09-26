import { forwardRef, useCallback, useId, useRef, useState, type ButtonHTMLAttributes } from 'react';
import { Tooltip } from './Tooltip';
import './primitives.css';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost';
  size?: 'sm' | 'md';
  iconOnly?: boolean;
  tooltip?: string;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'sm',
    iconOnly = false,
    tooltip,
    title,
    className = '',
    'aria-label': ariaLabel,
    'aria-describedby': describedBy,
    ...props
  },
  forwardedRef,
) {
  const targetRef = useRef<HTMLButtonElement>(null);
  const tooltipId = useId();
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const label = tooltip || title || ariaLabel;
  const isIcon = iconOnly || className.split(/\s+/).includes('icon-button');
  const ref = useCallback(
    (node: HTMLButtonElement | null) => {
      targetRef.current = node;
      if (typeof forwardedRef === 'function') forwardedRef(node);
      else if (forwardedRef) forwardedRef.current = node;
    },
    [forwardedRef],
  );
  const description =
    [describedBy, tooltipOpen && label ? tooltipId : null].filter(Boolean).join(' ') || undefined;

  return (
    <>
      <button
        {...props}
        ref={ref}
        className={`sf-button sf-button-${variant} sf-button-${size}${isIcon ? ' sf-button-icon' : ''} ${className}`.trim()}
        aria-label={ariaLabel || (isIcon ? label : undefined)}
        aria-describedby={description}
        data-tooltip={label}
        data-autofocus={props.autoFocus || undefined}
      />
      {label ? (
        <Tooltip targetRef={targetRef} id={tooltipId} onOpenChange={setTooltipOpen}>
          {label}
        </Tooltip>
      ) : null}
    </>
  );
});

export const IconButton = forwardRef<HTMLButtonElement, ButtonProps & { label: string }>(
  function IconButton({ label, ...props }, ref) {
    return (
      <Button
        {...props}
        ref={ref}
        iconOnly
        aria-label={props['aria-label'] || label}
        tooltip={props.tooltip || label}
      />
    );
  },
);
