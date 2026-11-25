// 打卡日历（二级页）：仅用 days 高亮已打卡日期，不展示/跳转任何关卡内容（§7.2）。
const api = require('../../utils/api')
const session = require('../../utils/store/session')

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

/** 周一开头的 7 列日历；days 数组中的日期高亮，不含成绩字段。 */
function buildCells(month, days) {
  const parts = String(month || '').split('-')
  const year = Number(parts[0])
  const monthIndex = Number(parts[1]) - 1
  if (!year || !parts[1]) return []
  const totalDays = new Date(year, monthIndex + 1, 0).getDate()
  const offset = (new Date(year, monthIndex, 1).getDay() + 6) % 7
  const checked = {}
  ;(days || []).forEach((day) => { if (day) checked[day] = true })
  const cells = []
  for (let i = 0; i < offset; i += 1) {
    cells.push({ key: 'blank-' + i, day: '', date: '', checkedIn: false })
  }
  for (let d = 1; d <= totalDays; d += 1) {
    const key = year + '-' + String(monthIndex + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0')
    cells.push({
      key: key,
      day: String(d),
      date: key,
      checkedIn: checked[key] === true
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
    selectedDate: '',
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
    this.setData({ loading: true, error: '', selectedDate: '' })
    const month = this.data.month || monthKey(new Date())
    try {
      await api.ensureLogin()
      const lang = session.getState().lang
      const [calendar, streakData] = await Promise.all([
        api.request('/api/levels/calendar?lang=' + lang + '&month=' + month),
        api.request('/api/levels/streak?lang=' + lang)
      ])
      const days = (calendar && calendar.days) || []
      const cells = buildCells(month, days)
      this.setData({
        month: (calendar && calendar.month) || month,
        monthLabel: (calendar && calendar.month) || month,
        streak: (streakData && streakData.streak) || this.data.streak,
        cells: cells,
        empty: days.length === 0,
        canGoNext: month < monthKey(new Date())
      })
    } catch (error) {
      this.setData({ error: (error && error.message) || '加载失败' })
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

  /** 点击已打卡日期仅高亮/提示，不展示成绩面板（§7.2）。 */
  onCellTap(e) {
    const date = e.currentTarget.dataset.date
    if (!date) return
    const cell = this.data.cells.find((item) => item.date === date)
    if (!cell || !cell.checkedIn) {
      this.setData({ selectedDate: '' })
      return
    }
    this.setData({ selectedDate: date })
    wx.showToast({ title: '已打卡', icon: 'none' })
  },

  retry() {
    this.load()
  }
})

module.exports = { buildCells: buildCells, monthKey: monthKey, shiftMonth: shiftMonth }
