// 每日关卡小程序契约测试：Node 直接运行，mock 微信运行时。
// 运行：node tests/run-tests.js
// 覆盖：token/Bearer/401 单次重试/503/超时、全局 store、today/calendar/submit/tests 契约、
//       题型与听力映射、等级持久化、关卡页与测试页、页面注册与测试目录排除。
const assert = require('assert')
const fs = require('fs')
const path = require('path')

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
let requestQueue = []
let uploadQueue = []
let loginCode = 'mock-code'
let loginCalls = 0
let capturedRequests = []
let capturedUploads = []
let envVersion = 'release'

global.wx = {
  getAccountInfoSync() { return { miniProgram: { envVersion: envVersion } } },
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
  showModal() {},
  stopPullDownRefresh() {},
  navigateTo() {},
  reLaunch() {},
  redirectTo() {},
  getFileInfo(o) { o && o.success && o.success({ size: 1024 }) }
}

const api = require('../utils/api.js')
const session = require('../utils/store/session.js')

function reset() {
  Object.keys(store).forEach((k) => delete store[k])
  requestQueue = []
  uploadQueue = []
  loginCalls = 0
  capturedRequests = []
  capturedUploads = []
  envVersion = 'release'
  session.clear()
}

function monthKey(date) {
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0')
}

function loadPage(relativePath) {
  const pagePath = require.resolve(relativePath)
  delete require.cache[pagePath]
  let definition = null
  global.Page = (value) => { definition = value }
  const mod = require(pagePath)
  delete global.Page
  // 页面文件可导出纯函数辅助（如 buildCards/buildCells），一并挂到定义上供测试断言。
  if (definition && mod && typeof mod === 'object') {
    Object.keys(mod).forEach((key) => { definition[key] = mod[key] })
  }
  return definition
}

function pageMock(definition, extra) {
  return Object.assign({
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(update) { this.data = Object.assign({}, this.data, update) }
  }, extra || {})
}

// ---- 同步用例 ----
test('BASE_URL 线上地址带 5443 端口', () => {
  assert.strictEqual(api.PROD_BASE_URL, 'https://mp.hetou.vip:5443')
  assert.strictEqual(api.DEV_BASE_URL, 'http://127.0.0.1:8080')
})

test('getBaseUrl：develop 走本地、trial/release 走线上', () => {
  reset()
  envVersion = 'develop'
  assert.strictEqual(api.getBaseUrl(), 'http://127.0.0.1:8080')
  envVersion = 'trial'
  assert.strictEqual(api.getBaseUrl(), 'https://mp.hetou.vip:5443')
  envVersion = 'release'
  assert.strictEqual(api.getBaseUrl(), 'https://mp.hetou.vip:5443')
})

test('getBaseUrl：globalData.apiBase 覆盖优先，真机可改局域网 IP', () => {
  reset()
  envVersion = 'develop'
  const previous = global.getApp
  global.getApp = () => ({ globalData: { apiBase: 'http://192.168.3.227:8080/' } })
  try {
    assert.strictEqual(api.getBaseUrl(), 'http://192.168.3.227:8080')
  } finally {
    if (previous === undefined) delete global.getApp
    else global.getApp = previous
  }
})

test('getAccountInfoSync 缺失时按线上处理', () => {
  reset()
  const previous = global.wx.getAccountInfoSync
  delete global.wx.getAccountInfoSync
  try {
    assert.strictEqual(api.getBaseUrl(), 'https://mp.hetou.vip:5443')
  } finally {
    global.wx.getAccountInfoSync = previous
  }
})

test('getToken/clearToken 读写 wx_token', () => {
  reset()
  assert.strictEqual(api.getToken(), '')
  wx.setStorageSync('wx_token', 't1')
  assert.strictEqual(api.getToken(), 't1')
  api.clearToken()
  assert.strictEqual(api.getToken(), '')
})

