/**
 * 作业 store：维护作业顺序、完成态与作业类型筛选。
 * 工单保存 / 复核 / 完成 / 删除全部走版本链（utils/transfer.ts + utils/versioning.ts），
 * 跨窗口冲突时置 conflict，由用户确认后基于最新版本重试。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { LocationQuery } from 'vue-router'
import type { Operation, OperationState } from '@/types/operation'
import type { FilterModel } from '@/types/filter'
import type { VersionConflict } from '@/types/transfer'
import {
  deleteOperationVersioned,
  isVersionConflict,
  listBatchVersions,
  reorderOperationsVersioned
} from '@/utils/versioning'
import {
  completeOperationVersioned,
  requeueWaitingOps,
  reviewOperationVersioned,
  saveOperationVersioned,
  type SaveOperationInput
} from '@/utils/transfer'
import { queryToFilters } from '@/utils/query'

export const OPERATION_FILTER_KEYS = ['types', 'states']

export const useOperationStore = defineStore('operation', () => {
  const filters = ref<FilterModel>({ keyword: '', types: [], states: [] })
  const currentBatchId = ref<string | null>(null)
  /** 各批次在本窗口的基准版本（batchId → version） */
  const baseVersions = ref<Record<string, number>>({})
  /** 待处理的跨窗口冲突（非空时页面弹冲突对话框） */
  const conflict = ref<VersionConflict | null>(null)

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

  /* ------------------------------ 基准版本 ------------------------------ */

  /** 窗口加载时快照全部批次版本（保存冲突检测的基准） */
  async function syncAllBaseVersions(): Promise<void> {
    baseVersions.value = await listBatchVersions()
  }

  /** 打开编辑对话框时快照单个批次版本 */
  async function syncBaseVersion(batchId: string): Promise<void> {
    const all = baseVersions.value
    if (!(batchId in all)) {
      baseVersions.value = { ...all, ...(await listBatchVersions()) }
    }
  }

  function baseVersionOf(batchId: string): number {
    return baseVersions.value[batchId] ?? 0
  }

  function bumpLocal(batchId: string, version: number): void {
    baseVersions.value = { ...baseVersions.value, [batchId]: version }
  }

  /** 接受最新版本：基准版本推进到冲突时的当前版本，用户基于最新数据重试 */
  function acceptLatest(): void {
    if (!conflict.value) return
    bumpLocal(conflict.value.batchId, conflict.value.currentVersion)
    conflict.value = null
  }

  function clearConflict(): void {
    conflict.value = null
  }

  /** 统一捕获版本冲突：冲突时置 conflict 并返回 null */
  async function guard<T>(batchId: string, run: (baseVersion: number) => Promise<T>): Promise<T | null> {
    try {
      const result = await run(baseVersionOf(batchId))
      conflict.value = null
      return result
    } catch (error) {
      if (isVersionConflict(error)) {
        conflict.value = error.conflict
        return null
      }
      throw error
    }
  }

  /* ------------------------------ 工单动作 ------------------------------ */

  /** 保存工单（新增 / 编辑）：倒罐容量不足自动转排队 */
  async function saveOperation(
    input: Omit<SaveOperationInput, 'baseVersion'>
  ): Promise<{ id: string; state: OperationState; shortfallL: number } | null> {
    return guard(input.batchId, async (baseVersion) => {
      const result = await saveOperationVersioned({ ...input, baseVersion })
      bumpLocal(input.batchId, result.version)
      return { id: result.id, state: result.state, shortfallL: result.shortfallL }
    })
  }

  /** 复核：待复核工单按最新趋势与容量重新定状态 */
  async function review(row: Operation): Promise<{ state: OperationState; shortfallL: number } | null> {
    return guard(row.batchId, async (baseVersion) => {
      const result = await reviewOperationVersioned(row.id, baseVersion)
      bumpLocal(row.batchId, result.version)
      return { state: result.state, shortfallL: result.shortfallL }
    })
  }

  /** 标记完成：倒罐完成即改绑目标罐占住容量；完成后重估排队工单 */
  async function finish(row: Operation): Promise<boolean> {
    const result = await guard(row.batchId, async (baseVersion) => {
      const version = await completeOperationVersioned(row.id, baseVersion)
      bumpLocal(row.batchId, version)
      return version
    })
    if (result === null) return false
    const promoted = await requeueWaitingOps()
    if (promoted > 0) await syncAllBaseVersions()
    return true
  }

  async function deleteOperation(row: Operation): Promise<boolean> {
    const result = await guard(row.batchId, async (baseVersion) => {
      const version = await deleteOperationVersioned(row.id, baseVersion)
      bumpLocal(row.batchId, version)
      return version
    })
    return result !== null
  }

  /** 拖拽调序后按新顺序批量写回 seq（版本化记录，其它窗口随后保存会被判冲突） */
  async function move(list: Operation[], from: number, to: number): Promise<void> {
    if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return
    const next = [...list]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    await reorderOperationsVersioned(next.map((item) => item.id))
    await syncAllBaseVersions()
  }

  return {
    filters,
    currentBatchId,
    baseVersions,
    conflict,
    setFilters,
    resetFilters,
    applyQuery,
    select,
    syncAllBaseVersions,
    syncBaseVersion,
    baseVersionOf,
    acceptLatest,
    clearConflict,
    saveOperation,
    review,
    finish,
    deleteOperation,
    move
  }
})
