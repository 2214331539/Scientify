import { forwardRef, type SelectHTMLAttributes } from 'react';
import './primitives.css';

/** Native select preserves desktop keyboard navigation and combobox semantics. */
export const Dropdown = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Dropdown({ className = '', ...props }, ref) {
    return <select {...props} ref={ref} className={`sf-dropdown ${className}`.trim()} />;
  },
);
