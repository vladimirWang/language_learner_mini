// 每日关卡小程序契约测试：Node 直接运行，mock 微信运行时。
// 运行：node tests/run-tests.js
// 覆盖：新契约 GET /api/levels 序列、GET /api/levels/:id 详情含答案、POST /:id/submit、
//       本地判定归一化、飞卡 3D、日历 days 高亮、attempt 恢复、401 重试、503、
//       隐私字段不下发、单页注册与测试目录排除。
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
  switchTab() {},
  reLaunch() {},
  redirectTo() {},
  createInnerAudioContext() {
    return {
      src: '', obeyMuteSwitch: true,
      play() {}, stop() {}, destroy() {},
      onCanplay() {}, onPlay() {}, onPause() {}, onStop() {}, onEnded() {}, onTimeUpdate() {}, onError() {}
    }
  },
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
  // 页面导出的纯函数辅助挂到定义上供测试断言。
  if (definition && mod && typeof mod === 'object') {
    Object.keys(mod).forEach((key) => { definition[key] = mod[key] })
  }
  return definition
}

// setData 支持 'levelState.12' 这类点路径，模拟微信真实行为。
function pathSet(obj, keyPath, value) {
  const parts = String(keyPath).split('.')
  let cur = obj
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {}
    cur = cur[parts[i]]
  }
  cur[parts[parts.length - 1]] = value
}

function pageMock(definition, extra) {
  return Object.assign({}, definition, {
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(update) {
      Object.keys(update).forEach((k) => {
        if (k.indexOf('.') >= 0) pathSet(this.data, k, update[k])
        else this.data[k] = update[k]
      })
    }
  }, extra || {})
}

// ---- 同步用例：api / store ----
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

test('全局 store：初始状态、setUser/setLevel 不保存隐私字段、订阅可取消', () => {
  reset()
  assert.deepStrictEqual(session.getState(), {
    lang: 'de', level: 'A1', user: null, ready: false
  })
  let notifications = 0
  const unsubscribe = session.subscribe(() => { notifications += 1 })
  session.setLevel('B1')
  assert.strictEqual(session.getState().level, 'B1')
  assert.strictEqual(notifications, 1)
  session.setUser({ level: 'A2', nickname: 'Anna', id: 3, openid: 'ox', unionid: 'ux' })
  const s = session.getState()
  assert.strictEqual(s.userId, undefined)
  assert.strictEqual(s.user.id, undefined, 'setUser 应过滤 id 隐私字段')
  assert.strictEqual(s.user.openid, undefined, 'setUser 应过滤 openid')
  assert.strictEqual(s.user.unionid, undefined, 'setUser 应过滤 unionid')
  assert.strictEqual(s.level, 'A2')
  assert.strictEqual(s.ready, true)
  unsubscribe()
  session.setLevel('C1')
  assert.strictEqual(notifications, 2)
  session.clear()
  assert.strictEqual(session.getState().level, 'A1')
})

test('app.json 注册四页、三 Tab，calendar 为二级页，tests 目录不进包', () => {
  const app = JSON.parse(fs.readFileSync(path.join(__dirname, '../app.json'), 'utf8'))
  assert.deepStrictEqual(app.pages, [
    'pages/levels/levels',
    'pages/calendar/calendar',
    'pages/tests/tests',
    'pages/mine/mine'
  ])
  assert.deepStrictEqual(app.tabBar.list.map((item) => item.pagePath), [
    'pages/levels/levels', 'pages/tests/tests', 'pages/mine/mine'
  ])
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../project.config.json'), 'utf8'))
  assert.ok(config.packOptions.ignore.some((item) => item.type === 'folder' && item.value === 'tests'))
  const pagesDir = fs.readdirSync(path.join(__dirname, '../pages'))
  assert.deepStrictEqual(pagesDir.sort(), ['calendar', 'levels', 'mine', 'tests'])
})

