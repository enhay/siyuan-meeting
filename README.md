# siyuan-meeting

思源桌面端会议录音插件：右上角入口、底部录音浮条、原生会议笔记、回听、豆包或腾讯云的实时与会后转写，以及思源 AI 纪要。

- 使用与安装：[docs/reports/使用说明.md](docs/reports/使用说明.md)
- 交互与视觉设计：[docs/design.md](docs/design.md)
- 实施计划：[docs/plans/2026-10-26-思源会议录音插件.md](docs/plans/2026-10-26-思源会议录音插件.md)
- Delivery 1 采集验证记录：[docs/reports/windows-probe.md](docs/reports/windows-probe.md)

插件面向 Windows 11 和 macOS 27，使用同一份安装包，要求思源 3.8.7 或以上版本。录音采集窗口使用隔离的 Electron 会话；浮条是独立、不可聚焦、置顶的桌面窗口，macOS 使用原生 panel。界面尺寸与交互参考 anarlog 固定提交 `341ccb3a5636a4e2784a9d4f1177a094d855c1bd`，纪要提示词改编自其 MIT 许可的 enhance 模板，版权与许可文本保留在 `src/prompts.js`。设备采集、权限和长录稳定性需按平台分别验收，当前证据范围见使用说明。

运行检查：

```bash
node tools/build.cjs   # 修改 src/ 后重新生成根目录 index.js 与 index.css
node --run check
node --run test
```

根目录 `index.js` 和 `index.css` 分别由 `src/main.js` + `src/*.js` 和 `src/styles.css` 生成，都是思源插件的入口文件；不要直接编辑它们。
