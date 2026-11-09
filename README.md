# dsh-chat-zhihu

[中文](#中文) · [English](#english)

---

## 中文

在 DeepSeek Harness（DSH）的**会话流里**摸鱼看知乎。输入 `/zhihu`，热榜就出现在你敲命令的那一轮，长得像一条普通的 AI 回复；点进问题就在卡片里往下读回答。内容**不进模型上下文、不产生任何 token**。

适配 DSH `>=0.2.1-0 <0.3.0-0`。看热榜 Web 版和桌面版都行；**看问题、回答、专栏需要桌面版**（见下文「原理」）。

### 特性

- **长在会话里**：卡片是一个自定义 chat node，位置就是 `/zhihu` 那一轮；`/zhihu` 这行命令本身不显示。
- **伪装成普通回复**：没有知乎配色和头像，问题标题像回复的小标题，作者和赞同数是一行小字，正文按段落排版；字号默认跟随会话字号。标题栏和按钮默认隐藏，鼠标移入才浮出。
- **图片默认不显示**（最容易露馅），只留一个小小的「［图］」，可在设置里打开。
- **零 token**：`/zhihu` 只产生两条只写日志的事件（`command/run` / `command/done`），结果只是一个目标（热榜 / 问题 id / 回答 id / 文章 id），不伪造 assistant 消息。
- **不顶动历史**：卡片高度 = 会话可视高度 − 输入框高度，内容在卡片内部滚动，往下滚到底自动加载更多回答。
- **老板键**（默认 `Ctrl + Alt + Z`，可在设置里改；和 dsh-chat-reader 的 `Ctrl + Alt + B` 不冲突）：按一次所有知乎卡片折叠成一行 `···`，内容**从 DOM 移除**，后台的知乎网页也一并关掉；再按恢复。刷新后保持。
- **卡片内导航**：热榜 → 问题 → 返回，每层的滚动位置都记得；刷新页面后回到原处。
- **会话常驻侧边栏**：和 dsh-chat-reader 一样，在新会话里 `/zhihu` 后跑一个不调用模型的空轮次，让会话留在侧边栏；会话标题默认是「资料整理」（可改）。

### 用法

```
/zhihu                                              # 热榜
/zhihu https://www.zhihu.com/question/123456        # 问题
/zhihu https://www.zhihu.com/question/123/answer/456 # 从某个回答开始读
/zhihu https://zhuanlan.zhihu.com/p/789             # 专栏文章
/zhihu 123456 · a456 · p789                         # 简写：问题 / 回答 / 文章
```

### 键盘

快捷键都绑在**卡片**上，点一下卡片才生效；插件唯一的全局监听是老板键。

| 按键 | 作用 |
| --- | --- |
| `空格` / `→` / `PageDown` | 下一页（`Shift+空格` 上一页） |
| `←` / `PageUp` | 上一页 |
| `↑` `↓` | 上 / 下滚一行 |
| `J` / `K` | 下一个 / 上一个回答 |
| `Backspace` | 返回上一层 |
| `Esc` | 合上卡片（点击 `···` 展开） |
| 老板键 | 全部知乎卡片折叠 / 恢复 |

### 登录

知乎的问题和回答只给登录用户看。两种方式，任选其一：

1. **卡片里扫码**：打开问题时如果提示要登录，点「在这里登录」（或悬停后点底栏的「登录」），卡片里会出现知乎登录页，扫码或输密码即可，登录完自动回来。DSH 给插件的内嵌网页是**进程级**存储，**App 重启后需要重新登录**。
2. **填 cookie（免重复登录）**：设置 → **知乎** → 粘贴浏览器里 `zhihu.com` 的完整 Cookie（需含 `z_c0`）。插件每次启动时把它种进自己的内嵌网页。cookie 只保存在本机 `$DSH_HOME/dsh-chat-zhihu/cookie.json`（权限 600），接口只回报「已设置」，不回显内容。

### 原理

- **热榜**由插件宿主侧请求知乎的公开热榜接口（不需要登录），缓存 1 分钟。
- **问题 / 回答 / 专栏**：知乎对这些接口有登录墙和签名校验。插件不去破解签名，而是在 DSH 桌面版里通过 `window.dshDesktop.browser`（DSH 自带侧栏浏览器用的同一个桥）租用一个**隐藏的 `<webview>`**，在里面正常打开知乎页面，读取页面自带的数据（`js-initialData`）和 DOM，然后把正文 HTML **转换成纯文本段落**再显示——知乎的 HTML 从不插进 DSH 页面。往下滚时，插件让隐藏网页滚到底，知乎自己加载更多回答。
- 隐藏网页运行在 DSH 的沙箱分区里（无 Node、contextIsolation、禁权限请求），和 DSH 自带浏览器的隔离策略一致。

### 设置

设置 → **知乎**：cookie、字号（默认跟随会话）、行距、显示图片（默认关）、老板键、常驻侧边栏、会话标题。

### 安装

**桌面版：** 打开左侧 **Plugins** 页，用 GitHub spec 安装 `github:luyang950/dsh-chat-zhihu`，按提示重启。

**命令行（Web 版 profile，只能看热榜）：**

```bash
dsh plugin --profile web add github:luyang950/dsh-chat-zhihu
```

预构建分发：没有构建脚本、没有 TypeScript、零运行时依赖。

### 安全

- `/zhihu` 只接受 `zhihu.com` 的问题、回答、专栏链接或纯数字 id；其他链接一律拒绝。
- 知乎的富文本经插件自带的小型解析器转成纯文本 / 图片地址，`<script>`、`<style>`、`<noscript>`、`<iframe>` 等整段丢弃；图片只接受 `*.zhimg.com` 的 https 地址，并以 `no-referrer` 加载。
- 插件只写 `$DSH_HOME/dsh-chat-zhihu/`：`config.json` 和 `cookie.json`（600）。

### HTTP 接口

前缀 `/dsh-chat-zhihu/api/`，统一返回 `{ ok, ... }` 或 `{ ok:false, error }`。

| 路由 | 方法 | 说明 |
| --- | --- | --- |
| `config` | GET / POST | 读取 / 局部更新配置（附带 `cookieSet`） |
| `cookie` | GET / POST `{cookie}` | 给浏览器端取 cookie 种入内嵌网页 / 保存（`''` 清除），POST 不回显内容 |
| `hot?refresh=1` | GET | 热榜（缓存 1 分钟） |

### 开发

```bash
npm test        # node --test，零依赖
```

覆盖链接解析、cookie 校验与存储权限、热榜解析（含 19 位 id 不丢精度）、路由校验、`/zhihu` 结果，以及 client bundle 的 loader 契约、HTML → 文本块转换、回答合并、老板键和在页面里运行的抽取脚本。

结构：

```
index.mjs           host 半边（cordis 插件）：/zhihu 命令 + API 路由
lib/zhihu.mjs       链接解析、热榜请求与解析
lib/store.mjs       config / cookie 持久化
lib/session.mjs     /zhihu 后用空轮次让会话常驻侧边栏、起标题
lib/client.js       client 半边（ModuleLoader bundle，仅依赖 react）：卡片、隐藏 webview、HTML 解析
cordis.patch.yml
```

---

## English

Read Zhihu **inside the DeepSeek Harness conversation transcript**, disguised as an ordinary reply. `/zhihu` shows the hot list where you typed it; open a question and read its answers inside the card. Nothing enters the model context; zero tokens.

- **Hot list** works on Web and Desktop (fetched by the host from Zhihu's public endpoint).
- **Questions, answers and articles need DSH Desktop**: Zhihu shows them only to a signed-in browser, so the card leases one hidden `<webview>` through `window.dshDesktop.browser` (the bridge DSH's own sidebar browser uses), opens the page there and reads the page's own data. Zhihu's HTML is converted to plain text blocks by a small parser and never injected.
- **Sign in** inside the card (QR code; lasts until the app quits) or paste your Zhihu cookie (with `z_c0`) in Settings → 知乎 so it survives restarts. The cookie is stored only in `$DSH_HOME/dsh-chat-zhihu/cookie.json` (mode 600).
- **Boss key** `Ctrl + Alt + Z` (configurable) folds every card to `···`, removes the text from the DOM and closes the hidden webview.
- Images are off by default; settings: font size, line height, images, boss key, keep-in-sidebar, session title.

Install on Desktop: **Plugins** → GitHub spec `github:luyang950/dsh-chat-zhihu`, then restart.

```
/zhihu                                    # hot list
/zhihu <question / answer / article link> # or 123 · a456 · p789
```

## License

MIT