// ---- 同步用例：关卡纯逻辑（新契约）----
test('归一化判定 normalize/isCorrect：trim、折叠空白、小写、空答案为错', () => {
  const def = loadPage('../pages/levels/levels.js')
  assert.strictEqual(def.normalize('  Der  Baum '), 'der baum')
  assert.strictEqual(def.normalize('树'), '树')
  assert.strictEqual(def.isCorrect(' 树 ', '树'), true)
  assert.strictEqual(def.isCorrect('Baum', 'baum'), true)
  assert.strictEqual(def.isCorrect('Der   Baum', 'der baum'), true)
  assert.strictEqual(def.isCorrect('', '树'), false)
  assert.strictEqual(def.isCorrect('窗户', '树'), false)
})

test('星数算法 estimateStars：6 题阶梯、不足 6 题折算与兜底、异常 0 星', () => {
  const def = loadPage('../pages/levels/levels.js')
  assert.deepStrictEqual([0, 1, 2, 3, 4, 5, 6].map((s) => def.estimateStars(s, 6)), [0, 0, 1, 1, 2, 2, 3])
  assert.strictEqual(def.estimateStars(0, 0), 0)
  assert.strictEqual(def.estimateStars(-1, 6), 0)
  assert.strictEqual(def.estimateStars(9, 6), 3, '异常输入钳制到 3')
  // 不足 6 题：主公式 floor(score*3/total)，门槛 floor(total*3/5)
  assert.strictEqual(def.estimateStars(2, 5), 1, 'floor(6/5)=1')
  assert.strictEqual(def.estimateStars(1, 5), 0, 'floor(3/5)=0 且 1<3 门槛，0 星')
  assert.strictEqual(def.estimateStars(4, 5), 2, 'floor(12/5)=2')
})

test('3D 飞卡：Z 分量为负、带随机 translate3d 与旋转缩小', () => {
  const def = loadPage('../pages/levels/levels.js')
  for (let i = 0; i < 12; i += 1) {
    const t = def.makeFlyTransform()
    assert.ok(t.indexOf('translate3d') === 0)
    const m = t.match(/translate3d\(([-\d.]+)px,([-\d.]+)px,([-\d.]+)px\)/)
    assert.ok(m, '含 translate3d 三段')
    assert.ok(Number(m[3]) < 0, 'Z 分量必须为负')
    assert.ok(t.indexOf('rotateX') >= 0 && t.indexOf('rotateY') >= 0 && t.indexOf('rotateZ') >= 0)
    assert.ok(t.indexOf('scale(.55)') >= 0)
  }
})

test('卡片堆 buildStack：最多 3 张、顶层可点后排 depth 1/2、飞卡样式仅顶层', () => {
  const def = loadPage('../pages/levels/levels.js')
  const items = [{ seq: 1 }, { seq: 2 }, { seq: 3 }, { seq: 4 }]
  const stack = def.buildStack(items, 1, 'FLY')
  assert.strictEqual(stack.length, 3)
  assert.deepStrictEqual(stack.map((c) => c.depth), [0, 1, 2])
  assert.strictEqual(stack[0].style, 'FLY')
  assert.strictEqual(stack[1].style, '')
  assert.strictEqual(def.buildStack(items, 3).length, 1, '最后一题只有顶层')
})

test('详情构建 buildItems：含答案/解析、按 attempt 预置、定位首个未答题', () => {
  const def = loadPage('../pages/levels/levels.js')
  const detail = {
    items: [
      { seq: 1, kind: 'word', prompt: { options: ['树', '窗'] }, correct_answer: '树', explanation: 'Baum=树' },
      { seq: 2, kind: 'grammar', prompt: { options: ['A', 'B'] }, correct_answer: 'A' },
      { seq: 3, kind: 'listening', prompt: { options: ['X', 'Y'] }, correct_answer: 'Y',
        audio: { url: '/api/levels/audio/9?exp=1&sig=s', duration: 12.8 } }
    ]
  }
  const built = def.buildItems(detail, { answers: [{ seq: 1, value: '树' }] })
  assert.strictEqual(built.items.length, 3)
  assert.strictEqual(built.items[0].answered, true)
  assert.strictEqual(built.items[0].correct, true)
  assert.strictEqual(built.items[0].correctAnswer, '树')
  assert.strictEqual(built.items[0].explanation, 'Baum=树')
  assert.strictEqual(built.cursor, 1, '定位首个未答题')
  assert.strictEqual(built.items[2].audioUrl, api.BASE_URL + '/api/levels/audio/9?exp=1&sig=s')
})

