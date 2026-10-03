/**
 * 发酵读数：逐日记录比重、温度与糖度。
 * 唯一性：同一批次同一日期只允许一条读数（数据库层 &[batchId+date] 唯一索引强制），
 * 补录历史读数时同日覆盖更新，改动或撤回后从受影响日期起重算趋势结论。
 */
export interface Reading {
  id: string
  /** 所属批次 */
  batchId: string
  /** 记录日期 YYYY-MM-DD */
  date: string
  /** 比重（SG） */
  gravity: number
  /** 温度 ℃ */
  tempC: number
  /** 糖度 °Bx */
  brix: number
}

/** 超温阈值 ℃ */
export const OVER_TEMP_C = 30
/** 发酵停滞判定：连续 2 日比重下降 < 0.002 视为停滞 */
export const STUCK_DECLINE_THRESHOLD = 0.002

export function createEmptyReading(): Omit<Reading, 'id'> {
  return { batchId: '', date: new Date().toISOString().slice(0, 10), gravity: 1.09, tempC: 24, brix: 22 }
}
