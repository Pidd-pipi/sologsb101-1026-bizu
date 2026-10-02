/**
 * 首次打开应用时灌入的演示数据
 * 只在 parcels 表为空时执行，地块 → 发酵罐 → 批次 → 读数/作业/苹乳/品评 三层互相引用，
 * 保证 6 个页面第一次进入都有内容。函数本身幂等：由调用方判定表是否为空。
 *
 * version(2) 起读数带行版本、批次带 readingVersion，倒罐工单带目标罐 / 液量 / 依据版本；
 * trends 表直接按当前读数写入趋势快照，auditlogs 写入可追溯的变更流水样例。
 */
import type {
  ParcelRow,
  TankRow,
  BatchRow,
  ReadingRow,
  OperationRow,
  MlfRow,
  TastingRow,
  TrendRow,
  AuditRow
} from './db'
import { db, ROW_REVISION } from './db'
import { deriveTrend } from './trend'

function rev<T>(row: T): T & { revision: number; createdAt: number; updatedAt: number } {
  return { ...row, revision: ROW_REVISION, createdAt: Date.now(), updatedAt: Date.now() }
}

const PARCELS: Array<Omit<ParcelRow, 'revision' | 'createdAt' | 'updatedAt'>> = [
  { id: 'p-001', name: '东坡三号地', variety: '赤霞珠', areaMu: 12.5, vineAge: 8, aspect: '南' },
  { id: 'p-002', name: '南坡老藤地', variety: '梅洛', areaMu: 8, vineAge: 15, aspect: '东南' },
  { id: 'p-003', name: '西坡白葡萄地', variety: '霞多丽', areaMu: 5.5, vineAge: 6, aspect: '西' }
]

const TANKS: Array<Omit<TankRow, 'revision' | 'createdAt' | 'updatedAt'>> = [
  { id: 'tk-001', code: 'F-01', material: '不锈钢', capacityL: 3000, tempControl: '夹套', state: '在用' },
  { id: 'tk-002', code: 'F-02', material: '橡木', capacityL: 2250, tempControl: '无', state: '在用' },
  { id: 'tk-003', code: 'F-03', material: '不锈钢', capacityL: 1500, tempControl: '盘管', state: '空闲' },
  { id: 'tk-004', code: 'F-04', material: '混凝土', capacityL: 5000, tempControl: '夹套', state: '清洗中' },
  // 倒罐目标罐示例：F-05 空闲大容量（可立即承接），F-06 空闲但容量小于待转液量（触发排队）
  { id: 'tk-005', code: 'F-05', material: '不锈钢', capacityL: 3000, tempControl: '夹套', state: '空闲' },
  { id: 'tk-006', code: 'F-06', material: '橡木', capacityL: 1500, tempControl: '无', state: '空闲' }
]

const BATCHES: Array<Omit<BatchRow, 'revision' | 'createdAt' | 'updatedAt'>> = [
  {
    id: 'b-001',
    parcelId: 'p-001',
    tankId: 'tk-001',
    harvestDate: '2024-09-12',
    volumeL: 2600,
    brix: 24.5,
    state: '酒精发酵',
    lastOperationAt: '2024-09-18T09:20:00.000Z',
    readingVersion: 4
  },
  {
    id: 'b-002',
    parcelId: 'p-002',
    tankId: 'tk-002',
    harvestDate: '2024-09-15',
    volumeL: 2000,
    brix: 23,
    state: '苹乳发酵',
    lastOperationAt: '2024-09-27T14:05:00.000Z',
    readingVersion: 4
  },
  {
    id: 'b-003',
    parcelId: 'p-003',
    tankId: '',
    harvestDate: '2024-09-20',
    volumeL: 1400,
    brix: 21.5,
    state: '已出罐',
    lastOperationAt: '2024-10-08T08:40:00.000Z',
    readingVersion: 3
  }
]

