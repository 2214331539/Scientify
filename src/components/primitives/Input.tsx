import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import './primitives.css';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className = '', ...props }, ref) {
    return <input {...props} ref={ref} className={`sf-input ${className}`.trim()} />;
  },
);

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className = '', ...props }, ref) {
  return <textarea {...props} ref={ref} className={`sf-textarea ${className}`.trim()} />;
});
