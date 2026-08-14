/**
 * @dsh-store/shared —— 跨端契约的单一事实来源。
 *
 * 约定：
 * - 客户端（dsh 插件）与服务端、联邦服务器之间只依赖本包中的类型与常量。
 * - 协议版本化（PROTOCOL_VERSION）：握手时按 min(双方) 通信。
 * - 未知字段一律忽略（向前/向后兼容）。
 */
export * from './protocol.js'
export * from './models.js'
export * from './api.js'
export * from './config.js'
