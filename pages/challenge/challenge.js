const { request, ensureLogin } = require('../../utils/api')

Page({
  data: {
    loading: true,
    error: '',
    submitting: false,
    challenge: null,
    items: [],
    attempt: null,
    lang: 'de',
    level: 'A1'
  },

  onLoad(query) {
    this.setData({
      lang: query.lang || 'de',
      level: query.level || 'A1'
    })
    this.load(query.day || '')
  },

  async load(day) {
    this.setData({ loading: true, error: '' })
    try {
      await ensureLogin()
      const data = await request(
        '/api/levels/today?lang=' + this.data.lang + '&level=' + this.data.level
      )
      if (!data.challenge) {
        this.setData({ error: '今天的关卡还没有发布' })
        return
      }
      if (day && data.challenge.day !== day) {
        this.setData({ error: '关卡日期已变化，请返回首页刷新' })
        return
      }
      const answers = (data.attempt && data.attempt.answers) || []
      const selectedBySeq = {}
      answers.forEach((answer) => { selectedBySeq[answer.seq] = answer.value })
      const items = data.challenge.items.map((item) => {
        const selected = selectedBySeq[item.seq] || ''
        const selectedIndex = item.prompt.options.indexOf(selected)
        return {
          seq: item.seq,
          kind: item.kind,
          prompt: item.prompt,
          selectedIndex,
          selected: selectedIndex >= 0 ? selected : ''
        }
      })
      this.setData({
        challenge: data.challenge,
        items,
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
      return {
        seq: item.seq,
        kind: item.kind,
        prompt: item.prompt,
        selectedIndex: index,
        selected: item.prompt.options[index]
      }
    })
    this.setData({ items })
  },

  retry() {
    this.load('')
  },

  async submit() {
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
      const result = await request('/api/levels/' + this.data.challenge.id + '/submit', {
        method: 'POST',
        data: { answers }
      })
      wx.setStorageSync('last_challenge_result', {
        title: this.data.challenge.title,
        day: this.data.challenge.day,
        result
      })
      wx.redirectTo({ url: '/pages/result/result' })
    } catch (error) {
      // 403 关卡已关闭 / 404 关卡不存在：提示后返回首页刷新（方案第 7 节）。
      if (error.statusCode === 403) {
        wx.showModal({
          title: '关卡已关闭',
          content: '该关卡已关闭，请返回首页刷新',
          showCancel: false,
          success: () => wx.reLaunch({ url: '/pages/index/index' })
        })
      } else if (error.statusCode === 404) {
        wx.showModal({
          title: '关卡不存在',
          content: '请返回首页刷新',
          showCancel: false,
          success: () => wx.reLaunch({ url: '/pages/index/index' })
        })
      } else {
        wx.showModal({ title: '提交失败', content: error.message || '请稍后重试', showCancel: false })
      }
    } finally {
      this.setData({ submitting: false })
    }
  }
})
