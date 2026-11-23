Page({
  data: {
    ready: false,
    hasData: false,
    title: '',
    day: '',
    score: 0,
    total: 0,
    passed: false,
    streak: null,
    items: []
  },

  onLoad() {
    const cached = wx.getStorageSync('last_challenge_result')
    if (!cached || !cached.result) {
      this.setData({ ready: true, hasData: false })
      return
    }
    const result = cached.result
    this.setData({
      ready: true,
      hasData: true,
      title: cached.title,
      day: cached.day,
      score: result.score,
      total: result.total,
      passed: result.passed,
      streak: result.streak || null,
      items: result.items || []
    })
  },

  goHome() {
    wx.reLaunch({ url: '/pages/index/index' })
  }
})
