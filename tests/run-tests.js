// 每日关卡小程序契约测试：Node 直接运行，mock 微信运行时。
// 运行：node tests/run-tests.js
// 覆盖：新契约 GET /api/levels 序列、GET /api/levels/:id 详情含答案、POST /:id/submit、
//       本地判定归一化、飞卡 3D、日历 days 高亮、attempt 恢复、已完成关卡回顾、401 重试、503、
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
let audioContexts = []
let toasts = []
let navigateCalls = []
let navTitles = []
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
  showToast(o) { toasts.push(o) },
  showModal() {},
  stopPullDownRefresh() {},
  navigateTo(o) { navigateCalls.push(o) },
  switchTab() {},
  reLaunch() {},
  redirectTo() {},
  setNavigationBarTitle(o) { navTitles.push(o) },
  createInnerAudioContext() {
    const handlers = {}
    const ctx = {
      src: '', obeyMuteSwitch: true, currentTime: 0, duration: 0,
      play() { this.playCount = (this.playCount || 0) + 1; this.paused = false },
      pause() { this.paused = true },
      seek(t) { this.currentTime = t; this.seekedTo = t },
      stop() {}, destroy() {},
      onCanplay(fn) { handlers.canplay = fn },
      onPlay(fn) { handlers.play = fn },
      onPause(fn) { handlers.pause = fn },
      onStop(fn) { handlers.stop = fn },
      onEnded(fn) { handlers.ended = fn },
      onTimeUpdate(fn) { handlers.timeupdate = fn },
      onError(fn) { handlers.error = fn },
      emit(name) { handlers[name] && handlers[name]() }
    }
    audioContexts.push(ctx)
    return ctx
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
  audioContexts = []
  toasts = []
  navigateCalls = []
  navTitles = []
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
    // 页面加载后首次 load 应定位 progress.current（对应真实 onLoad 里的 _needPosition=true）
    _needPosition: true,
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

test('app.json 注册六页、三 Tab，calendar/testDetail/taskDetail 为二级页，tests 目录不进包', () => {
  const app = JSON.parse(fs.readFileSync(path.join(__dirname, '../app.json'), 'utf8'))
  assert.deepStrictEqual(app.pages, [
    'pages/levels/levels',
    'pages/calendar/calendar',
    'pages/tests/tests',
    'pages/testDetail/testDetail',
    'pages/taskDetail/taskDetail',
    'pages/mine/mine'
  ])
  assert.deepStrictEqual(app.tabBar.list.map((item) => item.pagePath), [
    'pages/levels/levels', 'pages/tests/tests', 'pages/mine/mine'
  ])
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../project.config.json'), 'utf8'))
  assert.ok(config.packOptions.ignore.some((item) => item.type === 'folder' && item.value === 'tests'))
  const pagesDir = fs.readdirSync(path.join(__dirname, '../pages'))
  assert.deepStrictEqual(pagesDir.sort(), ['calendar', 'levels', 'mine', 'taskDetail', 'testDetail', 'tests'])
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
        audio: { url: '/api/levels/audio/9?exp=1&sig=s', duration: 12.8 },
        image: { url: '/api/levels/image/9?exp=1&sig=i' } }
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
  assert.strictEqual(built.items[2].imageUrl, api.BASE_URL + '/api/levels/image/9?exp=1&sig=i')
})

test('音频进度 formatDuration/audioTimeText：秒转 m:ss 并拼接当前/总时长', () => {
  const def = loadPage('../pages/levels/levels.js')
  assert.strictEqual(def.formatDuration(0), '0:00')
  assert.strictEqual(def.formatDuration(9.9), '0:09')
  assert.strictEqual(def.formatDuration(75), '1:15')
  assert.strictEqual(def.formatDuration('bad'), '0:00')
  assert.strictEqual(def.audioTimeText(5, 12.8), '0:05 / 0:12')
  assert.strictEqual(def.audioTimeText(0, 0), '0:00 / 0:00')
})

