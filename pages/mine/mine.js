// 我的：展示登录状态、学习偏好、连续打卡，并提供重置进度入口。
const api = require('../../utils/api.js')

const LANG_LABELS = { de: '德语', en: '英语', ja: '日语' }

Page({
  data: {
    loggedIn: false,
    lang: 'de',
    level: 'A1',
    langLabel: '德语',
    user: null,
    nickname: '微信用户',
    draftNickname: '',
    avatarPreview: '',
    pendingAvatarPath: '',
    totalStars: 0,
    streak: { current: 0, longest: 0, last_day: null },
    loading: true,
    saving: false,
    loadError: ''
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
      lang,
      level,
      langLabel: LANG_LABELS[lang] || lang,
      loading: true,
      loadError: ''
    })
    try {
      await api.ensureLogin()
      const [me, streakData] = await Promise.all([
        api.getMe(),
        api.request('/api/levels/streak?lang=' + lang).catch(() => null)
      ])
      const user = (me && me.user) || {}
      this.setData({
        loggedIn: true,
        user,
        nickname: user.nickname || '微信用户',
        draftNickname: user.nickname || '',
        avatarPreview: user.avatar || '',
        pendingAvatarPath: '',
        totalStars: user.total_stars || 0,
        streak: (streakData && streakData.streak) || this.data.streak
      })
    } catch (e) {
      this.setData({ loadError: e.message || '用户信息加载失败' })
    } finally {
      this.setData({ loading: false })
    }
  },

  onChooseAvatar(e) {
    const filePath = e.detail && e.detail.avatarUrl
    if (!filePath) return
    this.setData({ pendingAvatarPath: filePath, avatarPreview: filePath })
  },

  onNicknameInput(e) {
    this.setData({ draftNickname: e.detail.value })
  },

  async onSaveProfile() {
    if (this.data.saving) return
    const nickname = (this.data.draftNickname || '').trim()
    const currentNickname = (this.data.user && this.data.user.nickname) || ''
    const avatarPath = this.data.pendingAvatarPath
    if (!avatarPath && !nickname) {
      wx.showToast({ title: '请输入昵称', icon: 'none' })
      return
    }
    if (!avatarPath && nickname === currentNickname) {
      wx.showToast({ title: '资料没有变化', icon: 'none' })
      return
    }
    this.setData({ saving: true })
    try {
      await api.ensureLogin()
      if (avatarPath) await api.uploadAvatar(avatarPath)
      if (nickname && nickname !== currentNickname) await api.updateNickname(nickname)
      wx.showToast({ title: '资料已保存', icon: 'success' })
      await this.refresh()
    } catch (e) {
      wx.showModal({ title: '保存失败', content: e.message || '请稍后重试', showCancel: false })
    } finally {
      this.setData({ saving: false })
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
