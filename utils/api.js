// 后端地址与请求封装。
// 说明：管理台与后端 API 同入口 https://mp.hetou.vip:5443，nginx 把 /api/ 反代到后端。
// 微信「合法域名」支持带端口，后台配 https://mp.hetou.vip:5443 即可（已实测 443 不通、5443 正常）。
// 发布前确认：BASE_URL 与小程序后台 request 合法域名一致。

// 请求超时（方案第 7 节：建议 10 秒）。
const REQUEST_TIMEOUT = 10000
const BASE_URL = 'https://mp.hetou.vip:5443'
const TOKEN_KEY = 'wx_token'

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
      url: BASE_URL + path,
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

module.exports = {
  BASE_URL: BASE_URL,
  SERVICE_UNAVAILABLE: SERVICE_UNAVAILABLE,
  getToken: getToken,
  clearToken: clearToken,
  request: request,
  login: login,
  ensureLogin: ensureLogin
}
