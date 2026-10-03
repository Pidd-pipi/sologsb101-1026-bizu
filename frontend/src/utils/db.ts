/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名 gbwinetank-db，数据结构版本号 version(3) 与 upgrade() 迁移逻辑
 * - 地块 / 发酵罐 / 入罐批次 / 发酵读数 / 作业 / 苹乳 / 品评 / 变更日志 / 批次数据版本 九张表分表存储
 * - 读数表带 &[batchId+date] 唯一索引：同批次同日只留一条；v2 迁移先去重，v3 再加唯一索引
 * - 读数与工单行带数据版本号 version，批次级版本号存 batchVersions，供跨窗口乐观锁
 * - 首次打开自动播种互相引用的演示数据，保证每个页面打开都有内容
 * - 纯前端应用：不依赖任何后端或数据库服务
 */
import Dexie, { type Table } from 'dexie'
import type { Parcel } from '../types/parcel'
import type { Tank } from '../types/tank'
import type { Batch } from '../types/batch'
import type { Reading } from '../types/reading'
import type { Operation } from '../types/operation'
import type { Mlf } from '../types/mlf'
import type { Tasting } from '../types/tasting'
import type { ChangeLog, BatchVersion } from '../types/changeLog'
import { nowIso } from './uuid'
import { seedDatabase } from './seed'

/** 数据库名 */
export const DB_NAME = 'gbwinetank-db'

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 3

/** 行结构修订号，便于后续按行迁移 */
export const ROW_REVISION = 2

/** 带时间戳与修订号的持久化实体 */
export interface Revisioned {
  revision: number
  createdAt: number
  updatedAt: number
}

/** 数据版本号：读数与工单每次变更 +1，跨窗口保存冲突检测用 */
export interface Versioned {
  version: number
}

export type ParcelRow = Parcel & Revisioned
export type TankRow = Tank & Revisioned
export type BatchRow = Batch & Revisioned
export type ReadingRow = Reading & Revisioned & Versioned
export type OperationRow = Operation & Revisioned & Versioned
export type MlfRow = Mlf & Revisioned
export type TastingRow = Tasting & Revisioned
export type ChangeLogRow = ChangeLog & Revisioned
export type BatchVersionRow = BatchVersion

const ALL_TABLES = [
  'parcels',
  'tanks',
  'batches',
  'readings',
  'operations',
  'mlfs',
  'tastings',
  'changeLogs',
  'batchVersions'
] as const

class GbWineTankDatabase extends Dexie {
  parcels!: Table<ParcelRow, string>
  tanks!: Table<TankRow, string>
  batches!: Table<BatchRow, string>
  readings!: Table<ReadingRow, string>
  operations!: Table<OperationRow, string>
  mlfs!: Table<MlfRow, string>
  tastings!: Table<TastingRow, string>
  changeLogs!: Table<ChangeLogRow, string>
  batchVersions!: Table<BatchVersionRow, string>

