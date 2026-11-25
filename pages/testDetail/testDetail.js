const api = require('../../utils/api')

// 测试详情：点击测试列表项进入，展示该测试关联的听力/口语任务（GET /api/tests/:id）。
// 只读展示，不在此页发起答题。
const TYPE_LABELS = {
  listening: '听力',
  speaking: '口语',
  speaking_topic: '口语话题',
  speaking_plan: '口语计划'
}

Page({
  data: {
    id: '',
    level: null,
    exams: [],
    loading: true,
    error: ''
  },

  onLoad(options) {
    const id = options && options.id ? decodeURIComponent(options.id) : ''
    const name = options && options.name ? decodeURIComponent(options.name) : ''
    if (name) wx.setNavigationBarTitle({ title: name })
    this.setData({ id: id })
    this.load()
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh())
  },

  async load() {
    if (!this.data.id) {
      this.setData({ loading: false, error: '测试参数缺失' })
      return
    }
    this.setData({ loading: true, error: '' })
    try {
      await api.ensureLogin()
      const data = await api.request('/api/tests/' + encodeURIComponent(this.data.id))
      const level = data && data.level ? data.level : null
      const exams = (data && Array.isArray(data.exams) ? data.exams : [])
        .map((item) => ({
          key: item.item_type + '-' + item.exam_id,
          name: item.name || item.exam_id,
          typeLabel: TYPE_LABELS[item.item_type] || item.item_type || '任务',
          lang: item.lang || '',
          order: Number(item.sort_order) || 0
        }))
        .sort((a, b) => a.order - b.order)
      if (level && level.name) wx.setNavigationBarTitle({ title: level.name })
      this.setData({ level: level, exams: exams })
    } catch (error) {
      this.setData({ error: (error && error.message) || '测试详情加载失败' })
    } finally {
      this.setData({ loading: false })
    }
  },

  retry() {
    this.load()
  }
})
