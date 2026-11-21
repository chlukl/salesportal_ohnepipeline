/**
 * Keyboard shortcut registry with an overview on «?» (INTENT 6.0).
 *
 *   useShortcut('n', () => nextLead(), { description: 'Nächster Lead', group: 'Arbeitsplatz' });
 *   useShortcut('g a', () => navigate('/anrufliste'), { description: 'Anrufliste', group: 'Navigation' });
 *   useShortcut('mod+enter', submit, { description: 'Freigeben', allowInInput: true });
 *
 * Keys: single keys ('n', '/', '?', 'escape'), modifiers ('mod' = Ctrl/⌘, 'shift', 'alt'), sequences of two ('g a').
 * Shortcuts are ignored while typing in inputs unless `allowInInput` is set.
 *
 * Layers: a modal context (e.g. the call overlay over the Anrufliste) wraps its content in `<ShortcutLayer active>`.
 * While a layer is active only the shortcuts registered inside the topmost layer fire (plus `global` ones such as «?») –
 * the page behind it keeps its registrations but does not react, so no key is handled twice.
 */
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Kbd } from '@/components/ui/Kbd';
import { kbdLabel, keyLabel } from '@/components/ui/keys';
import { createStore, useStore } from './store';

export interface ShortcutOptions {
  description: string;
  group?: string;
  allowInInput?: boolean;
  /** Hide from the «?» overview. */
  hidden?: boolean;
  enabled?: boolean;
  /** Also fires while a higher shortcut layer is active (e.g. «?»). */
  global?: boolean;
}

interface Registered extends ShortcutOptions {
  id: number;
  keys: string;
  /** 0 = page; > 0 = inside a `<ShortcutLayer>`. */
  layer: number;
  handler: (event: KeyboardEvent) => void;
}

const registry = createStore<Registered[]>([]);
export const shortcutOverlay = createStore(false);
let nextId = 1;
let pendingPrefix: { key: string; at: number } | null = null;

/** Stack of active layers (last = topmost). */
const layerStack = createStore<number[]>([]);
const LayerContext = createContext(0);
let nextLayer = 1;

function topLayer(stack: number[] = layerStack.get()): number {
  return stack.length ? stack[stack.length - 1]! : 0;
}

/** Shortcuts registered inside take over from the page while `active` (the page's shortcuts pause). */
export function ShortcutLayer({ active, children }: { active: boolean; children: ReactNode }) {
  const [id] = useState(() => nextLayer++);
  useEffect(() => {
    if (!active) return;
    layerStack.set((s) => [...s.filter((x) => x !== id), id]);
    return () => layerStack.set((s) => s.filter((x) => x !== id));
  }, [active, id]);
  return <LayerContext.Provider value={id}>{children}</LayerContext.Provider>;
}


function normalizeEventKey(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('mod');
  if (e.altKey) parts.push('alt');
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase();
  // Shift is implied for printable symbols like '?' – only track it for named keys / letters with modifiers.
  if (e.shiftKey && (key.length > 1 || parts.length > 0)) parts.push('shift');
  parts.push(key === ' ' ? 'space' : key);
  return parts.join('+');
}

function normalizeCombo(combo: string): string {
  const parts = combo.toLowerCase().split('+').map((p) => p.trim());
  const key = parts.pop() ?? '';
  const mods = ['mod', 'alt', 'shift'].filter((m) => parts.includes(m));
  return [...mods, key].join('+');
}

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.defaultPrevented || e.isComposing) return;
  const typing = isTypingTarget(e.target);
  const combo = normalizeEventKey(e);
  const now = Date.now();
  const top = topLayer();
  const entries = registry.get().filter((r) => r.enabled !== false && (!typing || r.allowInInput) && (r.global || r.layer === top));

  // Two-key sequences ('g a').
  if (pendingPrefix && now - pendingPrefix.at < 1200) {
    const seq = `${pendingPrefix.key} ${combo}`;
    const match = entries.find((r) => r.keys === seq);
    pendingPrefix = null;
    if (match) {
      e.preventDefault();
      match.handler(e);
      return;
    }
  }
  const direct = [...entries].reverse().find((r) => r.keys === combo);
  if (direct) {
    e.preventDefault();
    direct.handler(e);
    return;
  }
  if (!typing && entries.some((r) => r.keys.startsWith(`${combo} `))) {
    pendingPrefix = { key: combo, at: now };
  }
}

let listening = false;
function ensureListener(): void {
  if (listening || typeof window === 'undefined') return;
  window.addEventListener('keydown', onKeyDown);
  listening = true;
}

export function registerShortcut(keys: string, handler: (e: KeyboardEvent) => void, options: ShortcutOptions, layer = 0): () => void {
  ensureListener();
  const id = nextId++;
  const normalized = keys.split(' ').map(normalizeCombo).join(' ');
  registry.set((list) => [...list, { id, keys: normalized, handler, layer, ...options }]);
  return () => registry.set((list) => list.filter((r) => r.id !== id));
}

/** Register a shortcut while the component is mounted (handler may change without re-registering). */
export function useShortcut(keys: string, handler: (e: KeyboardEvent) => void, options: ShortcutOptions): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const { description, group, allowInInput, hidden, enabled, global } = options;
  const layer = useContext(LayerContext);
  useEffect(
    () => registerShortcut(keys, (e) => handlerRef.current(e), { description, group, allowInInput, hidden, enabled, global }, layer),
    [keys, description, group, allowInInput, hidden, enabled, global, layer],
  );
}

/** Display form of a key combo: 'mod+k' → [['Ctrl', 'K']] (Mac: ⌘). Same labels as the key hints on buttons. */
export function comboLabels(keys: string): string[][] {
  return keys.split(' ').map((combo) => combo.split('+').map((p) => keyLabel(p)));
}

/** Key hint text for a combo, e.g. for `<Button kbd>` – `kbdLabel('mod+enter')` → «Ctrl ↵» / «⌘ ↵». */
export { kbdLabel };

export function ShortcutOverlay() {
  const open = useStore(shortcutOverlay);
  // Only what works right now: the topmost layer (e.g. the call overlay) and global shortcuts.
  const top = topLayer(useStore(layerStack));
  const entries = useStore(registry).filter((r) => !r.hidden && (r.global || r.layer === top));
  const groups = new Map<string, Registered[]>();
  for (const e of entries) {
    const g = e.group ?? 'Allgemein';
    if (groups.get(g)?.some((x) => x.keys === e.keys)) continue;
    groups.set(g, [...(groups.get(g) ?? []), e]);
  }
  return (
    <Dialog open={open} onClose={() => shortcutOverlay.set(false)} title="Tastaturkürzel" size="lg">
      <div className="grid grid-cols-2 gap-x-10 gap-y-6">
        {[...groups.entries()].map(([group, list]) => (
          <section key={group}>
            <h3 className="mb-2 text-xs font-semibold tracking-wide text-fg-subtle uppercase">{group}</h3>
            <ul className="space-y-1.5">
              {list.map((e) => (
                <li key={e.id} className="flex items-center justify-between gap-4 text-sm">
                  <span className="text-fg-muted">{e.description}</span>
                  <span className="flex items-center gap-1">
                    {comboLabels(e.keys).map((combo, i) => (
                      <span key={i} className="flex items-center gap-0.5">
                        {i > 0 && <span className="px-0.5 text-xs text-fg-subtle">dann</span>}
                        {combo.map((k) => (
                          <Kbd key={k}>{k}</Kbd>
                        ))}
                      </span>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
