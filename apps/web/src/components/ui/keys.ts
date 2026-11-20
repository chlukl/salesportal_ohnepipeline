/**
 * Platform-aware key labels – one source for the «?» overview (shortcuts.tsx) and the key hints on buttons, so both
 * show «⌘» on a Mac and «Ctrl» elsewhere.
 */

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** Label of one key of a combo (`mod`, `shift`, `enter`, `k` …). */
export function keyLabel(key: string, mac = isMac): string {
  switch (key) {
    case 'mod':
      return mac ? '⌘' : 'Ctrl';
    case 'shift':
      return '⇧';
    case 'alt':
      return mac ? '⌥' : 'Alt';
    case 'escape':
      return 'Esc';
    case 'enter':
      return '↵';
    case 'arrowup':
      return '↑';
    case 'arrowdown':
      return '↓';
    default:
      return key.length === 1 ? key.toUpperCase() : key;
  }
}

/**
 * Key hint for a button: accepts a combo as registered with `useShortcut` (`'mod+enter'`, `'g a'`) or an already
 * written label (`'Ctrl ↵'`, `'N'`); «Ctrl»/«Alt» become «⌘»/«⌥» on a Mac.
 */
export function kbdLabel(keys: string, mac = isMac): string {
  const trimmed = keys.trim();
  // Registered combos are lower-case ('mod+enter', 'g a', 'n'); written labels are not ('Ctrl ↵', 'N').
  if (/^[a-z0-9?/+ ]+$/.test(trimmed)) {
    return trimmed
      .split(' ')
      .map((combo) => combo.split('+').map((k) => keyLabel(k, mac)).join(' '))
      .join(' dann ');
  }
  if (!mac) return trimmed;
  return trimmed.replace(/\bCtrl\b/g, '⌘').replace(/\bAlt\b/g, '⌥');
}
