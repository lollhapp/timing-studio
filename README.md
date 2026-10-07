# 时序工坊 · TimingStudio

面向 FPGA / RTL 学习和设计交流的本地时序图编辑器。鼠标绘图和 WaveJSON 代码共用同一份波形模型，可导出 JSON、SVG 和 PNG。

当前版本：**1.3.1**。

## 功能

- 绘制时钟、逻辑电平、未知态、高阻态及总线。
- 拖动边沿、编辑总线值、手动分段、调整信号顺序。
- 多画布标签，独立批注，撤销 / 重做，选区复制 / 剪切 / 粘贴。
- 切换画布与代码视图；返回画布时应用有效代码。
- 打开或拖入 `.json` / `.wavejson`，每个文件建立一个新画布。
- 本地自动保存，以及 JSON / SVG / PNG 导出。

## 使用

### 浏览器

下载或克隆本仓库后，用现代浏览器打开 `index.html` 即可。基础绘图不需要安装依赖，也不需要服务器。剪贴板能力受浏览器权限限制。

### 桌面开发

安装 Node.js 22 或更新的 LTS 版本，在仓库目录执行：

```sh
npm ci
npm start
```

### Windows 便携版打包

在 Windows 上执行：

```sh
npm ci
npm run dist:win
```

产物位于 `dist/`。桌面程序依赖 Electron；首次安装依赖和打包需要网络。本仓库发布源码，不包含安装目录或已构建的程序。

## WaveJSON 示例

```json
{
  "head": { "text": "握手示例" },
  "signal": [
    { "name": "clk", "wave": "p......." },
    { "name": "valid", "wave": "0.1...0." },
    { "name": "ready", "wave": "0....10." },
    { "name": "data", "wave": "x.=...x.", "data": ["DATA0"] }
  ]
}
```

支持扁平 `signal` 数组、`head.text`、`name`、`wave`、`data`、时钟 `period` / `phase`，最多 256 个时间格。支持 `0 1 x z u d = 2–9 p/n .` 等常用符号。软件附加信息存于 `_timingStudio`，包括批注、周期数和精细边沿。

这是 WaveJSON 常用子集的编辑器，未实现完整 WaveDrom 语法：不支持分组数组及 `edge` 箭头；`node` 标记不绘制。时序图用于表达设计意图，协议和 RTL 行为仍需独立核查。

## 快捷键

| 按键 | 操作 |
| --- | --- |
| S | 选择 / 拖边沿 |
| 1 / 2 | 高 / 低电平 |
| X / Z | 未知 / 高阻 |
| B / F | 总线 / 总线分界 |
| C | 独立批注 |
| Ctrl+C / X / V | 复制 / 剪切 / 粘贴 |
| Ctrl+Z / Y | 撤销 / 重做 |
| Ctrl+T / W | 新建 / 关闭画布 |
| Ctrl+Shift+T | 恢复关闭的画布 |

## 验证

```sh
npm ci
npx playwright install chromium
npm test
```

测试覆盖总线编辑、分段、边沿拖动、撤销重做、文件拖入、错误文件、草稿保留、本地恢复、视图切换和导出。

## 数据与隐私

应用代码不包含遥测或上传接口。画布与未应用的代码草稿保存在当前浏览器 / Electron 的本地存储中；清理网站数据会删除自动保存内容，请先导出需要保留的画布。


