// 每日关卡小程序 api.js 契约测试：Node 直接运行，mock 微信运行时。
// 运行：node tests/run-tests.js
// 覆盖：token 存储、Bearer 注入、401 重登重试一次、503 不重试、错误字段提取、
//       statusCode 透传、10 秒超时、ensureLogin 行为。
const assert = require('assert')

let passed = 0
let failed = 0
function ok(name) { passed += 1; console.log('  ✓ ' + name) }
function fail(name, e) { failed += 1; console.error('  ✗ ' + name + '\n      ' + ((e && e.message) || e)) }
function test(name, fn) {
  try { fn(); ok(name) } catch (e) { fail(name, e) }
}
// 异步用例串行执行，避免 mock 互相覆盖
const asyncTests = []
function atest(name, fn) { asyncTests.push({ name, fn }) }

// ---- mock wx 运行时 ----
const store = {}
let requestQueue = []   // 每次 wx.request 按序取出一个响应脚本
let uploadQueue = []    // 每次 wx.uploadFile 按序取出一个响应脚本
let loginCode = 'mock-code'
let loginCalls = 0
let capturedRequests = []
let capturedUploads = []

global.wx = {
  getStorageSync(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : '' },
  setStorageSync(k, v) { store[k] = v },
  removeStorageSync(k) { delete store[k] },
  login(o) {
    loginCalls += 1
    o && o.success && o.success({ code: loginCode })
  },
  request(opts) {
    capturedRequests.push(opts)
    const script = requestQueue.shift() || { statusCode: 200, data: {} }
    setTimeout(() => {
      if (script.fail) {
        opts.fail && opts.fail({ errMsg: script.fail })
      } else {
        opts.success && opts.success({ statusCode: script.statusCode, data: script.data })
      }
    }, 0)
  },
  uploadFile(opts) {
    capturedUploads.push(opts)
    const script = uploadQueue.shift() || { statusCode: 200, data: '{}' }
    setTimeout(() => {
      if (script.fail) {
        opts.fail && opts.fail({ errMsg: script.fail })
      } else {
        opts.success && opts.success({ statusCode: script.statusCode, data: script.data })
      }
    }, 0)
  },
  showToast() {},
  showModal() {}
}

const api = require('../utils/api.js')

function reset() {
  Object.keys(store).forEach((k) => delete store[k])
  requestQueue = []
  uploadQueue = []
  loginCalls = 0
  capturedRequests = []
  capturedUploads = []
}

// ---- 同步用例 ----
test('BASE_URL 带 5443 端口', () => {
  assert.strictEqual(api.BASE_URL, 'https://mp.hetou.vip:5443')
})

test('getToken/clearToken 读写 wx_token', () => {
  reset()
  assert.strictEqual(api.getToken(), '')
  wx.setStorageSync('wx_token', 't1')
  assert.strictEqual(api.getToken(), 't1')
  api.clearToken()
  assert.strictEqual(api.getToken(), '')
})

// ---- 异步用例 ----
atest('request 成功：GET 带 Bearer token', async () => {
  reset()
  wx.setStorageSync('wx_token', 'TOKEN_X')
  requestQueue.push({ statusCode: 200, data: { levels: [] } })
  const data = await api.request('/api/levels')
  assert.deepStrictEqual(data, { levels: [] })
  assert.strictEqual(capturedRequests[0].header.Authorization, 'Bearer TOKEN_X')
  assert.strictEqual(capturedRequests[0].url, api.BASE_URL + '/api/levels')
})

atest('request 带 10 秒超时', async () => {
  reset()
  requestQueue.push({ statusCode: 200, data: {} })
  await api.request('/api/x')
  assert.strictEqual(capturedRequests[0].timeout, 10000)
})

atest('request auth:false 不带 Authorization', async () => {
  reset()
  wx.setStorageSync('wx_token', 'TOKEN_X')
  requestQueue.push({ statusCode: 200, data: { token: 'new' } })
  await api.request('/api/auth/wx-login', { auth: false })
  assert.strictEqual(capturedRequests[0].header.Authorization, undefined)
})

atest('login 存 token，ensureLogin 有 token 不再登录', async () => {
  reset()
  loginCode = 'CODE_OK'
  requestQueue.push({ statusCode: 200, data: { token: 'LOGIN_TOKEN', user: {} } })
  await api.login()
  assert.strictEqual(api.getToken(), 'LOGIN_TOKEN')
  const t = await api.ensureLogin()
  assert.strictEqual(t, 'LOGIN_TOKEN')
  assert.strictEqual(loginCalls, 1, 'ensureLogin 不应重复调用 wx.login')
})

