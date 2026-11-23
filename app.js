const { ensureLogin } = require('./utils/api')

App({
  globalData: {
    lang: 'de',
    level: 'A1'
  },
  onLaunch() {
    const lang = wx.getStorageSync('challenge_lang')
    const level = wx.getStorageSync('challenge_level')
    if (lang) this.globalData.lang = lang
    if (level) this.globalData.level = level
    // 静默登录，失败时页面会提示重新登录。
    ensureLogin().catch(() => {})
  }
})
