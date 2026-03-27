# LocalClaw OneBox

## 中文

### 重点

我们演示了在 NVIDIA DGX Spark 上，使用 OpenClaw 与本地模型完成全栈式的语音交互。

整条链路包括：

- 本地语音输入
- 本地 ASR 识别
- OpenClaw Agent 推理与工具调用
- OpenViking 离线知识检索
- 本地 TTS 合成与语音播放

整个流程不依赖云端推理，核心能力都运行在本地设备与本地网络环境中。

### 运行环境

本次演示运行在 NVIDIA DGX Spark 上。

参考 NVIDIA 官方资料，DGX Spark 的关键参数包括：

- NVIDIA GB10 Grace Blackwell Superchip
- 最高可达 1 petaFLOP FP4 AI 性能
- 128GB unified system memory
- 支持通过 NVIDIA ConnectX 网络将两台 DGX Spark 连接起来

官方链接：

- [NVIDIA DGX Spark](https://www.nvidia.com/en-us/products/workstations/dgx-spark/)
- [DGX Spark User Guide](https://docs.nvidia.com/dgx/dgx-spark/dgx-spark.pdf)

### 模型与加载环境

本演示将不同能力拆分给不同的本地运行时：

- 推理：OpenClaw Agent + Ollama
- ASR：vLLM
- TTS：Rust 服务 `qwen3-tts-rs`

本次使用到的主要模型与工程如下：

| 能力 | 模型 / 运行时 | 链接 |
| --- | --- | --- |
| 文本推理 | `huihui_ai/qwen3.5-abliterated:35b-Claude` via Ollama | [ollama/ollama](https://github.com/ollama/ollama) |
| 语音识别 ASR | `Qwen/Qwen3-ASR-1.7B` via vLLM | [Model](https://huggingface.co/Qwen/Qwen3-ASR-1.7B) / [vllm-project/vllm](https://github.com/vllm-project/vllm) |
| 语音合成 TTS | `Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice` via `qwen3-tts-rs` | [Model](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice) / [danielclough/qwen3-tts-rs](https://github.com/danielclough/qwen3-tts-rs) |
| Agent 运行时 | OpenClaw | [OpenClaw Docs](https://docs.openclaw.ai) |

### OpenViking

我们使用 OpenViking 作为离线的向量化数据存储与上下文数据库。

它主要承担：

- 本地 FAQ 与资料的资源化管理
- 离线检索与上下文召回
- 为 OpenClaw Agent 提供可控的知识读取入口

仓库链接：

- [volcengine/OpenViking](https://github.com/volcengine/OpenViking)

### 前端

前端部分基于以下技术实现：

- React
- TypeScript
- Vite
- 浏览器音频采集与播放
- 本地 HTTPS 反向代理与局域网访问

前端负责：

- 麦克风输入
- 键盘输入与多语言 UI
- 音频播放与实时状态反馈
- 与 ASR / OpenClaw / TTS 的桥接

## English

### Key Point

This demo shows a full local voice interaction stack running on NVIDIA DGX Spark, with OpenClaw orchestrating local models end to end.

The full pipeline includes:

- local voice input
- local ASR
- OpenClaw agent reasoning and tool use
- OpenViking offline retrieval
- local TTS synthesis and playback

The core experience runs locally instead of relying on cloud inference.

### Runtime Environment

The demo runs on NVIDIA DGX Spark.

Based on NVIDIA's official documentation, the key hardware points are:

- NVIDIA GB10 Grace Blackwell Superchip
- up to 1 petaFLOP of FP4 AI performance
- 128GB unified system memory
- NVIDIA ConnectX networking for linking two DGX Spark systems

Official references:

- [NVIDIA DGX Spark](https://www.nvidia.com/en-us/products/workstations/dgx-spark/)
- [DGX Spark User Guide](https://docs.nvidia.com/dgx/dgx-spark/dgx-spark.pdf)

### Models and Runtime Stack

The demo splits the workload across different local runtimes:

- reasoning: OpenClaw Agent + Ollama
- ASR: vLLM
- TTS: Rust service powered by `qwen3-tts-rs`

Main models and runtime repositories:

| Capability | Model / Runtime | Links |
| --- | --- | --- |
| Text reasoning | `huihui_ai/qwen3.5-abliterated:35b-Claude` via Ollama | [ollama/ollama](https://github.com/ollama/ollama) |
| Speech recognition | `Qwen/Qwen3-ASR-1.7B` via vLLM | [Model](https://huggingface.co/Qwen/Qwen3-ASR-1.7B) / [vllm-project/vllm](https://github.com/vllm-project/vllm) |
| Speech synthesis | `Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice` via `qwen3-tts-rs` | [Model](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice) / [danielclough/qwen3-tts-rs](https://github.com/danielclough/qwen3-tts-rs) |
| Agent runtime | OpenClaw | [OpenClaw Docs](https://docs.openclaw.ai) |

### OpenViking

We use OpenViking as an offline vectorized data store and context database.

In this demo, it is used for:

- local resource management
- offline retrieval
- structured context delivery into OpenClaw

Repository:

- [volcengine/OpenViking](https://github.com/volcengine/OpenViking)

### Frontend

The frontend is built with:

- React
- TypeScript
- Vite
- browser audio capture and playback
- local HTTPS reverse proxy for LAN access

It handles:

- microphone input
- keyboard input and multilingual UI
- playback and live visual feedback
- bridging ASR, OpenClaw, and TTS

## 日本語

### 要点

このデモでは、NVIDIA DGX Spark 上で OpenClaw とローカルモデルを組み合わせ、音声対話をエンドツーエンドでローカル実行しています。

処理の流れは次のとおりです。

- ローカル音声入力
- ローカル ASR
- OpenClaw Agent による推論とツール呼び出し
- OpenViking によるオフライン検索
- ローカル TTS 合成と音声再生

中核の推論体験はクラウドではなくローカル環境で動作します。

### 実行環境

デモは NVIDIA DGX Spark 上で動作します。

NVIDIA の公式情報に基づく主な仕様は次のとおりです。

- NVIDIA GB10 Grace Blackwell Superchip
- 最大 1 petaFLOP の FP4 AI 性能
- 128GB の unified system memory
- 2 台の DGX Spark を接続できる NVIDIA ConnectX ネットワーク

公式リンク：

- [NVIDIA DGX Spark](https://www.nvidia.com/en-us/products/workstations/dgx-spark/)
- [DGX Spark User Guide](https://docs.nvidia.com/dgx/dgx-spark/dgx-spark.pdf)

### モデルとロード環境

このデモでは、機能ごとにローカル実行環境を分けています。

- 推論：OpenClaw Agent + Ollama
- ASR：vLLM
- TTS：Rust ベースの `qwen3-tts-rs`

使用している主なモデルとリポジトリは次のとおりです。

| 機能 | モデル / 実行環境 | リンク |
| --- | --- | --- |
| テキスト推論 | `huihui_ai/qwen3.5-abliterated:35b-Claude` via Ollama | [ollama/ollama](https://github.com/ollama/ollama) |
| 音声認識 | `Qwen/Qwen3-ASR-1.7B` via vLLM | [Model](https://huggingface.co/Qwen/Qwen3-ASR-1.7B) / [vllm-project/vllm](https://github.com/vllm-project/vllm) |
| 音声合成 | `Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice` via `qwen3-tts-rs` | [Model](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice) / [danielclough/qwen3-tts-rs](https://github.com/danielclough/qwen3-tts-rs) |
| Agent 実行基盤 | OpenClaw | [OpenClaw Docs](https://docs.openclaw.ai) |

### OpenViking

OpenViking は、オフラインのベクトル化データ保存とコンテキストデータベースとして利用しています。

主な役割は次のとおりです。

- ローカル資料の管理
- オフライン検索
- OpenClaw への構造化コンテキスト供給

リポジトリ：

- [volcengine/OpenViking](https://github.com/volcengine/OpenViking)

### フロントエンド

フロントエンドは次の技術で構成されています。

- React
- TypeScript
- Vite
- ブラウザでの音声収録と再生
- LAN 向けローカル HTTPS リバースプロキシ

主な担当は次のとおりです。

- マイク入力
- キーボード入力と多言語 UI
- 音声再生とリアルタイム状態表示
- ASR / OpenClaw / TTS の橋渡し
