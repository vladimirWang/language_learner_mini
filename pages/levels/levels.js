const api = require('../../utils/api')
const session = require('../../utils/store/session')

const TYPE_LABELS = { vocab: '单词与搭配', grammar: '语法', listening: '听力' }
const REASON_TEXT = {
  content_not_ready: '素材准备中，请稍后再来',
  not_published: '管理员尚未发布今天关卡'
}

function monthKey(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  return y + '-' + m
}

function dayKey(date) {
  const d = String(date.getDate()).padStart(2, '0')
  return monthKey(date) + '-' + d
}

function shiftMonth(month, delta) {
  const parts = String(month || '').split('-')
  const year = Number(parts[0])
  const idx = Number(parts[1]) - 1
  if (!year || !parts[1]) return month
  return monthKey(new Date(year, idx + delta, 1))
}

function formatDay(day) {
  const parts = String(day || '').split('-')
  if (parts.length !== 3) return { label: day || '', iso: day || '' }
  const month = Number(parts[1])
  const date = Number(parts[2])
  return { label: month + ' 月 ' + date + ' 日', iso: day }
}

function typeLabel(challenge) {
  const value = challenge && challenge.challenge_type
  return TYPE_LABELS[value] || TYPE_LABELS.vocab
}

/**
 * 由 calendar.entries + 今日 today 构建按天升序的卡片数组。
 * 题型标签只取 challenge_type，缺失时按 vocab 兼容；日期每张卡片必带。
 */
function buildCards(entries, today, todayDay) {
  const byDay = {}
  ;(entries || []).forEach((entry) => {
    if (entry && entry.day) byDay[entry.day] = entry
  })
  const todayChallenge = (today && today.challenge) || null
  const todayAttempt = (today && today.attempt) || null
  if (todayDay) {
    byDay[todayDay] = Object.assign({}, byDay[todayDay] || {}, {
      day: todayDay,
      title: todayChallenge ? todayChallenge.title : ((byDay[todayDay] || {}).title || ''),
      challenge: todayChallenge,
      attempt: todayAttempt,
      reason: today && today.reason
    })
  }
  return Object.keys(byDay).sort().map((day) => {
    const entry = byDay[day] || {}
    const challenge = entry.challenge || null
    const attempt = entry.attempt || null
    const isToday = day === todayDay
    const hasAttempt = !!attempt || (entry.stars !== null && entry.stars !== undefined)
    const date = formatDay(day)
    return {
      day: day,
      dateLabel: date.label,
      iso: date.iso,
      title: entry.title || '',
      typeLabel: typeLabel(challenge),
      itemCount: challenge && challenge.items ? challenge.items.length : (entry.total || 0),
      latestStars: (attempt && attempt.stars) || entry.stars || 0,
      bestStars: (attempt && attempt.best_stars) || entry.best_stars || 0,
      checkedIn: entry.checked_in === true || entry.passed === true,
      isToday: isToday,
      hasAttempt: hasAttempt,
      canAnswer: isToday && !!challenge,
      reason: !challenge && isToday ? (REASON_TEXT[entry.reason] || '今天暂无关卡') : '',
      challengeId: entry.challenge_id || (challenge && challenge.id) || 0
    }
  })
}

Page({
  data: {
    lang: 'de',
    level: 'A1',
    totalStars: 0,
    streak: { current: 0, longest: 0, last_day: '' },
    loading: true,
    error: '',
    cards: [],
    currentIndex: 0,
    month: '',
    todayDay: '',
    loadingAdjacent: false
  },

  onLoad() {
    const state = session.getState()
    this.setData({ lang: state.lang, level: state.level })
    this.unsubscribe = session.subscribe((next) => {
      if (next.level !== this.data.level) {
        this.setData({ level: next.level }, () => this.load())
      }
    })
  },

  onShow() {
    this.load()
  },

  onUnload() {
    if (this.unsubscribe) this.unsubscribe()
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh())
  },

  async load() {
    this.setData({ loading: true, error: '' })
    try {
      await api.ensureLogin()
      const now = new Date()
      const month = monthKey(now)
      // 等级由服务端从用户资料读取，客户端只传 lang。
      const [today, calendar] = await Promise.all([
        api.request('/api/levels/today?lang=de'),
        api.request('/api/levels/calendar?lang=de&month=' + month)
      ])
      const state = session.getState()
      const todayDay = (today && today.date) || dayKey(now)
      const cards = buildCards((calendar && calendar.entries) || [], today, todayDay)
      const index = Math.max(0, cards.findIndex((card) => card.day === todayDay))
      this.setData({
        lang: state.lang,
        level: (today && today.level) || state.level,
        totalStars: (today && today.total_stars) || 0,
        streak: {
          current: (today && today.streak && today.streak.current) || 0,
          longest: (today && today.streak && today.streak.longest) || 0,
          last_day: (today && today.streak && today.streak.last_day) || ''
        },
        cards: cards,
        currentIndex: index,
        month: (calendar && calendar.month) || month,
        todayDay: todayDay
      })
    } catch (error) {
      this.setData({ error: error.message || '加载失败' })
    } finally {
      this.setData({ loading: false })
    }
  },

  async onSwiperChange(e) {
    const index = e.detail.current
    this.setData({ currentIndex: index })
    const cards = this.data.cards
    if (!cards.length) return
    if (index >= cards.length - 1) {
      await this.loadAdjacentMonth(1)
    } else if (index === 0) {
      await this.loadAdjacentMonth(-1)
    }
  },

  async loadAdjacentMonth(delta) {
    if (this.data.loadingAdjacent) return
    const month = shiftMonth(this.data.month, delta)
    if (!month || month > monthKey(new Date())) return
    this.setData({ loadingAdjacent: true })
    try {
      const calendar = await api.request('/api/levels/calendar?lang=de&month=' + month)
      const added = buildCards((calendar && calendar.entries) || [], null, this.data.todayDay)
      if (!added.length) return
      const cards = this.data.cards.slice()
      added.forEach((card) => {
        if (!cards.some((item) => item.day === card.day)) cards.push(card)
      })
      cards.sort((a, b) => a.day.localeCompare(b.day))
      const newIndex = delta > 0
        ? this.data.currentIndex
        : this.data.currentIndex + added.length
      this.setData({ cards: cards, currentIndex: newIndex, month: month })
    } catch (error) {
      // 相邻月份加载失败不覆盖当前卡片，仅提示后可下拉重试。
      wx.showToast({ title: '相邻月份加载失败', icon: 'none' })
    } finally {
      this.setData({ loadingAdjacent: false })
    }
  },

  goCard(e) {
    const index = Number(e.currentTarget.dataset.index)
    const card = this.data.cards[index]
    if (!card) return
    if (card.canAnswer) {
      wx.navigateTo({ url: '/pages/challenge/challenge?day=' + card.day })
      return
    }
    if (card.hasAttempt) {
      wx.navigateTo({ url: '/pages/result/result?day=' + card.day })
      return
    }
    wx.showToast({ title: card.isToday ? card.reason : '该日关卡已过期', icon: 'none' })
  },

  retry() {
    this.load()
  }
})

module.exports = { buildCards: buildCards, formatDay: formatDay, shiftMonth: shiftMonth }
