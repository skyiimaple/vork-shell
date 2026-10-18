import type { DataTable, ErDiagram, ErEntity, ErPositions } from './contracts'
export function entityKey(table: DataTable) {
  return JSON.stringify([table.schema, table.name])
}
export const erWidth = 320,
  erHeader = 48,
  erRow = 22
export function layoutDiagram(graph: ErDiagram, positions: ErPositions = {}, full = false) {
  if (
    !positions ||
    typeof positions !== 'object' ||
    Array.isArray(positions) ||
    Object.keys(positions).length > 300 ||
    typeof full !== 'boolean'
  )
    throw new Error('关系图布局无效')
  for (const point of Object.values(positions))
    if (
      !point ||
      !Number.isFinite(point.x) ||
      !Number.isFinite(point.y) ||
      point.x < 0 ||
      point.y < 0 ||
      point.x > 1000000 ||
      point.y > 1000000
    )
      throw new Error('关系图坐标无效')
  const entities: (ErEntity & { external: boolean })[] = graph.tables.map((entity) => ({
      ...entity,
      external: false,
    })),
    known = new Set(entities.map((entity) => entityKey(entity.table)))
  for (const relation of graph.relations)
    for (const table of [relation.from, relation.to])
      if (!known.has(entityKey(table))) {
        known.add(entityKey(table))
        entities.push({ table, columns: [], external: true })
      }
  const cols = Math.min(4, Math.max(1, Math.ceil(Math.sqrt(entities.length)))),
    nodes: {
      key: string
      table: DataTable
      columns: ErEntity['columns']
      external: boolean
      x: number
      y: number
      height: number
      shown: ErEntity['columns']
    }[] = []
  let y = 24,
    rowHeight = 0
  for (let index = 0; index < entities.length; index++) {
    if (index && index % cols === 0) {
      y += rowHeight + 80
      rowHeight = 0
    }
    const entity = entities[index]!,
      key = entityKey(entity.table),
      shown = full ? entity.columns : entity.columns.slice(0, 12),
      height = entity.external
        ? 80
        : erHeader + shown.length * erRow + (shown.length < entity.columns.length ? 26 : 8),
      point = positions[key] || { x: 24 + (index % cols) * (erWidth + 80), y }
    nodes.push({ ...entity, key, shown, ...point, height })
    rowHeight = Math.max(rowHeight, height)
  }
  const byKey = new Map(nodes.map((node) => [node.key, node]))
  const edges = graph.relations.map((relation, index) => {
    const from = byKey.get(entityKey(relation.from))!,
      to = byKey.get(entityKey(relation.to))!,
      self = from.key === to.key
    const rowY = (node: typeof from, column: string | undefined) => {
      const i = node.shown.findIndex((field) => field.name === column)
      return node.y + (i < 0 ? erHeader / 2 : erHeader + i * erRow + erRow / 2)
    }
    if (self || Math.abs(from.x - to.x) < erWidth) {
      const x1 = from.x + erWidth,
        x2 = to.x + erWidth,
        y1 = rowY(from, relation.fromColumns[0]),
        y2 = rowY(to, relation.toColumns[0]) + (self ? erRow / 2 : 0),
        control = Math.max(x1, x2) + 64 + (index % 4) * 8
      return {
        relation,
        path: `M ${x1} ${y1} C ${control} ${y1}, ${control} ${y2}, ${x2} ${y2}`,
        labelX: control - 20,
        labelY: (y1 + y2) / 2 - 8,
      }
    }
    const right = to.x >= from.x + erWidth / 2,
      x1 = from.x + (right ? erWidth : 0),
      x2 = to.x + (right ? 0 : erWidth),
      y1 = rowY(from, relation.fromColumns[0]),
      y2 = rowY(to, relation.toColumns[0]),
      bend = Math.max(60, Math.abs(x2 - x1) / 2)
    const path = `M ${x1} ${y1} C ${x1 + (right ? bend : -bend)} ${y1}, ${x2 + (right ? -bend : bend)} ${y2}, ${x2} ${y2}`
    return {
      relation,
      path,
      labelX: (x1 + x2) / 2,
      labelY: (y1 + y2) / 2 - 8,
    }
  })
  return {
    nodes,
    edges,
    width: Math.max(600, ...nodes.map((node) => node.x + erWidth + 180)),
    height: Math.max(400, ...nodes.map((node) => node.y + node.height + 40)),
  }
}
function xml(value: unknown) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}
export function diagramSvg(graph: ErDiagram, positions: ErPositions, full: boolean) {
  const { nodes, edges, width, height } = layoutDiagram(graph, positions, full)
  const lines = edges
    .map(
      (edge) =>
        `<g><path d="${edge.path}" stroke="#9b7851" stroke-width="1.5" fill="none" marker-end="url(#arrow)"/><text x="${edge.labelX}" y="${edge.labelY}" text-anchor="middle" font-size="11">${xml(edge.relation.name)}</text></g>`,
    )
    .join('')
  const boxes = nodes
    .map(
      (node) =>
        `<g transform="translate(${node.x},${node.y})"><rect width="${erWidth}" height="${node.height}" rx="8" fill="${node.external ? '#f1f1ef' : '#ffffff'}" stroke="#777777"${node.external ? ' stroke-dasharray="5 4"' : ''}/><text x="12" y="25" font-size="13" font-weight="bold">${xml(node.table.schema + '.' + node.table.name)}</text>${node.external ? '<text x="12" y="58" font-size="11">未加载字段</text>' : node.shown.map((column, i) => `<text x="12" y="${erHeader + i * erRow + 15}" font-size="11">${xml((column.primaryKey ? 'PK ' : '') + column.name + ' : ' + column.type)}</text>`).join('')}${node.shown.length < node.columns.length ? `<text x="12" y="${node.height - 8}" font-size="10">另 ${node.columns.length - node.shown.length} 个字段</text>` : ''}</g>`,
    )
    .join('')
  return `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><title>ER 关系图</title><defs><marker id="arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#9b7851"/></marker></defs><rect width="100%" height="100%" fill="#fafaf8"/><g font-family="monospace" fill="#242424">${lines}${boxes}</g></svg>`
}
