// 我的：微信资料、累计星星、学习偏好与连续签到。等级修改必须先持久化到后端。
// 小程序当前只承载德语学习，等级只提供德语 CEFR 档位，不展示语种。
const api = require('../../utils/api.js')
const session = require('../../utils/store/session.js')

const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2']
const AVATAR_EXT = /\.(jpe?g|png|webp)$/i
const MAX_AVATAR_BYTES = 5 * 1024 * 1024

Page({
  data: {
    loggedIn: false,
    level: 'A1',
    levels: LEVELS,
    levelIndex: 0,
    user: null,
    nickname: '微信用户',
    draftNickname: '',
    avatarPreview: '',
    pendingAvatarPath: '',
    totalStars: 0,
    streak: { current: 0, longest: 0, last_day: '' },
    loading: true,
    saving: false,
    loadError: ''
  },

  onLoad() {
    this.applyState(session.getState())
    this.unsubscribe = session.subscribe((state) => this.applyState(state))
  },

  onUnload() {
    if (this.unsubscribe) this.unsubscribe()
  },

  onShow() {
    this.refresh()
  },

  applyState(state) {
    this.setData({
      loggedIn: !!state.user,
      level: state.level,
      levelIndex: Math.max(0, LEVELS.indexOf(state.level)),
      user: state.user
    })
  },

  async refresh() {
    this.setData({ loading: true, loadError: '' })
    try {
      await api.ensureLogin()
      const [me, streakData] = await Promise.all([
        api.getMe(),
        api.request('/api/levels/streak?lang=de').catch(() => null)
      ])
      const user = (me && me.user) || null
      // getMe 内部已同步 store；这里同步一次页面显示，避免异步通知时序差异。
      this.applyState(session.getState())
      this.setData({
        loggedIn: !!user,
        nickname: (user && user.nickname) || '微信用户',
        draftNickname: (user && user.nickname) || '',
        avatarPreview: (user && user.avatar) || '',
        pendingAvatarPath: '',
        totalStars: (user && user.total_stars) || 0,
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
    if (!AVATAR_EXT.test(filePath)) {
      wx.showToast({ title: '仅支持 JPEG / PNG / WebP 图片', icon: 'none' })
      return
    }
    wx.getFileInfo({
      filePath: filePath,
      success: (info) => {
        if (info.size > MAX_AVATAR_BYTES) {
          wx.showToast({ title: '头像不能超过 5 MiB', icon: 'none' })
          return
        }
        this.setData({ pendingAvatarPath: filePath, avatarPreview: filePath })
      },
      fail: () => wx.showToast({ title: '头像读取失败，请重试', icon: 'none' })
    })
  },

  onNicknameInput(e) {
    this.setData({ draftNickname: e.detail.value })
  },

  async onSaveProfile() {
    if (this.data.saving) return
    const nickname = (this.data.draftNickname || '').trim()
    const currentNickname = (this.data.user && this.data.user.nickname) || ''
    const avatarPath = this.data.pendingAvatarPath
    if (nickname.length > 64) {
      wx.showToast({ title: '昵称最多 64 个字符', icon: 'none' })
      return
    }
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

  goCalendar() {
    wx.navigateTo({ url: '/pages/calendar/calendar' })
  },

  async onLevelChange(e) {
    const level = LEVELS[Number(e.detail.value)]
    if (!level || level === this.data.level) return
    try {
      await api.ensureLogin()
      const data = await api.updateLevel(level)
      // 成功后才更新本地；返回值带 user 时由 api.updateLevel 注入 store。
      if (!data || !data.user) session.setLevel(level)
      wx.showToast({ title: '等级已更新', icon: 'success' })
      await this.refresh()
    } catch (err) {
      wx.showModal({ title: '等级更新失败', content: err.message || '请稍后重试', showCancel: false })
    }
  }
})
