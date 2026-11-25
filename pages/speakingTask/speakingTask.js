// 口语任务：人机对话（气泡图）。流程：
// 考官文本 → TTS 播放 → 播完自动开麦 → 静音检测自动结束 → ASR → 语法分析 + 追问 → 循环。
// 不使用「开始录音」按钮；录音结束由静音检测决定，另提供手动结束和 30 秒超时兜底。
const api = require('../../utils/api')
const permissions = require('../../utils/permissions')

const SAMPLE_RATE = 16000
const FRAME_MS = 128 // frameSize=4KB，16k 单声道 16bit ≈ 128ms
const MAX_FOLLOWUPS = 2
const MAX_RECORD_MS = 30000
const SILENCE_MS = 1100
const MIN_SPEECH_MS = 400
const SPEECH_RMS = 0.02

const TYPE_LABELS = {
  speaking: '口语',
  speaking_topic: '口语话题',
  speaking_plan: '口语计划'
}

/** 逐帧计算 16bit PCM 的音量（RMS，0~1）。 */
function frameRms(buffer) {
  const pcm = new Int16Array(buffer)
  if (!pcm.length) return 0
  let sum = 0
  for (let i = 0; i < pcm.length; i += 1) {
    const value = pcm[i] / 32768
    sum += value * value
  }
  return Math.sqrt(sum / pcm.length)
}

