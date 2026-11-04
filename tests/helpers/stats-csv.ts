import type { CsvFileHandle } from '../../src/features/player-stats/csv-sources'

export const HEADER =
  'Day,Month,Year,Hour,Min,Sec,mode,Time,BBBV,BBBVs,style,cell0,cell1,cell2,cell3,cell4,cell5,cell6,cell7,cell8,Lcl,Rcl,Dcl,Leff,Reff,Deff,Openings,Islands,Path,GZiNi,HZiNi'

export function csv(...times: number[]): string {
  const rows = times.map((time) =>
    `2,8,2024,16,1,12,BEG,${(time / 1000).toFixed(3)},12,2.40,Flag,19,21,10,4,0,0,0,0,0,12,3,3,12,1,3,3,3,992,12,12`,
  )
  return [HEADER, ...rows].join('\n')
}

export const CSV = csv(5000)

export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

/** 可控制文件内容、读取时机和权限，驱动真实的会话与视图逻辑。 */
export class CsvTestHandle implements CsvFileHandle {
  reads = 0
  permission: PermissionState = 'granted'
  requestResult: PermissionState = 'granted'
  gate: Promise<File> | null = null
  size: number | null = null

  constructor(public name: string, public text: string, public key = name) {}

  async getFile(): Promise<File> {
    this.reads += 1
    return this.gate ?? this.file()
  }

  file(): File {
    const text = this.text
    return {
      name: this.name,
      size: this.size ?? text.length,
      lastModified: 1,
      text: async () => text,
    } as unknown as File
  }

  async isSameEntry(other: CsvFileHandle): Promise<boolean> {
    return (other as CsvTestHandle).key === this.key
  }

  async queryPermission(): Promise<PermissionState> {
    return this.permission
  }

  async requestPermission(): Promise<PermissionState> {
    this.permission = this.requestResult
    return this.requestResult
  }
}
