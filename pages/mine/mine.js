// 我的：展示登录状态、学习偏好、连续打卡，并提供重置进度入口。
const api = require('../../utils/api.js')

const LANG_LABELS = { de: '德语', en: '英语', ja: '日语' }

Page({
  data: {
    loggedIn: false,
    lang: 'de',
    level: 'A1',
    langLabel: '德语',
    streak: { current: 0, longest: 0, last_day: null },
    loading: true
  },

  onShow() {
    this.refresh()
  },

  async refresh() {
    const app = getApp()
    const lang = (app && app.globalData.lang) || wx.getStorageSync('challenge_lang') || 'de'
    const level = (app && app.globalData.level) || wx.getStorageSync('challenge_level') || 'A1'
    this.setData({
      loggedIn: !!api.getToken(),
      lang: lang,
      level: level,
      langLabel: LANG_LABELS[lang] || lang,
      loading: true
    })
    try {
      await api.ensureLogin()
      const data = await api.request('/api/levels/streak?lang=' + lang)
      this.setData({ streak: (data && data.streak) || this.data.streak })
    } catch (e) {
      // 我的页以展示为主， streak 拉取失败静默处理，不阻塞页面
    } finally {
      this.setData({ loading: false })
    }
  },

  onReset() {
    wx.showModal({
      title: '重置进度',
      content: '确定清空所有关卡进度、连续天数与答题记录吗？此操作不可撤销。',
      confirmColor: '#C0392B',
      success: (res) => {
        if (!res.confirm) return
        try {
          ;['wx_token', 'challenge_lang', 'challenge_level', 'last_challenge_result'].forEach((k) => {
            wx.removeStorageSync(k)
          })
        } catch (e) { /* 忽略存储异常 */ }
        wx.showToast({ title: '已重置', icon: 'success' })
        this.refresh()
      }
    })
  }
})