atest('401：清 token → 重登 → 重试一次成功', async () => {
  reset()
  wx.setStorageSync('wx_token', 'OLD')
  loginCode = 'CODE_RELOGIN'
  // 第一次业务请求 401 → 登录请求成功 → 重试业务请求成功
  requestQueue.push({ statusCode: 401, data: { error: 'login expired' } })
  requestQueue.push({ statusCode: 200, data: { token: 'FRESH' } })
  requestQueue.push({ statusCode: 200, data: { ok: true } })
  const data = await api.request('/api/levels/today')
  assert.deepStrictEqual(data, { ok: true })
  assert.strictEqual(loginCalls, 1, '应重新登录一次')
  assert.strictEqual(api.getToken(), 'FRESH')
  assert.strictEqual(capturedRequests.length, 3)
  assert.strictEqual(capturedRequests[2].header.Authorization, 'Bearer FRESH')
})

atest('401 重试后仍 401：不再重登，向上抛错（防死循环）', async () => {
  reset()
  wx.setStorageSync('wx_token', 'OLD')
  requestQueue.push({ statusCode: 401, data: { error: 'login expired' } })
  requestQueue.push({ statusCode: 200, data: { token: 'FRESH2' } })
  requestQueue.push({ statusCode: 401, data: { error: 'login expired' } })
  let err = null
  try { await api.request('/api/levels/today') } catch (e) { err = e }
  assert.ok(err, '应抛错')
  assert.strictEqual(loginCalls, 1, '只允许重登一次')
  assert.strictEqual(capturedRequests.length, 3, '业务请求只重试一次')
})

atest('503：抛"服务暂未开放"，不重登不重试', async () => {
  reset()
  wx.setStorageSync('wx_token', 'T')
  requestQueue.push({ statusCode: 503, data: { error: '微信登录未配置' } })
  let err = null
  try { await api.request('/api/levels/today') } catch (e) { err = e }
  assert.ok(err, '应抛错')
  assert.strictEqual(err.message, '服务暂未开放')
  assert.strictEqual(loginCalls, 0, '503 不应触发重登')
  assert.strictEqual(capturedRequests.length, 1, '503 不应重试')
})

atest('403/404：错误对象带 statusCode，供页面区分', async () => {
  reset()
  requestQueue.push({ statusCode: 403, data: { error: '关卡未发布' } })
  let e403 = null
  try { await api.request('/api/levels/1/submit') } catch (e) { e403 = e }
  assert.strictEqual(e403.statusCode, 403)
  assert.strictEqual(e403.message, '关卡未发布')
  requestQueue.push({ statusCode: 404, data: { error: '关卡不存在' } })
  let e404 = null
  try { await api.request('/api/levels/999/submit') } catch (e) { e404 = e }
  assert.strictEqual(e404.statusCode, 404)
})

atest('网络失败：fail 回调映射为 Error', async () => {
  reset()
  requestQueue.push({ fail: 'request:fail timeout' })
  let err = null
  try { await api.request('/api/x') } catch (e) { err = e }
  assert.ok(err)
  assert.strictEqual(err.message, 'request:fail timeout')
})

atest('getMe / updateNickname 使用资料接口并携带修改内容', async () => {
  reset()
  wx.setStorageSync('wx_token', 'TOKEN_PROFILE')
  requestQueue.push({ statusCode: 200, data: { user: { nickname: '微信用户', total_stars: 7 } } })
  const me = await api.getMe()
  assert.strictEqual(me.user.total_stars, 7)
  assert.strictEqual(capturedRequests[0].url, api.BASE_URL + '/api/auth/wx-me')
  assert.strictEqual(capturedRequests[0].header.Authorization, 'Bearer TOKEN_PROFILE')

  requestQueue.push({ statusCode: 200, data: { user: { nickname: '新昵称' } } })
  await api.updateNickname('新昵称')
  assert.strictEqual(capturedRequests[1].method, 'PUT')
  assert.strictEqual(capturedRequests[1].url, api.BASE_URL + '/api/auth/wx-profile')
  assert.deepStrictEqual(capturedRequests[1].data, { nickname: '新昵称' })
})

atest('uploadAvatar：multipart 字段、Bearer、10 秒超时及 JSON 解析', async () => {
  reset()
  wx.setStorageSync('wx_token', 'TOKEN_UPLOAD')
  uploadQueue.push({ statusCode: 200, data: JSON.stringify({ user: { avatar: 'https://signed/avatar.jpg' } }) })
  const data = await api.uploadAvatar('/tmp/avatar.jpg')
  assert.strictEqual(data.user.avatar, 'https://signed/avatar.jpg')
  assert.strictEqual(capturedUploads.length, 1)
  assert.strictEqual(capturedUploads[0].name, 'avatar')
  assert.strictEqual(capturedUploads[0].filePath, '/tmp/avatar.jpg')
  assert.strictEqual(capturedUploads[0].header.Authorization, 'Bearer TOKEN_UPLOAD')
  assert.strictEqual(capturedUploads[0].timeout, 10000)
})