test('结算数据 resultPanel：字段齐全、stars_added 可透传', () => {
  const def = loadPage('../pages/levels/levels.js')
  const r = def.resultPanel({
    score: 5, total: 6, stars: 2, best_stars: 3, stars_added: 0,
    total_stars: 20, passed: true, checked_in: true,
    streak: { current: 4, longest: 7 }
  })
  assert.strictEqual(r.score, 5)
  assert.strictEqual(r.bestStars, 3)
  assert.strictEqual(r.starsAdded, 0)
  assert.strictEqual(r.passed, true)
  assert.strictEqual(r.streak.current, 4)
})

// ---- 同步用例：日历 buildCells（新签名 days）----
test('日历 buildCells：周一开头、days 高亮、无成绩字段', () => {
  const def = loadPage('../pages/calendar/calendar.js')
  const cells = def.buildCells('2026-11', ['2026-11-01', '2026-11-25'])
  const byDate = {}
  cells.forEach((c) => { byDate[c.date] = c })
  assert.strictEqual(byDate['2026-11-01'].checkedIn, true)
  assert.strictEqual(byDate['2026-11-25'].checkedIn, true)
  assert.strictEqual(byDate['2026-11-02'].checkedIn, false)
  assert.strictEqual(byDate['2026-11-01'].score, undefined, '不含成绩字段')
  assert.strictEqual(byDate['2026-11-01'].title, undefined, '不含关卡标题')
  assert.strictEqual(def.shiftMonth('2026-11', -1), '2026-10')
})

test('页面与样式不含日期语义/旧接口/成绩面板文案', () => {
  const lvJs = fs.readFileSync(path.join(__dirname, '../pages/levels/levels.js'), 'utf8')
  const lvWxml = fs.readFileSync(path.join(__dirname, '../pages/levels/levels.wxml'), 'utf8')
  const lvWxss = fs.readFileSync(path.join(__dirname, '../pages/levels/levels.wxss'), 'utf8')
  const calWxml = fs.readFileSync(path.join(__dirname, '../pages/calendar/calendar.wxml'), 'utf8')
  const combined = lvJs + lvWxml + lvWxss + calWxml
  assert.ok(combined.indexOf('levels/' + 'today') === -1, '不得请求旧接口')
  assert.ok(combined.indexOf('navigateTo') === -1, '关卡页不得跳独立答题页')
  assert.ok(combined.indexOf('dateLabel') === -1)
  assert.ok(combined.indexOf('每日') === -1 && combined.indexOf('今天') === -1)
  assert.ok(calWxml.indexOf('得分') === -1 && calWxml.indexOf('最高') === -1, '日历不展示成绩')
  assert.ok(/perspective:\s*900px/.test(lvWxss), '卡片堆需开启 3D 透视')
  assert.ok(lvWxss.indexOf('.day-card') === -1)
})

// ---- 异步用例 ----
atest('request 成功：GET 带 Bearer token', async () => {
  reset()
  wx.setStorageSync('wx_token', 'TOKEN_X')
  requestQueue.push({ statusCode: 200, data: { challenges: [] } })
  const data = await api.request('/api/levels')
  assert.deepStrictEqual(data, { challenges: [] })
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
  requestQueue.push({ statusCode: 200, data: { token: 'LOGIN_TOKEN', user: { level: 'A2' } } })
  await api.login()
  assert.strictEqual(api.getToken(), 'LOGIN_TOKEN')
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
  requestQueue.push({ statusCode: 200, data: { token: 'FRESH', user: { level: 'B1' } } })
  requestQueue.push({ statusCode: 200, data: { ok: true } })
  const data = await api.request('/api/levels')
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
  try { await api.request('/api/levels') } catch (e) { err = e }
  assert.ok(err)
  assert.strictEqual(loginCalls, 1)
  assert.strictEqual(capturedRequests.length, 3)
})