/** 把 PCM 帧拼成 16bit 单声道 WAV（小程序 RecorderManager 只给裸 PCM）。 */
function wavFromChunks(chunks, sampleRate) {
  let dataSize = 0
  chunks.forEach((chunk) => { dataSize += chunk.byteLength })
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)
  const writeText = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i))
  }
  writeText(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeText(8, 'WAVE')
  writeText(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeText(36, 'data')
  view.setUint32(40, dataSize, true)
  const bytes = new Uint8Array(buffer)
  let offset = 44
  chunks.forEach((chunk) => {
    bytes.set(new Uint8Array(chunk), offset)
    offset += chunk.byteLength
  })
  return buffer
}

/** 解析要点：单个要点内用 | 分隔同义表达。 */
function parsePoints(raw) {
  return String(raw || '')
    .split(/[;；\n]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function coveredPoints(text, points) {
  const answer = String(text || '').toLowerCase()
  if (!answer) return []
  return points.filter((point) => {
    const synonyms = point.split('|').map((s) => s.trim().toLowerCase()).filter(Boolean)
    return synonyms.some((word) => answer.indexOf(word) >= 0)
  })
}

Page({
  data: {
    levelId: '',
    itemType: '',
    examId: '',
    level: 'A1',
    title: '',
    typeLabel: '口语',
    loading: true,
    error: '',
    plan: null,
    items: [],
    messages: [],
    currentIndex: 0,
    phase: 'idle',
    statusText: '',
    recording: false,
    recordingSeconds: 0,
    micDenied: false,
    showGrammar: {},
    summary: null,
    scrollInto: ''
  },

  onLoad(options) {
    const opts = options || {}
    const decode = (value) => (value ? decodeURIComponent(value) : '')
    this.setData({
      levelId: decode(opts.levelId),
      itemType: decode(opts.itemType),
      examId: decode(opts.examId),
      level: (decode(opts.level) || 'A1').toUpperCase(),
      title: decode(opts.name),
      typeLabel: TYPE_LABELS[decode(opts.itemType)] || '口语'
    })
    if (opts.name) wx.setNavigationBarTitle({ title: decode(opts.name) })
    this.msgSeq = 0
    this.sessionId = 0
    this.exchange = 0
    this.grammarErrors = 0
    this.answeredItems = 0
    this.started = false
    this.audio = null
    this.recorder = null
    this.initRecorder()
    this.load()
  },

  onShow() {
    // 从设置页返回后，如果之前因权限暂停，自动重新开始。
    if (this.data.micDenied && !this.data.loading && !this.data.summary && !this.started) {
      permissions.getMicPermission().then((status) => {
        if (status === 'granted' && !this.started) {
          this.setData({ micDenied: false })
          this.startSession()
        }
      })
    }
  },

  onHide() {
    this.pauseSession()
  },

  onUnload() {
    this.pauseSession()
    this.releaseAudio()
    if (this.recorder) {
      try { this.recorder.stop() } catch (err) { /* 未在录音 */ }
    }
  },

  // ---------------- 数据加载 ----------------

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
      const speaking = (data && data.speaking) || {}
      const items = mapSpeakingItems(speaking.items)
      const title = (data && data.title) || this.data.title || '口语任务'
      this.setData({
        title: title,
        typeLabel: TYPE_LABELS[itemType] || this.data.typeLabel,
        plan: speaking.plan ? { name: speaking.plan.name || '', description: speaking.plan.description || '' } : null,
        items: items
      })
      if (title) wx.setNavigationBarTitle({ title: title })
      if (!items.length) {
        this.setData({ error: '该口语任务暂无题目' })
        return
      }
      this.prepareStart()
    } catch (error) {
      this.setData({ error: (error && error.message) || '口语任务加载失败' })
    } finally {
      this.setData({ loading: false })
    }
  },

  async prepareStart() {
    const status = await permissions.ensureMicPermission()
    if (status === 'granted') {
      this.setData({ micDenied: false })
      this.startSession()
      return
    }
    this.setData({ micDenied: true, phase: 'idle', statusText: '需要麦克风权限才能开始口语测试' })
  },

  // ---------------- 会话推进 ----------------

  startSession() {
    if (this.started || !this.data.items.length) return
    this.started = true
    this.sessionId += 1
    this.exchange = 0
    this.grammarErrors = 0
    this.answeredItems = 0
    this.setData({ messages: [], summary: null, showGrammar: {}, currentIndex: 0 })
    this.askQuestion(0)
  },

  askQuestion(index) {
    const session = this.sessionId
    const item = this.data.items[index]
    if (!item) {
      this.finish()
      return
    }
    this.exchange = 0
    this.currentPoints = parsePoints(item.expectedPoints)
    this.currentCovered = []
    this.setData({ currentIndex: index, phase: 'speaking', statusText: '考官正在说话' })
    const message = this.pushMessage('examiner', item.promptDe)
    this.speak(message.text).then(() => {
      if (session === this.sessionId && !this.preventRecord) this.startRecording()
    })
  },

  async handleUserAnswer(text) {
    const session = this.sessionId
    const item = this.data.items[this.data.currentIndex]
    if (!item) return
    const answer = String(text || '').trim()
    if (!answer) {
      this.setData({ phase: 'idle', statusText: '没有听清，再说一次吧' })
      return
    }
    this.pushMessage('user', answer)
    this.exchange += 1
    if (this.exchange === 1) {
      this.answeredItems += 1
      this.currentCovered = coveredPoints(answer, this.currentPoints || [])
    }
    this.checkGrammar(answer, item)

    if (this.exchange <= MAX_FOLLOWUPS) {
      this.setData({ phase: 'thinking', statusText: '考官正在回应' })
      try {
        const reply = await api.request('/api/speaking/reply', {
          method: 'POST',
          data: {
            lang: 'de',
            level: this.data.level,
            exam_part: item.examPart || 'part1_intro',
            topic: item.topic,
            role: item.role === 'partner' ? 'partner' : 'examiner',
            history: this.currentHistory(),
            followup_count: this.exchange,
            prompt_de: item.promptDe,
            expected_points: item.expectedPoints,
            covered_points: this.currentCovered,
            missing_points: (this.currentPoints || []).filter((point) => this.currentCovered.indexOf(point) < 0)
          }
        })
        if (session !== this.sessionId) return
        const text2 = (reply && reply.reply) || ''
        if (!text2) {
          this.startRecording()
          return
        }
        this.pushMessage('examiner', text2)
        await this.speak(text2)
        if (session === this.sessionId && !this.preventRecord) this.startRecording()
      } catch (err) {
        if (session !== this.sessionId) return
        this.setData({ phase: 'idle', statusText: '网络不稳定，点击继续' })
      }
      return
    }
    // 本题追问次数用尽，进入下一题。
    const nextIndex = this.data.currentIndex + 1
    if (nextIndex >= this.data.items.length) {
      this.finish()
      return
    }
    this.askQuestion(nextIndex)
  },

  currentHistory() {
    const item = this.data.items[this.data.currentIndex]
    const messages = this.data.messages
    let start = 0
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === 'examiner' && messages[i].text === (item && item.promptDe)) {
        start = i
        break
      }
    }
    return messages.slice(start).map((msg) => ({
      role: msg.role === 'user' ? 'user' : 'assistant',
      text: msg.text
    }))
  },

  checkGrammar(answer, item) {
    const messageId = this.lastUserId
    api.request('/api/speaking/check', {
      method: 'POST',
      data: {
        lang: 'de',
        level: this.data.level,
        topic: item.topic,
        prompt_de: item.promptDe,
        answer: answer
      }
    }).then((result) => {
      if (!result || result.source !== 'llm') return
      const errors = Array.isArray(result.errors) ? result.errors : []
      this.grammarErrors += errors.length
      const messages = this.data.messages.map((msg) => {
        if (msg.id !== messageId) return msg
        return Object.assign({}, msg, {
          checking: false,
          grammar: {
            corrected: result.corrected || '',
            comment: result.comment || '',
            errors: errors
          }
        })
      })
      this.setData({ messages: messages })
    }).catch(() => {
      const messages = this.data.messages.map((msg) => (
        msg.id === messageId ? Object.assign({}, msg, { checking: false }) : msg
      ))
      this.setData({ messages: messages })
    })
  },

  finish() {
    this.sessionId += 1
    this.preventRecord = true
    this.setData({ recording: false, micDenied: false })
    this.stopRecordingSilently()
    this.releaseAudio()
    const userMessages = this.data.messages.filter((msg) => msg.role === 'user')
    this.setData({
      phase: 'done',
      statusText: '',
      summary: {
        items: this.answeredItems,
        exchanges: userMessages.length,
        grammarErrors: this.grammarErrors
      }
    })
  },

  restart() {
    this.started = false
    this.preventRecord = false
    this.setData({ summary: null })
    this.startSession()
  },

  goBack() {
    wx.navigateBack({ delta: 1 })
  },

  // ---------------- 消息与播报 ----------------

  pushMessage(role, text) {
    this.msgSeq += 1
    const message = {
      id: 'm' + this.msgSeq,
      role: role,
      text: text,
      checking: role === 'user',
      grammar: null
    }
    if (role === 'user') this.lastUserId = message.id
    this.setData({
      messages: this.data.messages.concat([message]),
      scrollInto: message.id
    })
    return message
  },

  speak(text) {
    const session = this.sessionId
    return api.request('/api/speaking/tts', {
      method: 'POST',
      data: { text: text, lang: 'de' }
    }).then((result) => {
      if (session !== this.sessionId || !result || !result.audio) return null
      return this.playBase64(result.audio, result.mime)
    }).catch(() => null)
  },

  playBase64(base64, mime) {
    const session = this.sessionId
    return new Promise((resolve) => {
      const ext = /wav/.test(mime || '') ? 'wav' : 'mp3'
      const filePath = wx.env.USER_DATA_PATH + '/tts-' + Date.now() + '.' + ext
      let done = false
      const finish = () => {
        if (done) return
        done = true
        resolve(null)
      }
      try {
        wx.getFileSystemManager().writeFile({
          filePath: filePath,
          data: base64,
          encoding: 'base64',
          success: () => {
            if (session !== this.sessionId) { finish(); return }
            this.releaseAudio()
            const ctx = wx.createInnerAudioContext()
            this.audio = ctx
            ctx.src = filePath
            ctx.obeyMuteSwitch = false
            ctx.onEnded(finish)
            ctx.onError(finish)
            try { ctx.play() } catch (err) { finish() }
            // 播报缺失 onEnded 时兜底，避免一直停在“考官正在说话”。
            setTimeout(finish, 15000)
          },
          fail: finish
        })
      } catch (err) {
        finish()
      }
    })
  },

  releaseAudio() {
    if (!this.audio) return
    try { this.audio.stop() } catch (err) { /* 已停止 */ }
    try { this.audio.destroy() } catch (err) { /* 已销毁 */ }
    this.audio = null
  },

  // ---------------- 录音（静音自动结束） ----------------

  initRecorder() {
    const recorder = wx.getRecorderManager()
    this.recorder = recorder
    this.chunks = []
    this.speechMs = 0
    this.silenceMs = 0
    this.hasSpeech = false
    this.frameSeen = false
    this.recordMode = 'pcm'
    this.stopping = false

    recorder.onFrameRecorded((res) => {
      if (!this.data.recording || !res || !res.frameBuffer) return
      this.frameSeen = true
      this.chunks.push(res.frameBuffer)
      const rms = frameRms(res.frameBuffer)
      if (rms > SPEECH_RMS) {
        this.hasSpeech = true
        this.speechMs += FRAME_MS
        this.silenceMs = 0
      } else if (this.hasSpeech) {
        this.silenceMs += FRAME_MS
        if (this.silenceMs >= SILENCE_MS && this.speechMs >= MIN_SPEECH_MS) {
          this.stopRecording()
        }
      }
    })

    recorder.onStop((res) => {
      if (this.switchingMode) {
        // 从 PCM 切到 mp3 的中间态，不算一次作答。
        this.switchingMode = false
        this.setData({ recording: false })
        return
      }
      if (!this.data.recording) return
      this.setData({ recording: false, phase: 'recognizing', statusText: '正在识别你的回答' })
      clearInterval(this.recordTimer)
      if (this.recordMode === 'pcm') {
        this.handlePcmStop()
      } else {
        this.handleFileStop(res && res.tempFilePath)
      }
    })

    recorder.onError(() => {
      this.setData({ recording: false, phase: 'idle', statusText: '录音失败，点击继续说' })
      clearInterval(this.recordTimer)
    })
  },

  async startRecording() {
    if (this.preventRecord || this.data.phase === 'done' || this.data.summary) return
    const status = await permissions.getMicPermission()
    if (status !== 'granted') {
      this.setData({ micDenied: true, phase: 'idle', statusText: '麦克风权限未开启' })
      return
    }
    this.releaseAudio()
    this.chunks = []
    this.speechMs = 0
    this.silenceMs = 0
    this.hasSpeech = false
    this.frameSeen = false
    this.stopping = false
    this.recordMode = 'pcm'
    this.recordStartAt = Date.now()
    this.setData({
      recording: true,
      phase: 'recording',
      statusText: '正在聆听，说完停顿一下即可',
      recordingSeconds: 0
    })
    clearInterval(this.recordTimer)
    this.recordTimer = setInterval(() => {
      const seconds = Math.floor((Date.now() - this.recordStartAt) / 1000)
      this.setData({ recordingSeconds: seconds })
    }, 500)

    try {
      this.recorder.start({
        duration: MAX_RECORD_MS,
        sampleRate: SAMPLE_RATE,
        numberOfChannels: 1,
        encodeBitRate: 48000,
        format: 'PCM',
        frameSize: 4
      })
    } catch (err) {
      this.setData({ recording: false, phase: 'idle', statusText: '无法启动录音' })
      clearInterval(this.recordTimer)
      return
    }

    // 部分基础库拿不到 PCM 帧：2 秒仍无帧就改用 mp3 固定 8 秒兜底。
    setTimeout(() => {
      if (!this.data.recording || this.frameSeen) return
      this.recordMode = 'mp3'
      this.stopping = true
      this.switchingMode = true
      try { this.recorder.stop() } catch (err) { /* 已停止 */ }
      setTimeout(() => this.startFallbackRecording(), 250)
    }, 2000)
  },

  startFallbackRecording() {
    if (this.preventRecord || this.data.phase === 'done') return
    this.recordMode = 'mp3'
    this.stopping = false
    this.recordStartAt = Date.now()
    this.setData({ recording: true, phase: 'recording', statusText: '正在聆听…', recordingSeconds: 0 })
    try {
      this.recorder.start({
        duration: 8000,
        sampleRate: SAMPLE_RATE,
        numberOfChannels: 1,
        encodeBitRate: 48000,
        format: 'mp3'
      })
    } catch (err) {
      this.setData({ recording: false, phase: 'idle', statusText: '无法启动录音' })
    }
  },

  stopRecording() {
    if (!this.data.recording || this.stopping) return
    this.stopping = true
    try { this.recorder.stop() } catch (err) { /* 已停止 */ }
  },

  stopRecordingSilently() {
    if (this.recorder && this.data.recording) {
      try { this.recorder.stop() } catch (err) { /* 已停止 */ }
    }
    clearInterval(this.recordTimer)
  },

  handlePcmStop() {
    if (!this.chunks.length) {
      this.setData({ phase: 'idle', statusText: '没有录到声音，点击继续说' })
      return
    }
    const wav = wavFromChunks(this.chunks, SAMPLE_RATE)
    const filePath = wx.env.USER_DATA_PATH + '/answer-' + Date.now() + '.wav'
    wx.getFileSystemManager().writeFile({
      filePath: filePath,
      data: wav,
      success: () => this.uploadAnswer(filePath, 'audio/wav'),
      fail: () => this.setData({ phase: 'idle', statusText: '保存录音失败，点击重试' })
    })
  },

  handleFileStop(tempFilePath) {
    if (!tempFilePath) {
      this.setData({ phase: 'idle', statusText: '没有录到声音，点击继续说' })
      return
    }
    this.uploadAnswer(tempFilePath, 'audio/mpeg')
  },

  uploadAnswer(filePath, mime) {
    const session = this.sessionId
    this.setData({ phase: 'recognizing', statusText: '正在识别你的回答' })
    api.transcribeSpeaking(filePath, 'de', mime).then((text) => {
      if (session !== this.sessionId) return
      if (!text) {
        this.setData({ phase: 'idle', statusText: '没有识别到语音，点击继续说' })
        return
      }
      this.handleUserAnswer(text)
    }).catch((err) => {
      if (session !== this.sessionId) return
      this.setData({ phase: 'idle', statusText: (err && err.message) || '识别失败，点击重试' })
    })
  },

  // ---------------- 交互 ----------------

  onMicTap() {
    this.setData({ micDenied: false })
    this.startSession()
  },

  onOpenSetting() {
    permissions.openMicSetting().then((granted) => {
      if (granted) {
        this.setData({ micDenied: false })
        if (!this.started) this.startSession()
      }
    })
  },

  onTapContinue() {
    if (this.data.micDenied) {
      this.onOpenSetting()
      return
    }
    this.preventRecord = false
    const messages = this.data.messages
    const last = messages[messages.length - 1]
    if (last && last.role === 'examiner') {
      this.speak(last.text).then(() => this.startRecording())
      return
    }
    this.startRecording()
  },

  toggleGrammar(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    const next = Object.assign({}, this.data.showGrammar)
    next[id] = !next[id]
    this.setData({ showGrammar: next })
  },

  pauseSession() {
    clearInterval(this.recordTimer)
    this.preventRecord = true
    this.stopRecordingSilently()
    this.releaseAudio()
    if (this.started && !this.data.summary) {
      this.setData({ recording: false, phase: 'idle', statusText: '已暂停，点击继续' })
    }
  }
})

function mapSpeakingItems(rawItems) {
  return (Array.isArray(rawItems) ? rawItems : []).map((item) => ({
    key: item.item_key || '',
    topic: item.topic || '',
    role: item.role || 'examiner',
    examPart: item.exam_part || '',
    promptDe: item.prompt_de || '',
    promptZh: item.prompt_zh || '',
    expectedPoints: item.expected_points || '',
    refAnswer: item.ref_answer || '',
    errorNote: item.error_note || ''
  })).filter((item) => item.promptDe)
}

module.exports = {
  frameRms: frameRms,
  wavFromChunks: wavFromChunks,
  parsePoints: parsePoints,
  coveredPoints: coveredPoints,
  mapSpeakingItems: mapSpeakingItems
}
