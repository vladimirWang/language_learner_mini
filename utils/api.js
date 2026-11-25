// 后端地址与请求封装。
// 环境区分（按 wx.getAccountInfoSync().miniProgram.envVersion）：
//   develop（开发版）   → http://127.0.0.1:8080（本地后端；开发者工具模拟器可直连，真机需改成电脑局域网 IP）
//   trial / release    → https://mp.hetou.vip:5443（线上，nginx 把 /api/ 反代到后端）
// 真机调试覆盖：在 app.js 的 onLaunch 里设置 getApp().globalData.apiBase = 'http://<电脑局域网IP>:8080'。
// 微信「合法域名」支持带端口，线上后台配 https://mp.hetou.vip:5443（已实测 443 不通、5443 正常）。

// 请求超时（方案第 7 节：建议 10 秒）。
const REQUEST_TIMEOUT = 10000
const DEV_BASE_URL = 'http://127.0.0.1:8080'
const PROD_BASE_URL = 'https://mp.hetou.vip:5443'
const TOKEN_KEY = 'wx_token'
const session = require('./store/session.js')

/** 当前小程序环境版本；取不到时按线上处理，避免开发配置误入正式版。 */
function detectEnvVersion() {
  try {
    if (typeof wx !== 'undefined' && typeof wx.getAccountInfoSync === 'function') {
      const info = wx.getAccountInfoSync()
      if (info && info.miniProgram && info.miniProgram.envVersion) return info.miniProgram.envVersion
    }
  } catch (e) { /* 基础库不支持时按线上处理 */ }
  return 'release'
}

/** 运行时解析后端地址：globalData.apiBase 覆盖优先，否则按环境选择。 */
function getBaseUrl() {
  try {
    const app = typeof getApp === 'function' ? getApp() : null
    if (app && app.globalData && app.globalData.apiBase) {
      return String(app.globalData.apiBase).replace(/\/+$/, '')
    }
  } catch (e) { /* App 尚未初始化时按环境判断 */ }
  return detectEnvVersion() === 'develop' ? DEV_BASE_URL : PROD_BASE_URL
}

// 兼容原有导出的常量（取模块加载时的环境值）；请求内部一律用 getBaseUrl() 动态解析。
const BASE_URL = getBaseUrl()

// 登录失败/无配置的错误文案，供页面直接展示，不循环重试。
const SERVICE_UNAVAILABLE = '服务暂未开放'

function getToken() {
  return wx.getStorageSync(TOKEN_KEY) || ''
}

function clearToken() {
  try {
    wx.removeStorageSync(TOKEN_KEY)
  } catch (e) { /* 忽略存储异常 */ }
}

// 服务端返回的 user 是等级/身份权威值，统一写入全局 store。
function syncUser(data) {
  if (data && data.user) session.setUser(data.user)
}

function errorMessage(res) {
  if (res && res.data && typeof res.data === 'object' && res.data.error) {
    return String(res.data.error)
  }
  if (res && typeof res.data === 'string' && res.data) return res.data
  return '请求失败（' + ((res && res.statusCode) || '未知') + '）'
}

/**
 * 统一请求。
 * - auth 默认开启：自动带 Authorization: Bearer <token>
 * - 401：清 token → 重新登录 → 重试原请求一次（retried 标记防止死循环）
 * - 503： reject "服务暂未开放"，不重登不重试
 * - 其他非 2xx：展示后端 error 字段
 * @param {string} path
 * @param {object} options { method, data, auth, header }
 * @param {boolean} _retried 内部标记，业务方不要传
 */
function request(path, options, _retried) {
  const opts = options || {}
  const auth = opts.auth !== false
  return new Promise((resolve, reject) => {
    const header = Object.assign({ 'Content-Type': 'application/json' }, opts.header || {})
    const token = getToken()
    if (auth && token) header.Authorization = 'Bearer ' + token

    wx.request({
      url: getBaseUrl() + path,
      method: opts.method || 'GET',
      data: opts.data,
      header: header,
      timeout: REQUEST_TIMEOUT,
      success(res) {
        const status = res && res.statusCode
        if (status >= 200 && status < 300) {
          resolve(res.data)
          return
        }
        if (status === 503) {
          reject(new Error(SERVICE_UNAVAILABLE))
          return
        }
        if (status === 401 && auth && !_retried) {
          // 身份失效：清 token 重新登录，再重试原请求一次。
          clearToken()
          login().then(() => {
            request(path, options, true).then(resolve).catch(reject)
          }).catch(reject)
          return
        }
        const err = new Error(errorMessage(res))
        err.statusCode = status
        reject(err)
      },
      fail(err) {
        reject(new Error((err && err.errMsg) || '网络异常'))
      }
    })
  })
}

