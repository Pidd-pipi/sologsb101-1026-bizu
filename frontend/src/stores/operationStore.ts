/**
 * 作业 store：维护作业顺序、完成态与作业类型筛选。
 * 倒罐工单的保存 / 复核 / 完成全部走 db 的版本化事务（乐观锁 + 容量排队）。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { LocationQuery } from 'vue-router'
import type { Operation, OperationState } from '@/types/operation'
import type { FilterModel } from '@/types/filter'
import type { OperationRow } from '@/utils/db'
import {
  completeOperation,
  removeOperation,
  reorderOperations,
  reviewOperation as reviewOperationRow,
  saveOperationChange
} from '@/utils/db'
import { queryToFilters } from '@/utils/query'

export const OPERATION_FILTER_KEYS = ['types', 'states']

/** 新建 / 编辑工单的表单载荷 */
export interface OperationDraft {
  batchId: string
  type: Operation['type']
  date: string
  durationMin: number
  operator: string
  targetTankId: string
  transferVolumeL: number
}

export const useOperationStore = defineStore('operation', () => {
  const filters = ref<FilterModel>({ keyword: '', types: [], states: [] })
  const currentBatchId = ref<string | null>(null)

  function setFilters(next: FilterModel): void {
    filters.value = next
  }

  function resetFilters(): void {
    filters.value = { keyword: '', types: [], states: [] }
  }

  function applyQuery(query: LocationQuery): void {
    filters.value = queryToFilters(query, OPERATION_FILTER_KEYS)
    if (typeof query.batchId === 'string' && query.batchId.length > 0) {
      currentBatchId.value = query.batchId
    }
  }

  function select(id: string | null): void {
    currentBatchId.value = id
  }

  /**
   * 保存工单（新建或编辑）。
   * @param expectedReadingVersion 表单打开时批次的读数版本（乐观锁基线）
   * @param editing 编辑中的当前行（携带 updatedAt 防同单互相覆盖）
   */
  async function saveOperation(
    draft: OperationDraft,
    expectedReadingVersion: number,
    editing: OperationRow | null
  ): Promise<OperationRow> {
    if (!draft.batchId) throw new Error('请选择批次')
    if (!draft.operator.trim()) throw new Error('请填写操作人')
    // 倒罐按源罐批次全量转罐：液量由 db 事务内按批次在罐量核定，表单不允许少转
    const batchVolume = editing?.transferVolumeL ?? draft.transferVolumeL
    return saveOperationChange({
      id: editing?.id,
      batchId: draft.batchId,
      type: draft.type,
      date: draft.date,
      durationMin: draft.durationMin,
      operator: draft.operator,
      targetTankId: draft.targetTankId,
      transferVolumeL: draft.type === '倒罐' ? draft.transferVolumeL || batchVolume : 0,
      expectedReadingVersion,
      expectedUpdatedAt: editing?.updatedAt
    })
  }

  async function deleteOperation(id: string): Promise<void> {
    await removeOperation(id)
  }

  /** 复核退回的倒罐工单：依据刷新到最新读数版本，再按容量决定计划 / 排队 */
  async function review(id: string, note: string): Promise<OperationRow> {
    return reviewOperationRow(id, note)
  }

  /** 标记完成：倒罐完成后批次转入目标罐并保留容量；排队 / 待复核不允许完成 */
  async function finish(id: string): Promise<void> {
    await completeOperation(id)
  }

  /** 拖拽调序后按新顺序批量写回 seq，并按新顺序重排排队先后 */
  async function move(list: OperationRow[], from: number, to: number): Promise<void> {
    if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return
    const next = [...list]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    await reorderOperations(next.map((item) => item.id))
  }

  return {
    filters,
    currentBatchId,
    setFilters,
    resetFilters,
    applyQuery,
    select,
    saveOperation,
    deleteOperation,
    review,
    finish,
    move
  }
})

export type { OperationState }