test('音频播放器：播放/暂停图标、进度文本与进度条由 InnerAudioContext 事件驱动', () => {
  const wxml = fs.readFileSync(path.join(__dirname, '../pages/levels/levels.wxml'), 'utf8')
  const wxss = fs.readFileSync(path.join(__dirname, '../pages/levels/levels.wxss'), 'utf8')
  assert.ok(wxml.indexOf("'⏸' : '▶'") >= 0 || wxml.indexOf('⏸') >= 0)
  assert.ok(wxml.indexOf('audio-fill') >= 0)
  assert.ok(wxml.indexOf('audio-dot') >= 0)
  assert.ok(wxml.indexOf('audioPercent') >= 0)
  assert.ok(wxss.indexOf('.audio-dot') >= 0 && wxss.indexOf('border-radius: 50%') >= 0)
  assert.ok(wxml.indexOf('question-image') >= 0 && wxml.indexOf('current.imageUrl') >= 0)
  assert.ok(wxss.indexOf('.question-image') >= 0)
})

test('A-05 resolveIndex：首次定位当前关，二次 load 保留浏览位置，浏览关消失才回退', () => {
  const def = loadPage('../pages/levels/levels.js')
  const list = [{ id: 10 }, { id: 11 }, { id: 12 }, { id: 13 }]
  const page = pageMock(def, { _needPosition: true, data: Object.assign({}, def.data, { currentIndex: 0 }) })
  page.data.challenges = list
  // 首次进入：定位 progress.current(第 3 关)
  assert.strictEqual(def.resolveIndex.call(page, list, 3), 2)
  assert.strictEqual(page._needPosition, false)
  // 滑到已完成第 1 关后 onShow → load 再拉序列：保持第 1 关，不弹回第 3 关
  page.data.currentIndex = 0
  assert.strictEqual(def.resolveIndex.call(page, list, 3), 0)
  // 结算后序列刷新仍保持浏览位置
  assert.strictEqual(def.resolveIndex.call(page, list, 3), 0)
  // 浏览关被新序列移除：回退到当前关一次
  const shorter = [{ id: 10 }, { id: 11 }, { id: 13 }]
  page.data.currentIndex = 2 // 原第 3 关 id=12，新序列里已不存在
  assert.strictEqual(def.resolveIndex.call(page, shorter, 2), 1)
  // 切换等级重置标志后重新定位
  page._needPosition = true
  assert.strictEqual(def.resolveIndex.call(page, list, 4), 3)
})