  constructor() {
    super(DB_NAME)

    this.version(1)
      .stores({
        parcels: 'id, name, variety, aspect, updatedAt',
        tanks: 'id, code, material, tempControl, state, updatedAt',
        batches: 'id, parcelId, tankId, state, harvestDate, updatedAt',
        readings: 'id, batchId, date, updatedAt',
        operations: 'id, batchId, type, state, date, seq, updatedAt',
        mlfs: 'id, batchId, state, updatedAt',
        tastings: 'id, batchId, date, verdict, updatedAt'
      })
      .upgrade(async (tx) => {
        // 结构迁移：为历史行补齐行修订号与时间戳；新建库时各表为空，迁移天然幂等
        for (const name of ['parcels', 'tanks', 'batches', 'readings', 'operations', 'mlfs', 'tastings']) {
          await tx
            .table(name)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              row.revision = ROW_REVISION
              if (typeof row.createdAt !== 'number') row.createdAt = Date.now()
              if (typeof row.updatedAt !== 'number') row.updatedAt = row.createdAt
            })
        }
      })

    this.version(2)
      .stores({
        // 新增变更日志与批次数据版本表（读数 → 趋势 → 工单的可追溯版本链）
        changeLogs: 'id, batchId, entity, entityId, action, date, batchVersion, at',
        batchVersions: 'batchId, updatedAt'
      })
      .upgrade(async (tx) => {
        // 1) 读数去重：同批次同日保留 updatedAt 最新的一条，为 v3 的唯一索引做准备
        const readings = (await tx.table('readings').toArray()) as Array<Record<string, unknown>>
        const latestByKey = new Map<string, Record<string, unknown>>()
        const duplicateIds: string[] = []
        for (const row of readings) {
          const key = `${String(row.batchId)}::${String(row.date)}`
          const prev = latestByKey.get(key)
          if (!prev) {
            latestByKey.set(key, row)
            continue
          }
          const prevTs = typeof prev.updatedAt === 'number' ? prev.updatedAt : 0
          const curTs = typeof row.updatedAt === 'number' ? row.updatedAt : 0
          if (curTs >= prevTs) {
            duplicateIds.push(String(prev.id))
            latestByKey.set(key, row)
          } else {
            duplicateIds.push(String(row.id))
          }
        }
        if (duplicateIds.length > 0) await tx.table('readings').bulkDelete(duplicateIds)

        // 2) 读数 / 工单补数据版本号；工单补倒罐目标罐与退回原因字段
        await tx
          .table('readings')
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (typeof row.version !== 'number') row.version = 1
          })
        await tx
          .table('operations')
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (typeof row.version !== 'number') row.version = 1
            if (typeof row.targetTankId !== 'string') row.targetTankId = ''
            if (row.invalidReason === undefined) row.invalidReason = null
          })
      })

    // v3：读数按批次 + 日期唯一（v2 已完成去重，加唯一索引不会失败）
    this.version(3).stores({
      readings: 'id, batchId, date, updatedAt, &[batchId+date]'
    })
  }
}

export const db = new GbWineTankDatabase()

/** 打开数据库：首次使用时灌入演示数据（幂等：表非空不播） */
export async function initDatabase(): Promise<void> {
  await db.open()
  if ((await db.parcels.count()) === 0) {
    await seedDatabase()
  }
}

/* ------------------------------ 地块 ------------------------------ */

export async function listParcels(): Promise<ParcelRow[]> {
  const rows = await db.parcels.toArray()
  return rows.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
}

export async function putParcel(row: ParcelRow): Promise<void> {
  await db.parcels.put(row)
}

export async function updateParcel(id: string, patch: Partial<Parcel>): Promise<void> {
  await db.parcels.update(id, { ...patch, updatedAt: Date.now() } as never)
}

/** 删除地块：级联删除其下批次及批次的读数/作业/苹乳/品评，并释放罐位 */
export async function removeParcel(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.parcels, db.batches, db.readings, db.operations, db.mlfs, db.tastings, db.tanks, db.changeLogs, db.batchVersions],
    async () => {
      const batches = await db.batches.where('parcelId').equals(id).toArray()
      for (const batch of batches) {
        await cascadeRemoveBatch(batch.id)
      }
      await db.parcels.delete(id)
    }
  )
}

/* ------------------------------ 发酵罐 ------------------------------ */

export async function listTanks(): Promise<TankRow[]> {
  const rows = await db.tanks.toArray()
  return rows.sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'))
}

export async function putTank(row: TankRow): Promise<void> {
  await db.tanks.put(row)
}

export async function updateTank(id: string, patch: Partial<Tank>): Promise<void> {
  await db.tanks.update(id, { ...patch, updatedAt: Date.now() } as never)
}

export async function removeTank(id: string): Promise<void> {
  const active = await db.batches.where('tankId').equals(id).filter((b) => b.state !== '已出罐').count()
  if (active > 0) {
    throw new Error('该罐仍有在罐批次，请先出罐或改绑其它罐位')
  }
  await db.transaction('rw', db.tanks, db.batches, async () => {
    await db.batches.where('tankId').equals(id).modify({ tankId: '', updatedAt: Date.now() })
    await db.tanks.delete(id)
  })
}

/* ------------------------------ 入罐批次 ------------------------------ */

export async function listBatches(): Promise<BatchRow[]> {
  const rows = await db.batches.toArray()
  return rows.sort((a, b) => b.harvestDate.localeCompare(a.harvestDate))
}

