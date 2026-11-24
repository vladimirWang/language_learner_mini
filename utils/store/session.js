// 全局会话 store（微信原生单例，不引入第三方状态库）。
// 方案 §4.4：初始状态固定为 de/A1；服务端 user 的 level 才是权威值。

function initialState() {
  return { lang: 'de', level: 'A1', userId: 0, openid: '', user: null, ready: false }
}

let state = initialState()
const listeners = []

function notify() {
  listeners.slice().forEach((listener) => {
    try { listener(getState()) } catch (e) { /* 单个页面监听异常不影响其他页面 */ }
  })
}

function getState() {
  return Object.assign({}, state)
}

function setLevel(level) {
  if (!level || level === state.level) return
  state = Object.assign({}, state, { level: level })
  try { wx.setStorageSync('challenge_level', level) } catch (e) { /* 忽略存储异常 */ }
  notify()
}

function setUser(user) {
  const next = user || null
  const level = (next && next.level) || state.level
  state = Object.assign({}, state, {
    userId: next ? (next.id || 0) : 0,
    openid: next ? (next.openid || '') : '',
    user: next,
    level: level,
    ready: true
  })
  try {
    wx.setStorageSync('challenge_lang', 'de')
    wx.setStorageSync('challenge_level', level)
  } catch (e) { /* 忽略存储异常 */ }
  notify()
}

function subscribe(listener) {
  if (typeof listener !== 'function') return () => {}
  listeners.push(listener)
  return function unsubscribe() {
    const index = listeners.indexOf(listener)
    if (index >= 0) listeners.splice(index, 1)
  }
}

function clear() {
  state = initialState()
  try { wx.removeStorageSync('challenge_level') } catch (e) { /* 忽略存储异常 */ }
  notify()
}

module.exports = {
  getState: getState,
  setUser: setUser,
  setLevel: setLevel,
  subscribe: subscribe,
  clear: clear
}
