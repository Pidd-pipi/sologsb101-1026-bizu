/**
 * 发酵读数 store：读数按批次 + 日期唯一，所有写操作走版本化乐观锁事务。
 * 改动 / 撤回成功后由 db 层从受影响日期重算趋势并退回失效工单。
 */
import { defineStore } from 'pinia'
import {
  restoreReading as restoreReadingRow,
  saveReadingChange,
  withdrawReading as withdrawReadingRow,
  type ReadingChangeInput
} from '@/utils/db'

export interface ReadingDraft {
  batchId: string
  date: string
  gravity: number
  tempC: number
  brix: number
}

export const useReadingStore = defineStore('reading', () => {
  /** 新增 / 改动读数；expectedVersion 为窗口当前看到的批次 readingVersion */
  async function save(draft: ReadingDraft, expectedVersion: number, editingId?: string): Promise<void> {
    const payload: ReadingChangeInput = { ...draft, expectedVersion }
    if (editingId) payload.id = editingId
    await saveReadingChange(payload)
  }

  async function withdraw(id: string, reason: string, expectedVersion: number): Promise<void> {
    await withdrawReadingRow({ id, reason, expectedVersion })
  }

  async function restore(id: string, expectedVersion: number): Promise<void> {
    await restoreReadingRow(id, expectedVersion)
  }

  return { save, withdraw, restore }
})