atest('503：抛“服务暂未开放”，不重登不重试', async () => {
  reset()
  wx.setStorageSync('wx_token', 'T')
  requestQueue.push({ statusCode: 503, data: { error: '微信登录未配置' } })
  let err = null
  try { await api.request('/api/levels') } catch (e) { err = e }
  assert.ok(err)
  assert.strictEqual(err.message, '服务暂未开放')
  assert.strictEqual(loginCalls, 0)
  assert.strictEqual(capturedRequests.length, 1)
})

atest('403/404：错误对象带 statusCode，供页面区分', async () => {
  reset()
  requestQueue.push({ statusCode: 403, data: { error: 'challenge not unlocked' } })
  let e403 = null
  try { await api.request('/api/levels/1/submit') } catch (e) { e403 = e }
  assert.strictEqual(e403.statusCode, 403)
  assert.strictEqual(e403.message, 'challenge not unlocked')
  requestQueue.push({ statusCode: 404, data: { error: 'challenge not found' } })
  let e404 = null
  try { await api.request('/api/levels/999/submit') } catch (e) { e404 = e }
  assert.strictEqual(e404.statusCode, 404)
})

atest('网络失败：fail 回调映射为 Error', async () => {
  reset()
  requestQueue.push({ fail: 'request:fail timeout' })
  let err = null
  try { await api.request('/api/x') } catch (e) { err = e }
  assert.strictEqual(err.message, 'request:fail timeout')
})

atest('getMe / updateNickname / updateLevel 走资料接口并过滤隐私字段', async () => {
  reset()
  wx.setStorageSync('wx_token', 'TOKEN_PROFILE')
  requestQueue.push({ statusCode: 200, data: { user: { id: 3, level: 'A2', nickname: '微信用户', total_stars: 7 } } })
  const me = await api.getMe()
  assert.strictEqual(session.getState().user.id, undefined, 'store 不保存 id')
  assert.strictEqual(session.getState().level, 'A2')
  assert.strictEqual(capturedRequests[0].url, api.BASE_URL + '/api/auth/wx-me')
  requestQueue.push({ statusCode: 200, data: { user: { level: 'A2' } } })
  await api.updateNickname('新昵称')
  assert.deepStrictEqual(capturedRequests[1].data, { nickname: '新昵称' })
  requestQueue.push({ statusCode: 200, data: { user: { level: 'B1' } } })
  await api.updateLevel('B1')
  assert.deepStrictEqual(capturedRequests[2].data, { level: 'B1' })
  assert.strictEqual(session.getState().level, 'B1')
})

atest('uploadAvatar：multipart 字段、Bearer、10 秒超时；隐私字段不落 store', async () => {
  reset()
  wx.setStorageSync('wx_token', 'TOKEN_UPLOAD')
  uploadQueue.push({ statusCode: 200, data: JSON.stringify({ user: { avatar: 'https://signed/avatar.jpg', openid: 'ox' } }) })
  const data = await api.uploadAvatar('/tmp/avatar.jpg')
  assert.strictEqual(data.user.avatar, 'https://signed/avatar.jpg')
  assert.strictEqual(session.getState().user.openid, undefined)
  assert.strictEqual(capturedUploads[0].name, 'avatar')
  assert.strictEqual(capturedUploads[0].header.Authorization, 'Bearer TOKEN_UPLOAD')
  assert.strictEqual(capturedUploads[0].timeout, 10000)
})

