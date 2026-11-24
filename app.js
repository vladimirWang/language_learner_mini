const api = require('./utils/api')
const session = require('./utils/store/session')

App({
  onLaunch() {
    // 先恢复本地偏好；lang 暂固定 de，level 缓存只作初始展示，服务端值随后覆盖。
    try { wx.setStorageSync('challenge_lang', 'de') } catch (e) { /* 忽略存储异常 */ }
    const cachedLevel = wx.getStorageSync('challenge_level') || 'A1'
    session.setLevel(cachedLevel)

    // 静默登录，登录响应中的 user 由 api.login 写入 store；再拉一次 /wx-me 校正服务端最新资料。
    api.ensureLogin()
      .then(() => api.getMe())
      .catch(() => { /* 页面会展示错误与重试入口 */ })
  }
})
