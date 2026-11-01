# ControlNet / angle-viewpoint 制御モデルの調査結果

## 結論
MOSS-Image（MLX 8bit）は **T2Iのみ**。角度・姿勢変化はできない。外部ツールが必要。

## 利用可能なオープンソース制御モデル

### ControlNet 系（汎用）
| モデル | 制御タイプ | 備考 |
|---|---|---|
| lllyasviel/ControlNet | canny, depth, hed, lineart, seg, openpose | 標準的 |
| HunyuanDiT ControlNet (Tencent) | canny, depth, pose (DWPose) | HunyuanDiT専用 |
| ControlNet++ (xinsir6) | 10+ 制御タイプ | マルチ条件対応 |

### ポーズ/角度制御
- **OpenPose ControlNet**: 人体ポーズ＋img2img
- **HunyuanPortrait** (CVPR-2025): 肖像アニメーション（表情・頭部ポーズ）
- **LivePortrait**: 肖像アニメーション（頭部姿勢・表情）
- **PoseLLaVA**: 3D ポーズ操作（マルチモーダルLLM）

## 角度・姿勢変化のワークフロー
1. 参照画像を読み込む
2. OpenPose / DWPose / canny で制御画像を抽出
3. 制御画像 + プロンプトをモデルに入力
4. ControlNet / ControlNet++ で条件を付与
5. controlnet_conditioning_scale を調整

## ユーザーへの推奨
- ポーズ固定 → ControlNet OpenPose / HunyuanDiT ControlNet
- 肖像アニメーション → HunyuanPortrait / LivePortrait
- 汎用 → ControlNet++
