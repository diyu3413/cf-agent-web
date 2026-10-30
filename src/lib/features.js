// 运行环境特性探测的装配点。
//
// 独立部署（本仓库）：非内嵌，模型列表由设置里手填。
// 合并部署：cf-llm-gateway 持有本文件的覆盖实现（同步脚本不覆盖它），
// 返回 embedded=true 和网关「模型链」页配置的模型列表，前端据此切换成下拉选择。
// 签名：agentFeatures(env) => { embedded, models: [{id, kind}], defaultModel }

export async function agentFeatures(env) {
  return { embedded: false, models: [], defaultModel: '' };
}
