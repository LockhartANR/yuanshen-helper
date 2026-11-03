/**
 * 站点内容脚本入口：上传桥接 + 站内「赛博大表」入口。
 *
 * 保持单一 IIFE 输出（`content/upload.js`），manifest 路径不变；
 * 不依赖动态 import，也不在 MAIN world 运行。
 */
import './upload'
import { startPlayerAnalysis } from './player-analysis'

startPlayerAnalysis()
