export const defaultShortcuts = {
  newConnection: 'Mod-n',
  close: 'Mod-w',
  execute: 'Mod-Enter',
  searchHistory: 'Mod-Shift-f',
}
export type Shortcuts = typeof defaultShortcuts
export function normalizeShortcut(input: string): string {
  const parts = input.trim().replaceAll('+', '-').split('-').filter(Boolean)
  const key = parts.pop()?.toLowerCase()
  const aliases: Record<string, string> = {
    mod: 'Mod',
    ctrl: 'Ctrl',
    control: 'Ctrl',
    cmd: 'Meta',
    meta: 'Meta',
    alt: 'Alt',
    shift: 'Shift',
  }
  const modifiers = parts.map((p) => aliases[p.toLowerCase()])
  if (
    !key ||
    !/^(?:[a-z0-9]|enter|escape|space|f(?:[1-9]|1[0-2]))$/.test(key) ||
    modifiers.some((p) => !p) ||
    new Set(modifiers).size !== modifiers.length ||
    !modifiers.some((p) => ['Mod', 'Ctrl', 'Meta', 'Alt'].includes(p!))
  )
    throw new Error('快捷键需包含 Mod/Ctrl/Meta/Alt 和有效按键，例如 Mod-Shift-k')
  if (modifiers.includes('Mod') && (modifiers.includes('Ctrl') || modifiers.includes('Meta')))
    throw new Error('Mod 不能与 Ctrl/Meta 同时使用')
  const name =
    key === 'enter'
      ? 'Enter'
      : key === 'escape'
        ? 'Escape'
        : key === 'space'
          ? 'Space'
          : key.startsWith('f') && key.length > 1
            ? key.toUpperCase()
            : key
  return [
    ...['Mod', 'Ctrl', 'Meta', 'Alt', 'Shift'].filter((p) => modifiers.includes(p)),
    name,
  ].join('-')
}
export function validateShortcuts(input: Shortcuts): Shortcuts {
  const result = Object.fromEntries(
    Object.keys(defaultShortcuts).map((key) => [
      key,
      normalizeShortcut(input[key as keyof Shortcuts]),
    ]),
  ) as Shortcuts
  const signatures = (shortcut: string, mac: boolean) =>
    shortcut.replace('Mod', mac ? 'Meta' : 'Ctrl')
  for (const mac of [true, false]) {
    const values = Object.values(result).map((value) => signatures(value, mac))
    if (new Set(values).size !== values.length)
      throw new Error('快捷键冲突，请为每个操作选择不同组合')
  }
  return result
}
export function matchesShortcut(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>,
  shortcut: string,
) {
  const parts = shortcut.split('-'),
    key = parts.pop()!.toLowerCase()
  const mod = parts.includes('Mod')
  return (
    event.key.toLowerCase() === (key === 'space' ? ' ' : key) &&
    event.shiftKey === parts.includes('Shift') &&
    event.altKey === parts.includes('Alt') &&
    (mod
      ? event.ctrlKey !== event.metaKey
      : event.ctrlKey === parts.includes('Ctrl') && event.metaKey === parts.includes('Meta'))
  )
}