export async function putBatch(row: BatchRow): Promise<void> {
  await db.batches.put(row)
}

export async function updateBatch(id: string, patch: Partial<Batch>): Promise<void> {
  await db.batches.update(id, { ...patch, updatedAt: Date.now() } as never)
}

/** 内部级联删除：清掉批次下属全部子表数据（含版本链日志） */
async function cascadeRemoveBatch(batchId: string): Promise<void> {
  await db.readings.where('batchId').equals(batchId).delete()
  await db.operations.where('batchId').equals(batchId).delete()
  await db.mlfs.where('batchId').equals(batchId).delete()
  await db.tastings.where('batchId').equals(batchId).delete()
  await db.changeLogs.where('batchId').equals(batchId).delete()
  await db.batchVersions.delete(batchId)
  const batch = await db.batches.get(batchId)
  if (batch && batch.tankId) {
    await db.tanks.update(batch.tankId, { state: '空闲', updatedAt: Date.now() } as never)
  }
  await db.batches.delete(batchId)
}

export async function removeBatch(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.batches, db.readings, db.operations, db.mlfs, db.tastings, db.tanks, db.changeLogs, db.batchVersions],
    async () => {
      await cascadeRemoveBatch(id)
    }
  )
}

/** 出罐：批次置为已出罐并自动释放罐位 */
export async function shipBatch(id: string): Promise<void> {
  await db.transaction('rw', db.batches, db.tanks, async () => {
    const batch = await db.batches.get(id)
    if (!batch) throw new Error('批次不存在')
    if (batch.tankId) {
      await db.tanks.update(batch.tankId, { state: '空闲', updatedAt: Date.now() } as never)
    }
    await db.batches.update(id, { state: '已出罐', updatedAt: Date.now() } as never)
  })
}

/** 校验罐位是否可以分配给指定批次 */
export async function assertTankAssignable(tankId: string, batchId: string | null): Promise<void> {
  const tank = await db.tanks.get(tankId)
  if (!tank) throw new Error('发酵罐不存在')
  if (tank.state === '清洗中') throw new Error(`罐 ${tank.code} 正在清洗中，暂不可分配`)
  const occupants = await db.batches
    .where('tankId')
    .equals(tankId)
    .filter((b) => b.state !== '已出罐' && b.id !== batchId)
    .toArray()
  if (occupants.length > 0) {
    throw new Error(`罐 ${tank.code} 已被批次占用，禁止重复分配`)
  }
}

/* ------------------------------ 发酵读数 ------------------------------ */

export async function listReadings(): Promise<ReadingRow[]> {
  const rows = await db.readings.toArray()
  return rows.sort((a, b) => a.date.localeCompare(b.date))
}

/* -------------------------------- 作业 -------------------------------- */

export async function listOperations(): Promise<OperationRow[]> {
  const rows = await db.operations.toArray()
  return rows.sort((a, b) => a.seq - b.seq || a.date.localeCompare(b.date))
}

/** 某个批次现有作业的最大序号 */
export async function nextOperationSeq(batchId: string): Promise<number> {
  const rows = await db.operations.where('batchId').equals(batchId).toArray()
  return rows.reduce((max, row) => Math.max(max, row.seq), 0) + 1
}

/* ------------------------------ 变更日志 ------------------------------ */

export async function listChangeLogs(): Promise<ChangeLogRow[]> {
  const rows = await db.changeLogs.toArray()
  return rows.sort((a, b) => b.at - a.at)
}

/* ------------------------------ 苹乳发酵 ------------------------------ */

export async function listMlfs(): Promise<MlfRow[]> {
  return db.mlfs.toArray()
}

export async function putMlf(row: MlfRow): Promise<void> {
  await db.mlfs.put(row)
}

export async function updateMlf(id: string, patch: Partial<Mlf>): Promise<void> {
  await db.mlfs.update(id, { ...patch, updatedAt: Date.now() } as never)
}

export async function removeMlf(id: string): Promise<void> {
  await db.mlfs.delete(id)
}

/* ------------------------------ 品评调配 ------------------------------ */

export async function listTastings(): Promise<TastingRow[]> {
  const rows = await db.tastings.toArray()
  return rows.sort((a, b) => b.date.localeCompare(a.date))
}

