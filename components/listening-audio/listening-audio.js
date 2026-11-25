// 听力音频条：只负责展示与派发事件，播放逻辑由页面持有，
// 关卡页和测试任务页共用同一套 UI。
Component({
  properties: {
    playing: { type: Boolean, value: false },
    paused: { type: Boolean, value: false },
    percent: { type: Number, value: 0 },
    progress: { type: String, value: '' },
    error: { type: Boolean, value: false },
    // 关卡页一张关卡卡对应一个 seq，任务页用它标识题目序号。
    uid: { type: String, value: '' },
    seq: { type: Number, value: 0 }
  },

  methods: {
    onToggle() {
      this.triggerEvent('toggle', { uid: this.data.uid, seq: this.data.seq })
    },
    onStop() {
      this.triggerEvent('stop', { uid: this.data.uid, seq: this.data.seq })
    }
  }
})
