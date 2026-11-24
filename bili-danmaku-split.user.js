// ==UserScript==
// @name         B站弹幕长句发送（隐形快速版）
// @namespace    https://github.com/local/bili-danmaku-split-v6
// @version      8.0.1
// @description  在 B 站直播间输入框里直接写长句：超过 20 字自动按标点切分并快速并发发送；面板默认隐形，只在右下角留一个小按钮。
// @author       local
// @match        https://live.bilibili.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict'

  /* ───────── 配置 ───────── */
  const CFG_KEY = 'bds6:cfg'
  const DEFAULTS = {
    limit: 20,        // B 站单条上限（服务端硬限制）
    gapMs: 120,       // 并发投递时每条错开多少毫秒
    hidePanel: true,  // 面板默认隐形
    retry: true,      // 被限速(10031)时后台补发一次
    typeLimit: 200,   // 后台缓冲允许的字数
    mirrorWidth: 80,  // 镜像到 B 站框的显示宽度（中文算 2）
    boxExtra: 0,      // 输入框额外加高（px，0=不改 B 站原样）
    mode: 'compat',   // compat=原样输入(≤20字，最稳) / shadow=接管输入框(可写长句)
  }
  let cfg = { ...DEFAULTS }
  try { cfg = { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(CFG_KEY) || '{}') || {}) } } catch {}
  const saveCfg = () => { try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)) } catch {} }

  /* ───────── 屏蔽词 / 被吞留档 ───────── */
  const BLOCK_KEY = 'bds6:block'
  const EATEN_KEY = 'bds6:eaten'
  const loadJSON = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v } catch { return d } }
  const saveJSON = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch {} }
  let blockWords = loadJSON(BLOCK_KEY, ['加群', '群号', '微信', 'vx', 'qq', '私聊', '代练', '刷单', '外挂', '破解', '广告', '转账', '支付宝', '红包', '公众号', '二维码', '联系方式'])
  let eatenList = loadJSON(EATEN_KEY, [])
  const hitsOf = (t) => {
    const low = String(t || '').toLowerCase()
    return blockWords.filter((w) => w && low.includes(String(w).toLowerCase())).slice(0, 6)
  }
  function recordEaten(text) {
    const t = String(text || '').trim()
    if (!t) return
    eatenList = [t.slice(0, 200), ...eatenList.filter((x) => x !== t.slice(0, 200))].slice(0, 30)
    saveJSON(EATEN_KEY, eatenList)
  }

  /* ───────── 小工具 ───────── */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const roomId = () => {
    const m = location.pathname.match(/\/(\d+)/)
    return m ? m[1] : ''
  }
  const csrf = () => {
    const m = document.cookie.match(/(?:^|;\s*)bili_jct=([^;]+)/)
    return m ? decodeURIComponent(m[1]) : ''
  }

  /* ───────── 切分 ───────── */
  const SPLIT_RE = /[。！？!?，,、；;：:…~\s]+/
  function splitText(text, limit) {
    const out = []
    const raw = String(text || '').trim()
    if (!raw) return out
    const parts = raw.split(SPLIT_RE).filter(Boolean)
    const push = (s) => {
      if (!s) return
      while (s.length > limit) {
        out.push(s.slice(0, limit))
        s = s.slice(limit)
      }
      if (s) out.push(s)
    }
    let cur = ''
    for (const p of parts) {
      if (!cur) { cur = p; continue }
      if (cur.length + 1 + p.length <= limit) cur += ' ' + p
      else { push(cur); cur = p }
    }
    push(cur)
    return out.slice(0, 20)
  }

  /* ───────── 发送 ───────── */
  const SEND_ERR = { '-101': '未登录', 10030: '被禁言', 10031: '发送太快', 1003212: '被吞(疑似屏蔽词)' }

  async function sendOne(text) {
    const rid = roomId()
    if (!rid) return { ok: false, why: '拿不到房间号' }
    const body = new URLSearchParams({
      bubble: '0', msg: String(text).slice(0, 20), color: '16777215', mode: '1',
      fontsize: '25', rnd: String(Math.floor(Date.now() / 1000)),
      roomid: rid, csrf: csrf(), csrf_token: csrf(),
    })
    try {
      const r = await fetch('https://api.live.bilibili.com/msg/send', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      })
      const j = await r.json().catch(() => ({}))
      const code = Number(j.code)
      if (code === 0) return { ok: true }
      return { ok: false, code, why: SEND_ERR[code] || j.message || ('错误码 ' + code) }
    } catch (e) {
      return { ok: false, why: '网络错误' }
    }
  }

  /* ───────── 提示 ───────── */
  let toastEl = null
  let toastTimer = 0
  let stripEl = null
  let stripTimer = 0
  function showHits(text) {
    const hits = hitsOf(text)
    if (!hits.length) return
    if (!stripEl) {
      stripEl = document.createElement('div')
      stripEl.id = 'bds6-strip'
      document.body.appendChild(stripEl)
    }
    const low = String(text).toLowerCase()
    let html = '⚠ 可能被吞：'
    const seen = new Set()
    for (const w of hits) {
      if (seen.has(w)) continue
      seen.add(w)
      html += `<span class="hit">${w}</span> `
    }
    stripEl.innerHTML = html
    stripEl.classList.add('show')
    clearTimeout(stripTimer)
    stripTimer = setTimeout(() => stripEl && stripEl.classList.remove('show'), 5000)
  }

  function toast(msg, ms) {
    if (!toastEl) {
      toastEl = document.createElement('div')
      toastEl.id = 'bds6-toast'
      document.body.appendChild(toastEl)
    }
    toastEl.textContent = msg
    toastEl.classList.add('show')
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms || 2200)
  }

  /* ───────── 发送队列：批次串行、批内并发 ───────── */
  let sending = false
  const pendingTexts = []

  function enqueueSend(text) {
    const t = String(text || '').trim()
    if (!t) return
    if (sending) {
      pendingTexts.push(t)
      toast(`排队中…（前面还有 ${pendingTexts.length} 段）`, 1400)
      return
    }
    void runBatch(t)
  }

  async function drainQueue() {
    while (pendingTexts.length) {
      const t = pendingTexts.shift()
      await runBatch(t)
    }
  }

  /** 一批：切成 N 条后并发投递，不等回执；被限速的后台补发一次 */
  /** 一批：切成 N 条并发投递；失败的（被吞/限速/网络）全部留档，并把失败句放回输入框 */
  async function runBatch(text) {
    sending = true
    try {
      const chunks = splitText(text, cfg.limit)
      if (!chunks.length) return
      if (chunks.length === 1) {
        const r = await sendOne(chunks[0])
        if (r.ok) toast('已发送', 1500)
        else {
          recordEaten(chunks[0])
          restoreToBox([chunks[0]])
          toast('没发出去：' + (r.why || r.code), 2600)
        }
        return
      }
      showHits(text)
      toast(`发送中… 共 ${chunks.length} 条`, 1000)
      let ok = 0
      const failed = []
      await Promise.all(
        chunks.map(async (piece, i) => {
          if (i) await sleep(i * cfg.gapMs * (0.8 + Math.random() * 0.4))
          const r = await sendOne(piece)
          if (r.ok) ok++
          else failed.push({ t: piece, why: r.why || String(r.code || '') })
        }),
      )
      let still = failed
      if (failed.length && cfg.retry) {
        await sleep(3000)
        const retried = []
        for (const f of failed.slice(0, 5)) {
          const r = await sendOne(f.t)
          if (r.ok) ok++
          else retried.push(f)
          await sleep(700)
        }
        still = retried.concat(failed.slice(5))
      }
      if (still.length) {
        for (const f of still) recordEaten(f.t)
        const back = still.length >= 3 ? still.map((f) => f.t) : [still[0].t]
        restoreToBox(back)
        toast(`已发 ${ok} 条，${still.length} 条没上去（已放回输入框）`, 3000)
      } else {
        toast(`已发送 ${chunks.length} 条`, 2200)
      }
    } finally {
      try { if (ta && document.activeElement !== ta) ta.focus() } catch {}
      sending = false
      void drainQueue()
    }
  }

  /** 把没发出去的句子放回输入框缓冲区，改一下就能再发 */
  function restoreToBox(texts) {
    if (!texts || !texts.length) return
    const add = texts.join(' ')
    buffer = (buffer ? buffer + ' ' : '') + add
    truncWarned = false
    renderMirror()
    try { if (ta) ta.focus() } catch {}
  }

  /* ───────── 接管原生输入框 ───────── */
  let ta = null
  let shadow = ''
  let composing = false

  const findInput = () => {
    const sels = [
      '#chat-input-control',
      '.chat-input-panel textarea',
      '.chat-input textarea',
      'textarea[placeholder*="弹幕"]',
      'textarea',
    ]
    for (const s of sels) {
      const el2 = document.querySelector(s)
      if (el2 && el2.offsetParent !== null) return el2
    }
    return null
  }

  const caretEnd = () => {
    try { const n = ta.value.length; ta.setSelectionRange(n, n) } catch {}
  }

  const syncUI = () => {
    if (!panelInfo) return
    const t = buffer || ''
    panelInfo.textContent = `${t.trim().length} 字 / ${splitText(t, cfg.limit).length} 条`
  }

  /* ── 影子编辑：全量文本存在 buffer，B 站框只做「镜像显示」 ── */
  let buffer = ''
  let caretPos = 0          // 光标在 buffer 里的位置（不依赖 DOM，因为镜像可能被截断）
  let truncWarned = false
  const PAIRS = { '“': '”', '‘': '’', '（': '）', '【': '】', '《': '》', '「': '」', '『': '』', '(': ')', '[': ']', '{': '}', '"': '"', "'": "'" }
  const CLOSE_TO_OPEN = { '”': '“', '’': '‘', '）': '（', '】': '【', '》': '《', '」': '「', '』': '『', ')': '(', ']': '[', '}': '{' }
  const charW = (ch) => (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch) ? 2 : 1)
  const mirrorLimit = () => Math.max(20, Math.min(400, Number(cfg.mirrorWidth) || 80))

  function mirrorPrefix() {
    const lim = mirrorLimit()
    let w = 0
    let out = ''
    for (const ch of buffer) {
      const cw = charW(ch)
      if (w + cw > lim) break
      w += cw
      out += ch
    }
    return out
  }

  function renderMirror() {
    if (!ta) return
    const m = mirrorPrefix()
    if (ta.value !== m) setSiteValue(m)
    const p = Math.max(0, Math.min(caretPos, m.length))
    try { ta.setSelectionRange(p, p) } catch {}
    if (buffer.length > m.length && caretPos > m.length && !truncWarned) {
      truncWarned = true
      toast('已超过输入框显示上限，后面的字仍在后台保留（回车照样发）', 2600)
    }
    applyBoxHeight()
    try { ta.scrollTop = ta.scrollHeight; ta.scrollLeft = 0 } catch {}
    syncUI()
  }

  const caret = () => Math.max(0, Math.min(caretPos, buffer.length))

  /** 输入法一次提交“”或（）这类成对符号时，把光标放到中间，否则会变成“”文本 */
  function pairOffset(str) {
    if (str.length === 2 && PAIRS[str[0]] === str[1]) return 1
    return -1
  }

  const insertText = (str) => {
    const pos = caret()
    // 右括号/右引号：如果光标后面已经有一个同样的字符（输入法自动配对留下的），
    // 不要重复插入，直接把光标移过去，否则会出现 “”文本
    if (str.length === 1 && CLOSE_TO_OPEN[str] && buffer[pos] === str) {
      caretPos = pos + 1
      renderMirror()
      return
    }
    let v = buffer.slice(0, pos) + str + buffer.slice(pos)
    const max = Number(cfg.typeLimit) || 200
    if (v.length > max) v = v.slice(0, max)
    buffer = v
    const mid = pairOffset(str)
    caretPos = mid >= 0 ? Math.min(pos + mid, buffer.length) : Math.min(pos + str.length, buffer.length)
    renderMirror()
  }

  const deleteSel = (back) => {
    const pos = caret()
    if (back && pos > 0) {
      buffer = buffer.slice(0, pos - 1) + buffer.slice(pos)
      caretPos = pos - 1
    } else if (!back && pos < buffer.length) {
      buffer = buffer.slice(0, pos) + buffer.slice(pos + 1)
      caretPos = pos
    }
    renderMirror()
  }

  const moveCaret = (to) => { caretPos = Math.max(0, Math.min(to, buffer.length)); renderMirror() }

  /* ───────── 兼容模式：完全不拦输入，只用回车发送、长粘贴自动分条 ───────── */
  const bindCompat = (el2) => {
    if (!el2 || el2.dataset.bds6c === '1') return
    el2.dataset.bds6c = '1'
    ta = el2

    el2.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'Enter' && !e.shiftKey) {
        const text = (el2.value || '').trim()
        if (!text) return
        e.preventDefault(); e.stopImmediatePropagation()
        setSiteValue('')
        enqueueSend(text)
        try { el2.focus() } catch (_) {}
        return
      }
      if (e.key === 'Escape') { setSiteValue(''); buffer = ''; caretPos = 0; syncUI() }
    }, true)

    el2.addEventListener('input', () => { buffer = el2.value || ''; caretPos = buffer.length; syncUI() })
    syncUI()
  }

  const bindInput = (el2) => {
    if (!el2 || el2 === ta) return
    ta = el2
    if (!buffer && el2.value) buffer = el2.value
    caretPos = buffer.length
    el2.dataset.bds6 = '1'

    el2.addEventListener('click', () => {
      ta = el2
      const p = el2.selectionStart == null ? buffer.length : el2.selectionStart
      caretPos = Math.min(p, buffer.length)
      syncUI()
    }, true)

    el2.addEventListener('compositionstart', () => { composing = true }, true)
    el2.addEventListener('compositionend', (e) => {
      composing = false
      const t = e.data || ''
      if (t) insertText(t)
    }, true)

    /* 用 beforeinput 接管编辑：空格、符号、退格、删除都能覆盖，且不打断输入法 */
    el2.addEventListener('beforeinput', (e) => {
      if (settingValue) return
      if (e.isComposing || composing) return
      const t = e.inputType || ''

      if (t === 'insertText' && typeof e.data === 'string' && e.data) {
        e.preventDefault()
        insertText(e.data)
        return
      }
      if (t === 'insertLineBreak' || t === 'insertParagraph') {
        e.preventDefault()
        const text = buffer.trim()
        if (!text) return
        buffer = ''
        caretPos = 0
        truncWarned = false
        setSiteValue('')
        syncUI()
        enqueueSend(text)
        return
      }
      if (t === 'deleteContentBackward') { e.preventDefault(); deleteSel(true); return }
      if (t === 'deleteContentForward') { e.preventDefault(); deleteSel(false); return }
      if (t === 'deleteByCut') { e.preventDefault(); return }
    }, true)

    el2.addEventListener('keydown', (e) => {
      if (e.isComposing || composing || e.keyCode === 229) return
      if (e.metaKey || e.ctrlKey || e.altKey) return

      if (e.key === 'Enter' && !e.shiftKey) {
        const text = buffer.trim()
        if (!text) return
        e.preventDefault()
        e.stopImmediatePropagation()
        buffer = ''
        caretPos = 0
        truncWarned = false
        setSiteValue('')
        syncUI()
        enqueueSend(text)
        try { el2.focus() } catch {}
        return
      }
      if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopImmediatePropagation(); moveCaret(caret() - 1); return }
      if (e.key === 'ArrowRight') { e.preventDefault(); e.stopImmediatePropagation(); moveCaret(caret() + 1); return }
      if (e.key === 'Home') { e.preventDefault(); e.stopImmediatePropagation(); moveCaret(0); return }
      if (e.key === 'End') { e.preventDefault(); e.stopImmediatePropagation(); moveCaret(buffer.length); return }
      if (e.key === 'Escape') { buffer = ''; caretPos = 0; truncWarned = false; setSiteValue(''); syncUI() }
    }, true)

    el2.addEventListener('paste', (e) => {
      const t = (e.clipboardData || window.clipboardData)?.getData('text') || ''
      if (!t) return
      e.preventDefault(); e.stopImmediatePropagation()
      insertText(t.replace(/\r/g, ''))
    }, true)

    /* 兜底：站点自己改了内容（自动配对、截断、清空）时，以站点为准同步缓冲 */
    el2.addEventListener('input', () => {
      if (composing || settingValue) return
      const v = el2.value == null ? '' : el2.value
      const m = mirrorPrefix()
      if (v !== m) {
        buffer = v
        caretPos = el2.selectionStart == null ? buffer.length : Math.min(el2.selectionStart, buffer.length)
      }
      syncUI()
    })
  }

  /* ───────── 面板（默认隐形） ───────── */
  let panel = null
  let panelInfo = null
  let fab = null

  function buildUI() {
    const style = document.createElement('style')
    style.textContent = `
      #bds6-strip{position:fixed;left:50%;bottom:150px;transform:translateX(-50%) translateY(6px);
        background:rgba(28,22,26,.9);color:#ffd7e2;font-size:12px;line-height:1.5;padding:5px 10px;
        border-radius:7px;z-index:2147483000;pointer-events:none;opacity:0;transition:opacity .18s,transform .18s;
        max-width:60vw;white-space:normal;backdrop-filter:blur(6px);border:1px solid rgba(255,80,120,.35)}
      #bds6-strip.show{opacity:1;transform:translateX(-50%) translateY(0)}
      #bds6-strip .hit{color:#ff7aa2;font-weight:700;background:rgba(255,80,120,.14);
        padding:0 3px;border-radius:3px}
      #bds6-toast{position:fixed;left:50%;bottom:110px;transform:translateX(-50%) translateY(6px);
        background:rgba(20,20,24,.86);color:#eee;font-size:12.5px;line-height:1.5;padding:7px 12px;
        border-radius:8px;z-index:2147483000;pointer-events:none;opacity:0;transition:opacity .18s,transform .18s;
        max-width:60vw;white-space:pre-wrap;backdrop-filter:blur(6px)}
      #bds6-toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
      #bds6-fab{position:fixed;right:14px;bottom:70px;width:30px;height:30px;border-radius:50%;
        border:0;background:rgba(0,174,236,.16);color:#7fd8ff;font-size:15px;cursor:pointer;
        z-index:2147482900;opacity:.35;transition:opacity .15s}
      #bds6-fab:hover{opacity:1}
      #bds6-panel{position:fixed;right:14px;bottom:108px;width:260px;padding:10px 12px;border-radius:10px;
        background:rgba(18,18,22,.86);color:#ddd;font-size:12px;z-index:2147482950;display:none;
        box-shadow:0 8px 24px rgba(0,0,0,.45);backdrop-filter:blur(8px)}
      #bds6-panel.show{display:block}
      #bds6-panel .row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:6px 0}
      #bds6-panel input[type=number]{width:64px;background:#26262c;border:1px solid #3a3a44;color:#eee;
        border-radius:5px;padding:2px 5px;font-size:12px}
      #bds6-panel .hint{color:#8b8b95;font-size:11px;line-height:1.5;margin-top:6px}
      #bds6-panel b{color:#7fd8ff;font-weight:600}
      #bds6-panel textarea{width:100%;box-sizing:border-box;min-height:52px;max-height:110px;resize:vertical;
        background:#1f1f25;border:1px solid #34343d;color:#ddd;border-radius:6px;padding:5px 6px;font-size:11.5px;
        line-height:1.5;word-break:break-all}
      #bds6-panel .mini{background:#2a2a33;border:1px solid #3b3b46;color:#bbb;border-radius:5px;
        font-size:11px;padding:1px 7px;cursor:pointer}
      #bds6-panel .mini:hover{color:#fff;border-color:#5a5a68}
    `
    document.head.appendChild(style)

    fab = document.createElement('button')
    fab.id = 'bds6-fab'
    fab.title = '弹幕长句（点开设置）'
    fab.textContent = '⋯'
    fab.onclick = () => panel.classList.toggle('show')
    document.body.appendChild(fab)

    panel = document.createElement('div')
    panel.id = 'bds6-panel'
    panel.innerHTML = `
      <div class="row"><span><b>弹幕长句</b> · 隐形快速版</span><span id="bds6-info">0 字 / 0 条</span></div>
      <div class="row"><span>每条上限（B 站 20 字/条）</span><input id="bds6-limit" type="number" min="1" max="20" step="1"></div>
      <div class="row"><span>并发间隔(ms)</span><input id="bds6-gap" type="number" min="0" max="2000" step="50"></div>
      <div class="row"><span>输入上限</span><input id="bds6-type" type="number" min="20" max="1000" step="10"></div>
      <div class="row"><span>输入框加高(px，0=不改)</span><input id="bds6-boxh" type="number" min="0" max="120" step="8"></div>
      <div class="row"><span>被限速自动补发</span><input id="bds6-retry" type="checkbox"></div>
      <div class="row"><span>输入模式</span><select id="bds6-mode"><option value="compat">兼容（最稳）</option><option value="shadow">接管（可写长句）</option></select></div>
      <div class="row" style="margin-top:10px"><span>写作框（长句）</span><button id="bds6-sendc" class="mini">发送</button></div>
      <textarea id="bds6-compose" spellcheck="false" placeholder="在这里写长句，Ctrl+Enter 或点「发送」"></textarea>
      <div class="row" style="margin-top:10px"><span>屏蔽词（逗号分隔）</span></div>
      <textarea id="bds6-block" spellcheck="false"></textarea>
      <div class="row" style="margin-top:8px"><span>最近被吞 <b id="bds6-eatn">0</b> 条</span><button id="bds6-cleareat" class="mini">清空</button></div>
      <div id="bds6-eatlist" style="max-height:210px;overflow:auto;margin-top:6px;border:1px solid #33333a;border-radius:6px;padding:2px 4px;font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-all"></div>
      <div class="hint">兼容模式：就在 B 站框里打字（最多 20 字），回车即发；长句请用上面的「写作框」。切到「接管」可让框里直接写长句（依赖输入法，可能不稳）。</div>
    `
    document.body.appendChild(panel)
    panelInfo = panel.querySelector('#bds6-info')

    const q = (id) => panel.querySelector('#' + id)
    const l = q('bds6-limit'); l.value = cfg.limit
    const g = q('bds6-gap'); g.value = cfg.gapMs
    const t = q('bds6-type'); t.value = cfg.typeLimit
    const bh = q('bds6-boxh'); bh.value = cfg.boxExtra
    const firstH = ta ? (ta.clientHeight || 0) : 0
    bh.onchange = () => { cfg.boxExtra = Math.max(0, Math.min(120, Number(bh.value) || 0)); saveCfg(); applyBoxHeight() }
    const r = q('bds6-retry'); r.checked = !!cfg.retry
    l.onchange = () => { cfg.limit = Math.max(1, Math.min(20, Number(l.value) || 20)); l.value = cfg.limit; saveCfg(); syncUI() }
    g.onchange = () => { cfg.gapMs = Math.max(0, Math.min(2000, Number(g.value) || 0)); saveCfg() }
    t.onchange = () => { cfg.typeLimit = Math.max(20, Math.min(1000, Number(t.value) || 200)); saveCfg() }
    r.onchange = () => { cfg.retry = !!r.checked; saveCfg() }

    const md = q('bds6-mode')
    if (md) {
      md.value = cfg.mode === 'shadow' ? 'shadow' : 'compat'
      md.onchange = () => { cfg.mode = md.value === 'shadow' ? 'shadow' : 'compat'; saveCfg(); location.reload() }
    }
    const cp = q('bds6-compose')
    const sendC = () => {
      const v = cp ? cp.value.trim() : ''
      if (!v) return
      enqueueSend(v)
      if (cp) cp.value = ''
    }
    const sc = q('bds6-sendc'); if (sc) sc.onclick = sendC
    if (cp) cp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendC() }
    })

    const blk = panel.querySelector('#bds6-block')
    if (blk) {
      blk.value = blockWords.join('，')
      blk.onchange = () => {
        blockWords = blk.value.split(/[,，\s\n]+/).map((x) => x.trim()).filter(Boolean).slice(0, 80)
        saveJSON(BLOCK_KEY, blockWords)
        toast(`屏蔽词已保存（${blockWords.length} 个）`, 1600)
      }
    }
    const eatN = panel.querySelector('#bds6-eatn')
    const eatListEl = panel.querySelector('#bds6-eatlist')
    const paintEaten = () => {
      if (eatN) eatN.textContent = String(eatenList.length)
      if (!eatListEl) return
      if (!eatenList.length) {
        eatListEl.textContent = '（暂无）'
        eatListEl.style.color = '#777'
        return
      }
      eatListEl.style.color = ''
      eatListEl.textContent = ''
      eatenList.forEach((x, i) => {
        const row = document.createElement('div')
        row.style.cssText = 'padding:3px 2px;border-bottom:1px dashed #33333a;cursor:pointer'
        row.textContent = `${i + 1}. ${x}`
        row.title = '点击把这句放回输入框'
        row.onclick = () => { restoreToBox([x]); toast('已放回输入框', 1500) }
        eatListEl.appendChild(row)
      })
    }
    paintEaten()
    const clearE = panel.querySelector('#bds6-cleareat')
    if (clearE) clearE.onclick = () => { eatenList = []; saveJSON(EATEN_KEY, eatenList); paintEaten() }
  }

  /* ───────── 启动 ───────── */
  function boot() {
    if (!/live\.bilibili\.com/.test(location.host)) return
    buildUI()
    const attach = () => {
      const el2 = findInput()
      if (el2) { if (cfg.mode === 'shadow') bindInput(el2); else bindCompat(el2) }
    }
    attach()
    // 直播间是 SPA：房间切换/重渲染时重新绑定（防抖，避免自触发死循环）
    let busy = false
    const mo = new MutationObserver(() => {
      if (busy) return
      busy = true
      setTimeout(() => { busy = false; attach() }, 400)
    })
    mo.observe(document.body, { childList: true, subtree: true })
    setInterval(attach, 3000)
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
})()
