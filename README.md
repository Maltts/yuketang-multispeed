# 雨课堂多倍速助手

> 通过 Chrome DevTools 协议把雨课堂课程视频锁定在 **5 倍速**自动连播，直到整门课的视频全部完成。

[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

---

## 它解决什么问题

雨课堂的课程视频默认只能 1 倍速观看，一门课 178 个视频、约 27 小时素材，正常播完要一整天。
这个工具把播放速率锁定在 5 倍，同时自动切换到下一节，直到所有视频都被后台标记为「已完成」。

**它不改动雨课堂的任何数据，只是让浏览器以合法的速率播放。** 成绩由雨课堂后台真实记录决定。

---

## 为什么是 5 倍，不是更快

这是本项目最重要的实测结论，也是唯一需要认真看的一段。

雨课堂后台根据心跳上报的观看时长计算进度。实测结果：

| 设定倍速 | 后台记录速率 | 缺口是否累积 | 能否 100% 完成 |
|---|---|---|---|
| 1x – 4x | 1x – 4x | 否 | ✅ 可以 |
| **5x** | **≈4.96x** | **否** | ✅ **可以** |
| 6x | 每批少记 30–36 秒 | **是**（23 → 53 → 89 → 109 秒） | ❌ 永远卡在 0.847 |

6 倍速下，缺口会随着视频推进不断累积，`completed` 永远是 false。**所以不要贪快，5 倍是上限。**

另一个容易误判的点：侧栏显示的百分比是「已看时长 / 总时长」，`rate` 字段永远不会等于 1。
真正决定这一节算不算完成的是后台返回的 **`completed` 布尔值**，不是百分比。

---

## 快速开始

### 前置条件

- Windows（macOS / Linux 改一下启动脚本即可，逻辑通用）
- Microsoft Edge 或 Chrome
- [Node.js](https://nodejs.org) 18 及以上

### 三步

```bash
git clone https://github.com/Maltts/yuketang-multispeed.git
cd yuketang-multispeed
```

1. 双击 `启动.bat`（Windows），会打开一个带调试端口的独立浏览器窗口
2. 在该窗口登录雨课堂，进入课程并点开任意一个视频
3. 回到命令行按任意键，脚本自动注入并开始工作

macOS / Linux 手动等价命令：

```bash
# 终端 A
"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
  --remote-debugging-port=9223 \
  --user-data-dir="$PWD/profile" \
  https://www.yuketang.cn/v2/web/index

# 终端 B（登录进课程后）
CDP_MATCH=yuketang.cn node run-agent2.mjs
```

---

## 工作原理

整个过程只依赖两件事：CDP 注入，以及两个属性的劫持。

### 1. 锁死倍速

雨课堂的播放器有一个看门狗，会周期性把 `currentTime` 往回拖、把 `playbackRate` 改回 1。
所以不能只是「设置一次倍速」，而要接管 setter：

```js
var d = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'playbackRate');
Object.defineProperty(HTMLMediaElement.prototype, 'playbackRate', {
  configurable: true,
  get: function () { return d.get.call(this); },
  set: function () { try { d.set.call(this, window.__RATE); } catch (e) {} }
});
```

`currentTime` 同样处理，但只拦截**向后**的 seek，正常播放的推进不拦。

### 2. 按节点推进

侧栏每个 `.leaf-item` 就是一个课程节点，`.leaf-item-tag` 区分「视频 / 作业 / 图文」。
脚本只挑 `视频` 类型的节点，播完一个点下一个。

课程参数（`cid` / `user_id` / `classroom_id`）**全部从运行时网络请求里动态抓取**，
所以换账号、换课程都不需要改代码：

```js
// 从 Performance Resource Timing 里捞出 video-log 请求的参数
var es = performance.getEntriesByType('resource');
for (var i = es.length - 1; i >= 0; i--) {
  if (!/video-log/.test(es[i].name)) continue;
  var cid = es[i].name.match(/[?&]cid=(\d+)/);
  var uid = es[i].name.match(/[?&]user_id=(\d+)/);
  // ...
}
```

### 3. 收尾确认

一节课播完后，脚本不会立刻跳走，而是每 3 秒轮询一次后台：

```
/video-log/get_video_watch_progress/?cid=...&classroom_id=...&video_type=video&vtype=rate&video_id=...
```

只有拿到 `completed === 1` 才切换到下一节。45 秒仍未确认，就原地重播一次（最多两次）。

---

## 常见问题

**进度条停在 90% 多，没到 100%？**
正常。`rate` 是时长比值，5 倍速下后台按 5 倍计时，数值天然到不了 1。看 `completed` 是否为 true。

**侧栏一堆 `--` 或百分比不刷新？**
那是页面加载时的快照，只有刷新页面才会更新，不代表失败。以后台 `completed` 为准。

**弹出「请完成安全核验」的拖拽验证？**
随机触发，会自动超时消失，脚本会自己接上。卡住超过 2 分钟就手动拖一次（从「起」拖到「终」，经过 1、2、3）。

**能一边刷一边用电脑吗？**
可以，别关那个浏览器窗口。注意关闭系统休眠，否则会中断。

**中途关掉，会从头开始吗？**
不会。脚本会从第一个 `completed !== 1` 的节点继续。

---

## 目录结构

```
├── 启动.bat           # Windows 一键启动（启动浏览器 → 等登录 → 注入）
├── run-agent2.mjs     # CDP 注入器：连接调试端口、注册脚本、保活
├── inject2.js         # 核心逻辑：锁速 + 节点推进 + 后台确认
├── 使用说明.txt        # 面向普通用户的图文步骤
└── README.md
```

---

## 免责声明

- 本项目仅供**技术研究与学习使用**，用于理解 CDP 协议、浏览器媒体 API 和前端逆向的基本方法。
- 使用本工具可能违反雨课堂 / 学堂在线的用户协议。**由此产生的账号封禁、成绩作废、学术处分等后果，由使用者自行承担。**
- 作者不对任何因使用本工具造成的直接或间接损失负责。
- 请勿将本工具用于商业用途或售卖。

如果你只是想把课刷完，我建议你直接开 2 倍速看完 —— 学到的东西是自己的。

---

## 相关项目

- **[zhihuishu-mastery](https://github.com/Maltts/zhihuishu-mastery)** — 智慧树「掌握度」半自动练习助手，同一套 CDP 技术栈

---

## License

[MIT](LICENSE)
