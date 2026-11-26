/**
 * 站点内容脚本入口：上传桥接、站内入口与小游戏历史只读接口。
 *
 * 保持单一 IIFE 输出（`content/upload.js`），manifest 路径不变；
 * 不依赖动态 import，也不在 MAIN world 运行。
 */
import './upload'
import { startPlayerAnalysis } from './player-analysis'
import { startRankingEntry } from './ranking-entry'
import { registerMinigameHistory } from './minigame-history'
import { startMinigamePlayback } from './minigame-playback'

startPlayerAnalysis()
startRankingEntry()
registerMinigameHistory()
startMinigamePlayback()
