// 关卡序列页：竖向 swiper 单页承载「选关 + 答题 + 结算」（方案 §7.1）。
// 关卡与日期解绑：序列来自 GET /api/levels，详情含答案来自 GET /api/levels/:id，
// 答题全程零请求，末题后仅一次 POST /:id/submit。每题 0~3 星以服务端提交结果为准。
const api = require('../../utils/api')
const session = require('../../utils/store/session')

const TYPE_LABELS = { vocab: '单词与搭配', grammar: '语法', listening: '听力' }
const KIND_LABELS = { word: '单词', collocation: '固定搭配', grammar: '语法', listening: '听力' }

// 反馈停留时长与飞卡动画时长（§7.1.5 / §7.1.6）
const FEEDBACK_MS = 600
const FLY_MS = 420

/** 归一化：trim + 折叠空白 + 小写，与服务端判定口径一致（§6.2）。 */
function normalize(v) {
  return String(v === null || v === undefined ? '' : v).trim().replace(/\s+/g, ' ').toLowerCase()
}

/** 本地即时判定：空答案为错，两侧归一化后相等才算对。 */
function isCorrect(selected, correctAnswer) {
  if (!selected || !correctAnswer) return false
  return normalize(selected) === normalize(correctAnswer)
}

/** 本次星数预估（§5.2）；最终 stars 一律以提交响应为准。 */
function estimateStars(score, total) {
  score = Number(score) || 0
  total = Number(total) || 0
  if (total <= 0 || score <= 0) return 0
  if (score > total) score = total
  if (total >= 6) return Math.min(3, Math.floor(score / 2))
  const main = Math.min(3, Math.floor(score * 3 / total))
  const threshold = Math.floor(total * 3 / 5)
  if (score >= threshold && main < 1) return 1
  return Math.min(3, main)
}

function typeLabel(challenge) {
  const value = challenge && challenge.challenge_type
  return TYPE_LABELS[value] || TYPE_LABELS.vocab
}

/** 随机 3D 飞卡变换：Z 分量恒为负（向屏幕深处），带随机漂移/旋转/缩小（§7.1.6）。 */
function makeFlyTransform() {
  const sign = Math.random() < 0.5 ? -1 : 1
  const dx = sign * (80 + Math.random() * 160)
  const dy = -(40 + Math.random() * 160)
  const dz = -(650 + Math.random() * 450)
  const rx = (Math.random() * 30 + 10) * (Math.random() < 0.5 ? -1 : 1)
  const ry = (Math.random() * 40 + 10) * (Math.random() < 0.5 ? -1 : 1)
  const rz = (Math.random() * 24 + 6) * (Math.random() < 0.5 ? -1 : 1)
  return 'translate3d(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px,' + dz.toFixed(1) + 'px) rotateX(' +
    rx.toFixed(1) + 'deg) rotateY(' + ry.toFixed(1) + 'deg) rotateZ(' + rz.toFixed(1) + 'deg) scale(.55)'
}

/** 卡片堆：顶层为当前可交互题，后 1~2 张仅作景深骨架，不渲染真实文案（§7.1.3）。 */
function buildStack(items, cursor, topStyle) {
  const stack = []
  const top = items && items[cursor]
  if (top) stack.push({ key: 'top-' + top.seq, depth: 0, seq: top.seq, style: topStyle || '' })
  if (items && items[cursor + 1]) stack.push({ key: 'd1-' + items[cursor + 1].seq, depth: 1, seq: items[cursor + 1].seq, style: '' })
  if (items && items[cursor + 2]) stack.push({ key: 'd2-' + items[cursor + 2].seq, depth: 2, seq: items[cursor + 2].seq, style: '' })
  return stack
}

