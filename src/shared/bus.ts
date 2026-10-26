const CHANNEL = 'yuanshen-helper'

export function notifyDataChanged(): void {
  if (typeof BroadcastChannel === 'undefined') return
  const channel = new BroadcastChannel(CHANNEL)
  channel.postMessage({ type: 'data-changed' })
  channel.close()
}

export function onDataChanged(callback: () => void): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => {}
  const channel = new BroadcastChannel(CHANNEL)
  channel.onmessage = () => callback()
  return () => channel.close()
}
