# 会议助手 Meeting Copilot（Mac 版原型）

电脑开会，手机看答案：实时转写会议（中英混合）、区分说话人、识别对方的提问，自动在你准备的资料库里找答案，以「一句话结论 + 要点 + 出处」的形式推送到手机。

```
麦克风（我） ─┐                                                  ┌─> 电脑页面
              ├─> 分句(VAD) ─> Whisper 识别 ─> 声纹区分说话人 ─> 意图识别 ─> 资料库检索 ─> Claude 生成回答 ─┤
系统声音（对方）┘                                (Claude / Jev / 规则)                               └─> 手机（扫码）
```

---

## 一、安装（只需做一次）

需要：Apple 芯片的 Mac（M1 及以后）、Python 3.10–3.12、[Homebrew](https://brew.sh)。

```bash
# 1. 虚拟声卡，用来录到会议软件里对方的声音
brew install blackhole-2ch

# 2. 进入项目文件夹，建虚拟环境并安装依赖
cd meeting-copilot
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# 3. 设置 Claude API Key（用于判断问题和生成回答）
export ANTHROPIC_API_KEY="sk-ant-..."     # 建议写进 ~/.zshrc
```

> Intel Mac：把 requirements.txt 里的 `mlx-whisper` 换成 `faster-whisper`，并把 config.yaml 的 `asr.backend` 改成 `faster-whisper`。

### 让电脑既能听到声音，又能把声音录下来

BlackHole 装好后，需要建一个「多输出设备」，让声音同时送到耳机和 BlackHole：

1. 打开「音频 MIDI 设置」（Audio MIDI Setup，在 应用程序 > 实用工具 里）
2. 左下角「+」→「创建多输出设备」
3. 勾选你的耳机/扬声器 **和** BlackHole 2ch；把耳机/扬声器设为「主设备」，并勾上 BlackHole 的「漂移校正」
4. 在 Zoom / Teams / 腾讯会议 的音频设置里，把**扬声器**选成这个多输出设备（或在系统设置 > 声音 > 输出里选它）

> 建议戴耳机开会：否则对方的声音会从扬声器漏进你的麦克风，被识别成「我」说的话。
> 使用多输出设备时，键盘上的音量键可能不起作用，需在会议软件里调音量。

检查设备名：

```bash
python scripts/list_devices.py
```

如果设备名和 config.yaml 里的 `mic_device` / `system_device` 不一样，改成对应的名字（填一部分即可）。

---

## 二、使用

```bash
source .venv/bin/activate
python run.py
```

- 浏览器会自动打开电脑端页面，终端里也会打印二维码
- 手机连**同一个 Wi-Fi**，扫页面右侧的二维码，就能在手机浏览器里看到实时回答（不用装 App；iPhone 可「添加到主屏幕」）
- 第一次运行会下载语音识别模型（约 1.6GB）和向量模型（约 2GB），需要几分钟
- macOS 第一次会弹出「允许麦克风」和「允许接受网络连接」，都要点允许

**线下会议**：把 config.yaml 里 `system_device` 改成 `null`，就只用一个麦克风录全场，靠声纹区分不同的人。

### 准备资料库

把资料放进 `knowledge/` 文件夹（支持 `.md` `.txt` `.pdf` `.docx`，可以有子文件夹），然后在电脑页面点「重新加载资料库」。

写资料的小建议：
- 用标题分好节（Word 里用标题样式、Markdown 里用 `#`），每节讲一件事，检索会准很多
- 常被问到的问题，可以直接写成「问：… 答：…」的形式
- 中英文资料都可以，中文问题也能搜到英文资料

### 不开会时测试

```bash
python run.py --no-audio
```

在电脑页面左下角输入框里「模拟对方」说一句话，比如「你们的数据存在哪里？」，就能看到问题检测和回答的完整流程。

---

## 三、接入 Jev（预留接口）

Jev 是 TypeSafe AI 的决策模型，返回「是/否概率」和「多选一」，速度快、成本低，适合「这句话是不是在问我」这种判断。它不会生成文字，所以回答仍由 Claude 生成。

接入步骤：
1. 拿到 Jev 的 API 地址和 Key
2. `export JEV_API_KEY="..."`，在 config.yaml 里填 `intent.jev.url`
3. 打开 `app/intent.py`，按官方文档修改 `JevDetector` 里的两个方法（其他代码都不用动）：
   - `build_payload()`：组织请求（已按「状态 + 一个是/否问题 + 一个选择题」写好草稿）
   - `parse_response()`：从返回结果中取出概率和选项
4. 把 `intent.provider` 改成：
   - `compare`：先对比一段时间。仍以 Claude 为准，同时调用 Jev，两边的判断结果和耗时记录在 `logs/intent_compare.jsonl`
   - `jev`：确认效果后，正式切换为 Jev

Jev 调用失败或超时会自动退回规则判断，不会影响会议。

---

## 四、可调参数（config.yaml）

| 参数 | 作用 | 建议 |
|---|---|---|
| `audio.end_silence_ms` | 静音多久算一句话结束 | 对方说话慢可调到 900 |
| `intent.settle_ms` | 对方停顿多久才判断是不是问题 | 回答太早打断就调大，太慢就调小 |
| `intent.answer_for` | `others` 只回答对方 / `all` 也回答自己 | |
| `speakers.threshold` | 声纹相似度阈值 | 一个人被分成多人就调低，多人被当成一个人就调高 |
| `llm.answer_model` | 生成回答的模型 | 要更快可换成 `claude-haiku-5-5` |
| `asr.initial_prompt` | 给识别模型的提示 | 写进你们行业的专有名词，能明显提升识别准确率 |

## 五、项目结构

```
run.py              启动入口
config.yaml         配置
app/audio.py        两路录音 + 分句
app/asr.py          语音识别（mlx-whisper / faster-whisper）
app/speakers.py     声纹区分说话人
app/intent.py       意图识别（Claude / Jev / 规则，可切换）
app/kb.py           资料库：读取、切块、语义 + 关键词混合检索
app/brain.py        生成回答
app/server.py       服务端、WebSocket 推送、扫码
app/web/            电脑页面、手机页面
knowledge/          你的资料
```

## 注意

- 手机链接里带有一次性令牌，每次启动都会变；只有扫到码的人才能看。电脑端页面只能在本机打开。
- 数据只在你的电脑和手机之间传输；问题判断和回答生成会把相关的转写内容和资料片段发送给 Claude（和 Jev，如启用）。
- 录音和转写他人的发言前，请按当地法律告知并征得参会者同意（在新南威尔士州通常需要各方同意）。
