(function () {
  'use strict';
  if (window.__YT_BOOST__) {
    try { window.__YT_BOOST__.tick(); } catch (e) {}
    return;
  }

  var CFG = { rate: parseFloat(localStorage.getItem('ytb2_rate') || '5'), autoNext: true, resume: true, tail: 0, dwell: 32000 };
  var LOG = [];
  function log(s) { LOG.push(new Date().toLocaleTimeString() + ' ' + s); if (LOG.length > 80) LOG.shift(); }

  /* ---------- 1. 锁死倍速 ---------- */
  window.__RATE = CFG.rate;
  try {
    var P = HTMLMediaElement.prototype;
    if (!P.__ratePatched) {
      var d = Object.getOwnPropertyDescriptor(P, 'playbackRate');
      Object.defineProperty(P, 'playbackRate', {
        configurable: true,
        get: function () { return d.get.call(this); },
        set: function () { try { d.set.call(this, window.__RATE); } catch (e) {} },
      });
      var dd = Object.getOwnPropertyDescriptor(P, 'defaultPlaybackRate');
      if (dd && dd.set) {
        Object.defineProperty(P, 'defaultPlaybackRate', {
          configurable: true,
          get: function () { return dd.get.call(this); },
          set: function () { try { dd.set.call(this, window.__RATE); } catch (e) {} },
        });
      }
      P.__ratePatched = 1;
    }
    /* ---------- 2. 拦掉看门狗的向后拖拽 ---------- */
    if (!P.__ctPatched) {
      var cd = Object.getOwnPropertyDescriptor(P, 'currentTime');
      window.__BLOCKED = 0;
      Object.defineProperty(P, 'currentTime', {
        configurable: true,
        get: function () { return cd.get.call(this); },
        set: function (v) {
          var cur = cd.get.call(this);
          if (!window.__ALLOW_SEEK && v < cur - 0.05) { window.__BLOCKED++; return; }
          cd.set.call(this, v);
        },
      });
      P.__ctPatched = 1;
      log('ct-patch ok');
    }
  } catch (e) { log('patch fail ' + e.message); }

  /* ---------- 3. 防离开页面暂停 ---------- */
  try {
    Object.defineProperty(document, 'hidden', { configurable: true, get: function () { return false; } });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: function () { return 'visible'; } });
    document.hasFocus = function () { return true; };
    document.addEventListener('visibilitychange', function (e) { e.stopImmediatePropagation(); }, true);
    window.addEventListener('blur', function (e) { e.stopImmediatePropagation(); }, true);
  } catch (e) {}

  /* ---------- 工具 ---------- */
  function vids() { return Array.prototype.slice.call(document.querySelectorAll('video')); }
  function tagOf(e) { var t = e.querySelector('.leaf-item-tag'); return t ? (t.innerText || '').trim() : ''; }
  /* 只跑「视频」节点；作业/图文跳过 */
  function leaves() {
    return Array.prototype.slice.call(document.querySelectorAll('.leaf-item')).filter(function (e) {
      return tagOf(e) === '视频';
    });
  }
  function titleOf(e) { var t = e.querySelector('.leaf-item-title'); return t ? (t.innerText || '').trim() : ''; }
  function activeLeaf() { return document.querySelector('.leaf-item.is-active'); }
  function leafByTitle(t) {
    var L = leaves();
    for (var i = 0; i < L.length; i++) if (titleOf(L[i]) === t) return L[i];
    return null;
  }
  // 返回 100 / 0~99 / null(无状态)
  function statusByTitle(t) {
    var e = leafByTitle(t);
    if (!e) return null;
    var s = e.querySelector('.leaf-item-status');
    if (!s) return null;
    if (s.querySelector('.icon-yuanquangou-mianzhuang')) return 100;
    var p = s.querySelector('.status-pie');
    if (p) {
      var st = p.getAttribute('style') || '';
      var n = parseInt(st.split(':')[1], 10);
      return isNaN(n) ? 0 : n;
    }
    return null;
  }

  function setRateAll(r) {
    CFG.rate = r;
    window.__RATE = r;
    localStorage.setItem('ytb2_rate', String(r));
    vids().forEach(function (v) { try { v.playbackRate = r; } catch (e) {} });
    paintBtns();
  }

  function play(v) {
    if (!v.paused) return;
    var p = v.play();
    if (p && p.catch) p.catch(function () { try { v.muted = true; v.play().catch(function () {}); } catch (e) {} });
  }

  /* ---------- 4. 核对 + 补做 ---------- */
  var S = { lastTitle: null, prevTitle: null, retry: [], attempt: {}, atEnd: false, tried: {}, retryMode: false, resumeTo: null,
            phase: '', tailMode: 0, advAt: 0, nodeAt: 0, holdTitle: null, endedAt: 0, holding: false, quizAt: 0, zeroAt: 0, audited: false };

  function verifyPrev(prev) {
    setTimeout(function () {
      var st = statusByTitle(prev);
      log('核对「' + prev.slice(0, 12) + '」= ' + (st === null ? '无状态' : st + '%') + '（目录数据不刷新，仅记录）');
    }, 5000);
  }

  function replayNext() {
    if (!S.retryMode) {
      var a0 = activeLeaf();
      S.resumeTo = a0 ? titleOf(a0) : null;
      S.retryMode = true;
      log('进入补做模式，原位置：' + (S.resumeTo || '-').slice(0, 12));
    }
    while (S.retry.length) {
      var t = S.retry.shift();
      var n = (S.attempt[t] || 0) + 1;
      if (n > 3) { log('放弃补做：' + t.slice(0, 12)); continue; }
      S.attempt[t] = n;
      var el = leafByTitle(t);
      if (!el) { log('补做找不到节点：' + t.slice(0, 12)); continue; }
      var r = n >= 2 ? 1 : CFG.rate;
      setRateAll(r);
      log('补做「' + t.slice(0, 12) + '」第 ' + n + ' 次 @' + r + 'x（整段重放）');
      el.click();
      S.advAt = Date.now();
      S.zeroAt = Date.now() + 3000;
      return true;
    }
    log('补做队列已清空');
    return false;
  }

  function advance(hop) {
    hop = hop || 0;
    if (hop > 6) return;
    /* 防重复推进：一次跳节后 4.5s 内忽略外部调用（递归重试 hop>0 不受限） */
    if (hop === 0 && Date.now() - (S.advAt || 0) < 4500) {
      log('advance 冷却中(距上次 '+Math.round((Date.now()-(S.advAt||0))/1000)+'s)，忽略');
      return;
    }

    /* 补做模式：先清空队列，再回到原位置继续主线 */
    if (S.retryMode) {
      if (S.retry.length) { replayNext(); return; }
      var back = S.resumeTo;
      S.retryMode = false;
      S.resumeTo = null;
      var el2 = back ? leafByTitle(back) : null;
      if (el2) { log('补做结束，回到「' + back.slice(0, 12) + '」'); el2.click(); S.advAt = Date.now(); return; }
      log('补做结束');
      return;
    }

    var all = leaves();
    var i = -1;
    for (var k = 0; k < all.length; k++) if (all[k].classList.contains('is-active')) { i = k; break; }
    if (i < 0) {                       /* 当前停的是作业/图文等非视频节点 → 直接回第一个视频 */
      if (all[0]) {
        log('当前不在视频节点，回到第一个视频：' + titleOf(all[0]).slice(0, 14));
        all[0].click(); S.advAt = Date.now();
      }
      return;
    }
    var next = all[i + 1];
    if (!next) { // 到头了
      if (S.retry.length) { replayNext(); return; }
      var round = parseInt(localStorage.getItem('ytb2_round') || '0', 10);
      if (!S.audited && round < 3) {
        S.audited = true;
        localStorage.setItem('ytb2_round', String(round + 1));
        log('主线走完，刷新核对（第 ' + (round + 1) + ' 轮）');
        setTimeout(function () { location.reload(); }, 2500);
        return;
      }
      log('全部节点已走完');
      return;
    }
    log('跳转 -> ' + titleOf(next).slice(0, 16));
    next.click();
    S.advAt = Date.now();
    setTimeout(function () {
      var has = vids().some(function (v) { return v.duration > 1; });
      if (!has) advance(hop + 1);
    }, 6000);
  }

  /* ---------- 4b. 弹题自动作答 ---------- */
  function quizRows(box) {
    var all = Array.prototype.slice.call(box.querySelectorAll('div,li,label,p'));
    var rows = [];
    all.forEach(function (e) {
      var t = (e.innerText || '').replace(/\s+/g, ' ').trim();
      if (!/^[A-H][\s.、]/.test(t) || t.length < 8) return;
      var hasChild = Array.prototype.slice.call(e.querySelectorAll('div,li,label,p')).some(function (c) {
        var ct = (c.innerText || '').replace(/\s+/g, ' ').trim();
        return /^[A-H][\s.、]/.test(ct) && ct.length > 8;
      });
      if (!hasChild) rows.push(e);
    });
    return rows;
  }

  function answerQuiz(mask) {
    var box = mask.querySelector('.c-question') || mask;
    var txt = (box.innerText || '').replace(/\s+/g, ' ');
    var isMulti = /多选/.test(txt);
    var isJudge = /判断/.test(txt);
    var rows = quizRows(box);
    log('弹题[' + (isMulti ? '多选' : isJudge ? '判断' : '单选') + '] ' + txt.slice(0, 90) + ' 选项' + rows.length);

    if (!rows.length) { log('弹题选项没找到'); return; }

    var picks = [];
    if (isJudge) {
      picks = [rows[0]];
    } else if (isMulti) {
      var lens = rows.map(function (r) { return (r.innerText || '').length; });
      var avg = lens.reduce(function (a, b) { return a + b; }, 0) / lens.length;
      rows.forEach(function (r, i) { if (lens[i] >= avg) picks.push(r); });
      if (!picks.length) picks = [rows[0]];
    } else {
      var best = rows[0], bl = 0;
      rows.forEach(function (r) { var l = (r.innerText || '').length; if (l > bl) { bl = l; best = r; } });
      picks = [best];
    }

    picks.forEach(function (r) {
      try { r.click(); } catch (e) {}
      log('选中：' + (r.innerText || '').replace(/\s+/g, ' ').slice(0, 24));
    });

    setTimeout(function () {
      var btn = Array.prototype.slice.call((mask.querySelector('.c-question') || mask).querySelectorAll('button,div,span'))
        .filter(function (e) { return (e.innerText || '').trim() === '提交答案' && e.offsetParent; })[0];
      if (btn) { btn.click(); log('已提交弹题'); }
      else log('没找到提交按钮');
      setTimeout(function () {
        var go = Array.prototype.slice.call(document.querySelectorAll('button,div,span'))
          .filter(function (e) {
            var t = (e.innerText || '').trim();
            return e.offsetParent && e.children.length <= 1 && /^(继续播放|继续学习|继续|知道了|关闭|确定)$/.test(t);
          })[0];
        if (go) { go.click(); log('关闭弹题提示'); }
      }, 1800);
    }, 900);
  }

  /* ---------- 4c. 后端完成度确认（真正决定成绩的是 completed 布尔值） ---------- */
  /* cid 每门课不同，从页面已发出的请求里自动读；classroom_id 从 URL 读 */
  function params() {
    if (window.__PARAMS__) return window.__PARAMS__;
    var cid = null, uid = null;
    var es = performance.getEntriesByType('resource');
    for (var i = es.length - 1; i >= 0; i--) {
      if (!/video-log/.test(es[i].name)) continue;
      var m1 = es[i].name.match(/[?&]cid=(\d+)/);
      var m2 = es[i].name.match(/[?&]user_id=(\d+)/);
      if (m1) cid = m1[1];
      if (m2) uid = m2[1];
      if (cid && uid) break;
    }
    var cm = location.href.match(/lms-graph\/(\d+)/) || location.href.match(/classroom_id=(\d+)/);
    window.__PARAMS__ = { cid: cid, uid: uid, crid: cm ? cm[1] : null };
    return window.__PARAMS__;
  }
  function videoId() { var m = location.href.match(/video\/(\d+)/); return m ? m[1] : null; }
  function PROG(vid) {
    var p = params();
    if (!p.cid || !p.uid) return Promise.reject(new Error('no-params'));
    var u = 'https://www.yuketang.cn/video-log/get_video_watch_progress/?cid=' + p.cid + '&user_id=' + p.uid +
      '&classroom_id=' + p.crid + '&video_type=video&vtype=rate&video_id=' + vid + '&snapshot=1&no_loading=true';
    return fetch(u, { credentials: 'include', headers: { xtbz: 'ykt', 'X-Requested-With': 'XMLHttpRequest' } })
      .then(function (r) { return r.json(); })
      .then(function (j) { return (j.data && j.data[vid]) || j; });
  }

  /* 原地重放：不动导航，直接把当前视频拉回 0 再播；最多 2 次 */
  function replaySelf() {
    var t = titleOf(activeLeaf() || document.body);
    var n = (S.attempt[t] || 0) + 1;
    S.attempt[t] = n;
    if (n > 2) {
      log('重放 2 次仍失败，排入补做并跳过：' + (t || '').slice(0, 10));
      if (S.retry.indexOf(t) < 0) S.retry.push(t);
      S.phase = ''; advance(0); return;
    }
    var v = vids().filter(function (x) { return x.duration > 1; })[0];
    if (!v) { S.phase = ''; advance(0); return; }
    window.__ALLOW_SEEK = true;
    try { v.currentTime = 0; } catch (e) {}
    window.__ALLOW_SEEK = false;
    S.tailMode = 0; S.phase = ''; S.nodeAt = Date.now(); S.advAt = 0;
    log('原地重放第 ' + n + ' 次 @' + CFG.rate + 'x：' + (t || '').slice(0, 10));
    try { play(v); } catch (e) {}
  }

  function onEnded(why) {
    if (S.phase === 'verify') return;
    S.phase = 'verify';
    S.tailMode = 0;
    var t = titleOf(activeLeaf() || document.body);
    S.holdTitle = t;
    log('[' + why + '] 向后端确认：' + (t || '').slice(0, 12));
    var vid = videoId();
    var n = 0;
    (function poll() {
      var cur = titleOf(activeLeaf() || document.body);
      if (cur !== S.holdTitle) { S.phase = ''; log('节点已换掉，停止确认'); return; }
      PROG(vid).then(function (p) {
        if (p && (p.completed === 1 || p.completed === true)) {
          log('✔ 后端已确认完成 rate=' + (p.rate ? (+p.rate).toFixed(3) : '?') + ' 用时' + n * 3 + 's');
          S.phase = ''; advance(0); return;
        }
        n++;
        if (n % 3 === 0) log('… 仍未确认 rate=' + (p && p.rate ? (+p.rate).toFixed(3) : '?'));
        if (n > 15) {
          log('✖ 45s 未确认，原地重放：' + (S.holdTitle || '').slice(0, 8));
          S.phase = '';
          replaySelf();
          return;
        }
        setTimeout(poll, 3000);
      }).catch(function (e) {
        n++;
        if (n > 15) { S.phase = ''; advance(0); } else setTimeout(poll, 3000);
      });
    })();
  }

  /* ---------- 5. 主循环 ---------- */
  function tick() {
    var vs = vids();
    var a = activeLeaf();
    var title = a ? titleOf(a) : null;

    // 节点切换 -> 核对上一节
    if (title && S.lastTitle && title !== S.lastTitle) {
      S.prevTitle = S.lastTitle;
      S.nodeAt = Date.now();
      S.holding = false; S.tailMode = 0; S.holdTitle = null; S.endedAt = 0; S.phase = '';
      verifyPrev(S.lastTitle);
    }
    if (title && !S.nodeAt) S.nodeAt = Date.now();
    if (title) S.lastTitle = title;

    /* 弹题：出现就作答（视频会被它暂停） */
    if (!S.quizAt || Date.now() - S.quizAt > 9000) {
      var m = document.querySelector('.c-question-mask');
      if (m && m.offsetParent !== null) {
        S.quizAt = Date.now();
        try { answerQuiz(m); } catch (e) { log('quiz err ' + e.message); }
      }
    }

    vs.forEach(function (v) {
      var eff = CFG.rate;
      if (CFG.tail > 0 && CFG.rate > 2 && v.duration > 1 && (v.duration - v.currentTime) <= CFG.tail) eff = 1;
      if (S.tailMode) eff = 1;                       /* 收尾阶段强制 1x，把 cp 顶到 duration */
      window.__RATE = eff;
      if (Math.abs(v.playbackRate - eff) > 0.01) { try { v.playbackRate = eff; } catch (e) {} }

      /* 尾部悬停：按倍速放大窗口（4x→8s，6x→12s），确保 tick 能抓到 */
      var holdAt = Math.max(2, CFG.rate * 2);
      if (!S.phase && v.duration > 1 && !v.paused &&
          Date.now() - (S.nodeAt || 0) > 3000 &&
          (v.duration - v.currentTime) <= holdAt && (v.duration - v.currentTime) > 0) {
        S.phase = 'hold';
        S.holdTitle = titleOf(activeLeaf() || document.body);
        try { v.pause(); } catch (e) {}
        log('到尾部，暂停 2s 上报 → 1x 收尾：' + (S.holdTitle || '').slice(0, 12));
        setTimeout(function () {
          if (S.phase !== 'hold') return;
          S.phase = 'coast'; S.tailMode = 1;
          try { play(v); } catch (e) {}
        }, 2000);
        return;
      }
      if (!v.__ytb) {
        v.__ytb = 1;
        v.addEventListener('ended', function () { onEnded('ended 事件'); });
        v.addEventListener('pause', function () {
          if (!CFG.resume || v.ended || S.phase) return;
          setTimeout(function () { if (v.paused && !v.ended && !S.phase) play(v); }, 1000);
        });
      }
      if (CFG.resume && !S.phase && v.paused && !v.ended && v.duration > 1) play(v);
      /* 已完成的节点被误入 → 播放器会直接停在末尾，走同一条确认流程 */
      if (!S.phase && v.ended && Date.now() - (S.nodeAt || 0) > 4000) onEnded('停在末尾');
    });

    // 播到末尾且是最后一个节点 -> 触发补做
    var v0 = vs[0];
    // 补做时强制从头播
    if (S.zeroAt && Date.now() > S.zeroAt && v0 && v0.duration > 1) {
      S.zeroAt = 0;
      if (v0.currentTime > 3) {
        window.__ALLOW_SEEK = true;
        try { v0.currentTime = 0; } catch (e) {}
        window.__ALLOW_SEEK = false;
        log('已强制从头播放');
      }
    }
    if (v0 && v0.ended && S.retry.length && !S.atEnd) {
      S.atEnd = true;
      setTimeout(function () { S.atEnd = false; replayNext(); }, 3000);
    }

    render(v0, title);
  }

  /* ---------- 6. 面板 ---------- */
  var panel, info, row0;
  function render(v, title) {
    if (!panel || !document.body.contains(panel)) build();
    if (!info) return;
    info.innerHTML =
      '<div style="color:#9aa4b5;margin-bottom:3px">' + (title ? title.slice(0, 20) : '-') + '</div>' +
      (v
        ? '<div style="color:#7ee0a5">' + fmt(v.currentTime) + ' / ' + fmt(v.duration) + ' · ' + CFG.rate + 'x' +
          (v.paused ? ' · <span style="color:#ffb454">暂停</span>' : '') + '</div>'
        : '<div style="color:#ff7a7a">未检测到视频</div>') +
      '<div style="color:#6b7484;font-size:10px;margin-top:2px">补做队列 ' + S.retry.length + '</div>';
  }
  function fmt(t) {
    if (!isFinite(t)) return '--:--';
    t = Math.floor(t); var m = Math.floor(t / 60), s = t % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }
  function paintBtns() {
    if (!row0) return;
    Array.prototype.forEach.call(row0.children, function (c) {
      var on = c.textContent.trim() === CFG.rate + 'x';
      c.style.background = on ? '#3b6ef0' : '#242b37';
      c.style.borderColor = on ? '#3b6ef0' : '#39414f';
      c.style.color = on ? '#fff' : '#cfd6e2';
    });
  }
  function build() {
    var old = document.getElementById('ytb-panel');
    if (old) old.remove();
    panel = document.createElement('div');
    panel.id = 'ytb-panel';
    panel.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:2147483647;background:rgba(24,28,38,.94);' +
      'color:#e8ecf3;font:12px/1.7 system-ui,"Microsoft YaHei";padding:9px 11px;border-radius:10px;' +
      'box-shadow:0 8px 24px rgba(0,0,0,.45);user-select:none;min-width:190px';
    var h = document.createElement('div');
    h.style.cssText = 'font-weight:600;color:#8ab4ff;margin-bottom:4px';
    h.textContent = '加速助手';
    panel.appendChild(h);
    info = document.createElement('div');
    info.style.cssText = 'margin-bottom:6px;font-size:11px';
    panel.appendChild(info);
    row0 = document.createElement('div');
    row0.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px';
    [1, 1.5, 2, 2.5, 3, 4, 6].forEach(function (r) {
      var b = document.createElement('button');
      b.textContent = r + 'x';
      b.style.cssText = 'padding:2px 7px;border:1px solid #39414f;background:#242b37;color:#cfd6e2;border-radius:6px;cursor:pointer;font:11px system-ui';
      b.onclick = function (e) { e.preventDefault(); S.retry = []; setRateAll(r); };
      row0.appendChild(b);
    });
    panel.appendChild(row0);
    paintBtns();
    var row2 = document.createElement('div');
    row2.style.cssText = 'display:flex;gap:4px;margin-top:5px';
    var bn = document.createElement('button');
    bn.textContent = '下一节 ▶';
    bn.style.cssText = 'padding:2px 7px;border:1px solid #39414f;background:#242b37;color:#cfd6e2;border-radius:6px;cursor:pointer;font:11px system-ui';
    bn.onclick = function (e) { e.preventDefault(); advance(0); };
    row2.appendChild(bn);
    var rp = document.createElement('button');
    rp.textContent = '补做 ↻';
    rp.style.cssText = bn.style.cssText;
    rp.onclick = function (e) { e.preventDefault(); replayNext(); };
    row2.appendChild(rp);
    panel.appendChild(row2);
    document.body.appendChild(panel);
  }

  window.__YT_BOOST__ = {
    tick: tick, log: function () { return LOG.slice(-25).join('\n'); },
    cfg: CFG, advance: advance, replayNext: replayNext,
    retry: S.retry, status: statusByTitle, prog: function () { var v = videoId(); return v ? PROG(v) : null; },
    scan: function () {
      return leaves().map(function (e) {
        var t = titleOf(e); var s = statusByTitle(t);
        return (s === 100 ? '[OK] ' : '[' + (s === null ? '--' : s + '%') + '] ') + t.slice(0, 22);
      });
    },
  };

  /* ---------- 7. 启动时回填：把已经卡在 <100% 的节点收进补做队列 ---------- */
  function backfill(tries) {
    tries = tries || 0;
    if (leaves().length < 5) {
      if (tries > 30) { log('目录一直没渲染，放弃回填'); return; }
      setTimeout(function () { backfill(tries + 1); }, 2000);
      return;
    }
    var a = activeLeaf();
    var actTitle = a ? titleOf(a) : null;
    leaves().forEach(function (e) {
      var t = titleOf(e);
      if (!t || t === actTitle) return;
      var st = statusByTitle(t);
      if (st !== null && st < 100 && S.retry.indexOf(t) < 0) S.retry.push(t);
    });
    if (S.retry.length) {
      log('补做队列初始化 ' + S.retry.length + ' 条：' + S.retry.map(function (x) { return x.slice(0, 8); }).join(','));
    } else {
      S.audited = true;
      log('审核通过：所有节点均 100%');
    }
  }
  setTimeout(function () { backfill(0); }, 3000);

  build();
  tick();
  setInterval(tick, 800);
  log('注入完成 rate=' + CFG.rate);
})();
