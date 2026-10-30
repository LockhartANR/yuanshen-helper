/**
 * File System Access API 的 Chromium 专有部分不在 TypeScript 的 lib.dom 里，
 * 这里补上项目实际用到的两个能力。
 */

interface FileSystemHandle {
  queryPermission?(descriptor?: { mode?: 'read' | 'write' }): Promise<PermissionState>
  requestPermission?(descriptor?: { mode?: 'read' | 'write' }): Promise<PermissionState>
}

interface Window {
  showDirectoryPicker?(options?: {
    id?: string
    mode?: 'read' | 'readwrite'
    startIn?: FileSystemHandle | string
  }): Promise<FileSystemDirectoryHandle>
}
