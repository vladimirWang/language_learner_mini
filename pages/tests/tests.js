const api = require('../../utils/api')

// 方案 §6.7/§7.2：测试配置列表来自 GET /api/tests，直接渲染响应的 levels 数组。
// 不读取本地 mock，不复用每日关卡接口，也不按当前用户等级过滤。
// 点击列表项进入测试详情，展示该测试关联的听力/口语任务（GET /api/tests/:id）。
Page({
  data: {
    levels: [],
    loading: true,
    error: ''
  },

  onLoad() {
    this.load()
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh())
  },

  /** 进入测试详情：只传 id 与名称，详情页自行拉取 /api/tests/:id。 */
  openDetail(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    const name = e.currentTarget.dataset.name || ''
    wx.navigateTo({
      url: '/pages/testDetail/testDetail?id=' + encodeURIComponent(id) +
        '&name=' + encodeURIComponent(name)
    })
  },

  async load() {
    this.setData({ loading: true, error: '' })
    try {
      await api.ensureLogin()
      const data = await api.request('/api/tests')
      const levels = data && Array.isArray(data.levels) ? data.levels : []
      this.setData({ levels: levels })
    } catch (error) {
      this.setData({ error: error.message || '加载失败' })
    } finally {
      this.setData({ loading: false })
    }
  },

  retry() {
    this.load()
  }
})