export async function putTasting(row: TastingRow): Promise<void> {
  await db.tastings.put(row)
}

export async function updateTasting(id: string, patch: Partial<Tasting>): Promise<void> {
  await db.tastings.update(id, { ...patch, updatedAt: Date.now() } as never)
}

export async function removeTasting(id: string): Promise<void> {
  await db.tastings.delete(id)
}

/* --------------------------- 整库导入导出 --------------------------- */

export interface DatabaseSnapshot {
  name: string
  schemaVersion: number
  exportedAt: string
  parcels: Parcel[]
  tanks: Tank[]
  batches: Batch[]
  readings: Reading[]
  operations: Operation[]
  mlfs: Mlf[]
  tastings: Tasting[]
  /** v2 起新增：变更日志与批次数据版本（旧备份可缺省） */
  changeLogs?: ChangeLog[]
  batchVersions?: BatchVersion[]
}

function stripRow<T extends Revisioned>(row: T): Omit<T, keyof Revisioned> {
  const copy = { ...row } as Record<string, unknown>
  delete copy.revision
  delete copy.createdAt
  delete copy.updatedAt
  return copy as Omit<T, keyof Revisioned>
}

export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [parcels, tanks, batches, readings, operations, mlfs, tastings, changeLogs, batchVersions] =
    await Promise.all([
      db.parcels.toArray(),
      db.tanks.toArray(),
      db.batches.toArray(),
      db.readings.toArray(),
      db.operations.toArray(),
      db.mlfs.toArray(),
      db.tastings.toArray(),
      db.changeLogs.toArray(),
      db.batchVersions.toArray()
    ])
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    parcels: parcels.map(stripRow),
    tanks: tanks.map(stripRow),
    batches: batches.map(stripRow),
    readings: readings.map(stripRow),
    operations: operations.map(stripRow),
    mlfs: mlfs.map(stripRow),
    tastings: tastings.map(stripRow),
    changeLogs: changeLogs.map(stripRow),
    batchVersions
  }
}

function stamp<T>(row: T): T & Revisioned {
  return { ...row, revision: ROW_REVISION, createdAt: Date.now(), updatedAt: Date.now() }
}

export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction('rw', ALL_TABLES.map((name) => db.table(name)), async () => {
    await Promise.all(ALL_TABLES.map((name) => db.table(name).clear()))
    await db.parcels.bulkPut(snapshot.parcels.map(stamp))
    await db.tanks.bulkPut(snapshot.tanks.map(stamp))
    await db.batches.bulkPut(snapshot.batches.map(stamp))
    await db.readings.bulkPut(
      snapshot.readings.map((row) => ({ ...stamp(row), version: (row as ReadingRow).version ?? 1 }))
    )
    await db.operations.bulkPut(
      snapshot.operations.map((row) => ({
        ...stamp(row),
        version: (row as OperationRow).version ?? 1,
        targetTankId: row.targetTankId ?? '',
        invalidReason: row.invalidReason ?? null
      }))
    )
    await db.mlfs.bulkPut(snapshot.mlfs.map(stamp))
    await db.tastings.bulkPut(snapshot.tastings.map(stamp))
    await db.changeLogs.bulkPut((snapshot.changeLogs ?? []).map(stamp))
    await db.batchVersions.bulkPut(snapshot.batchVersions ?? [])
  })
}

/** 清空全部数据并重新灌入演示数据 */
export async function resetDatabase(): Promise<void> {
  await db.transaction('rw', ALL_TABLES.map((name) => db.table(name)), async () => {
    await Promise.all(ALL_TABLES.map((name) => db.table(name).clear()))
  })
  await seedDatabase()
}

/** 各表行数统计，供页脚与概览展示 */
export async function countAll(): Promise<Record<string, number>> {
  const [parcels, tanks, batches, readings, operations, mlfs, tastings, changeLogs] = await Promise.all([
    db.parcels.count(),
    db.tanks.count(),
    db.batches.count(),
    db.readings.count(),
    db.operations.count(),
    db.mlfs.count(),
    db.tastings.count(),
    db.changeLogs.count()
  ])
  return { parcels, tanks, batches, readings, operations, mlfs, tastings, changeLogs }
}
