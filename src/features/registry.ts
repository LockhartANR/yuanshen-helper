import { mountUserSearchOptions } from './user-search/options-view'
import { mountUserSearchPopup } from './user-search/popup-view'

export interface Feature {
  id: string
  name: string
  mountPopup(root: HTMLElement): void | Promise<void>
  mountOptions(root: HTMLElement): void | Promise<void>
}

export const features: Feature[] = [
  {
    id: 'user-search',
    name: '用户搜索',
    mountPopup: mountUserSearchPopup,
    mountOptions: mountUserSearchOptions,
  },
]