function readingRow(
  base: Omit<ReadingRow, 'version' | 'status' | 'withdrawReason' | 'revision' | 'createdAt' | 'updatedAt'>,
  version = 1
): Omit<ReadingRow, 'revision' | 'createdAt' | 'updatedAt'> {
  return { ...base, version, status: '有效', withdrawReason: '' }
}

const READINGS: Array<Omit<ReadingRow, 'revision' | 'createdAt' | 'updatedAt'>> = [
  readingRow({ id: 'r-001', batchId: 'b-001', date: '2024-09-12', gravity: 1.102, tempC: 24.5, brix: 24.5 }),
  // 演示一次补录改动：9-14 读数经历两个版本（审计流水可追溯）
  readingRow({ id: 'r-002', batchId: 'b-001', date: '2024-09-14', gravity: 1.078, tempC: 27.2, brix: 19.4 }, 2),
  readingRow({ id: 'r-003', batchId: 'b-001', date: '2024-09-16', gravity: 1.052, tempC: 31.4, brix: 13.1 }),
  readingRow({ id: 'r-004', batchId: 'b-001', date: '2024-09-18', gravity: 1.03, tempC: 28.6, brix: 7.6 }),
  readingRow({ id: 'r-005', batchId: 'b-002', date: '2024-09-15', gravity: 1.096, tempC: 23.1, brix: 23 }),
  readingRow({ id: 'r-006', batchId: 'b-002', date: '2024-09-19', gravity: 1.04, tempC: 25.8, brix: 10.1 }),
  readingRow({ id: 'r-007', batchId: 'b-002', date: '2024-09-24', gravity: 1.006, tempC: 22.4, brix: 1.6 }),
  readingRow({ id: 'r-008', batchId: 'b-002', date: '2024-09-27', gravity: 1.002, tempC: 21.7, brix: 0.6 }),
  readingRow({ id: 'r-009', batchId: 'b-003', date: '2024-09-20', gravity: 1.09, tempC: 19.8, brix: 21.5 }),
  readingRow({ id: 'r-010', batchId: 'b-003', date: '2024-09-26', gravity: 1.02, tempC: 18.2, brix: 5.1 }),
  readingRow({ id: 'r-011', batchId: 'b-003', date: '2024-10-05', gravity: 0.994, tempC: 16.5, brix: -1.5 })
]