atest('关卡页 load：首屏仅请求 /api/levels?lang=de，定位 progress.current，锁定关不拉详情', async () => {
  reset()
  wx.setStorageSync('wx_token', 'TOKEN_HOME')
  session.setLevel('A2')
  const def = loadPage('../pages/levels/levels.js')
  const page = pageMock(def)
  requestQueue.push({
    statusCode: 200,
    data: {
      lang: 'de', level: 'A2', total_stars: 18,
      streak: { current: 3, longest: 7, last_day: '2026-11-25' },
      challenges: [
        { id: 12, position: 1, challenge_type: 'vocab', best_stars: 3, passed: true, unlocked: true },
        { id: 13, position: 2, challenge_type: 'grammar', best_stars: 0, passed: false, unlocked: false }
      ],
      progress: { total: 2, passed: 1, current: 2 }
    }
  })
  // 当前定位第 2 关（锁定），只应请求序列，不拉详情。
  await def.load.call(page)
  assert.strictEqual(capturedRequests.length, 1, '当前为锁定关，只请求序列')
  assert.strictEqual(capturedRequests[0].url, api.BASE_URL + '/api/levels?lang=de')
  assert.ok(capturedRequests[0].url.indexOf('level=') === -1, '等级由服务端读取')
  assert.strictEqual(page.data.level, 'A2')
  assert.strictEqual(page.data.totalStars, 18)
  assert.strictEqual(page.data.progress.current, 2)
  assert.strictEqual(page.data.currentIndex, 1, '定位 progress.current-1')
  assert.strictEqual(page.data.levelState['13'].locked, true, '锁定关直接标记，不拉详情')
  // 滑到第 1 关（解锁）才懒加载详情。
  requestQueue.push({
    statusCode: 200,
    data: { challenge: { id: 12 }, items: [{ seq: 1, kind: 'word', prompt: { options: ['树'] }, correct_answer: '树' }] }
  })
  await def.ensureLoaded.call(page, 0)
  assert.strictEqual(capturedRequests.length, 2, '滑到解锁关才请求详情')
  assert.strictEqual(capturedRequests[1].url, api.BASE_URL + '/api/levels/12')
})

atest('关卡页详情懒加载：解锁关拉详情、缓存后不重复请求、attempt 恢复结算', async () => {
  reset()
  wx.setStorageSync('wx_token', 'TOKEN_DETAIL')
  const def = loadPage('../pages/levels/levels.js')
  const page = pageMock(def)
  page.data.challenges = [{ id: 12, position: 1, unlocked: true }]
  requestQueue.push({
    statusCode: 200,
    data: {
      challenge: { id: 12, challenge_type: 'vocab' },
      items: [{ seq: 1, kind: 'word', prompt: { options: ['树', '窗'] }, correct_answer: '树' }],
      attempt: { answers: [{ seq: 1, value: '树' }], score: 1, total: 1, stars: 3, best_stars: 3, passed: true }
    }
  })
  await def.loadLevel.call(page, 12)
  assert.strictEqual(capturedRequests[0].url, api.BASE_URL + '/api/levels/12')
  assert.strictEqual(page.data.levelState['12'].result.stars, 3, '全部已答直接结算')
  assert.strictEqual(page.data.levelState['12'].items[0].answered, true)
  await def.ensureLoaded.call(page, 0)
  assert.strictEqual(capturedRequests.length, 1, '已缓存不重复请求')
})

atest('关卡页提交：末题后一次 POST submit、结算字段齐全、刷新序列', async () => {
  reset()
  wx.setStorageSync('wx_token', 'TOKEN_SUBMIT')
  const def = loadPage('../pages/levels/levels.js')
  const page = pageMock(def)
  page.data.levelState['12'] = {
    items: [{ seq: 1, selected: '树' }, { seq: 2, selected: '窗' }],
    cursor: 2, total: 2, answeredCount: 2, submitting: false, result: null
  }
  requestQueue.push({
    statusCode: 200,
    data: {
      score: 1, total: 2, stars: 1, best_stars: 2, stars_added: 0,
      total_stars: 20, passed: true, checked_in: true,
      items: [{ seq: 1, correct: true }, { seq: 2, correct: false }],
      streak: { current: 4, longest: 7 }
    }
  })
  // 刷新序列的第二次请求
  requestQueue.push({
    statusCode: 200,
    data: { challenges: [], progress: { total: 3, passed: 2, current: 3 }, total_stars: 20, streak: { current: 4 } }
  })
  await def.doSubmit.call(page, 12)
  assert.strictEqual(capturedRequests.length, 2, '1 次 submit + 1 次刷新序列')
  assert.strictEqual(capturedRequests[0].url, api.BASE_URL + '/api/levels/12/submit')
  assert.strictEqual(capturedRequests[0].method, 'POST')
  assert.deepStrictEqual(capturedRequests[0].data, {
    answers: [{ seq: 1, value: '树' }, { seq: 2, value: '窗' }]
  })
  const r = page.data.levelState['12'].result
  assert.strictEqual(r.score, 1)
  assert.strictEqual(r.starsAdded, 0)
  assert.strictEqual(r.passed, true)
  assert.strictEqual(r.streak.current, 4)
  // refreshSeries 为异步后台刷新，等待其完成后断言解锁态已更新。
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.strictEqual(page.data.progress.current, 3, '结算后解锁态与后端一致')
})

