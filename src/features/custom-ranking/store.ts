import { getDb } from '../../shared/db'
import { normalizeStoredConfig } from './config'
import {
  DEFAULT_RANK_META,
  RANK_STRATEGY_VERSION,
  type GlobalRankDataset,
  type GlobalRankMeta,
  type GlobalRankTask,
  type GlobalRankTaskChunk,
  type GlobalRankVideoRow,
  type RankConfig,
} from './model'

export function chunkKey(index: number): string {
  return String(index).padStart(8, '0')
}

export async function getRankingMeta(baseUrl: string): Promise<GlobalRankMeta> {
  const db = await getDb()
  const stored = await db.get('globalRankMeta', baseUrl)
  const defaults = DEFAULT_RANK_META(baseUrl)
  if (!stored) return defaults
  return {
    ...defaults,
    ...stored,
    key: baseUrl,
    startId: asRangeId(stored.startId, defaults.startId),
    endId: asRangeId(stored.endId, defaults.endId),
    strategyVersion: Number.isSafeInteger(stored.strategyVersion)
      ? stored.strategyVersion
      : RANK_STRATEGY_VERSION,
  }
}

function asRangeId(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback
}

export async function putRankingMeta(meta: GlobalRankMeta): Promise<void> {
  const db = await getDb()
  await db.put('globalRankMeta', meta)
}

export async function getDataset(id: string): Promise<GlobalRankDataset | undefined> {
  const db = await getDb()
  return db.get('globalRankDatasets', id)
}

export async function putDataset(dataset: GlobalRankDataset): Promise<void> {
  const db = await getDb()
  await db.put('globalRankDatasets', dataset)
}

export async function listDatasetsForBase(baseUrl: string): Promise<GlobalRankDataset[]> {
  const db = await getDb()
  return db.getAllFromIndex('globalRankDatasets', 'by-base', baseUrl)
}

export async function getTask(id: string): Promise<GlobalRankTask | undefined> {
  const db = await getDb()
  return db.get('globalRankTasks', id)
}

export async function putTask(task: GlobalRankTask): Promise<void> {
  const db = await getDb()
  await db.put('globalRankTasks', task)
}

export async function getTaskForDataset(datasetId: string): Promise<GlobalRankTask | undefined> {
  const db = await getDb()
  const tasks = await db.getAllFromIndex('globalRankTasks', 'by-dataset', datasetId)
  return tasks.sort((left, right) => right.startedAt - left.startedAt)[0]
}

export async function listTasks(): Promise<GlobalRankTask[]> {
  const db = await getDb()
  const tasks = await db.getAll('globalRankTasks')
  return tasks.sort((left, right) => right.updatedAt - left.updatedAt)
}

export async function putTaskChunks(
  taskId: string,
  kind: GlobalRankTaskChunk['kind'],
  chunks: number[][],
): Promise<void> {
  if (chunks.length === 0) return
  const db = await getDb()
  const tx = db.transaction('globalRankTaskChunks', 'readwrite')
  for (const [index, items] of chunks.entries()) {
    void tx.store.put({
      taskId,
      kind,
      chunkId: chunkKey(index),
      items,
    })
  }
  await tx.done
}

export async function getTaskChunk(
  taskId: string,
  kind: GlobalRankTaskChunk['kind'],
  index: number,
): Promise<GlobalRankTaskChunk | undefined> {
  const db = await getDb()
  return db.get('globalRankTaskChunks', [taskId, kind, chunkKey(index)])
}

export async function getVideoRow(
  datasetId: string,
  videoId: number,
): Promise<GlobalRankVideoRow | undefined> {
  const db = await getDb()
  return db.get('globalRankVideos', [datasetId, videoId])
}

/** 同一数据集内按录像 ID 区间读取；用于区间同步和详情读取。 */
export async function getVideoRange(
  datasetId: string,
  first: number,
  count: number,
): Promise<GlobalRankVideoRow[]> {
  const db = await getDb()
  const range = IDBKeyRange.bound([datasetId, first], [datasetId, first + count - 1])
  return db.getAll('globalRankVideos', range)
}

