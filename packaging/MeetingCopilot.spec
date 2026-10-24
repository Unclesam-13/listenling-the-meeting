# PyInstaller 打包配置：生成 会议助手.app
# 用法（在 Mac 上，项目根目录）：pyinstaller packaging/MeetingCopilot.spec --noconfirm
import os
from PyInstaller.utils.hooks import collect_data_files, collect_submodules

ROOT = os.path.abspath(os.path.join(SPECPATH, ".."))
VERSION = os.environ.get("APP_VERSION", "0.0.0")

datas = [
    (os.path.join(ROOT, "app", "web"), "app/web"),
    (os.path.join(ROOT, "config.yaml"), "."),
    (os.path.join(ROOT, "knowledge"), "knowledge"),
]
datas += collect_data_files("jieba")            # 中文分词词典
datas += collect_data_files("_sounddevice_data")  # 自带的 PortAudio 库
datas += collect_data_files("certifi")
datas += collect_data_files("webview")            # pywebview 自带的 JS 文件

hiddenimports = (
    collect_submodules("uvicorn")
    + collect_submodules("websockets")
    + collect_submodules("app")
    + collect_submodules("webview")
    + ["sounddevice", "rank_bm25", "jieba", "pypdf", "docx", "qrcode.image.svg", "anthropic", "httpx"]
)

a = Analysis(
    [os.path.join(ROOT, "macapp.py")],
    pathex=[ROOT],
    datas=datas,
    hiddenimports=hiddenimports,
    excludes=["tkinter", "matplotlib", "torch", "scipy", "pandas", "IPython"],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz, a.scripts, [],
    exclude_binaries=True,
    name="MeetingCopilot",  # 可执行文件用英文名更稳妥；显示名仍是「会议助手」
    console=False,
    argv_emulation=False,
    codesign_identity=None,
)
coll = COLLECT(exe, a.binaries, a.datas, name="MeetingCopilot")
app = BUNDLE(
    coll,
    name="会议助手.app",
    icon=os.path.join(ROOT, "packaging", "icon.icns") if os.path.exists(os.path.join(ROOT, "packaging", "icon.icns")) else None,
    bundle_identifier="com.unclesam13.meetingcopilot",
    version=VERSION,
    info_plist={
        "CFBundleDisplayName": "会议助手",
        "CFBundleShortVersionString": VERSION,
        "LSUIElement": False,  # 正常的窗口应用，显示在 Dock
        "NSMicrophoneUsageDescription": "会议助手需要使用麦克风来实时转写会议内容。",
        "NSHighResolutionCapable": True,
        "LSMinimumSystemVersion": "12.0",
    },
)