atest('uploadAvatar：401 重登后仅重试一次', async () => {
  reset()
  wx.setStorageSync('wx_token', 'OLD_UPLOAD')
  uploadQueue.push({ statusCode: 401, data: JSON.stringify({ error: 'login expired' }) })
  requestQueue.push({ statusCode: 200, data: { token: 'FRESH_UPLOAD' } })
  uploadQueue.push({ statusCode: 200, data: JSON.stringify({ user: { avatar: 'ok' } }) })
  const data = await api.uploadAvatar('/tmp/avatar.png')
  assert.strictEqual(data.user.avatar, 'ok')
  assert.strictEqual(loginCalls, 1)
  assert.strictEqual(capturedUploads.length, 2)
  assert.strictEqual(capturedUploads[1].header.Authorization, 'Bearer FRESH_UPLOAD')
})

atest('uploadAvatar：503 和网络错误不重试', async () => {
  reset()
  uploadQueue.push({ statusCode: 503, data: JSON.stringify({ error: 'avatar storage not configured' }) })
  let unavailable = null
  try { await api.uploadAvatar('/tmp/avatar.webp') } catch (e) { unavailable = e }
  assert.strictEqual(unavailable.message, '服务暂未开放')
  assert.strictEqual(capturedUploads.length, 1)
  assert.strictEqual(loginCalls, 0)

  uploadQueue.push({ fail: 'uploadFile:fail timeout' })
  let network = null
  try { await api.uploadAvatar('/tmp/avatar.webp') } catch (e) { network = e }
  assert.strictEqual(network.message, 'uploadFile:fail timeout')
  assert.strictEqual(capturedUploads.length, 2)
})

atest('答题页进入时恢复最近一次已选答案', async () => {
  reset()
  wx.setStorageSync('wx_token', 'TOKEN_CHALLENGE')
  const pagePath = require.resolve('../pages/challenge/challenge.js')
  delete require.cache[pagePath]
  let definition = null
  global.Page = (value) => { definition = value }
  require(pagePath)
  delete global.Page
  const page = {
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(update) { this.data = Object.assign({}, this.data, update) }
  }
  page.data.lang = 'de'
  page.data.level = 'A1'
  requestQueue.push({
    statusCode: 200,
    data: {
      challenge: {
        id: 9,
        day: '2026-11-24',
        items: [
          { seq: 1, kind: 'word', prompt: { options: ['A', 'B'] } },
          { seq: 2, kind: 'grammar', prompt: { options: ['C', 'D'] } }
        ]
      },
      attempt: { answers: [{ seq: 2, value: 'D' }], stars: 0, best_stars: 2 }
    }
  })
  await definition.load.call(page, '2026-11-24')
  assert.strictEqual(page.data.items[0].selectedIndex, -1)
  assert.strictEqual(page.data.items[0].selected, '')
  assert.strictEqual(page.data.items[1].selectedIndex, 1)
  assert.strictEqual(page.data.items[1].selected, 'D')
  assert.strictEqual(page.data.attempt.best_stars, 2)
})

atest('首页日历优先 checked_in，并兼容旧 passed 字段', () => {
  const pagePath = require.resolve('../pages/index/index.js')
  delete require.cache[pagePath]
  let definition = null
  global.Page = (value) => { definition = value }
  require(pagePath)
  delete global.Page
  const cells = definition.buildCells('2026-11', [
    { day: '2026-11-01', checked_in: true, passed: false },
    { day: '2026-11-02', passed: true },
    { day: '2026-11-03', checked_in: false, passed: false }
  ])
  const byKey = {}
  cells.forEach((cell) => { byKey[cell.key] = cell.checkedIn })
  assert.strictEqual(byKey['2026-11-01'], true)
  assert.strictEqual(byKey['2026-11-02'], true)
  assert.strictEqual(byKey['2026-11-03'], false)
})

;(async () => {
  console.log('\n每日关卡 api.js 契约测试\n' + '='.repeat(32))
  for (const t of asyncTests) {
    try { await t.fn(); ok(t.name) } catch (e) { fail(t.name, e) }
  }
  console.log('\n' + '='.repeat(32))
  console.log('通过 ' + passed + ' / ' + (passed + failed) + ' 项测试')
  if (failed > 0) {
    console.error('失败 ' + failed + ' 项 ✗')
    process.exit(1)
  } else {
    console.log('全部通过 ✓')
  }
})()