test('答题反馈：展示你的答案/正确答案，听力题不展示转写原文', () => {
  const wxml = fs.readFileSync(path.join(__dirname, '../pages/levels/levels.wxml'), 'utf8')
  const wxss = fs.readFileSync(path.join(__dirname, '../pages/levels/levels.wxss'), 'utf8')
  assert.ok(wxml.indexOf('answer-feedback') >= 0, '有答案对比卡片')
  assert.ok(wxml.indexOf('你的答案') >= 0 && wxml.indexOf('正确答案') >= 0)
  assert.ok(wxml.indexOf("current.kind !== 'listening'") >= 0, '听力解析（转写）不展示')
  assert.ok(wxml.indexOf('confirmNext') >= 0 && wxml.indexOf('awaitingConfirm') >= 0, '需用户确认才跳下一题')
  assert.ok(wxml.indexOf("class=\"q-title\" wx:if=\"{{levelState[challenge.id].current.kind !== 'listening'}}\"") >= 0, '不展示听力题占位标题')
  assert.ok(wxss.indexOf('.answer-feedback') >= 0 && wxss.indexOf('.af-value.bad') >= 0)
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

test('A-06 已完成关结算面板只展示星数与答对题数，页面无冗余统计文案', () => {
  const wxml = fs.readFileSync(path.join(__dirname, '../pages/levels/levels.wxml'), 'utf8')
  const banned = ['累计', '历史最高', '本次未增加', '已打卡', '未打卡', '连续', '解锁下一关']
  banned.forEach((word) => {
    assert.strictEqual(wxml.indexOf(word), -1, '页面不应出现：' + word)
  })
  assert.ok(wxml.indexOf('result.stars') >= 0, '展示服务端 stars')
  assert.ok(wxml.indexOf('答对 {{levelState[challenge.id].result.score}}/{{levelState[challenge.id].result.total}}') >= 0, '展示答对 n/m')
  assert.ok(wxml.indexOf('查看题目') >= 0 && wxml.indexOf('再答一次') >= 0, '保留回顾与重考入口')
})

test('结算面板样式：饱和星形图标、查看题目在答对题数下、底部仅两个按钮', () => {
  const wxml = fs.readFileSync(path.join(__dirname, '../pages/levels/levels.wxml'), 'utf8')
  const wxss = fs.readFileSync(path.join(__dirname, '../pages/levels/levels.wxss'), 'utf8')
  assert.ok(wxml.indexOf('class="star-icon') >= 0 && wxml.indexOf('★') >= 0, '星数用星形图标')
  assert.ok(wxss.indexOf('.star-icon.filled') >= 0 && wxss.indexOf('#ff9500') >= 0, '已获星图标为饱和色')
  const scorePos = wxml.indexOf('result.score')
  const reviewPos = wxml.indexOf('bindtap="openReview"')
  const actionsPos = wxml.indexOf('class="result-actions"')
  assert.ok(scorePos > 0 && reviewPos > scorePos && reviewPos < actionsPos, '查看题目紧跟答对题数且在按钮区之前')
  const actions = wxml.slice(actionsPos, wxml.indexOf('<!-- 层叠卡片堆', actionsPos))
  assert.ok(actions.indexOf('retryLevel') >= 0 && actions.indexOf('goNext') >= 0, '底部保留再答一次与下一题')
  assert.strictEqual(actions.indexOf('openReview'), -1, '底部不再放查看题目')
  assert.ok(wxml.indexOf('下一题') >= 0 && wxml.indexOf('下一关') === -1, '按钮文案为下一题')
  assert.ok(wxss.indexOf('.result-actions') >= 0 && wxss.indexOf('width: 100%') >= 0, '按钮区占满宽度，不再溢出')
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

test('打卡日历月份导航：灰色实心箭头 + 主题色月份，无上一月/下一月文字', () => {
  const wxml = fs.readFileSync(path.join(__dirname, '../pages/calendar/calendar.wxml'), 'utf8')
  const wxss = fs.readFileSync(path.join(__dirname, '../pages/calendar/calendar.wxss'), 'utf8')
  assert.ok(wxml.indexOf('◀') >= 0 && wxml.indexOf('▶') >= 0, '实心三角箭头')
  assert.ok(wxml.indexOf('nav-month') >= 0 && wxml.indexOf('{{monthLabel}}') >= 0)
  assert.ok(wxml.indexOf('上一月') === -1 && wxml.indexOf('下一月') === -1, '不展示上一月/下一月文字')
  assert.ok(wxml.indexOf('nav-arrow-disabled') >= 0)
  assert.ok(wxss.indexOf('.nav-month') >= 0 && wxss.indexOf('color: var(--theme-color, #1677ff)') >= 0, '月份用主题色')
  assert.ok(wxss.indexOf('.nav-arrow') >= 0 && wxss.indexOf('color: #8a919f') >= 0, '箭头灰色')
  assert.ok(wxml.indexOf('bindtap="prevMonth"') >= 0 && wxml.indexOf('bindtap="nextMonth"') >= 0)
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

atest('关卡页音频：canplay 显示总时长、timeupdate 更新当前位置与进度条', async () => {
  reset()
  wx.setStorageSync('wx_token', 'TOKEN_AUDIO')
  const def = loadPage('../pages/levels/levels.js')
  const page = pageMock(def)
  const id = 12
  const seq = 9
  const item = {
    seq: seq,
    audioUrl: 'https://cdn.example/a.mp3',
    audioDuration: 12.8
  }
  page.data.levelState[id] = {
    items: [item],
    current: item,
    cursor: 0,
    total: 1,
    playingSeq: 0,
    audioProgress: '0:00 / 0:00',
    audioPercent: 0
  }
  def.toggleAudio.call(page, { currentTarget: { dataset: { id: id, seq: seq } } })
  assert.strictEqual(page.data.levelState[id].playingSeq, seq)
  assert.strictEqual(page.data.levelState[id].audioProgress, '0:00 / 0:12')
  const ctx = audioContexts[0]
  assert.ok(ctx)
  assert.strictEqual(ctx.src, item.audioUrl)
  assert.strictEqual(ctx.obeyMuteSwitch, false)
  ctx.duration = 12.8
  ctx.currentTime = 3.2
  ctx.emit('timeupdate')
  assert.strictEqual(page.data.levelState[id].audioProgress, '0:03 / 0:12')
  assert.strictEqual(page.data.levelState[id].audioPercent, 25)
  ctx.currentTime = 12.8
  ctx.emit('ended')
  assert.strictEqual(page.data.levelState[id].playingSeq, 0)
  assert.strictEqual(page.data.levelState[id].audioProgress, '0:12 / 0:12')
  assert.strictEqual(page.data.levelState[id].audioPercent, 100)
})

atest('关卡页音频：暂停保留位置，再次播放复用实例并从暂停位置续播', async () => {
  reset()
  wx.setStorageSync('wx_token', 'TOKEN_PAUSE')
  const def = loadPage('../pages/levels/levels.js')
  const page = pageMock(def)
  const id = 12
  const seq = 9
  const item = { seq: seq, audioUrl: 'https://cdn.example/a.mp3', audioDuration: 12.8 }
  page.data.levelState[id] = {
    items: [item], current: item, cursor: 0, total: 1,
    playingSeq: 0, pausedSeq: 0, audioProgress: '0:00 / 0:00', audioPercent: 0
  }
  const tap = () => def.toggleAudio.call(page, { currentTarget: { dataset: { id: id, seq: seq } } })
  tap()
  const ctx = audioContexts[0]
  ctx.duration = 12.8
  ctx.currentTime = 4.1
  ctx.emit('timeupdate')
  assert.strictEqual(page.data.levelState[id].audioProgress, '0:04 / 0:12')
  // 暂停：只 pause，不 destroy，记录位置与 pausedSeq
  tap()
  assert.strictEqual(ctx.paused, true)
  assert.strictEqual(page.data.levelState[id].playingSeq, 0)
  assert.strictEqual(page.data.levelState[id].pausedSeq, seq)
  assert.strictEqual(page.data.levelState[id].audioProgress, '0:04 / 0:12')
  const playCountBefore = ctx.playCount
  // 续播：复用同一实例，未新建 context
  tap()
  assert.strictEqual(audioContexts.length, 1, '续播不得新建 InnerAudioContext')
  assert.strictEqual(ctx.playCount, playCountBefore + 1)
  assert.strictEqual(ctx.seekedTo, 4.1, '从暂停位置 seek')
  assert.strictEqual(page.data.levelState[id].playingSeq, seq)
  assert.strictEqual(page.data.levelState[id].pausedSeq, 0)
  assert.strictEqual(page.data.levelState[id].audioProgress, '0:04 / 0:12')
  assert.strictEqual(page.data.levelState[id].audioPercent, 32)
})

atest('听力题答题后等待用户确认才跳题，跳题后音频与进度归零并绑定新题', async () => {
  reset()
  wx.setStorageSync('wx_token', 'TOKEN_CONFIRM')
  const def = loadPage('../pages/levels/levels.js')
  const pending = []
  const page = pageMock(def, {
    _timers: [],
    later(fn) { pending.push(fn); return pending.length }
  })
  const id = 12
  const q1 = { seq: 1, kind: 'listening', audioUrl: 'https://cdn.example/a.mp3', audioDuration: 12.8,
    correctAnswer: 'mit dem Zug' }
  const q2 = { seq: 2, kind: 'listening', audioUrl: 'https://cdn.example/b.mp3', audioDuration: 8.4,
    correctAnswer: '1 Tag' }
  page.data.challenges = [{ id: id, position: 1, unlocked: true }]
  page.data.currentIndex = 0
  page.data.levelState[id] = {
    items: [q1, q2], current: q1, cursor: 0, total: 2, answeredCount: 0,
    flying: false, feedback: null, awaitingConfirm: false, result: null,
    playingSeq: 0, pausedSeq: 0, audioErrorSeq: 0, audioProgress: '0:00 / 0:12', audioPercent: 0
  }
  def.onPick.call(page, {
    currentTarget: { dataset: { id: id, seq: 1, value: 'mit dem Zug' } }
  })
  assert.strictEqual(pending.length, 1, '答题后只有反馈定时器')
  pending.shift()()
  const afterPick = page.data.levelState[id]
  assert.strictEqual(afterPick.awaitingConfirm, true)
  assert.strictEqual(afterPick.cursor, 0, '未确认前不得跳题')
  assert.strictEqual(afterPick.items[0].answered, true)
  assert.strictEqual(pending.length, 0, '听力题不得自动排飞卡/推进定时器')
  // 确认后进入飞卡，定时器到点才推进；此刻模拟上一题音频仍在播
  def.confirmNext.call(page, { currentTarget: { dataset: { id: id } } })
  assert.strictEqual(page.data.levelState[id].awaitingConfirm, false)
  assert.strictEqual(pending.length, 1)
  page.data.levelState[id].playingSeq = 1
  page.data.levelState[id].audioProgress = '0:07 / 0:12'
  page.data.levelState[id].audioPercent = 58
  pending.shift()()
  const afterAdvance = page.data.levelState[id]
  assert.strictEqual(afterAdvance.cursor, 1, '确认后进入下一题')
  assert.strictEqual(afterAdvance.current.seq, 2)
  assert.strictEqual(afterAdvance.playingSeq, 0)
  assert.strictEqual(afterAdvance.pausedSeq, 0)
  assert.strictEqual(afterAdvance.audioErrorSeq, 0)
  assert.strictEqual(afterAdvance.audioProgress, '0:00 / 0:08', '进度按新题时长归零')
  assert.strictEqual(afterAdvance.audioPercent, 0)
  assert.strictEqual(afterAdvance.feedback, null)
  assert.strictEqual(afterAdvance.awaitingConfirm, false)
})

test('听力播放/暂停时展示停止与暂停按钮，停止后进度归零', () => {
  const def = loadPage('../pages/levels/levels.js')
  const page = pageMock(def)
  const id = 7
  page.data.currentIndex = 0
  page.data.challenges = [{ id: id, position: 1, challenge_type: 'listening', unlocked: true }]
  page.data.levelState[id] = {
    playingSeq: 3, pausedSeq: 0, audioErrorSeq: 0, audioPercent: 42,
    current: { seq: 3, audioDuration: 20 }, items: []
  }

  def.stopAudioTap.call(page, { currentTarget: { dataset: { id: id, seq: 3 } } })
  const st = page.data.levelState[id]
  assert.strictEqual(st.playingSeq, 0)
  assert.strictEqual(st.pausedSeq, 0)
  assert.strictEqual(st.audioPercent, 0)
  assert.ok(st.audioProgress.indexOf('0:00') === 0, '进度文本归零')

  const wxml = fs.readFileSync(path.join(__dirname, '../pages/levels/levels.wxml'), 'utf8')
  assert.ok(wxml.indexOf('bindtap="stopAudioTap"') >= 0, '播放中展示停止按钮')
  assert.ok(wxml.indexOf('audio-stop') >= 0, '停止按钮有独立样式')
})

test('已完成关卡只读回顾：openReview 汇总题目与作答，closeReview 关闭', () => {
  const def = loadPage('../pages/levels/levels.js')
  const page = pageMock(def)
  const id = 12
  const items = [
    { seq: 1, kind: 'word', kindLabel: '单词', prompt: { question: 'Baum', options: ['树', '窗'] },
      selected: '树', correct: true, correctAnswer: '树', explanation: 'Baum = 树' },
    { seq: 2, kind: 'grammar', kindLabel: '语法', prompt: { question: '...', options: ['A', 'B'] },
      selected: 'B', correct: false, correctAnswer: 'A' }
  ]
  page.data.challenges = [{ id: id, position: 3, challenge_type: 'grammar', unlocked: true }]
  page.data.levelState[id] = { items, result: { score: 1, total: 2, stars: 2, bestStars: 2 } }

  def.openReview.call(page, { currentTarget: { dataset: { id: id } } })
  assert.strictEqual(page.data.reviewing.items.length, 2, '回顾包含全部题目')
  assert.strictEqual(page.data.reviewing.title, '第 3 关 · 语法')
  assert.strictEqual(page.data.reviewing.summary, '得分 1/2 · 最高 2 星')

  def.closeReview.call(page)
  assert.strictEqual(page.data.reviewing, null)

  const wxml = fs.readFileSync(path.join(__dirname, '../pages/levels/levels.wxml'), 'utf8')
  assert.ok(wxml.indexOf('bindtap="openReview"') >= 0, '结算面板提供查看题目入口')
  assert.ok(wxml.indexOf('wx:if="{{reviewing}}"') >= 0, '回顾为只读浮层')
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

atest('我的页：等级提示不再常驻，仅修改等级成功后 toast 展示', async () => {
  reset()
  wx.setStorageSync('wx_token', 'TOKEN_LEVEL')
  session.setUser({ level: 'A1', nickname: 'Anna' })
  const wxml = fs.readFileSync(path.join(__dirname, '../pages/mine/mine.wxml'), 'utf8')
  assert.ok(wxml.indexOf('修改等级会保存到服务器') === -1, '页面不得常驻该提示')
  const def = loadPage('../pages/mine/mine.js')
  const page = pageMock(def)
  // 1) updateLevel → 2) refresh 的 getMe → 3) refresh 的 /api/levels
  requestQueue.push({ statusCode: 200, data: { user: { level: 'A2', nickname: 'Anna' } } })
  requestQueue.push({ statusCode: 200, data: { user: { level: 'A2', nickname: 'Anna' } } })
  requestQueue.push({ statusCode: 200, data: { total_stars: 5, progress: { total: 2, passed: 1, current: 2 } } })
  await def.onLevelChange.call(page, { detail: { value: 1 } })
  assert.strictEqual(capturedRequests[0].url, api.BASE_URL + '/api/auth/wx-profile')
  assert.deepStrictEqual(capturedRequests[0].data, { level: 'A2' })
  assert.strictEqual(toasts.length, 1)
  assert.strictEqual(toasts[0].title, '修改等级会保存到服务器，关卡与日历将按新等级刷新')
  assert.strictEqual(toasts[0].icon, 'none')
  assert.strictEqual(session.getState().level, 'A2')
  // 选择相同等级时不发请求、不弹提示
  await def.onLevelChange.call(page, { detail: { value: 1 } })
  assert.strictEqual(capturedRequests.length, 3)
  assert.strictEqual(toasts.length, 1)
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

atest('测试页移除说明卡片，点击列表项跳转测试详情', async () => {
  reset()
  wx.setStorageSync('wx_token', 'TOKEN_TESTS')
  const def = loadPage('../pages/tests/tests.js')
  const page = pageMock(def)
  const wxml = fs.readFileSync(path.join(__dirname, '../pages/tests/tests.wxml'), 'utf8')
  assert.ok(wxml.indexOf('<view class="title">测试配置</view>') === -1, '不应展示测试配置标题')
  assert.ok(wxml.indexOf('以下为管理端配置') === -1, '不应展示管理端说明')
  assert.ok(wxml.indexOf('bindtap="openDetail"') >= 0, '列表项应绑定 openDetail')
  assert.ok(wxml.indexOf('item.lang') === -1, '按约定不在小程序展示语种')
  def.openDetail.call(page, { currentTarget: { dataset: { id: 2, name: 'a1 听力' } } })
  assert.strictEqual(navigateCalls.length, 1)
  assert.strictEqual(navigateCalls[0].url,
    '/pages/testDetail/testDetail?id=2&name=' + encodeURIComponent('a1 听力'))
})

atest('测试详情页按 id 拉取 /api/tests/:id 并按 sort_order 展示任务', async () => {
  reset()
  wx.setStorageSync('wx_token', 'TOKEN_TESTS')
  const def = loadPage('../pages/testDetail/testDetail.js')
  const page = pageMock(def)
  page.data.id = '7'
  requestQueue.push({ statusCode: 200, data: {
    level: { id: 7, name: 'a1听力', lang: 'de', difficulty: 'A1', description: '德语听力' },
    exams: [
      { exam_id: 'e2', item_type: 'speaking', name: '口语二', lang: 'de', sort_order: 2 },
      { exam_id: 'e1', item_type: 'listening', name: '', lang: 'de', sort_order: 1 }
    ]
  } })
  await def.load.call(page)
  assert.strictEqual(capturedRequests[capturedRequests.length - 1].url, api.BASE_URL + '/api/tests/7')
  assert.strictEqual(page.data.level.name, 'a1听力')
  assert.strictEqual(page.data.exams.length, 2)
  assert.strictEqual(page.data.exams[0].name, 'e1', '无名称时回退 exam_id')
  assert.strictEqual(page.data.exams[0].typeLabel, '听力')
  assert.strictEqual(page.data.exams[0].itemType, 'listening')
  assert.strictEqual(page.data.exams[0].examId, 'e1')
  assert.strictEqual(page.data.exams[1].typeLabel, '口语')
})

atest('测试详情页任务卡可点击进入任务详情，且不展示语种', async () => {
  reset()
  wx.setStorageSync('wx_token', 'TOKEN_TESTS')
  const def = loadPage('../pages/testDetail/testDetail.js')
  const page = pageMock(def)
  page.data.id = '7'
  const wxml = fs.readFileSync(path.join(__dirname, '../pages/testDetail/testDetail.wxml'), 'utf8')
  assert.ok(wxml.indexOf('bindtap="openTask"') >= 0, '任务卡应绑定 openTask')
  assert.ok(wxml.indexOf('exam-meta') === -1, '不应展示任务卡语种')
  assert.ok(wxml.indexOf('level.lang') === -1, '摘要不应展示语种')
  def.openTask.call(page, {
    currentTarget: {
      dataset: { examId: 'e1', itemType: 'listening', name: 'a1 听力' }
    }
  })
  assert.strictEqual(navigateCalls.length, 1)
  assert.strictEqual(navigateCalls[0].url,
    '/pages/taskDetail/taskDetail?levelId=7&itemType=listening&examId=e1&name=' +
    encodeURIComponent('a1 听力'))
})

atest('测试详情页 onLoad 写入 id 并用名称设置标题', async () => {
  reset()
  wx.setStorageSync('wx_token', 'TOKEN_TESTS')
  const def = loadPage('../pages/testDetail/testDetail.js')
  const page = pageMock(def)
  requestQueue.push({ statusCode: 200, data: { level: { name: 'a1 听力' }, exams: [] } })
  def.onLoad.call(page, { id: '3', name: encodeURIComponent('a1 听力') })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.strictEqual(page.data.id, '3')
  assert.strictEqual(navTitles[0].title, 'a1 听力')
})

atest('测试详情页缺少 id 时提示且不发起请求', async () => {
  reset()
  const def = loadPage('../pages/testDetail/testDetail.js')
  const page = pageMock(def)
  await def.load.call(page)
  assert.strictEqual(page.data.loading, false)
  assert.strictEqual(page.data.error, '测试参数缺失')
  assert.strictEqual(capturedRequests.length, 0)
})

atest('任务详情页拉取听力内容并把素材路径补成完整地址', async () => {
  reset()
  wx.setStorageSync('wx_token', 'TOKEN_TESTS')
  const def = loadPage('../pages/taskDetail/taskDetail.js')
  const page = pageMock(def)
  page.data.levelId = '7'
  page.data.itemType = 'listening'
  page.data.examId = 'e1'
  requestQueue.push({ statusCode: 200, data: {
    item_type: 'listening',
    exam_id: 'e1',
    title: '听力一',
    listening: {
      duration: 12.5,
      question_count: 1,
      questions: [{
        number: 1,
        duration: 6,
        audio_url: '/api/tests/7/items/listening/e1/asset?path=audio%2Fq01.m4a',
        image_url: '/api/tests/7/items/listening/e1/asset?path=images%2Fq01.jpg',
        transcript: 'Hallo',
        answer: 'A',
        options: ['A', 'B']
      }]
    }
  } })
  await def.load.call(page)
  assert.strictEqual(capturedRequests[capturedRequests.length - 1].url,
    api.BASE_URL + '/api/tests/7/items/listening/e1')
  assert.strictEqual(page.data.title, '听力一')
  assert.strictEqual(page.data.typeLabel, '听力')
  assert.strictEqual(page.data.listening.questions.length, 1)
  assert.strictEqual(page.data.listening.questions[0].audioUrl,
    api.BASE_URL + '/api/tests/7/items/listening/e1/asset?path=audio%2Fq01.m4a')
  assert.strictEqual(page.data.listening.questions[0].duration, 6)
})

atest('任务详情页拉取口语方案并映射题目字段', async () => {
  reset()
  wx.setStorageSync('wx_token', 'TOKEN_TESTS')
  const def = loadPage('../pages/taskDetail/taskDetail.js')
  const page = pageMock(def)
  page.data.levelId = '7'
  page.data.itemType = 'speaking_plan'
  page.data.examId = '12'
  requestQueue.push({ statusCode: 200, data: {
    item_type: 'speaking_plan',
    exam_id: '12',
    title: '口语方案',
    speaking: {
      plan: { id: 12, name: '口语方案', description: '自我介绍' },
      items: [{
        item_key: 'k1', topic: '自我介绍', prompt_de: 'Stellen Sie sich vor.',
        prompt_zh: '请介绍自己。', expected_points: '姓名/职业', ref_answer: 'Ich heiße ...',
        error_note: '注意语序', sort_order: 1
      }]
    }
  } })
  await def.load.call(page)
  assert.strictEqual(page.data.title, '口语方案')
  assert.strictEqual(page.data.typeLabel, '口语计划')
  assert.strictEqual(page.data.speaking.plan.name, '口语方案')
  assert.strictEqual(page.data.speaking.items[0].promptDe, 'Stellen Sie sich vor.')
  assert.strictEqual(page.data.speaking.items[0].refAnswer, 'Ich heiße ...')
})

atest('任务详情页音频支持播放、暂停与停止', async () => {
  reset()
  const def = loadPage('../pages/taskDetail/taskDetail.js')
  const page = pageMock(def)
  page.data.listening = {
    questions: [{ number: 1, audioUrl: 'https://cdn.example.com/a.m4a', duration: 10 }]
  }
  def.toggleAudio.call(page, { currentTarget: { dataset: { index: 0 } } })
  assert.strictEqual(audioContexts.length, 1)
  assert.strictEqual(page.data.playingIndex, 0)
  def.toggleAudio.call(page, { currentTarget: { dataset: { index: 0 } } })
  assert.strictEqual(page.data.playingIndex, -1)
  assert.strictEqual(page.data.pausedIndex, 0)
  def.stopAudioTap.call(page)
  assert.strictEqual(page.data.playingIndex, -1)
  assert.strictEqual(page.data.pausedIndex, -1)
  assert.strictEqual(page.audio, null)
})

atest('任务详情页缺少参数时提示且不发起请求', async () => {
  reset()
  const def = loadPage('../pages/taskDetail/taskDetail.js')
  const page = pageMock(def)
  await def.load.call(page)
  assert.strictEqual(page.data.loading, false)
  assert.strictEqual(page.data.error, '任务参数缺失')
  assert.strictEqual(capturedRequests.length, 0)
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