/** 由详情 + attempt 构建题目数组；预置已答选择，返回首个未答题下标。 */
function buildItems(detail, attempt) {
  const answers = (attempt && attempt.answers) || []
  const selectedBySeq = {}
  answers.forEach((a) => { if (a && a.seq) selectedBySeq[a.seq] = a.value })
  const items = ((detail && detail.items) || []).map((item) => {
    const prompt = item.prompt || {}
    const selected = selectedBySeq[item.seq] || ''
    const audioUrl = item.audio && item.audio.url
      ? api.getBaseUrl() + item.audio.url
      : ''
    return {
      seq: item.seq,
      kind: item.kind,
      kindLabel: KIND_LABELS[item.kind] || '题目',
      prompt: prompt,
      correctAnswer: item.correct_answer || '',
      explanation: item.explanation || '',
      selected: selected,
      answered: !!selected,
      correct: selected ? isCorrect(selected, item.correct_answer) : false,
      audioUrl: audioUrl,
      audioDuration: (item.audio && item.audio.duration) || 0
    }
  })
  const found = items.findIndex((it) => !it.answered)
  // found=-1 表示全部已答 → cursor 指向末尾，便于判定 allAnswered 与展示结算。
  const cursor = found < 0 ? items.length : found
  return { items: items, cursor: cursor }
}

/** 给关卡状态补上 current（当前题），供 WXML 稳定绑定，避免多重动态下标。 */
function withCurrent(st) {
  const items = (st && st.items) || []
  const cursor = (st && st.cursor) || 0
  return Object.assign({}, st, { current: items[cursor] || null })
}

/** 结算面板数据（供已恢复作答与提交成功后共用）。 */
function resultPanel(attempt, extra) {
  const base = {
    score: (attempt && attempt.score) || 0,
    total: (attempt && attempt.total) || 0,
    stars: (attempt && attempt.stars) || 0,
    bestStars: (attempt && attempt.best_stars) || 0,
    starsAdded: (attempt && attempt.stars_added) || 0,
    totalStars: (attempt && attempt.total_stars) || 0,
    passed: attempt && attempt.passed === true,
    checkedIn: attempt && attempt.checked_in === true,
    streak: (attempt && attempt.streak) || null
  }
  return Object.assign(base, extra || {})
}