test('全局 store：初始状态、setUser/setLevel、订阅可取消、clear', () => {
  reset()
  assert.deepStrictEqual(session.getState(), {
    lang: 'de', level: 'A1', userId: 0, openid: '', user: null, ready: false
  })
  let notifications = 0
  const unsubscribe = session.subscribe(() => { notifications += 1 })
  session.setLevel('B1')
  assert.strictEqual(session.getState().level, 'B1')
  assert.strictEqual(notifications, 1)
  session.setUser({ id: 7, openid: 'openid-7', level: 'A2', nickname: 'Anna' })
  assert.strictEqual(session.getState().userId, 7)
  assert.strictEqual(session.getState().openid, 'openid-7')
  assert.strictEqual(session.getState().level, 'A2')
  assert.strictEqual(session.getState().ready, true)
  assert.strictEqual(notifications, 2)
  unsubscribe()
  session.setLevel('C1')
  assert.strictEqual(notifications, 2)
  session.clear()
  assert.strictEqual(session.getState().level, 'A1')
  assert.strictEqual(session.getState().ready, false)
})

test('app.json 注册六页与关卡/测试/我的 Tab，calendar 为二级页，tests 目录不进包', () => {
  const app = JSON.parse(fs.readFileSync(path.join(__dirname, '../app.json'), 'utf8'))
  assert.deepStrictEqual(app.pages, [
    'pages/levels/levels',
    'pages/calendar/calendar',
    'pages/tests/tests',
    'pages/challenge/challenge',
    'pages/result/result',
    'pages/mine/mine'
  ])
  assert.deepStrictEqual(app.tabBar.list.map((item) => item.pagePath), [
    'pages/levels/levels',
    'pages/tests/tests',
    'pages/mine/mine'
  ])
  assert.deepStrictEqual(app.tabBar.list.map((item) => item.text), ['关卡', '测试', '我的'])
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../project.config.json'), 'utf8'))
  assert.ok(config.packOptions.ignore.some((item) => item.type === 'folder' && item.value === 'tests'))
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

atest('login 存 token 并用服务端 user 覆盖 store', async () => {
  reset()
  loginCode = 'CODE_OK'
  requestQueue.push({
    statusCode: 200,
    data: { token: 'LOGIN_TOKEN', user: { id: 7, openid: 'o7', level: 'A2' } }
  })
  await api.login()
  assert.strictEqual(api.getToken(), 'LOGIN_TOKEN')
  assert.strictEqual(session.getState().userId, 7)
  assert.strictEqual(session.getState().level, 'A2')
  const t = await api.ensureLogin()
  assert.strictEqual(t, 'LOGIN_TOKEN')
  assert.strictEqual(loginCalls, 1, 'ensureLogin 不应重复调用 wx.login')
})

atest('401：清 token → 重登 → 重试一次成功，新 user 同步 store', async () => {
  reset()
  wx.setStorageSync('wx_token', 'OLD')
  loginCode = 'CODE_RELOGIN'
  requestQueue.push({ statusCode: 401, data: { error: 'login expired' } })
  requestQueue.push({
    statusCode: 200,
    data: { token: 'FRESH', user: { id: 9, openid: 'o9', level: 'B1' } }
  })
  requestQueue.push({ statusCode: 200, data: { ok: true } })
  const data = await api.request('/api/levels/today')
  assert.deepStrictEqual(data, { ok: true })
  assert.strictEqual(loginCalls, 1)
  assert.strictEqual(api.getToken(), 'FRESH')
  assert.strictEqual(session.getState().level, 'B1')
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
  assert.ok(err)
  assert.strictEqual(loginCalls, 1)
  assert.strictEqual(capturedRequests.length, 3)
})

atest('503：抛“服务暂未开放”，不重登不重试', async () => {
  reset()
  wx.setStorageSync('wx_token', 'T')
  requestQueue.push({ statusCode: 503, data: { error: '微信登录未配置' } })
  let err = null
  try { await api.request('/api/levels/today') } catch (e) { err = e }
  assert.ok(err)
  assert.strictEqual(err.message, '服务暂未开放')
  assert.strictEqual(loginCalls, 0)
  assert.strictEqual(capturedRequests.length, 1)
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

atest('getMe / updateNickname / updateLevel 走资料接口并同步 store', async () => {
  reset()
  wx.setStorageSync('wx_token', 'TOKEN_PROFILE')
  requestQueue.push({
    statusCode: 200,
    data: { user: { id: 3, level: 'A2', nickname: '微信用户', total_stars: 7 } }
  })
  const me = await api.getMe()
  assert.strictEqual(me.user.total_stars, 7)
  assert.strictEqual(session.getState().level, 'A2')
  assert.strictEqual(capturedRequests[0].url, api.BASE_URL + '/api/auth/wx-me')
  assert.strictEqual(capturedRequests[0].header.Authorization, 'Bearer TOKEN_PROFILE')

  requestQueue.push({ statusCode: 200, data: { user: { id: 3, level: 'A2', nickname: '新昵称' } } })
  await api.updateNickname('新昵称')
  assert.strictEqual(capturedRequests[1].method, 'PUT')
  assert.deepStrictEqual(capturedRequests[1].data, { nickname: '新昵称' })

  requestQueue.push({ statusCode: 200, data: { user: { id: 3, level: 'B1', nickname: '新昵称' } } })
  await api.updateLevel('B1')
  assert.strictEqual(capturedRequests[2].url, api.BASE_URL + '/api/auth/wx-profile')
  assert.deepStrictEqual(capturedRequests[2].data, { level: 'B1' })
  assert.strictEqual(session.getState().level, 'B1')
})

atest('uploadAvatar：multipart 字段、Bearer、10 秒超时及 JSON 解析', async () => {
  reset()
  wx.setStorageSync('wx_token', 'TOKEN_UPLOAD')
  uploadQueue.push({
    statusCode: 200,
    data: JSON.stringify({ user: { id: 4, avatar: 'https://signed/avatar.jpg' } })
  })
  const data = await api.uploadAvatar('/tmp/avatar.jpg')
  assert.strictEqual(data.user.avatar, 'https://signed/avatar.jpg')
  assert.strictEqual(session.getState().userId, 4)
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

atest('答题页恢复最近答案，today 不传 level，保留听力地址与题型标签', async () => {
  reset()
  wx.setStorageSync('wx_token', 'TOKEN_CHALLENGE')
  session.setLevel('A1')
  const definition = loadPage('../pages/challenge/challenge.js')
  const page = pageMock(definition)
  const day = '2026-11-24'
  requestQueue.push({
    statusCode: 200,
    data: {
      challenge: {
        id: 9,
        day: day,
        challenge_type: 'listening',
        items: [
          { seq: 1, kind: 'word', prompt: { options: ['A', 'B'] } },
          { seq: 2, kind: 'grammar', prompt: { options: ['C', 'D'] } },
          {
            seq: 3,
            kind: 'listening',
            prompt: { type: 'audio_choice', options: ['X', 'Y'] },
            audio: { url: '/api/levels/audio/88?exp=1&sig=s', duration: 12.8 }
          }
        ]
      },
      attempt: { answers: [{ seq: 2, value: 'D' }], stars: 1, best_stars: 2 }
    }
  })
  await definition.load.call(page, day)
  assert.strictEqual(capturedRequests.length, 1)
  assert.strictEqual(capturedRequests[0].url, api.BASE_URL + '/api/levels/today?lang=de')
  assert.ok(capturedRequests[0].url.indexOf('level=') === -1)
  assert.strictEqual(page.data.typeLabel, '听力')
  assert.strictEqual(page.data.items[0].selectedIndex, -1)
  assert.strictEqual(page.data.items[0].selected, '')
  assert.strictEqual(page.data.items[1].selectedIndex, 1)
  assert.strictEqual(page.data.items[1].selected, 'D')
  assert.strictEqual(page.data.items[2].kindLabel, '听力')
  assert.strictEqual(
    page.data.items[2].audioUrl,
    api.BASE_URL + '/api/levels/audio/88?exp=1&sig=s'
  )
  assert.strictEqual(page.data.attempt.best_stars, 2)
})

test('答题页忽略路由 query 的 level', () => {
  reset()
  session.setLevel('A2')
  const definition = loadPage('../pages/challenge/challenge.js')
  const page = pageMock(definition, { load: () => Promise.resolve() })
  definition.onLoad.call(page, { level: 'B1', day: '' })
  assert.strictEqual(page.data.level, 'A2')
})

test('关卡卡片：日期醒目、按天升序、今日可答/往期不可答、checked_in 兼容 passed', () => {
  const definition = loadPage('../pages/levels/levels.js')
  const cards = definition.buildCards([
    { day: '2026-11-01', checked_in: true, passed: false, stars: 2, best_stars: 3, title: '周一关卡' },
    { day: '2026-11-02', passed: true, score: 4, total: 6, title: '周二关卡' },
    { day: '2026-11-03', checked_in: false, passed: false }
  ], null, '2026-11-03')
  assert.deepStrictEqual(cards.map((c) => c.day), ['2026-11-01', '2026-11-02', '2026-11-03'])
  assert.strictEqual(cards[0].checkedIn, true)
  assert.strictEqual(cards[1].checkedIn, true, '仅 passed 也应高亮')
  assert.strictEqual(cards[0].dateLabel, '11 月 1 日')
  assert.ok(cards.every((c) => c.dateLabel.indexOf('周') === -1))
  assert.strictEqual(cards[0].canAnswer, false)
  assert.strictEqual(cards[0].hasAttempt, true)
  assert.strictEqual(cards[2].canAnswer, false)
})

test('卡片题型标签只取 challenge_type，缺失时按 vocab 兼容', () => {
  const definition = loadPage('../pages/levels/levels.js')
  const withType = definition.buildCards([], { challenge: { challenge_type: 'listening', items: [] } }, '2026-11-24')
  assert.strictEqual(withType[0].typeLabel, '听力')
  assert.strictEqual(withType[0].canAnswer, true)
  const without = definition.buildCards([], { challenge: { items: [] } }, '2026-11-24')
  assert.strictEqual(without[0].typeLabel, '单词与搭配')
})

atest('关卡页并行请求 today 与 calendar，卡片定位今天且无 level query', async () => {
  reset()
  wx.setStorageSync('wx_token', 'TOKEN_HOME')
  session.setLevel('A2')
  const definition = loadPage('../pages/levels/levels.js')
  const page = pageMock(definition)
  const month = monthKey(new Date())
  const day = month + '-01'
  requestQueue.push({
    statusCode: 200,
    data: {
      date: day,
      lang: 'de',
      level: 'A2',
      total_stars: 18,
      streak: { current: 3, longest: 7, last_day: day },
      challenge: {
        id: 12,
        day: day,
        challenge_type: 'grammar',
        title: '语法关卡',
        items: [{ seq: 1, kind: 'grammar', prompt: { options: ['A', 'B'] } }]
      },
      attempt: { stars: 1, best_stars: 3 }
    }
  })
  requestQueue.push({
    statusCode: 200,
    data: {
      month: month,
      entries: [{ day: day, checked_in: true, stars: 2, best_stars: 3, passed: true }]
    }
  })
  await definition.load.call(page)
  assert.strictEqual(capturedRequests.length, 2)
  assert.strictEqual(capturedRequests[0].url, api.BASE_URL + '/api/levels/today?lang=de')
  assert.strictEqual(capturedRequests[1].url, api.BASE_URL + '/api/levels/calendar?lang=de&month=' + month)
  assert.ok(capturedRequests.every((item) => item.url.indexOf('level=') === -1))
  assert.strictEqual(page.data.level, 'A2')
  assert.strictEqual(page.data.cards.length, 1)
  assert.strictEqual(page.data.cards[0].typeLabel, '语法')
  assert.strictEqual(page.data.cards[0].latestStars, 1)
  assert.strictEqual(page.data.cards[0].bestStars, 3)
  assert.strictEqual(page.data.cards[0].checkedIn, true)
  assert.strictEqual(page.data.currentIndex, 0)
  assert.strictEqual(page.data.streak.current, 3)
})

atest('关卡页无当日关卡按 reason 提示，today 无 challenge 时卡片不显示答题按钮', async () => {
  reset()
  wx.setStorageSync('wx_token', 'TOKEN_HOME_REASON')
  const definition = loadPage('../pages/levels/levels.js')
  const page = pageMock(definition)
  const month = monthKey(new Date())
  requestQueue.push({ statusCode: 200, data: { challenge: null, reason: 'content_not_ready' } })
  requestQueue.push({ statusCode: 200, data: { month: month, entries: [] } })
  await definition.load.call(page)
  assert.strictEqual(page.data.cards.length, 1)
  assert.strictEqual(page.data.cards[0].reason, '素材准备中，请稍后再来')
  assert.strictEqual(page.data.cards[0].canAnswer, false)
})

test('日历页：周一开头网格、checked_in 兼容 passed、成绩摘要字段', () => {
  const definition = loadPage('../pages/calendar/calendar.js')
  const cells = definition.buildCells('2026-11', [
    { day: '2026-11-01', checked_in: true, passed: false, score: 5, total: 6, stars: 2, best_stars: 3, title: '单词关' },
    { day: '2026-11-02', passed: true }
  ])
  const byDate = {}
  cells.forEach((cell) => { byDate[cell.date] = cell })
  assert.strictEqual(byDate['2026-11-01'].checkedIn, true)
  assert.strictEqual(byDate['2026-11-01'].hasRecord, true)
  assert.strictEqual(byDate['2026-11-01'].bestStars, 3)
  assert.strictEqual(byDate['2026-11-02'].checkedIn, true)
  assert.strictEqual(byDate['2026-11-03'].checkedIn, false)
  assert.strictEqual(definition.shiftMonth('2026-11', -1), '2026-10')
})

atest('日历页读取 calendar + streak，不传 level', async () => {
  reset()
  wx.setStorageSync('wx_token', 'TOKEN_CALENDAR')
  session.setLevel('A2')
  const definition = loadPage('../pages/calendar/calendar.js')
  const page = pageMock(definition, { month: '2026-11' })
  requestQueue.push({
    statusCode: 200,
    data: {
      month: '2026-11',
      entries: [{ day: '2026-11-01', checked_in: true, score: 5, total: 6, stars: 2, best_stars: 3 }]
    }
  })
  requestQueue.push({ statusCode: 200, data: { streak: { current: 4, longest: 7 } } })
  await definition.load.call(page)
  assert.strictEqual(capturedRequests.length, 2)
  assert.strictEqual(capturedRequests[0].url, api.BASE_URL + '/api/levels/calendar?lang=de&month=2026-11')
  assert.strictEqual(capturedRequests[1].url, api.BASE_URL + '/api/levels/streak?lang=de')
  assert.ok(capturedRequests.every((item) => item.url.indexOf('level=') === -1))
  assert.strictEqual(page.data.streak.current, 4)
  assert.strictEqual(page.data.empty, false)
  const first = page.data.cells.find((cell) => cell.date === '2026-11-01')
  assert.strictEqual(first.checkedIn, true)
})

test('我的页提供打卡日历入口，跳转二级页', () => {
  const definition = loadPage('../pages/mine/mine.js')
  assert.strictEqual(typeof definition.goCalendar, 'function')
  let target = ''
  global.wx.navigateTo = (opts) => { target = opts.url }
  try {
    definition.goCalendar.call({})
    assert.strictEqual(target, '/pages/calendar/calendar')
  } finally {
    delete global.wx.navigateTo
  }
})

atest('测试页调用 /api/tests 直接渲染 levels，不按用户等级过滤', async () => {
  reset()
  wx.setStorageSync('wx_token', 'TOKEN_TESTS')
  session.setLevel('B1')
  const definition = loadPage('../pages/tests/tests.js')
  const page = pageMock(definition)
  requestQueue.push({
    statusCode: 200,
    data: {
      levels: [
        { id: 1, name: 'a1听力', lang: 'de', difficulty: 'A1', active: true, description: '难度为 a1 的德语听力' },
        { id: 2, name: 'b1阅读', lang: 'de', difficulty: 'B1', active: false, description: '' }
      ]
    }
  })
  await definition.load.call(page)
  assert.strictEqual(capturedRequests.length, 1)
  assert.strictEqual(capturedRequests[0].url, api.BASE_URL + '/api/tests')
  assert.ok(capturedRequests[0].url.indexOf('level=') === -1)
  assert.strictEqual(page.data.levels.length, 2)
  assert.strictEqual(page.data.levels[0].name, 'a1听力')
  assert.strictEqual(page.data.levels[0].active, true)
  assert.strictEqual(page.data.levels[1].difficulty, 'B1')
  assert.strictEqual(page.data.levels[1].active, false)
})

atest('测试页空 levels 与失败态：空态文案、错误提示与重试保留', async () => {
  reset()
  wx.setStorageSync('wx_token', 'TOKEN_TESTS_EMPTY')
  const definition = loadPage('../pages/tests/tests.js')
  const page = pageMock(definition)
  requestQueue.push({ statusCode: 200, data: { levels: [] } })
  await definition.load.call(page)
  assert.deepStrictEqual(page.data.levels, [])
  assert.strictEqual(page.data.error, '')
  assert.strictEqual(page.data.loading, false)

  requestQueue.push({ statusCode: 500, data: { error: '测试配置读取失败' } })
  await definition.load.call(page)
  assert.strictEqual(page.data.error, '测试配置读取失败')
  assert.deepStrictEqual(page.data.levels, [])
})

test('关卡页不展示顶部统计条与拿星规则，按钮和日期统一取主题色', () => {
  const wxml = fs.readFileSync(path.join(__dirname, '../pages/levels/levels.wxml'), 'utf8')
  const wxss = fs.readFileSync(path.join(__dirname, '../pages/levels/levels.wxss'), 'utf8')
  const appWxss = fs.readFileSync(path.join(__dirname, '../app.wxss'), 'utf8')
  assert.ok(wxml.indexOf('topbar') === -1, '不应有顶部统计条')
  assert.ok(wxml.indexOf('上下滑动查看每天') === -1)
  assert.ok(wxml.indexOf('每答对 2 题得 1 星') === -1, '不应有拿星规则')
  assert.ok(appWxss.indexOf('--theme-color:') >= 0, 'app.wxss 应定义主题色变量')
  assert.ok(appWxss.indexOf('background: var(--theme-color') >= 0, '主按钮背景应取主题色')
  assert.ok(wxss.indexOf('color: var(--theme-color') >= 0, '日期颜色应取主题色')
  assert.ok(/box-sizing:\s*border-box/.test(wxss) && /height:\s*calc\(100% - 48rpx\)/.test(wxss),
    '卡片需按 border-box 扣掉上下 margin，避免底部按钮被裁切')
  assert.ok(/flex-shrink:\s*0/.test(wxss), '按钮不应被 flex 布局挤压')
})

;(async () => {
  console.log('\n每日关卡小程序契约测试\n' + '='.repeat(32))
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
