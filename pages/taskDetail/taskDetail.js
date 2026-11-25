const api = require('../../utils/api')

// 任务详情：从测试详情页点击任务卡进入，按 item_type + exam_id 拉取内容。
// GET /api/tests/:id/items/:itemType/:examId
// 按项目约定：语种只在服务端使用，本页不展示 lang。
const TYPE_LABELS = {
  listening: '听力',
  speaking: '口语',
  speaking_topic: '口语话题',
  speaking_plan: '口语计划'
}

function pad2(value) {
  return value < 10 ? '0' + value : String(value)
}

function audioTimeText(current, duration) {
  const cur = Math.max(0, Math.floor(Number(current) || 0))
  const total = Math.max(0, Math.floor(Number(duration) || 0))
  const head = pad2(Math.floor(cur / 60)) + ':' + pad2(cur % 60)
  const tail = total > 0 ? pad2(Math.floor(total / 60)) + ':' + pad2(total % 60) : '--:--'
  return head + ' / ' + tail
}

function audioPercentOf(current, duration) {
  const total = Number(duration) || 0
  if (total <= 0) return 0
  const percent = (Number(current) || 0) / total * 100
  return Math.max(0, Math.min(100, Math.round(percent)))
}

Page({
  data: {
    levelId: '',
    itemType: '',
    examId: '',
    title: '',
    typeLabel: '',
    loading: true,
    error: '',
    listening: null,
    speaking: null,
    playingIndex: -1,
    pausedIndex: -1,
    audioErrorIndex: -1,
    audioProgress: '',
    audioPercent: 0,
    // 听力做题：一次只展示一题，选择即判分，确认后进入下一题。
    cursor: 0,
    answers: {},
    revealed: {},
    score: 0,
    finished: false,
    showTranscript: {},
    showAnswer: {}
  },

  onLoad(options) {
    const opts = options || {}
    const levelId = opts.levelId ? decodeURIComponent(opts.levelId) : ''
    const itemType = opts.itemType ? decodeURIComponent(opts.itemType) : ''
    const examId = opts.examId ? decodeURIComponent(opts.examId) : ''
    const name = opts.name ? decodeURIComponent(opts.name) : ''
    if (name) wx.setNavigationBarTitle({ title: name })
    this.setData({
      levelId: levelId,
      itemType: itemType,
      examId: examId,
      title: name,
      typeLabel: TYPE_LABELS[itemType] || '任务'
    })
    this.load()
  },

  onUnload() {
    this.stopAudio()
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh())
  },

  async load() {
    const { levelId, itemType, examId } = this.data
    if (!levelId || !itemType || !examId) {
      this.setData({ loading: false, error: '任务参数缺失' })
      return
    }
    this.setData({ loading: true, error: '' })
    try {
      await api.ensureLogin()
      const data = await api.request(
        '/api/tests/' + encodeURIComponent(levelId) +
        '/items/' + encodeURIComponent(itemType) +
        '/' + encodeURIComponent(examId)
      )
      const title = (data && data.title) || this.data.title
      this.setData({
        title: title,
        typeLabel: TYPE_LABELS[itemType] || this.data.typeLabel,
        listening: data && data.listening ? this.mapListening(data.listening) : null,
        speaking: data && data.speaking ? this.mapSpeaking(data.speaking) : null,
        // 刷新/重进时回到第一题，清掉上一轮作答。
        cursor: 0,
        answers: {},
        revealed: {},
        score: 0,
        finished: false,
        showTranscript: {},
        showAnswer: {}
      })
      if (title) wx.setNavigationBarTitle({ title: title })
    } catch (error) {
      this.setData({ error: (error && error.message) || '任务加载失败' })
    } finally {
      this.setData({ loading: false })
    }
  },

  /** 听力素材地址由服务端给相对路径，这里补上后端域名。 */
  mapListening(raw) {
    const base = api.getBaseUrl()
    const absolute = (path) => (path ? base + path : '')
    const questions = (raw && Array.isArray(raw.questions) ? raw.questions : []).map((q) => ({
      number: q.number,
      duration: Number(q.duration) || 0,
      audioUrl: absolute(q.audio_url),
      imageUrl: absolute(q.image_url),
      transcript: q.transcript || '',
      answer: q.answer || '',
      options: Array.isArray(q.options) ? q.options : []
    }))
    return {
      duration: Number(raw && raw.duration) || 0,
      questionCount: questions.length,
      questions: questions
    }
  },

  mapSpeaking(raw) {
    const plan = raw && raw.plan
      ? {
          id: raw.plan.id,
          name: raw.plan.name || '',
          description: raw.plan.description || ''
        }
      : null
    const items = (raw && Array.isArray(raw.items) ? raw.items : []).map((item) => ({
      key: item.item_key || '',
      topic: item.topic || '',
      promptDe: item.prompt_de || '',
      promptZh: item.prompt_zh || '',
      expectedPoints: item.expected_points || '',
      refAnswer: item.ref_answer || '',
      errorNote: item.error_note || ''
    }))
    return { plan: plan, items: items }
  },

  retry() {
    this.load()
  },

  /** 选择选项即判分，与关卡页听力一致。 */
  selectOption(e) {
    const cursor = this.data.cursor
    if (this.data.finished || this.data.revealed[cursor]) return
    const value = e.currentTarget.dataset.value
    const question = this.data.listening && this.data.listening.questions[cursor]
    if (!question || value === undefined) return
    const answers = Object.assign({}, this.data.answers)
    answers[cursor] = value
    const revealed = Object.assign({}, this.data.revealed)
    revealed[cursor] = true
    const correct = this.isAnswerCorrect(value, question.answer)
    this.setData({
      answers: answers,
      revealed: revealed,
      score: this.data.score + (correct ? 1 : 0)
    })
  },

  isAnswerCorrect(value, answer) {
    return String(value == null ? '' : value).trim().toLowerCase() ===
      String(answer == null ? '' : answer).trim().toLowerCase()
  },

  /** 未作答时直接看答案，不计分。 */
  revealAnswer() {
    const cursor = this.data.cursor
    const revealed = Object.assign({}, this.data.revealed)
    revealed[cursor] = true
    this.setData({ revealed: revealed })
  },

  confirmNext() {
    const cursor = this.data.cursor
    const questions = (this.data.listening && this.data.listening.questions) || []
    this.stopAudioTap()
    if (cursor + 1 >= questions.length) {
      this.setData({ finished: true, cursor: cursor })
      return
    }
    this.setData({ cursor: cursor + 1, audioProgress: '', audioPercent: 0 })
  },

  restartListening() {
    this.stopAudioTap()
    this.setData({
      cursor: 0,
      answers: {},
      revealed: {},
      score: 0,
      finished: false,
      audioProgress: '',
      audioPercent: 0
    })
  },

  /** 展开/收起听力原文。 */
  toggleTranscript(e) {
    this.toggleMap('showTranscript', e.currentTarget.dataset.index)
  },

  /** 展开/收起答案（听力答案与口语参考答案共用）。 */
  toggleAnswer(e) {
    this.toggleMap('showAnswer', e.currentTarget.dataset.index)
  },

  toggleMap(field, rawIndex) {
    const key = String(rawIndex)
    const next = Object.assign({}, this.data[field])
    next[key] = !next[key]
    this.setData({ [field]: next })
  },

  previewImage(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    wx.previewImage({ current: url, urls: [url] })
  },

  // ---- 音频：同一时刻只播一题；暂停保留实例与位置，停止/切题/离开才销毁 ----
  // listening-audio 组件事件：组件只负责展示，播放状态仍由页面持有。
  onAudioToggle(e) {
    const seq = e.detail && e.detail.seq
    this.toggleAudio({ currentTarget: { dataset: { index: seq } } })
  },

  onAudioStop() {
    this.stopAudioTap()
  },

  toggleAudio(e) {
    if (!this.data.listening) return
    const index = Number(e.currentTarget.dataset.index)
    const question = this.data.listening.questions[index]
    if (!question || !question.audioUrl) return

    if (this.data.playingIndex === index && this.audio) {
      const ctx = this.audio
      this.pausedTime = Number(ctx.currentTime) || this.pausedTime || 0
      try { ctx.pause() } catch (err) { /* 忽略已停止 */ }
      this.setData({ playingIndex: -1, pausedIndex: index })
      return
    }

    if (this.data.pausedIndex === index && this.audio) {
      const ctx = this.audio
      const pos = Number(this.pausedTime) || 0
      this.setData({ playingIndex: index, pausedIndex: -1 })
      try {
        if (pos > 0 && typeof ctx.seek === 'function') ctx.seek(pos)
      } catch (err) { /* 忽略 seek 失败 */ }
      try { ctx.play() } catch (err) { /* 忽略播放异常 */ }
      return
    }

    this.stopAudio()
    this.audioIndex = index
    this.pausedTime = 0
    const ctx = wx.createInnerAudioContext()
    this.audio = ctx
    ctx.src = question.audioUrl
    ctx.obeyMuteSwitch = false
    this.setData({
      playingIndex: index,
      pausedIndex: -1,
      audioErrorIndex: -1,
      audioProgress: audioTimeText(0, question.duration),
      audioPercent: 0
    })
    ctx.onCanplay(() => {
      if (this.audio !== ctx) return
      this.patchAudioProgress(Number(ctx.currentTime) || 0)
    })
    ctx.onTimeUpdate(() => {
      if (this.audio !== ctx) return
      this.patchAudioProgress(Number(ctx.currentTime) || 0)
    })
    ctx.onEnded(() => {
      if (this.audio !== ctx) return
      const duration = Number(ctx.duration) || question.duration || 0
      this.setData({
        playingIndex: -1,
        pausedIndex: -1,
        audioProgress: audioTimeText(duration, duration),
        audioPercent: 100
      })
    })
    ctx.onError(() => {
      if (this.audio !== ctx) return
      this.setData({
        playingIndex: -1,
        pausedIndex: -1,
        audioErrorIndex: index,
        audioProgress: '',
        audioPercent: 0
      })
    })
    try { ctx.play() } catch (err) { /* 忽略播放异常 */ }
  },

  patchAudioProgress(currentTime) {
    const question = this.data.listening
      ? this.data.listening.questions[this.audioIndex]
      : null
    const duration = Number(this.audio && this.audio.duration) || Number(question && question.duration) || 0
    this.setData({
      audioProgress: audioTimeText(currentTime, duration),
      audioPercent: audioPercentOf(currentTime, duration)
    })
  },

  /** 停止播放并回到开头。 */
  stopAudioTap() {
    this.stopAudio()
  },

  stopAudio() {
    if (this.audio) {
      try { this.audio.stop() } catch (err) { /* 忽略已停止 */ }
      try { this.audio.destroy() } catch (err) { /* 忽略已销毁 */ }
      this.audio = null
    }
    this.audioIndex = -1
    this.pausedTime = 0
    this.setData({
      playingIndex: -1,
      pausedIndex: -1,
      audioErrorIndex: -1,
      audioProgress: '',
      audioPercent: 0
    })
  }
})