/** 读取录像和进度的同一事务快照。每次写入新区间或补齐详情都会递增对应计数。 */
export async function scanRankingVideos(
  datasetId: string,
  visit: (row: GlobalRankVideoRow) => boolean | void,
  options: { playerId?: number; version?: string } = {},
): Promise<string> {
  const db = await getDb()
  const tx = db.transaction(['globalRankDatasets', 'globalRankVideos'])
  const dataset = await tx.objectStore('globalRankDatasets').get(datasetId)
  const version = dataset ? `${dataset.intervalDone}:${dataset.detailCount}` : null
  if (version === null || (options.version !== undefined && options.version !== version)) {
    throw new Error('本次计算的数据已变更或清除，请重新计算排行榜')
  }
  const index = tx.objectStore('globalRankVideos').index('by-dataset-player')
  const range = options.playerId === undefined
    ? IDBKeyRange.bound([datasetId, 1], [datasetId, Number.MAX_SAFE_INTEGER])
    : IDBKeyRange.only([datasetId, options.playerId])
  let cursor = await index.openCursor(range)
  while (cursor && visit(cursor.value) !== false) cursor = await cursor.continue()
  await tx.done
  return version
}

export async function getVideosByDetailState(
  datasetId: string,
  state: GlobalRankVideoRow['detailState'],
): Promise<GlobalRankVideoRow[]> {
  const db = await getDb()
  return db.getAllFromIndex('globalRankVideos', 'by-dataset-detail', [datasetId, state])
}

/** 按玩家索引游标收集本数据集出现过的玩家 ID，不组装全部录像数组。 */
export async function getDatasetPlayerIds(datasetId: string): Promise<number[]> {
  const db = await getDb()
  const tx = db.transaction('globalRankVideos')
  const range = IDBKeyRange.bound(
    [datasetId, 1],
    [datasetId, Number.MAX_SAFE_INTEGER],
  )
  const players = new Set<number>()
  let cursor = await tx.store.index('by-dataset-player').openCursor(range)
  while (cursor) {
    players.add(cursor.value.playerId)
    cursor = await cursor.continue()
  }
  await tx.done
  return [...players].sort((left, right) => left - right)
}

export async function putConfig(config: RankConfig): Promise<void> {
  const db = await getDb()
  await db.put('globalRankConfigs', config)
}

export async function listConfigs(): Promise<RankConfig[]> {
  const db = await getDb()
  const configs = await db.getAll('globalRankConfigs')
  return configs
    .map((config) => normalizeStoredConfig(config))
    .sort((left, right) => right.updatedAt - left.updatedAt)
}

export async function deleteConfig(id: string): Promise<void> {
  const db = await getDb()
  await db.delete('globalRankConfigs', id)
}

/** 原子发布：数据集状态、任务状态和当前指针必须在同一事务提交。 */
export async function publishRankingDataset(
  dataset: GlobalRankDataset,
  task: GlobalRankTask,
  ready: boolean,
): Promise<GlobalRankMeta> {
  const db = await getDb()
  const tx = db.transaction(
    ['globalRankDatasets', 'globalRankTasks', 'globalRankMeta'],
    'readwrite',
  )
  const storedTask = await tx.objectStore('globalRankTasks').get(task.id)
  if (!storedTask || storedTask.runToken !== task.runToken) {
    throw new Error('排行榜任务已失效，拒绝发布旧数据')
  }
  const current =
    (await tx.objectStore('globalRankMeta').get(dataset.baseUrl)) ??
    DEFAULT_RANK_META(dataset.baseUrl)
  const now = Date.now()
  const next: GlobalRankMeta = {
    ...current,
    key: dataset.baseUrl,
    latestDatasetId: dataset.id,
    readyDatasetId: ready ? dataset.id : current.readyDatasetId,
    readyAt: ready ? now : current.readyAt,
    updatedAt: now,
    revision: current.revision + 1,
  }
  await tx.objectStore('globalRankDatasets').put(dataset)
  await tx.objectStore('globalRankTasks').put(task)
  await tx.objectStore('globalRankMeta').put(next)
  await tx.done
  return next
}