const OPERATIONS: Array<Omit<OperationRow, 'revision' | 'createdAt' | 'updatedAt'>> = [
  {
    id: 'op-001', batchId: 'b-001', type: '压帽', date: '2024-09-13', durationMin: 30, operator: '陈岩',
    state: '已完成', seq: 1, targetTankId: '', transferVolumeL: 0, shortfallL: 0, basisVersion: 0,
    staleDates: [], reviewNote: ''
  },
  {
    id: 'op-002', batchId: 'b-001', type: '淋皮', date: '2024-09-14', durationMin: 25, operator: '陈岩',
    state: '已完成', seq: 2, targetTankId: '', transferVolumeL: 0, shortfallL: 0, basisVersion: 0,
    staleDates: [], reviewNote: ''
  },
  {
    // 已完成倒罐：批次 b-001 曾于 9-18 完成一次倒罐后又回到 F-01（演示容量保留字段）
    id: 'op-003', batchId: 'b-001', type: '倒罐', date: '2024-09-18', durationMin: 55, operator: '林沐',
    state: '已完成', seq: 3, targetTankId: 'tk-001', transferVolumeL: 2600, shortfallL: 0, basisVersion: 3,
    staleDates: [], reviewNote: ''
  },
  {
    id: 'op-004', batchId: 'b-001', type: '倒罐', date: '2024-09-26', durationMin: 50, operator: '林沐',
    state: '待复核', seq: 4, targetTankId: 'tk-005', transferVolumeL: 2600, shortfallL: 0, basisVersion: 2,
    staleDates: ['2024-09-16'], reviewNote: '9-16 读数已改动，超温结论重算，请复核'
  },
  {
    id: 'op-005', batchId: 'b-002', type: '压帽', date: '2024-09-16', durationMin: 30, operator: '周亦',
    state: '已完成', seq: 1, targetTankId: '', transferVolumeL: 0, shortfallL: 0, basisVersion: 0,
    staleDates: [], reviewNote: ''
  },
  {
    // 已完成倒罐：保留目标罐容量
    id: 'op-006', batchId: 'b-002', type: '倒罐', date: '2024-09-21', durationMin: 60, operator: '周亦',
    state: '已完成', seq: 2, targetTankId: 'tk-002', transferVolumeL: 2000, shortfallL: 0, basisVersion: 2,
    staleDates: [], reviewNote: ''
  },
  {
    id: 'op-007', batchId: 'b-002', type: '淋皮', date: '2024-09-24', durationMin: 20, operator: '许澜',
    state: '计划', seq: 3, targetTankId: '', transferVolumeL: 0, shortfallL: 0, basisVersion: 4,
    staleDates: [], reviewNote: ''
  },
  {
    // 可转罐且容量足够：b-002（2000L，最新比重 1.002、无超温）→ F-05（3000L 空闲）
    id: 'op-008', batchId: 'b-002', type: '倒罐', date: '2024-09-30', durationMin: 60, operator: '周亦',
    state: '计划', seq: 4, targetTankId: 'tk-005', transferVolumeL: 2000, shortfallL: 0, basisVersion: 4,
    staleDates: [], reviewNote: ''
  },
  {
    // 容量不足排队：目标罐 F-06 仅 1500L，本单要 2000L → 还差 500L
    id: 'op-009', batchId: 'b-002', type: '倒罐', date: '2024-10-02', durationMin: 55, operator: '许澜',
    state: '排队', seq: 5, targetTankId: 'tk-006', transferVolumeL: 2000, shortfallL: 500, basisVersion: 4,
    staleDates: [], reviewNote: ''
  },
  {
    id: 'op-010', batchId: 'b-003', type: '倒罐', date: '2024-09-28', durationMin: 45, operator: '许澜',
    state: '已完成', seq: 1, targetTankId: '', transferVolumeL: 1400, shortfallL: 0, basisVersion: 2,
    staleDates: [], reviewNote: ''
  }
]

const MLFS: Array<Omit<MlfRow, 'revision' | 'createdAt' | 'updatedAt'>> = [
  { id: 'mlf-001', batchId: 'b-001', startDate: '', endDate: '', malicG: 2.4, state: '未启动' },
  { id: 'mlf-002', batchId: 'b-002', startDate: '2024-09-26', endDate: '', malicG: 0.9, state: '进行中' },
  { id: 'mlf-003', batchId: 'b-003', startDate: '2024-09-29', endDate: '2024-10-06', malicG: 0.2, state: '已完成' }
]

const TASTINGS: Array<Omit<TastingRow, 'revision' | 'createdAt' | 'updatedAt'>> = [
  {
    id: 'ts-001',
    batchId: 'b-001',
    date: '2024-09-19',
    aroma: '黑醋栗与青椒，果香集中',
    tannin: '单宁紧实，收口略涩',
    acidity: '酸度中高，骨架清晰',
    verdict: '待定'
  },
  {
    id: 'ts-002',
    batchId: 'b-002',
    date: '2024-09-28',
    aroma: '李子与雪松，带轻微还原味',
    tannin: '单宁柔顺',
    acidity: '酸度偏低，需补酸',
    verdict: '需调配'
  },
  {
    id: 'ts-003',
    batchId: 'b-003',
    date: '2024-10-08',
    aroma: '白桃与柠檬皮，香气干净',
    tannin: '几乎无单宁',
    acidity: '酸度明亮，平衡良好',
    verdict: '可直接装瓶'
  }
]

