const api = require('../../utils/api')

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']

function monthKey(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  return y + '-' + m
}

function shiftMonth(month, delta) {
  const parts = String(month || '').split('-')
  const year = Number(parts[0])
  const idx = Number(parts[1]) - 1
  if (!year || !parts[1]) return month
  return monthKey(new Date(year, idx + delta, 1))
}

/** 周一开头的 7 列日历；点击某天可带出当天成绩摘要。 */
function buildCells(month, entries) {
  const parts = String(month || '').split('-')
  const year = Number(parts[0])
  const monthIndex = Number(parts[1]) - 1
  if (!year || !parts[1]) return []
  const days = new Date(year, monthIndex + 1, 0).getDate()
  const offset = (new Date(year, monthIndex, 1).getDay() + 6) % 7
  const byDay = {}
  ;(entries || []).forEach((entry) => {
    if (entry && entry.day) byDay[entry.day] = entry
  })
  const cells = []
  for (let i = 0; i < offset; i += 1) {
    cells.push({ key: 'blank-' + i, day: '', checkedIn: false })
  }
  for (let d = 1; d <= days; d += 1) {
    const key = year + '-' + String(monthIndex + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0')
    const entry = byDay[key] || {}
    cells.push({
      key: key,
      day: String(d),
      date: key,
      checkedIn: entry.checked_in === true || entry.passed === true,
      title: entry.title || '',
      score: entry.score,
      total: entry.total,
      stars: entry.stars,
      bestStars: entry.best_stars,
      hasRecord: entry.score !== null && entry.score !== undefined
    })
  }
  return cells
}

Page({
  data: {
    weekdays: WEEKDAYS,
    month: '',
    monthLabel: '',
    canGoNext: false,
    streak: { current: 0, longest: 0, last_day: '' },
    cells: [],
    selected: null,
    loading: true,
    error: '',
    empty: false
  },

  onLoad() {
    this.setData({ month: monthKey(new Date()) })
  },

  onShow() {
    this.load()
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh())
  },

  async load() {
    this.setData({ loading: true, error: '', selected: null })
    const month = this.data.month || monthKey(new Date())
    try {
      await api.ensureLogin()
      const [calendar, streakData] = await Promise.all([
        api.request('/api/levels/calendar?lang=de&month=' + month),
        api.request('/api/levels/streak?lang=de')
      ])
      const entries = (calendar && calendar.entries) || []
      const cells = buildCells(month, entries)
      this.setData({
        month: (calendar && calendar.month) || month,
        monthLabel: (calendar && calendar.month) || month,
        streak: (streakData && streakData.streak) || this.data.streak,
        cells: cells,
        empty: entries.length === 0,
        canGoNext: month < monthKey(new Date())
      })
    } catch (error) {
      this.setData({ error: error.message || '加载失败' })
    } finally {
      this.setData({ loading: false })
    }
  },

  prevMonth() {
    this.setData({ month: shiftMonth(this.data.month, -1) }, () => this.load())
  },

  nextMonth() {
    if (!this.data.canGoNext) return
    this.setData({ month: shiftMonth(this.data.month, 1) }, () => this.load())
  },

  onCellTap(e) {
    const date = e.currentTarget.dataset.date
    if (!date) return
    const cell = this.data.cells.find((item) => item.date === date)
    if (!cell || !cell.hasRecord) {
      this.setData({ selected: null })
      return
    }
    this.setData({ selected: cell })
  },

  retry() {
    this.load()
  }
})

module.exports = { buildCells: buildCells, monthKey: monthKey, shiftMonth: shiftMonth }
