// Minimal native-page substitute: initiate the real XHR/fetch before document_idle,
// then render the same replay/control selectors as the Vue page.
let fixtureSequence = 0
window.renderFixturePlayback = function () {
  const game = location.hash.split('?')[0].split('/').at(-1)
  const page = document.createElement('section')
  page.className = 'training-page'
  page.dataset.replay = 'true'
  page.innerHTML = `<div class="training-controls">难度设置</div>${game === 'missing-cell' ? ''
    : '<div class="minigame-replay-controls" data-cy="minigame-replay-controls"><button type="button">播放</button><input type="range" aria-label="回放进度"><output>0.000 / 1.234 s</output></div>'}`
  page.querySelector('button')?.addEventListener('click', (event) => {
    event.target.textContent = event.target.textContent === '播放' ? '暂停' : '播放'
  })
  document.querySelector('.training-page')?.remove()
  document.body.append(page)
}

window.loadFixturePlayback = async function (transport = 'xhr') {
  const generation = ++fixtureSequence
  document.querySelector('.training-page')?.remove()
  const route = new URL(location.hash.slice(1), location.origin)
  const game = route.pathname.split('/').at(-1)
  if (route.searchParams.has('player')) {
    const endpoint = `/api/minigame/${game}/replay?${route.searchParams}`
    if (transport === 'fetch') {
      const response = await fetch(endpoint)
      if (!response.ok) throw new Error('Native fixture replay failed')
      window.fixtureBytes = Array.from(new Uint8Array(await response.arrayBuffer()))
    } else {
      window.fixtureBytes = await new Promise((resolve, reject) => {
        const request = new XMLHttpRequest()
        request.open('GET', endpoint)
        request.responseType = 'arraybuffer'
        request.onload = () => request.status === 200
          ? resolve(Array.from(new Uint8Array(request.response))) : reject(new Error('Native fixture replay failed'))
        request.onerror = reject
        request.send()
      })
    }
  }
  if (!document.body) await new Promise((resolve) => addEventListener('DOMContentLoaded', resolve, { once: true }))
  if (generation === fixtureSequence) window.renderFixturePlayback()
}

window.switchFixturePlayback = function (hash, transport = 'xhr') {
  history.replaceState({}, '', hash)
  return window.loadFixturePlayback(transport)
}

if (new URL(location.href).searchParams.has('no-load')) {
  addEventListener('DOMContentLoaded', () => window.renderFixturePlayback(), { once: true })
} else {
  void window.loadFixturePlayback().catch((error) => { document.body.textContent = error.message })
}
