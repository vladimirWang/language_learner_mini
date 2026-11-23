const { request, ensureLogin } = require('../../utils/api')

const LANGS = [
  { value: 'de', label: '德语' },
  { value: 'en', label: '英语' },
  { value: 'ja', label: '日语' }
]
const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'N5', 'N4', 'N3', 'N2', 'N1']
const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']

function monthKey(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  return y + '-' + m
}

Page({
  data: {
    lang: 'de',
    level: 'A1',
    langLabels: LANGS.map((item) => item.label),
    langIndex: 0,
    levels: LEVELS,
    levelIndex: 0,
    loading: true,
    error: '',
    date: '',
    challenge: null,
    attempt: null,
    reason: '',
    streak: { current: 0, longest: 0, last_day: null },
    monthLabel: '',
    weekdays: WEEKDAYS,
    cells: []
  },

  onLoad() {
    const app = getApp()
    const langIndex = Math.max(0, LANGS.findIndex((item) => item.value === app.globalData.lang))
    const levelIndex = Math.max(0, LEVELS.indexOf(app.globalData.level))
    this.setData({
      langIndex,
      levelIndex,
      lang: LANGS[langIndex].value,
      level: LEVELS[levelIndex]
    })
  },

  onShow() {
    this.loadToday()
  },

  onPullDownRefresh() {
    this.loadToday().finally(() => wx.stopPullDownRefresh())
  },

  onLangChange(e) {
    const index = Number(e.detail.value)
    const lang = LANGS[index].value
    getApp().globalData.lang = lang
    wx.setStorageSync('challenge_lang', lang)
    this.setData({ langIndex: index, lang })
    this.loadToday()
  },

  onLevelChange(e) {
    const index = Number(e.detail.value)
    const level = LEVELS[index]
    getApp().globalData.level = level
    wx.setStorageSync('challenge_level', level)
    this.setData({ levelIndex: index, level })
    this.loadToday()
  },

  async loadToday() {
    this.setData({ loading: true, error: '' })
    try {
      await ensureLogin()
      const { lang, level } = this.data
      const [today, calendar] = await Promise.all([
        request('/api/levels/today?lang=' + lang + '&level=' + level),
        request('/api/levels/calendar?lang=' + lang + '&level=' + level + '&month=' + monthKey(new Date()))
      ])
      this.setData({
        date: today.date || '',
        challenge: today.challenge || null,
        attempt: today.attempt || null,
        reason: today.reason || '',
        streak: today.streak || { current: 0, longest: 0, last_day: null },
        monthLabel: calendar.month || monthKey(new Date()),
        cells: this.buildCells(calendar.month || monthKey(new Date()), calendar.entries || [])
      })
    } catch (error) {
      this.setData({ error: error.message || '加载失败' })
    } finally {
      this.setData({ loading: false })
    }
  },

  buildCells(month, entries) {
    const parts = month.split('-')
    const year = Number(parts[0])
    const monthIndex = Number(parts[1]) - 1
    const first = new Date(year, monthIndex, 1)
    const days = new Date(year, monthIndex + 1, 0).getDate()
    const offset = (first.getDay() + 6) % 7
    const passed = {}
    entries.forEach((entry) => {
      passed[entry.day] = entry.passed
    })
    const cells = []
    for (let i = 0; i < offset; i += 1) {
      cells.push({ key: 'blank-' + i, day: '', passed: false })
    }
    for (let d = 1; d <= days; d += 1) {
      const key = year + '-' + String(monthIndex + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0')
      cells.push({ key, day: String(d), passed: passed[key] === true })
    }
    return cells
  },

  startChallenge() {
    if (!this.data.challenge) return
    wx.navigateTo({
      url: '/pages/challenge/challenge?day=' + this.data.challenge.day + '&lang=' + this.data.lang + '&level=' + this.data.level
    })
  },

  retry() {
    this.loadToday()
  }
})
