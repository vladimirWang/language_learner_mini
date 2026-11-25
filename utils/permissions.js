// 小程序权限工具：当前只使用麦克风（scope.record）。
// 约定：authSetting 里 true=已授权，false=已拒绝，undefined=尚未请求过。
// 已拒绝后 wx.authorize 不会再次弹窗，只能引导用户去 wx.openSetting 调整。

function getMicPermission() {
  return new Promise((resolve) => {
    wx.getSetting({
      success(res) {
        const setting = (res && res.authSetting) || {}
        const value = setting['scope.record']
        if (value === true) resolve('granted')
        else if (value === false) resolve('denied')
        else resolve('unset')
      },
      fail() {
        // 读取失败不阻塞流程，按未授权处理，由调用方决定是否提示。
        resolve('unknown')
      }
    })
  })
}

function requestMicPermission() {
  return new Promise((resolve) => {
    wx.authorize({
      scope: 'scope.record',
      success() {
        resolve('granted')
      },
      fail() {
        resolve('denied')
      }
    })
  })
}

function openMicSetting() {
  return new Promise((resolve) => {
    wx.openSetting({
      success(res) {
        const setting = (res && res.authSetting) || {}
        resolve(setting['scope.record'] === true)
      },
      fail() {
        resolve(false)
      }
    })
  })
}

// 确保拿到麦克风权限：已授权直接通过；未请求过主动弹授权；已拒绝返回 denied，
// 由页面提示用户点「去设置」。
function ensureMicPermission() {
  return getMicPermission().then((status) => {
    if (status === 'granted') return 'granted'
    if (status === 'unset' || status === 'unknown') {
      return requestMicPermission()
    }
    return 'denied'
  })
}

module.exports = {
  getMicPermission,
  requestMicPermission,
  openMicSetting,
  ensureMicPermission
}
