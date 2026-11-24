const api = require('../../utils/api')
const session = require('../../utils/store/session')

const KIND_LABELS = { word: '单词', collocation: '固定搭配', grammar: '语法', listening: '听力' }
const TYPE_LABELS = { vocab: '单词与搭配', grammar: '语法', listening: '听力' }
const REASON_TEXT = {
  content_not_ready: '素材准备中，请稍后再来',
  not_published: '管理员尚未发布今天关卡'
}

function formatTime(seconds) {
  const n = Math.max(0, Math.floor(Number(seconds) || 0))
  const m = Math.floor(n / 60)
  const s = n % 60
  return m + ':' + (s < 10 ? '0' : '') + s
}

Page({
  data: {
    loading: true,
    error: '',
    submitting: false,
    challenge: null,
    items: [],
    attempt: null,
    lang: 'de',
    level: 'A1',
    typeLabel: '',
    playingSeq: 0,
    audioErrorSeq: 0,
    audioProgress: '0:00 / 0:00'
  },

  onLoad(query) {
    // 方案 §4.4：语种/等级只从全局 store 取，路由 query 不能覆盖等级。
    this.expectedDay = (query && query.day) || ''
    const state = session.getState()
    this.setData({ lang: state.lang, level: state.level })
    this.unsubscribe = session.subscribe((next) => {
      if (next.level !== this.data.level) {
        this.stopAudio()
        this.setData({ level: next.level }, () => this.load())
      }
    })
    this.load()
  },

  onUnload() {
    if (this.unsubscribe) this.unsubscribe()
    this.stopAudio()
  },

  async load(expectedDay) {
    const expected = typeof expectedDay === 'string' ? expectedDay : this.expectedDay
    this.setData({ loading: true, error: '' })
    try {
      await api.ensureLogin()
      // 等级由后端从 wx_users.level 读取，客户端不传 level。
      const data = await api.request('/api/levels/today?lang=de')
      if (!data.challenge) {
        this.setData({ error: REASON_TEXT[data.reason] || '今天的关卡还没有发布' })
        return
      }
      if (expected && data.challenge.day !== expected) {
        this.setData({ error: '关卡日期已变化，请返回首页刷新' })
        return
      }
      const answers = (data.attempt && data.attempt.answers) || []
      const selectedBySeq = {}
      answers.forEach((answer) => { selectedBySeq[answer.seq] = answer.value })
      const items = (data.challenge.items || []).map((item) => {
        const options = (item.prompt && item.prompt.options) || []
        const selected = selectedBySeq[item.seq] || ''
        const selectedIndex = options.indexOf(selected)
        const audioUrl = item.audio && item.audio.url
          ? api.BASE_URL + item.audio.url
          : ''
        return {
          seq: item.seq,
          kind: item.kind,
          kindLabel: KIND_LABELS[item.kind] || '题目',
          prompt: item.prompt,
          selectedIndex: selectedIndex,
          selected: selectedIndex >= 0 ? selected : '',
          audioUrl: audioUrl,
          audioDuration: (item.audio && item.audio.duration) || 0
        }
      })
      const state = session.getState()
      this.setData({
        lang: state.lang,
        level: state.level,
        challenge: data.challenge,
        typeLabel: TYPE_LABELS[data.challenge.challenge_type] || TYPE_LABELS.vocab,
        items: items,
        attempt: data.attempt || null
      })
      if (data.attempt) {
        wx.showToast({ title: '已恢复最近作答', icon: 'none' })
      }
    } catch (error) {
      this.setData({ error: error.message || '加载失败' })
    } finally {
      this.setData({ loading: false })
    }
  },

  onSelect(e) {
    const seq = Number(e.currentTarget.dataset.seq)
    const index = Number(e.currentTarget.dataset.index)
    const items = this.data.items.map((item) => {
      if (item.seq !== seq) return item
      return Object.assign({}, item, {
        selectedIndex: index,
        selected: item.prompt.options[index]
      })
    })
    this.setData({ items: items })
  },

  // ---- 听力播放 ----
  stopAudio() {
    if (this.audio) {
      try { this.audio.stop() } catch (e) { /* 忽略已停止实例 */ }
      try { this.audio.destroy() } catch (e) { /* 忽略已销毁实例 */ }
      this.audio = null
    }
    if (this.data.playingSeq || this.data.audioErrorSeq) {
      this.setData({ playingSeq: 0, audioErrorSeq: 0, audioProgress: '0:00 / 0:00' })
    }
  },

  toggleAudio(e) {
    const seq = Number(e.currentTarget.dataset.seq)
    const item = this.data.items.find((entry) => entry.seq === seq)
    if (!item || !item.audioUrl) return
    if (this.data.playingSeq === seq) {
      this.stopAudio()
      return
    }
    this.stopAudio()

    const ctx = wx.createInnerAudioContext()
    this.audio = ctx
    ctx.src = item.audioUrl
    ctx.obeyMuteSwitch = false
    this.setData({ playingSeq: seq, audioErrorSeq: 0, audioProgress: '0:00 / 0:00' })
    ctx.onCanplay(() => {
      if (this.audio === ctx) this.setData({ audioErrorSeq: 0 })
    })
    ctx.onPlay(() => {
      if (this.audio === ctx) this.setData({ playingSeq: seq })
    })
    ctx.onPause(() => {
      if (this.audio === ctx) this.setData({ playingSeq: 0 })
    })
    ctx.onStop(() => {
      if (this.audio === ctx) this.setData({ playingSeq: 0 })
    })
    ctx.onEnded(() => {
      if (this.audio !== ctx) return
      this.setData({ playingSeq: 0, audioProgress: '0:00 / ' + formatTime(item.audioDuration) })
    })
    ctx.onTimeUpdate(() => {
      if (this.audio !== ctx) return
      const duration = ctx.duration || item.audioDuration || 0
      this.setData({ audioProgress: formatTime(ctx.currentTime) + ' / ' + formatTime(duration) })
    })
    ctx.onError(() => {
      if (this.audio !== ctx) return
      this.setData({ playingSeq: 0, audioErrorSeq: seq, audioProgress: '0:00 / 0:00' })
      try { ctx.destroy() } catch (err) { /* 忽略销毁异常 */ }
      this.audio = null
    })
    ctx.play()
  },

  retry() {
    this.load('')
  },

  submit() {
    if (this.data.submitting || !this.data.challenge) return
    const unanswered = this.data.items.filter((item) => !item.selected).length
    if (unanswered > 0) {
      wx.showModal({
        title: '还有题目未作答',
        content: '未作答的题目会按错误计分，确定提交吗？',
        success: (res) => {
          if (res.confirm) this.doSubmit()
        }
      })
      return
    }
    this.doSubmit()
  },

  async doSubmit() {
    this.setData({ submitting: true })
    try {
      const answers = this.data.items
        .filter((item) => item.selected)
        .map((item) => ({ seq: item.seq, value: item.selected }))
      const result = await api.request('/api/levels/' + this.data.challenge.id + '/submit', {
        method: 'POST',
        data: { answers: answers }
      })
      wx.setStorageSync('last_challenge_result', {
        title: this.data.challenge.title,
        day: this.data.challenge.day,
        result: result
      })
      wx.redirectTo({ url: '/pages/result/result' })
    } catch (error) {
      // 403 未发布/未到可见日期/等级不一致，404 不存在：提示后返回首页刷新。
      if (error.statusCode === 403) {
        wx.showModal({
          title: '关卡已关闭',
          content: '该关卡已关闭，请返回首页刷新',
          showCancel: false,
          success: () => wx.reLaunch({ url: '/pages/levels/levels' })
        })
      } else if (error.statusCode === 404) {
        wx.showModal({
          title: '关卡不存在',
          content: '请返回首页刷新',
          showCancel: false,
          success: () => wx.reLaunch({ url: '/pages/levels/levels' })
        })
      } else {
        wx.showModal({ title: '提交失败', content: error.message || '请稍后重试', showCancel: false })
      }
    } finally {
      this.setData({ submitting: false })
    }
  }
})