atest('我的页 refresh：累计星星/进度取 /api/levels，提供去闯关与日历入口', async () => {
  reset()
  wx.setStorageSync('wx_token', 'TOKEN_MINE')
  const def = loadPage('../pages/mine/mine.js')
  const page = pageMock(def)
  requestQueue.push({ statusCode: 200, data: { user: { level: 'A1', nickname: 'Anna', avatar: 'https://a', total_stars: 99 } } })
  requestQueue.push({
    statusCode: 200,
    data: {
      total_stars: 18, streak: { current: 3, longest: 7 },
      progress: { total: 8, passed: 3, current: 4 }, challenges: []
    }
  })
  await def.refresh.call(page)
  assert.strictEqual(page.data.totalStars, 18, '以 /api/levels 为准，非 /wx-me 的 99')
  assert.strictEqual(page.data.progress.passed, 3)
  assert.strictEqual(page.data.progress.total, 8)
  assert.strictEqual(page.data.streak.current, 3)
  assert.strictEqual(typeof def.goLevels, 'function')
  assert.strictEqual(typeof def.goCalendar, 'function')
  let tabTarget = ''
  global.wx.switchTab = (o) => { tabTarget = o.url }
  try {
    def.goLevels.call(page)
    assert.strictEqual(tabTarget, '/pages/levels/levels')
  } finally {
    delete global.wx.switchTab
  }
})

atest('日历页读取 calendar.days + streak，不传 level、不展示成绩', async () => {
  reset()
  wx.setStorageSync('wx_token', 'TOKEN_CALENDAR')
  session.setLevel('A2')
  const def = loadPage('../pages/calendar/calendar.js')
  const page = pageMock(def, { month: '2026-11' })
  requestQueue.push({ statusCode: 200, data: { month: '2026-11', days: ['2026-11-01', '2026-11-25'] } })
  requestQueue.push({ statusCode: 200, data: { streak: { current: 4, longest: 7 } } })
  await def.load.call(page)
  assert.strictEqual(capturedRequests.length, 2)
  assert.strictEqual(capturedRequests[0].url, api.BASE_URL + '/api/levels/calendar?lang=de&month=2026-11')
  assert.strictEqual(capturedRequests[1].url, api.BASE_URL + '/api/levels/streak?lang=de')
  assert.ok(capturedRequests.every((i) => i.url.indexOf('level=') === -1))
  assert.strictEqual(page.data.streak.current, 4)
  assert.strictEqual(page.data.empty, false)
  const first = page.data.cells.find((c) => c.date === '2026-11-01')
  assert.strictEqual(first.checkedIn, true)
  assert.strictEqual(first.score, undefined, '不展示成绩')
})

atest('测试页调用 /api/tests 直接渲染 levels，不按用户等级过滤', async () => {
  reset()
  wx.setStorageSync('wx_token', 'TOKEN_TESTS')
  session.setLevel('B1')
  const def = loadPage('../pages/tests/tests.js')
  const page = pageMock(def)
  requestQueue.push({ statusCode: 200, data: { levels: [
    { id: 1, name: 'a1听力', lang: 'de', difficulty: 'A1', active: true, description: '德语听力' },
    { id: 2, name: 'b1阅读', lang: 'de', difficulty: 'B1', active: false, description: '' }
  ] } })
  await def.load.call(page)
  assert.strictEqual(capturedRequests[0].url, api.BASE_URL + '/api/tests')
  assert.ok(capturedRequests[0].url.indexOf('level=') === -1)
  assert.strictEqual(page.data.levels.length, 2)
  assert.strictEqual(page.data.levels[1].active, false)
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
