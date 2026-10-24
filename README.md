# 会议助手 Meeting Copilot（Mac）

电脑开会，手机看答案：实时转写会议（中英混合）、区分说话人、识别对方的提问，自动在你准备的资料库里找答案，以「一句话结论 + 要点 + 出处」的形式推送到手机。

全部使用云端 API，**不需要下载任何模型**，安装只要几分钟。

```
麦克风（我）  ─┐                                                           ┌─> 电脑页面
               ├─> Soniox 实时识别（中英混说 + 区分说话人 + 自动断句）─> 意图识别 ─> 资料库 ─> Claude 生成回答 ─┤
系统声音（对方）┘                                         (Claude / Jev / 规则)                  └─> 手机（扫码）
```

需要两个 API Key：

| 用途 | 服务 | 获取 | 费用（参考） |
|---|---|---|---|
| 语音识别 | [Soniox](https://soniox.com) | https://console.soniox.com | 实时识别约 0.12 美元/小时 |
| 判断提问、生成回答 | [Claude](https://console.anthropic.com) | https://console.anthropic.com | 按用量计费 |

---

## 下载安装（推荐：DMG）

1. 到 [Releases](https://github.com/Unclesam-13/listenling-the-meeting/releases/latest) 下载 DMG：Apple 芯片（M1 及以后）选 `AppleSilicon`，Intel 芯片选 `Intel`
2. 打开 DMG，把「会议助手」拖进「Applications」
3. 第一次打开会被系统拦截（应用未经 Apple 公证）：去「系统设置 → 隐私与安全性」，点「仍要打开」
4. 屏幕右上角菜单栏出现「会」字图标，浏览器自动打开页面；在弹出的「设置」里填写两个 API Key，并选择麦克风和 BlackHole
5. 安装免费的 [BlackHole 2ch](https://existential.audio/blackhole/)，并建好多输出设备（见下文）

资料库、配置和日志都在 个人文件夹/会议助手 里，菜单栏图标可以一键打开。

DMG 由 GitHub Actions 在云端 Mac 上自动打包（`.github/workflows/build-dmg.yml`），推送 `v*` 标签即发布新版本。

---

## 快速开始（不用 DMG，用脚本安装）

1. 下载并解压 zip 包
2. 双击 **安装.command**：自动安装所需软件，并让你粘贴上面两个 API Key（约 3–5 分钟，只需一次）
3. 按安装结束时的提示，在「音频 MIDI 设置」里建好多输出设备（见下文）
4. 以后每次开会，双击 **启动会议助手.command**，然后用手机扫电脑页面上的二维码

> 第一次双击时如果提示"无法打开，因为来自身份不明的开发者"：右键点该文件 →「打开」→ 再点「打开」。
> 如果提示"没有权限"：打开终端，输入 `cd `（cd 加一个空格），把解压出来的文件夹拖进终端窗口，回车，然后运行 `chmod +x *.command`。

### 让电脑既能听到声音，又能把声音录下来

1. 打开「音频 MIDI 设置」（应用程序 > 实用工具）
2. 左下角「+」→「创建多输出设备」
3. 勾选你的耳机/扬声器 **和** BlackHole 2ch；耳机/扬声器设为「主设备」，BlackHole 勾选「漂移校正」
4. 在 Zoom / Teams / 腾讯会议 的音频设置里，把**扬声器**选成这个多输出设备

> 建议戴耳机开会：否则对方的声音会从扬声器漏进你的麦克风，被识别成「我」说的话。
> 使用多输出设备时，键盘音量键可能不起作用，需在会议软件里调音量。

**线下会议**：把 config.yaml 里的 `system_device` 改成 `null`，只用一个麦克风录全场，由 Soniox 区分不同的人。

---

## 使用

- 电脑页面：左边是实时转写（灰色是正在说的话），中间是回答，右边是二维码和说话人列表（点名字可以改名，比如把"对方1"改成"王总"）
- 手机页面：最新的回答显示在最上面，也可以直接在手机上提问
- 不开会时测试：在终端运行 `./启动会议助手.command --no-audio`，然后在电脑页面左下角「模拟对方」说一句话

### 准备资料库

把资料放进 `knowledge/` 文件夹（支持 `.md` `.txt` `.pdf` `.docx`，可以有子文件夹），然后在电脑页面点「重新加载资料库」。

- 资料总量不大时（默认 15 万字以内），全部资料会直接交给 Claude 阅读，回答最准确；启用了提示词缓存，同一场会议里后续提问会更快、更便宜
- 资料较多时，自动改为关键词检索：Claude 会先把问题扩展成中英文关键词，所以中文问题也能找到英文资料
- 写资料时用标题分好节（Word 用标题样式、Markdown 用 `#`），常见问题可以直接写成「问：… 答：…」

### 提高识别准确率

在 config.yaml 里填：
- `asr.terms`：你们行业的专有名词、产品名、人名，例如 `[Kubernetes, ARR, 毛利率]`
- `asr.context_text`：一句话描述会议背景

---

## 接入 Jev（预留接口）

Jev 是 TypeSafe AI 的决策模型，返回「是/否概率」和「多选一」，速度快、成本低，适合判断「这句话是不是在问我」。它不生成文字，所以回答仍由 Claude 负责。

1. 拿到 Jev 的 API 地址和 Key；在 `.env` 里加一行 `JEV_API_KEY=...`，并在 config.yaml 里填 `intent.jev.url`
2. 按官方文档修改 `app/intent.py` 中 `JevDetector` 的两个方法：`build_payload()`（组织请求）和 `parse_response()`（读取结果）
3. 把 `intent.provider` 改成 `compare`，先和 Claude 对比一段时间（结果记录在 `logs/intent_compare.jsonl`）；确认效果后改成 `jev`

Jev 调用失败时会自动退回规则判断，不影响会议。

---

## 常用参数（config.yaml）

| 参数 | 作用 | 建议 |
|---|---|---|
| `asr.max_endpoint_delay_ms` | 一句话结束后多久确认 | 对方说话慢可调大 |
| `intent.settle_ms` | 对方停顿多久才判断是否在提问 | 回答出现得太早就调大，太慢就调小 |
| `intent.answer_for` | `others` 只回答对方 / `all` 也回答自己 | |
| `llm.answer_model` | 生成回答的模型 | 想更快可换成 `claude-haiku-5-5` |
| `kb.mode` | `auto` / `full` / `search` | 一般保持 auto |

## 项目结构

```
安装.command / 启动会议助手.command   双击安装 / 启动
run.py              启动入口
config.yaml         配置
.env                API Key（安装时生成，不会上传到 GitHub）
app/audio.py        两路录音
app/asr.py          Soniox 实时识别
app/speakers.py     说话人名单
app/intent.py       意图识别（Claude / Jev / 规则，可切换）
app/kb.py           资料库
app/brain.py        生成回答
app/server.py       服务端、推送到电脑和手机、扫码
app/web/            电脑页面、手机页面
knowledge/          你的资料
```

## 注意

- 手机链接带有一次性令牌，每次启动都会变，只有扫到码的设备才能查看。电脑页面只能在本机打开。
- 会议音频会实时发送给 Soniox 识别；转写内容和资料会发送给 Claude（以及启用后的 Jev）。请确认这符合你们公司对会议内容和资料的保密要求。
- 录音和转写他人的发言前，请按当地法律告知并征得参会者同意（在新南威尔士州通常需要各方同意）。
