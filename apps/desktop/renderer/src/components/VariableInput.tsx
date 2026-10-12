import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type InputHTMLAttributes, type KeyboardEvent, type MouseEvent, type Ref } from 'react';
import { refreshVariableIndex, useActiveVariableIndex } from '../lib/variable-index';
import { applyCompletion, completionContext, describeHint, filterCompletions, findVariableTokens, lookupHint, scopeLabel, type CompletionItem, type VariableIndex } from '../lib/variable-hints';

export interface VariableInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'> {
  value: string;
  onChange(value: string): void;
  /** Defaults to the active tab's index. */
  variables?: VariableIndex;
  inputRef?: Ref<HTMLInputElement>;
}

interface Popup {
  items: CompletionItem[];
  selected: number;
  left: number;
  top: number;
  width: number;
}

interface Tip {
  title: string;
  detail: string;
  unresolved: boolean;
  left: number;
  top: number;
}

const POPUP_MAX = 12;

/**
 * Text input with `{{variable}}` support: autocomplete after `{{`, hover information
 * for a reference under the mouse, and inline highlighting of unresolved names.
 * The visible text lives in a mirror element behind a transparent-text input so
 * the native caret, selection, scrolling and IME keep working.
 */
export function VariableInput({ value, onChange, variables, inputRef, className = '', onKeyDown, onBlur, onFocus, onScroll, style, ...rest }: VariableInputProps) {
  const active = useActiveVariableIndex();
  const index = variables ?? active;
  const input = useRef<HTMLInputElement | null>(null);
  const mirror = useRef<HTMLSpanElement>(null);
  const [popup, setPopup] = useState<Popup | null>(null);
  const [tip, setTip] = useState<Tip | null>(null);
  const tokens = useMemo(() => findVariableTokens(value), [value]);

  const setRef = useCallback(
    (el: HTMLInputElement | null) => {
      input.current = el;
      if (typeof inputRef === 'function') inputRef(el);
      else if (inputRef && typeof inputRef === 'object') (inputRef as { current: HTMLInputElement | null }).current = el;
    },
    [inputRef],
  );

  // The mirror must render with exactly the input's metrics (font, padding, letter spacing).
  useLayoutEffect(() => {
    const el = input.current;
    const m = mirror.current;
    if (!el || !m) return;
    const cs = getComputedStyle(el);
    m.style.font = cs.font;
    m.style.letterSpacing = cs.letterSpacing;
    m.style.padding = cs.padding;
    m.style.borderWidth = cs.borderWidth;
    m.style.textAlign = cs.textAlign;
  }, [className]);

  useLayoutEffect(() => {
    if (mirror.current && input.current) mirror.current.scrollLeft = input.current.scrollLeft;
  }, [value]);

  const updatePopup = useCallback(
    (text: string, caret: number) => {
      const ctx = completionContext(text, caret);
      const el = input.current;
      if (!ctx || !el) {
        setPopup(null);
        return;
      }
      const items = filterCompletions(index, ctx.prefix, POPUP_MAX);
      if (items.length === 0) {
        setPopup(null);
        return;
      }
      const rect = el.getBoundingClientRect();
      setPopup({ items, selected: 0, left: rect.left, top: rect.bottom + 2, width: Math.max(260, rect.width) });
    },
    [index],
  );

  const accept = useCallback(
    (name: string) => {
      const el = input.current;
      const caret = el?.selectionStart ?? value.length;
      const next = applyCompletion(value, caret, name);
      onChange(next.text);
      setPopup(null);
      requestAnimationFrame(() => {
        const node = input.current;
        if (node) {
          node.focus();
          node.setSelectionRange(next.caret, next.caret);
        }
      });
    },
    [value, onChange],
  );

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (popup) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const delta = e.key === 'ArrowDown' ? 1 : -1;
        setPopup({ ...popup, selected: (popup.selected + delta + popup.items.length) % popup.items.length });
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        accept(popup.items[popup.selected]!.name);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setPopup(null);
        return;
      }
    }
    onKeyDown?.(e);
  };

  // Which `{{token}}` is under the mouse: measure the text with the input's font.
  const tokenAt = (e: MouseEvent<HTMLInputElement>): { name: string; left: number } | null => {
    const el = input.current;
    if (!el || tokens.length === 0) return null;
    const cs = getComputedStyle(el);
    const canvas = measureCanvas();
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.font = cs.font;
    const rect = el.getBoundingClientRect();
    const padLeft = parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth);
    const x = e.clientX - rect.left - padLeft + el.scrollLeft;
    for (const t of tokens) {
      const from = ctx.measureText(value.slice(0, t.start)).width;
      const to = ctx.measureText(value.slice(0, t.end)).width;
      if (x >= from && x <= to) return { name: t.name, left: rect.left + padLeft + from - el.scrollLeft };
    }
    return null;
  };

  const handleMouseMove = (e: MouseEvent<HTMLInputElement>) => {
    const hit = tokenAt(e);
    if (!hit) {
      if (tip) setTip(null);
      return;
    }
    const d = describeHint(index, hit.name);
    const rect = input.current!.getBoundingClientRect();
    if (!tip || tip.title !== d.title) setTip({ ...d, left: Math.min(hit.left, window.innerWidth - 320), top: rect.bottom + 2 });
  };

  useEffect(() => {
    if (!popup) return;
    const close = () => setPopup(null);
    window.addEventListener('resize', close);
    return () => window.removeEventListener('resize', close);
  }, [popup]);

  const segments = useMemo(() => {
    const out: Array<{ text: string; cls?: string }> = [];
    let pos = 0;
    for (const t of tokens) {
      if (t.start > pos) out.push({ text: value.slice(pos, t.start) });
      const hint = lookupHint(index, t.name);
      out.push({ text: value.slice(t.start, t.end), cls: !hint ? 'vi-var vi-unresolved' : hint.secret ? 'vi-var vi-secret' : 'vi-var' });
      pos = t.end;
    }
    if (pos < value.length) out.push({ text: value.slice(pos) });
    return out;
  }, [value, tokens, index]);

  const unresolvedCount = tokens.filter((t) => !lookupHint(index, t.name)).length;

  return (
    <span className={`vi-wrap ${rest.disabled ? 'vi-disabled' : ''}`} style={style}>
      <span ref={mirror} className="vi-mirror" aria-hidden="true">
        {segments.map((s, i) =>
          s.cls ? (
            <span key={i} className={s.cls}>
              {s.text}
            </span>
          ) : (
            <span key={i}>{s.text}</span>
          ),
        )}
      </span>
      <input
        {...rest}
        ref={setRef}
        className={`vi-input ${className}`}
        value={value}
        autoComplete="off"
        spellCheck={false}
        aria-autocomplete="list"
        aria-expanded={popup !== null}
        aria-invalid={unresolvedCount > 0 ? true : undefined}
        onChange={(e) => {
          onChange(e.target.value);
          updatePopup(e.target.value, e.target.selectionStart ?? e.target.value.length);
        }}
        onKeyDown={handleKeyDown}
        onFocus={(e) => {
          refreshVariableIndex();
          onFocus?.(e);
        }}
        onBlur={(e) => {
          // Let a click on a popup item run first.
          setTimeout(() => setPopup(null), 120);
          setTip(null);
          onBlur?.(e);
        }}
        onScroll={(e) => {
          if (mirror.current) mirror.current.scrollLeft = e.currentTarget.scrollLeft;
          onScroll?.(e);
        }}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setTip(null)}
      />
      {popup && (
        <ul className="vi-popup" role="listbox" style={{ left: popup.left, top: popup.top, minWidth: popup.width }}>
          {popup.items.map((item, i) => (
            <li
              key={`${item.scope}:${item.name}`}
              role="option"
              aria-selected={i === popup.selected}
              className={`vi-item ${i === popup.selected ? 'active' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault();
                accept(item.name);
              }}
              onMouseEnter={() => setPopup((p) => (p ? { ...p, selected: i } : p))}
            >
              <code className="vi-item-name">{`{{${item.name}}}`}</code>
              <span className={`vi-scope vi-scope-${item.scope}`}>{scopeLabel(item.scope)}</span>
              {item.secret && <span className="vi-secret-badge">secret</span>}
            </li>
          ))}
        </ul>
      )}
      {tip && !popup && (
        <div className={`vi-tip ${tip.unresolved ? 'vi-tip-unresolved' : ''}`} role="tooltip" style={{ left: tip.left, top: tip.top }}>
          <code>{tip.title}</code>
          <span>{tip.detail}</span>
        </div>
      )}
    </span>
  );
}

let canvas: HTMLCanvasElement | null = null;
function measureCanvas(): HTMLCanvasElement {
  if (!canvas) canvas = document.createElement('canvas');
  return canvas;
}