Page({
  data: {
    lang: 'de',
    level: 'A1',
    totalStars: 0,
    progress: { total: 0, passed: 0, current: 1 },
    streak: { current: 0, longest: 0, last_day: '' },
    challenges: [],
    currentIndex: 0,
    levelState: {},
    swiperDisabled: false,
    loading: true,
    error: ''
  },

  onLoad() {
    const state = session.getState()
    this.setData({ lang: state.lang, level: state.level })
    this._timers = []
    this.unsubscribe = session.subscribe((next) => {
      if (next.level !== this.data.level) {
        this.clearTimers()
        this.stopAudio()
        this.setData({ levelState: {} }, () => this.load())
      }
    })
  },

  onShow() {
    this.load()
  },

  onUnload() {
    if (this.unsubscribe) this.unsubscribe()
    this.clearTimers()
    this.stopAudio()
  },

  onPullDownRefresh() {
    this.load(true).finally(() => wx.stopPullDownRefresh())
  },

  clearTimers() {
    ;(this._timers || []).forEach((t) => clearTimeout(t))
    this._timers = []
  },

  later(fn, delay) {
    const id = setTimeout(() => {
      this._timers = (this._timers || []).filter((t) => t !== id)
      fn()
    }, delay)
    this._timers.push(id)
    return id
  },

  patch(id, update) {
    const current = this.data.levelState[id] || {}
    const next = Object.assign({}, current, update)
    this.setData({ ['levelState.' + id]: withCurrent(next) })
  },

  state(id) {
    return this.data.levelState[id] || null
  },

  /** 拉序列（§6.1）；refresh 时清空按关缓存。首次定位 progress.current。 */
  async load(refresh) {
    this.setData({ loading: true, error: '' })
    if (refresh === true) this.setData({ levelState: {} })
    try {
      await api.ensureLogin()
      const lang = session.getState().lang
      const data = await api.request('/api/levels?lang=' + lang)
      const challenges = (data && data.challenges) || []
      const progress = (data && data.progress) || { total: challenges.length, passed: 0, current: 1 }
      const current = Math.max(1, Number(progress.current) || 1)
      const index = Math.min(challenges.length - 1, current - 1)
      this.setData({
        lang: lang,
        level: (data && data.level) || session.getState().level,
        totalStars: (data && data.total_stars) || 0,
        progress: {
          total: Number(progress.total) || challenges.length,
          passed: Number(progress.passed) || 0,
          current: current
        },
        streak: (data && data.streak) || this.data.streak,
        challenges: challenges,
        currentIndex: Math.max(0, index)
      })
      if (challenges.length) this.ensureLoaded(Math.max(0, index))
    } catch (error) {
      this.setData({ error: (error && error.message) || '关卡加载失败' })
    } finally {
      this.setData({ loading: false })
    }
  },

  /** 仅加载当前 slide；锁定关不请求详情（§7.1.1 / §7.1.2）。 */
  ensureLoaded(index) {
    const challenge = this.data.challenges[index]
    if (!challenge) return
    const id = challenge.id
    if (this.data.levelState[id]) return
    if (challenge.unlocked === false) {
      this.setData({ ['levelState.' + id]: { locked: true, loading: false } })
      return
    }
    this.loadLevel(id)
  },

  async loadLevel(id) {
    this.patch(id, { loading: true, error: '', locked: false })
    try {
      const detail = await api.request('/api/levels/' + id)
      const built = buildItems(detail, detail && detail.attempt)
      const { items, cursor } = built
      const attempt = detail && detail.attempt
      const allAnswered = items.length > 0 && cursor >= items.length
      const st = {
        loading: false,
        error: '',
        locked: false,
        items: items,
        cursor: cursor,
        answeredCount: allAnswered ? items.length : cursor,
        total: items.length,
        stack: buildStack(items, cursor),
        flying: false,
        feedback: null,
        submitting: false,
        submitError: '',
        result: allAnswered ? resultPanel(attempt, { challengeId: id }) : null,
        playingSeq: 0,
        audioErrorSeq: 0,
        audioProgress: '0:00 / 0:00'
      }
      this.setData({ ['levelState.' + id]: withCurrent(st) })
    } catch (error) {
      const status = error && error.statusCode
      const message = (error && error.message) || '关卡详情加载失败'
      if (status === 403 || status === 404) {
        // 未解锁/等级不符/已关闭/不存在：回退到当前待通关关并提示（§8）。
        const target = Math.max(0, (Number(this.data.progress.current) || 1) - 1)
        wx.showToast({ title: message, icon: 'none' })
        if (indexById(this.data.challenges, id) !== target) this.setData({ currentIndex: target })
        this.setData({ ['levelState.' + id]: { error: message, loading: false } })
        this.ensureLoaded(target)
      } else {
        this.patch(id, { error: message, loading: false })
      }
    }
  },

  async onSwiperChange(e) {
    const index = Number(e.detail.current) || 0
    if (this.data.swiperDisabled) return
    this.stopAudio()
    this.setData({ currentIndex: index })
    this.ensureLoaded(index)
  },

  /** 选项点击：本地即时判定 → 反馈 → 飞卡 → 推进/提交（§7.1.5 / §7.1.6）。 */
  onPick(e) {
    if (this.data.swiperDisabled) return
    const id = Number(e.currentTarget.dataset.id)
    const seq = Number(e.currentTarget.dataset.seq)
    const st = this.state(id)
    if (!st || st.flying || st.submitting || st.result) return
    const item = (st.items || []).find((it) => it.seq === seq)
    if (!item || item.answered) return

    // value 为选项完整文本（§6.3）；本地按归一化规则即时判定，无网络请求。
    const value = e.currentTarget.dataset.value || ''
    const right = isCorrect(value, item.correctAnswer)
    this.setData({
      swiperDisabled: true,
      ['levelState.' + id]: Object.assign({}, st, {
        flying: true,
        feedback: {
          seq: seq,
          selected: value,
          correct: right,
          correctAnswer: item.correctAnswer,
          explanation: item.explanation
        }
      })
    })

    // 记录选择（含未答也可提交，未答按错计分）
    this.later(() => {
      const cur = this.state(id)
      if (!cur) return
      const items = (cur.items || []).map((it) => it.seq === seq
        ? Object.assign({}, it, { selected: value, answered: true, correct: right })
        : it)
      const fly = makeFlyTransform()
      // 顶层（当前题）执行飞走动画，cursor 此刻不变；420ms 后才推进。
      const stack = buildStack(items, cur.cursor, fly)
      this.setData({
        ['levelState.' + id]: withCurrent(Object.assign({}, cur, { items: items, stack: stack }))
      })
      this.later(() => this.advance(id), FLY_MS)
    }, FEEDBACK_MS)
  },

  /** 飞走动画结束：上升一档、插入下一题；末题则自动提交一次。 */
  advance(id) {
    const st = this.state(id)
    if (!st) return
    this.stopAudio()
    const answeredCount = (st.answeredCount || 0) + 1
    const cursor = st.cursor + 1
    if (cursor >= (st.total || st.items.length)) {
      this.setData({
        swiperDisabled: false,
        ['levelState.' + id]: withCurrent(Object.assign({}, st, {
          answeredCount: answeredCount, cursor: cursor, flying: false,
          stack: buildStack(st.items, cursor)
        }))
      })
      this.doSubmit(id)
      return
    }
    this.setData({
      swiperDisabled: false,
      ['levelState.' + id]: withCurrent(Object.assign({}, st, {
        answeredCount: answeredCount,
        cursor: cursor,
        flying: false,
        feedback: null,
        stack: buildStack(st.items, cursor)
      }))
    })
  },

  /** 整关只提交一次；成功后结算面板 + 刷新序列更新解锁态（§7.1.7）。 */
  async doSubmit(id) {
    const st = this.state(id)
    if (!st || st.submitting || st.result) return
    this.setData({
      swiperDisabled: true,
      ['levelState.' + id]: Object.assign({}, st, { submitting: true, submitError: '' })
    })
    try {
      const answers = (st.items || [])
        .filter((it) => it.selected)
        .map((it) => ({ seq: it.seq, value: it.selected }))
      const result = await api.request('/api/levels/' + id + '/submit', {
        method: 'POST',
        data: { answers: answers }
      })
      this.setData({
        swiperDisabled: false,
        ['levelState.' + id]: Object.assign({}, this.state(id), {
          submitting: false,
          result: resultPanel(result, { challengeId: id }),
          items: (st.items || []).map((it) => {
            const hit = ((result && result.items) || []).find((r) => r.seq === it.seq)
            return hit ? Object.assign({}, it, {
              correct: hit.correct === true,
              correctAnswer: hit.correct_answer || it.correctAnswer,
              explanation: hit.explanation || it.explanation
            }) : it
          })
        })
      })
      this.refreshSeries()
    } catch (error) {
      const status = error && error.statusCode
      const message = (error && error.message) || '提交失败'
      if (status === 403 || status === 404) {
        wx.showToast({ title: message, icon: 'none' })
        this.load(true)
      }
      this.setData({
        swiperDisabled: false,
        ['levelState.' + id]: Object.assign({}, this.state(id), {
          submitting: false, submitError: message
        })
      })
    }
  },

  /** 结算后静默刷新序列（不重建本页作答状态）。 */
  async refreshSeries() {
    try {
      const lang = session.getState().lang
      const data = await api.request('/api/levels?lang=' + lang)
      const progress = (data && data.progress) || {}
      this.setData({
        challenges: (data && data.challenges) || this.data.challenges,
        progress: {
          total: Number(progress.total) || this.data.progress.total,
          passed: Number(progress.passed) || 0,
          current: Number(progress.current) || this.data.progress.current
        },
        totalStars: (data && data.total_stars) || this.data.totalStars,
        streak: (data && data.streak) || this.data.streak
      })
    } catch (e) { /* 刷新失败不影响本次结算展示 */ }
  },

  /** 再答一次：清空本关作答，从第一题重新开始（保留 best_stars）。 */
  retryLevel(e) {
    const id = Number(e.currentTarget.dataset.id)
    const st = this.state(id)
    if (!st) return
    const items = (st.items || []).map((it) => Object.assign({}, it, {
      selected: '', answered: false, correct: false
    }))
    this.setData({
      ['levelState.' + id]: withCurrent(Object.assign({}, st, {
        items: items, cursor: 0, answeredCount: 0, stack: buildStack(items, 0),
        flying: false, feedback: null, result: null, submitError: '',
        playingSeq: 0, audioErrorSeq: 0, audioProgress: '0:00 / 0:00'
      }))
    })
    this.stopAudio()
  },

  goNext(e) {
    const index = Number(e.currentTarget.dataset.index)
    if (!Number.isFinite(index)) return
    const next = this.data.challenges[index + 1]
    if (!next || next.unlocked === false) return
    this.stopAudio()
    this.setData({ currentIndex: index + 1 })
    this.ensureLoaded(index + 1)
  },

  /** 提交失败后手动重试：仍只发一次新请求，不清空答案。 */
  resubmit(e) {
    const id = Number(e.currentTarget.dataset.id)
    this.doSubmit(id)
  },

  /** 详情加载失败后按关重试。 */
  onRetryLevel(e) {
    const id = Number(e.currentTarget.dataset.id)
    if (id) this.loadLevel(id)
  },

  retry() {
    this.load(true)
  },

  // ---- 听力播放器：同一时刻只播一个，切题/切关/离开都销毁（§7.1.4 / C-02）----
  stopAudio() {
    if (this.audio) {
      try { this.audio.stop() } catch (e) { /* 忽略已停止 */ }
      try { this.audio.destroy() } catch (e) { /* 忽略已销毁 */ }
      this.audio = null
    }
    const index = this.data.currentIndex
    const challenge = this.data.challenges[index]
    if (challenge) {
      const st = this.state(challenge.id)
      if (st && (st.playingSeq || st.audioErrorSeq)) {
        this.patch(challenge.id, { playingSeq: 0, audioErrorSeq: 0, audioProgress: '0:00 / 0:00' })
      }
    }
  },

  toggleAudio(e) {
    const id = Number(e.currentTarget.dataset.id)
    const seq = Number(e.currentTarget.dataset.seq)
    const st = this.state(id)
    if (!st) return
    const item = (st.items || []).find((it) => it.seq === seq)
    if (!item || !item.audioUrl) return
    if (st.playingSeq === seq) {
      this.stopAudio()
      return
    }
    this.stopAudio()
    const ctx = wx.createInnerAudioContext()
    this.audio = ctx
    ctx.src = item.audioUrl
    ctx.obeyMuteSwitch = false
    this.patch(id, { playingSeq: seq, audioErrorSeq: 0, audioProgress: '0:00 / 0:00' })
    ctx.onPlay(() => { if (this.audio === ctx) this.patch(id, { playingSeq: seq }) })
    ctx.onPause(() => { if (this.audio === ctx) this.patch(id, { playingSeq: 0 }) })
    ctx.onStop(() => { if (this.audio === ctx) this.patch(id, { playingSeq: 0 }) })
    ctx.onEnded(() => {
      if (this.audio !== ctx) return
      this.patch(id, { playingSeq: 0 })
    })
    ctx.onError(() => {
      if (this.audio !== ctx) return
      this.patch(id, { playingSeq: 0, audioErrorSeq: seq, audioProgress: '0:00 / 0:00' })
      try { ctx.destroy() } catch (err) { /* 忽略 */ }
      this.audio = null
    })
    ctx.play()
  }
})

/** 按 id 找序列下标。 */
function indexById(list, id) {
  const arr = list || []
  for (let i = 0; i < arr.length; i += 1) {
    if (arr[i].id === id) return i
  }
  return -1
}

module.exports = {
  normalize: normalize,
  isCorrect: isCorrect,
  estimateStars: estimateStars,
  typeLabel: typeLabel,
  makeFlyTransform: makeFlyTransform,
  buildStack: buildStack,
  buildItems: buildItems,
  resultPanel: resultPanel
}
