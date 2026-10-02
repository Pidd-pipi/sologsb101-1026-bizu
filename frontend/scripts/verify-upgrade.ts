/**
 * 验证 v1 旧库 → v2 自动升级：
 * 旧结构读数无版本字段、作业无倒罐工单字段，升级后应：
 * - 批次补 readingVersion
 * - 读数补 version/status
 * - 旧计划倒罐退回复核
 * - 趋势快照回填
 */
import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import Dexie from 'dexie'

const DB_NAME = 'gbwinetank-db'

async function buildV1Database(): Promise<void> {
  const old = new Dexie(DB_NAME)
  old.version(1).stores({
    parcels: 'id, name, variety, aspect, updatedAt',
    tanks: 'id, code, material, tempControl, state, updatedAt',
    batches: 'id, parcelId, tankId, state, harvestDate, updatedAt',
    readings: 'id, batchId, date, updatedAt',
    operations: 'id, batchId, type, state, date, seq, updatedAt',
    mlfs: 'id, batchId, state, updatedAt',
    tastings: 'id, batchId, date, verdict, updatedAt'
  })
  await old.table('tanks').bulkPut([
    { id: 'tk-1', code: 'F-01', material: '不锈钢', capacityL: 3000, tempControl: '夹套', state: '在用' }
  ])
  await old.table('batches').bulkPut([
    {
      id: 'b-1',
      parcelId: 'p-1',
      tankId: 'tk-1',
      harvestDate: '2024-09-12',
      volumeL: 2600,
      brix: 24,
      state: '酒精发酵',
      lastOperationAt: null
    }
  ])
  await old.table('readings').bulkPut([
    { id: 'r-1', batchId: 'b-1', date: '2024-09-12', gravity: 1.1, tempC: 24, brix: 24 },
    { id: 'r-2', batchId: 'b-1', date: '2024-09-15', gravity: 1.01, tempC: 23, brix: 2 }
  ])
  await old.table('operations').bulkPut([
    { id: 'op-1', batchId: 'b-1', type: '倒罐', date: '2024-09-20', durationMin: 40, operator: '甲', state: '计划', seq: 1 },
    { id: 'op-2', batchId: 'b-1', type: '压帽', date: '2024-09-16', durationMin: 20, operator: '乙', state: '已完成', seq: 2 }
  ])
  await old.table('parcels').bulkPut([{ id: 'p-1', name: '旧地块', variety: '赤霞珠', areaMu: 1, vineAge: 1, aspect: '南' }])
  await old.close()
}

async function main(): Promise<void> {
  await buildV1Database()

  // 打开应用 db（单例注册到 v2），触发 upgrade
  const { db, initDatabase } = await import('../src/utils/db')
  await db.open()
  // parcels 非空，initDatabase 不会播种；但显式调用确保打开成功
  await initDatabase()

  const batch = await db.batches.get('b-1')
  assert.equal(batch.readingVersion, 0, '旧批次补 readingVersion=0（无流水基线）')

  const readings = await db.readings.where('batchId').equals('b-1').toArray()
  assert.equal(readings.length, 2)
  for (const row of readings) {
    assert.equal(row.version, 1)
    assert.equal(row.status, '有效')
    assert.equal(row.withdrawReason, '')
  }

  const racking = await db.operations.get('op-1')
  assert.equal(racking.targetTankId, 'tk-1', '已完成/计划旧倒罐默认目标罐回填为入罐罐')
  assert.equal(racking.transferVolumeL, 2600)
  assert.equal(racking.state, '待复核', '旧计划倒罐单升级后统一退回复核')

  const punch = await db.operations.get('op-2')
  assert.equal(punch.state, '已完成', '非倒罐作业状态不变')

  const trend = await db.trends.get('trend-b-1')
  assert.ok(trend, '趋势快照应回填')
  assert.equal(trend.dates.length, 2)
  assert.equal(trend.overTempDates.length, 0)
  assert.equal(trend.rackable, true, '1.01 平稳读数应可转罐')

  console.log('✓ v1 → v2 升级：版本字段回填、旧倒罐退复核、趋势快照重算全部正确')
  await db.close()
}

main().catch((err) => {
  console.error('升级验证失败：', err)
  process.exit(1)
})
