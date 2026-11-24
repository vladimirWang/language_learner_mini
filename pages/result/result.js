Page({
  data: {
    ready: false,
    hasData: false,
    title: '',
    day: '',
    score: 0,
    total: 0,
    stars: 0,
    bestStars: 0,
    starsAdded: 0,
    totalStars: 0,
    checkedIn: false,
    alreadySubmitted: false,
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
      stars: result.stars || 0,
      bestStars: result.best_stars || 0,
      starsAdded: result.stars_added || 0,
      totalStars: result.total_stars || 0,
      checkedIn: result.checked_in === true || result.passed === true,
      alreadySubmitted: result.already_submitted === true,
      passed: result.passed,
      streak: result.streak || null,
      items: result.items || []
    })
  },

  goHome() {
    wx.reLaunch({ url: '/pages/index/index' })
  }
})
