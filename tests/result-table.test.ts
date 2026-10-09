import { expect, it } from 'vitest'
import type { Cell } from '../src/shared/contracts'
import { compareCells } from '../src/renderer/src/lib/result-table'
it('sorts numeric values numerically, puts NULL first and compares big integers exactly', () => {
  expect([10, 2, null, -1].sort(compareCells)).toEqual([null, -1, 2, 10])
  expect(compareCells('9007199254740993', '9007199254740992')).toBeGreaterThan(0)
  expect(compareCells('a2', 'a10')).toBeLessThan(0)
  expect(compareCells(null, null)).toBe(0)
})

import { effectScope, ref, nextTick } from 'vue'
import {
  useTable,
  tableFeatures,
  rowSortingFeature,
  columnSizingFeature,
  createSortedRowModel,
} from '@tanstack/vue-table'
it('uses the actual table model to cycle sorting without mutating source rows and clamp resized widths', async () => {
  const scope = effectScope()
  const features = tableFeatures({
    rowSortingFeature,
    columnSizingFeature,
    sortedRowModel: createSortedRowModel(),
  })
  const source = ref<Cell[][]>([[10], [2], [null]])
  const table = scope.run(() =>
    useTable<typeof features, Cell[]>({
      features,
      data: source,
      columns: [
        {
          id: '0',
          accessorFn: (row) => row[0],
          size: 180,
          minSize: 80,
          maxSize: 1000,
          sortDescFirst: false,
          sortFn: (a, b) => compareCells(a.original[0], b.original[0]),
        },
      ],
    }),
  )!
  try {
    table.getColumn('0')!.toggleSorting()
    await nextTick()
    expect(table.getRowModel().rows.map((row) => row.original[0])).toEqual([null, 2, 10])
    table.getColumn('0')!.toggleSorting()
    await nextTick()
    expect(table.getRowModel().rows.map((row) => row.original[0])).toEqual([10, 2, null])
    table.getColumn('0')!.toggleSorting()
    await nextTick()
    expect(table.getRowModel().rows.map((row) => row.original[0])).toEqual([10, 2, null])
    expect(table.getColumn('0')!.getIsSorted()).toBe(false)
    expect(source.value).toEqual([[10], [2], [null]])
    table.setColumnSizing({ '0': 5000 })
    expect(table.getColumn('0')!.getSize()).toBe(1000)
    table.setColumnSizing({ '0': 20 })
    expect(table.getColumn('0')!.getSize()).toBe(80)
  } finally {
    scope.stop()
  }
})
