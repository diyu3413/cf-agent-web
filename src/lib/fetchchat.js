// 模型调用通道的装配点。
//
// 独立部署（本仓库）：只有一条路 —— HTTP 调用户在设置里配置的 OpenAI 兼容网关。
// 合并部署（cf-llm-gateway 仓库的 src/agent/）：同步脚本【不会】覆盖本文件所在的
// 两个装配点之一 —— fetchchat.js 在那边换成内嵌版，直接调网关的 runChain()，
// 模型列表和故障转移全部复用网关配置，无需地址和密钥。
// 两边保证同一签名：buildFetchChat(env, settings) => ({messages, tools, onDelta}) => 解析结果

import { chatStream } from './llm.js';

export function buildFetchChat(env, settings) {
  return ({ messages, tools, onDelta }) =>
    chatStream({
      baseUrl: settings.gatewayBaseUrl,
      apiKey: settings.gatewayKey,
      model: settings.model,
      messages,
      tools,
      onDelta,
    });
}
