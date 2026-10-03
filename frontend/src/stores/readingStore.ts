/**
 * 读数 store：维护本窗口的批次基准版本、读数保存 / 撤回与跨窗口冲突状态。
 * 窗口在打开编辑对话框时快照基准版本；保存时若批次已被其它窗口更新，
 * 保存被拒绝并置 conflict（含冲突日期与工单明细），由用户确认后基于最新版本重试。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { RecalcResult, VersionConflict } from '@/types/transfer'
import {
  getBatchVersion,
  isVersionConflict,
  saveReadingVersioned,
  withdrawReadingVersioned,
  type SaveReadingResult
} from '@/utils/versioning'

export const useReadingStore = defineStore('reading', () => {
  /** 各批次在本窗口的基准版本（batchId → version） */
  const baseVersions = ref<Record<string, number>>({})
  /** 待处理的跨窗口冲突（非空时页面弹冲突对话框） */
  const conflict = ref<VersionConflict | null>(null)
  /** 最近一次保存触发的趋势重算结果（页面用于提示） */
  const lastRecalc = ref<RecalcResult | null>(null)

  /** 快照指定批次的基准版本（打开编辑对话框 / 切换批次时调用） */
  async function syncBaseVersion(batchId: string): Promise<number> {
    const version = await getBatchVersion(batchId)
    baseVersions.value = { ...baseVersions.value, [batchId]: version }
    return version
  }

  function baseVersionOf(batchId: string): number {
    return baseVersions.value[batchId] ?? 0
  }

  /** 保存读数（新增 / 编辑 / 同日覆盖）；冲突时返回 null 并置 conflict */
  async function saveReading(input: {
    batchId: string
    date: string
    gravity: number
    tempC: number
    brix: number
    editingId?: string | null
  }): Promise<SaveReadingResult | null> {
    const baseVersion = await ensureBaseVersion(input.batchId)
    try {
      const result = await saveReadingVersioned({ ...input, baseVersion })
      baseVersions.value = { ...baseVersions.value, [input.batchId]: result.version }
      lastRecalc.value = result.recalc
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

  /** 撤回读数；冲突时返回 null 并置 conflict */
  async function withdrawReading(input: { id: string; batchId: string }): Promise<SaveReadingResult | null> {
    const baseVersion = await ensureBaseVersion(input.batchId)
    try {
      const result = await withdrawReadingVersioned({ ...input, baseVersion })
      baseVersions.value = { ...baseVersions.value, [input.batchId]: result.version }
      lastRecalc.value = result.recalc
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

  async function ensureBaseVersion(batchId: string): Promise<number> {
    if (!(batchId in baseVersions.value)) return syncBaseVersion(batchId)
    return baseVersions.value[batchId]
  }

  /** 接受最新版本：基准版本推进到冲突时的当前版本，用户基于最新数据重试 */
  function acceptLatest(): void {
    if (!conflict.value) return
    baseVersions.value = {
      ...baseVersions.value,
      [conflict.value.batchId]: conflict.value.currentVersion
    }
    conflict.value = null
  }

  function clearConflict(): void {
    conflict.value = null
  }

  return {
    baseVersions,
    conflict,
    lastRecalc,
    syncBaseVersion,
    baseVersionOf,
    saveReading,
    withdrawReading,
    acceptLatest,
    clearConflict
  }
})