/** 按当前读数生成趋势快照 */
function buildTrendRows(
  readings: Array<Omit<ReadingRow, 'revision' | 'createdAt' | 'updatedAt'>>,
  batches: Array<Omit<BatchRow, 'revision' | 'createdAt' | 'updatedAt'>>
): Array<Omit<TrendRow, 'revision' | 'createdAt' | 'updatedAt'>> {
  const byBatch = new Map<string, ReadingRow[]>()
  for (const row of readings) {
    const list = byBatch.get(row.batchId) ?? []
    list.push(row as ReadingRow)
    byBatch.set(row.batchId, list)
  }
  const versionOf = new Map(batches.map((batch) => [batch.id, batch.readingVersion]))
  const rows: Array<Omit<TrendRow, 'revision' | 'createdAt' | 'updatedAt'>> = []
  for (const [batchId, list] of byBatch) {
    const derived = deriveTrend(list)
    rows.push({
      id: `trend-${batchId}`,
      batchId,
      readingVersion: versionOf.get(batchId) ?? 1,
      dates: derived.dates,
      points: derived.points,
      stuckDates: derived.stuckDates,
      overTempDates: derived.overTempDates,
      rackable: derived.rackable,
      rackableReasons: derived.rackableReasons,
      latestGravity: derived.latestGravity
    })
  }
  return rows
}

const TRENDS = buildTrendRows(READINGS, BATCHES)

/** 可追溯流水样例 */
function audit(
  base: Omit<AuditRow, 'id' | 'revision' | 'createdAt' | 'updatedAt' | 'beforeJson' | 'afterJson'> &
    Partial<Pick<AuditRow, 'beforeJson' | 'afterJson'>>
): Omit<AuditRow, 'revision' | 'createdAt' | 'updatedAt'> {
  return {
    ...base,
    id: `audit-${base.batchId}-${base.action}-${Math.random().toString(36).slice(2, 8)}`,
    beforeJson: base.beforeJson ?? 'null',
    afterJson: base.afterJson ?? 'null'
  }
}

const AUDIT_LOGS: Array<Omit<AuditRow, 'revision' | 'createdAt' | 'updatedAt'>> = [
  audit({
    batchId: 'b-001',
    readingVersion: 2,
    action: '读数改动',
    dates: ['2024-09-14'],
    operationIds: [],
    message: '补录 9-14 温度读数，温度 26.8 → 27.2（v2）'
  }),
  audit({
    batchId: 'b-001',
    readingVersion: 4,
    action: '工单失效',
    dates: ['2024-09-16', '2024-09-18'],
    operationIds: ['op-004'],
    message: '倒罐工单 2024-09-26 依据过期，退回复核'
  }),
  audit({
    batchId: 'b-002',
    readingVersion: 4,
    action: '工单保存',
    dates: [],
    operationIds: ['op-008'],
    message: '倒罐工单 2024-09-30 → F-05 已确认（2000L）'
  }),
  audit({
    batchId: 'b-002',
    readingVersion: 4,
    action: '容量排队',
    dates: [],
    operationIds: [],
    message: '目标罐 F-06 容量紧张，后到工单需排队等待'
  })
]

/** 灌入演示数据（地块 → 罐 → 批次 → 读数/作业/苹乳/品评 + 趋势/流水） */
export async function seedDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.parcels,
      db.tanks,
      db.batches,
      db.readings,
      db.operations,
      db.mlfs,
      db.tastings,
      db.trends,
      db.auditlogs
    ],
    async () => {
      await db.parcels.bulkPut(PARCELS.map(rev))
      await db.tanks.bulkPut(TANKS.map(rev))
      await db.batches.bulkPut(BATCHES.map(rev))
      await db.readings.bulkPut(READINGS.map(rev))
      await db.operations.bulkPut(OPERATIONS.map(rev))
      await db.mlfs.bulkPut(MLFS.map(rev))
      await db.tastings.bulkPut(TASTINGS.map(rev))
      await db.trends.bulkPut(TRENDS.map(rev))
      await db.auditlogs.bulkPut(AUDIT_LOGS.map(rev))
    }
  )
}
