const api = require('../../utils/api')
const permissions = require('../../utils/permissions')

// 测试详情：点击测试列表项进入，展示该测试关联的听力/口语任务（GET /api/tests/:id）。
// 听力任务进入任务页做题；口语任务进入人机对话页，进入前先校验麦克风权限。
// 按项目约定不在小程序展示语种。
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
    hasSpeaking: false,
    micGranted: null,
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

  onShow() {
    this.refreshMicPermission()
  },

  refreshMicPermission() {
    permissions.getMicPermission().then((status) => {
      // null 表示尚未请求过，false 表示明确拒绝，true 表示已开启。
      this.setData({
        micGranted: status === 'granted' ? true : (status === 'denied' ? false : null)
      })
    })
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
          examId: item.exam_id,
          itemType: item.item_type,
          name: item.name || item.exam_id,
          typeLabel: TYPE_LABELS[item.item_type] || item.item_type || '任务',
          order: Number(item.sort_order) || 0
        }))
        .sort((a, b) => a.order - b.order)
      if (level && level.name) wx.setNavigationBarTitle({ title: level.name })
      const hasSpeaking = exams.some((item) => item.itemType.indexOf('speaking') === 0)
      this.setData({ level: level, exams: exams, hasSpeaking: hasSpeaking })
      this.refreshMicPermission()
    } catch (error) {
      this.setData({ error: (error && error.message) || '测试详情加载失败' })
    } finally {
      this.setData({ loading: false })
    }
  },

  retry() {
    this.load()
  },

  /** 进入任务：听力进入做题页；口语先校验麦克风权限，再进入人机对话页。 */
  async openTask(e) {
    const dataset = e.currentTarget.dataset || {}
    if (!dataset.examId || !dataset.itemType) return
    const isSpeaking = dataset.itemType.indexOf('speaking') === 0
    if (!isSpeaking) {
      this.navigateToTask(dataset, false)
      return
    }
    const status = await permissions.ensureMicPermission()
    if (status === 'granted') {
      this.setData({ micGranted: true })
      this.navigateToTask(dataset, true)
      return
    }
    this.setData({ micGranted: false })
    this.promptMicSetting(dataset)
  },

  /** 已拒绝授权时，只能引导到微信设置页重新开启。 */
  promptMicSetting(dataset) {
    wx.showModal({
      title: '需要麦克风权限',
      content: '口语测试需要麦克风才能开始，请在微信设置中开启后重试。',
      confirmText: '去设置',
      success: (res) => {
        if (!res || !res.confirm) return
        permissions.openMicSetting().then((granted) => {
          this.setData({ micGranted: granted })
          if (granted && dataset) this.navigateToTask(dataset, true)
        })
      }
    })
  },

  /** 详情页顶部权限提示的「去开启」按钮。 */
  async onEnableMic() {
    const status = await permissions.ensureMicPermission()
    if (status === 'granted') {
      this.setData({ micGranted: true })
      return
    }
    this.setData({ micGranted: false })
    this.promptMicSetting(null)
  },

  navigateToTask(dataset, isSpeaking) {
    const difficulty = this.data.level && this.data.level.difficulty ? this.data.level.difficulty : ''
    let url = (isSpeaking ? '/pages/speakingTask/speakingTask' : '/pages/taskDetail/taskDetail') +
      '?levelId=' + encodeURIComponent(this.data.id) +
      '&itemType=' + encodeURIComponent(dataset.itemType) +
      '&examId=' + encodeURIComponent(dataset.examId) +
      '&name=' + encodeURIComponent(dataset.name || '')
    if (isSpeaking) url += '&level=' + encodeURIComponent(difficulty)
    wx.navigateTo({ url: url })
  }
})