export async function deleteDataset(datasetId: string): Promise<void> {
  const db = await getDb()
  const tx = db.transaction(
    ['globalRankDatasets', 'globalRankVideos', 'globalRankTasks', 'globalRankTaskChunks'],
    'readwrite',
  )
  const videoRange = IDBKeyRange.bound(
    [datasetId, 1],
    [datasetId, Number.MAX_SAFE_INTEGER],
  )
  const videoKeys = await tx.objectStore('globalRankVideos').getAllKeys(videoRange)
  for (const key of videoKeys) void tx.objectStore('globalRankVideos').delete(key)
  const tasks = await tx.objectStore('globalRankTasks').index('by-dataset').getAll(datasetId)
  for (const task of tasks) {
    const chunks = await tx.objectStore('globalRankTaskChunks').index('by-task').getAllKeys(task.id)
    for (const key of chunks) void tx.objectStore('globalRankTaskChunks').delete(key)
    void tx.objectStore('globalRankTasks').delete(task.id)
  }
  void tx.objectStore('globalRankDatasets').delete(datasetId)
  await tx.done
}

export async function clearGlobalRankingData(): Promise<void> {
  const db = await getDb()
  const tx = db.transaction(
    [
      'globalRankDatasets',
      'globalRankVideos',
      'globalRankTasks',
      'globalRankTaskChunks',
      'globalRankConfigs',
      'globalRankMeta',
    ],
    'readwrite',
  )
  await Promise.all([
    tx.objectStore('globalRankDatasets').clear(),
    tx.objectStore('globalRankVideos').clear(),
    tx.objectStore('globalRankTasks').clear(),
    tx.objectStore('globalRankTaskChunks').clear(),
    tx.objectStore('globalRankConfigs').clear(),
    tx.objectStore('globalRankMeta').clear(),
  ])
  await tx.done
}

/** 清空全站录像缓存，保留用户保存的范围、当前配置和排行榜配置。 */
export async function clearRankingCache(): Promise<void> {
  const db = await getDb()
  const metas = await db.getAll('globalRankMeta')
  const tx = db.transaction(
    [
      'globalRankDatasets',
      'globalRankVideos',
      'globalRankTasks',
      'globalRankTaskChunks',
      'globalRankMeta',
    ],
    'readwrite',
  )
  await Promise.all([
    tx.objectStore('globalRankDatasets').clear(),
    tx.objectStore('globalRankVideos').clear(),
    tx.objectStore('globalRankTasks').clear(),
    tx.objectStore('globalRankTaskChunks').clear(),
    tx.objectStore('globalRankMeta').clear(),
  ])
  const now = Date.now()
  for (const meta of metas) {
    await tx.objectStore('globalRankMeta').put({
      ...meta,
      readyDatasetId: null,
      latestDatasetId: null,
      readyAt: 0,
      updatedAt: now,
      revision: (meta.revision ?? 0) + 1,
    })
  }
  await tx.done
}

/** 删除未完成数据集后，把“最近数据集”指回上一份成功快照。 */
export async function restoreLatestToReady(baseUrl: string): Promise<GlobalRankMeta> {
  const db = await getDb()
  const tx = db.transaction('globalRankMeta', 'readwrite')
  const current = (await tx.store.get(baseUrl)) ?? DEFAULT_RANK_META(baseUrl)
  const next: GlobalRankMeta = {
    ...current,
    key: baseUrl,
    latestDatasetId: current.readyDatasetId,
    updatedAt: Date.now(),
    revision: current.revision + 1,
  }
  await tx.store.put(next)
  await tx.done
  return next
}
