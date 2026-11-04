/**
 * File System Access API 的 Chromium 专有部分不在 TypeScript 的 lib.dom 里，
 * 这里只补上项目实际用到、且 lib.dom 尚未声明的成员。
 */

interface FilePickerAcceptTypeLike {
  description?: string
  accept: Record<string, string[]>
}

interface OpenFilePickerOptionsLike {
  id?: string
  multiple?: boolean
  excludeAcceptAllOption?: boolean
  startIn?: FileSystemHandle | string
  types?: FilePickerAcceptTypeLike[]
}

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
  showOpenFilePicker?(options?: OpenFilePickerOptionsLike): Promise<FileSystemFileHandle[]>
}