/** 微信一键登录：wx.login 拿 code → 后端换 token → 存储。 */
function login() {
  return new Promise((resolve, reject) => {
    wx.login({
      success(res) {
        if (!res.code) {
          reject(new Error('微信登录未返回 code'))
          return
        }
        request('/api/auth/wx-login', {
          method: 'POST',
          data: { code: res.code },
          auth: false
        }).then((data) => {
          if (data && data.token) {
            wx.setStorageSync(TOKEN_KEY, data.token)
            syncUser(data)
            resolve(data)
          } else {
            reject(new Error('登录响应缺少 token'))
          }
        }).catch(reject)
      },
      fail(err) {
        reject(new Error((err && err.errMsg) || '微信登录失败'))
      }
    })
  })
}

/** 确保已登录：有 token 直接用，否则静默登录。 */
function ensureLogin() {
  if (getToken()) return Promise.resolve(getToken())
  return login().then(() => getToken())
}

function getMe() {
  return request('/api/auth/wx-me').then((data) => {
    syncUser(data)
    return data
  })
}

/** 按方案 §4.2：nickname / level 至少传一项；成功后同步 store。 */
function updateProfile(profile) {
  const payload = profile || {}
  return request('/api/auth/wx-profile', {
    method: 'PUT',
    data: payload
  }).then((data) => {
    syncUser(data)
    return data
  })
}

function updateNickname(nickname) {
  return updateProfile({ nickname: nickname })
}

function updateLevel(level) {
  return updateProfile({ level: level })
}

/** 上传微信头像；401 重登后仅重试一次，网络错误与 503 不重试。 */
function uploadAvatar(filePath, _retried) {
  return new Promise((resolve, reject) => {
    const header = {}
    const token = getToken()
    if (token) header.Authorization = 'Bearer ' + token
    wx.uploadFile({
      url: getBaseUrl() + '/api/auth/wx-avatar',
      filePath,
      name: 'avatar',
      header,
      timeout: REQUEST_TIMEOUT,
      success(res) {
        const status = res && res.statusCode
        let data = res && res.data
        if (typeof data === 'string') {
          try { data = JSON.parse(data) } catch (e) { data = { error: data } }
        }
        const response = { statusCode: status, data }
        if (status >= 200 && status < 300) {
          syncUser(data)
          resolve(data)
          return
        }
        if (status === 503) {
          reject(new Error(SERVICE_UNAVAILABLE))
          return
        }
        if (status === 401 && !_retried) {
          clearToken()
          login().then(() => {
            uploadAvatar(filePath, true).then(resolve).catch(reject)
          }).catch(reject)
          return
        }
        const err = new Error(errorMessage(response))
        err.statusCode = status
        reject(err)
      },
      fail(err) {
        reject(new Error((err && err.errMsg) || '网络异常'))
      }
    })
  })
}

/**
 * 口语录音转写：录音先读成 base64，走普通 JSON 请求。
 * 真机上 wx.uploadFile 经调试代理容易超时，后端因此提供了 base64 入口。
 * @param {string} filePath 本地录音文件
 * @param {string} lang 题目语种（de/en/...）
 * @param {string} mime audio/wav 或 audio/mpeg
 */
function transcribeSpeaking(filePath, lang, mime) {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().readFile({
      filePath: filePath,
      encoding: 'base64',
      success(res) {
        request('/api/speaking/transcribe-base64', {
          method: 'POST',
          data: {
            audio: res.data,
            mime: mime || 'audio/wav',
            lang: lang || 'de'
          }
        }).then((data) => {
          if (data && typeof data.text === 'string' && data.text.trim()) resolve(data.text.trim())
          else reject(new Error('没有识别到语音'))
        }).catch(reject)
      },
      fail() {
        reject(new Error('读取录音失败'))
      }
    })
  })
}

module.exports = {
  BASE_URL: BASE_URL,
  DEV_BASE_URL: DEV_BASE_URL,
  PROD_BASE_URL: PROD_BASE_URL,
  getBaseUrl: getBaseUrl,
  detectEnvVersion: detectEnvVersion,
  SERVICE_UNAVAILABLE: SERVICE_UNAVAILABLE,
  getToken: getToken,
  clearToken: clearToken,
  logout: function logout() {
    clearToken()
    session.clear()
  },
  request: request,
  login: login,
  ensureLogin: ensureLogin,
  getMe: getMe,
  updateProfile: updateProfile,
  updateNickname: updateNickname,
  updateLevel: updateLevel,
  uploadAvatar: uploadAvatar,
  transcribeSpeaking: transcribeSpeaking
}
