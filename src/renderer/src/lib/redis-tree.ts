export interface KeyNode {
  id: string
  label: string
  key?: string
  children: KeyNode[]
}
export interface KeyRow extends KeyNode {
  depth: number
}
export function buildKeyTree(keys: string[]): KeyNode[] {
  const roots: KeyNode[] = []
  const index = new Map<string, KeyNode>()
  for (const key of new Set(keys)) {
    let nodes = roots
    const raw = key.split(':')
    const parts = raw.length > 16 ? [...raw.slice(0, 15), raw.slice(15).join(':')] : raw
    parts.forEach((part, position) => {
      const id = JSON.stringify(parts.slice(0, position + 1))
      let node = index.get(id)
      if (!node) {
        node = { id, label: part || '(空)', children: [] }
        nodes.push(node)
        index.set(id, node)
      }
      if (position === parts.length - 1) node.key = key
      nodes = node.children
    })
  }
  function sort(nodes: KeyNode[]) {
    nodes.sort((a, b) => a.label.localeCompare(b.label))
    for (const node of nodes) sort(node.children)
  }
  sort(roots)
  return roots
}
export function flattenKeyTree(nodes: KeyNode[], expanded: Set<string>, depth = 0): KeyRow[] {
  return nodes.flatMap((node) => [
    { ...node, depth },
    ...(expanded.has(node.id) ? flattenKeyTree(node.children, expanded, depth + 1) : []),
  ])
}
