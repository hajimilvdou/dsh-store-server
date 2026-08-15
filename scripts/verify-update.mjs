// 版本推送专项验证：manifest 客户端插件下发 / 注销端点鉴权 / 在线更新执行器 / 管理页横幅
const BASE = 'http://127.0.0.1:8080'
let failed = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`)
  if (!ok) failed++
}
const call = async (path, opts) => {
  const res = await fetch(BASE + path, opts)
  let body = null
  try { body = await res.json() } catch { /* ignore */ }
  return { status: res.status, body }
}
const H = { 'Content-Type': 'application/json', 'X-Admin-Token': 'mock-admin' }

// 等待服务就绪
let ok = false
for (let i = 0; i < 24; i++) {
  const r = await call('/health')
  if (r.status === 200) { ok = true; break }
  await new Promise((res) => setTimeout(res, 5000))
}
check('服务就绪', ok)

// 0.5 首次设置密码端点：已配置口令时 → needs_setup=false 且 setup 拒绝（409）
const sst = await call('/admin/setup/status')
check('首次设置状态可读', sst.status === 200 && typeof sst.body.needs_setup === 'boolean', JSON.stringify(sst.body))
const sup = await call('/admin/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'x12345678' }) })
check('已配置口令时 setup 被拒(409)', sup.status === 409, `status=${sup.status}`)

// 1. 默认不推送客户端插件版本
const m0 = await call('/api/v1/manifest')
check('manifest 含 client_plugin 字段', m0.body && 'client_plugin' in m0.body, JSON.stringify(m0.body.client_plugin))

// 2. 配置中心填入客户端插件版本 → manifest 即下发
const cfg0 = (await call('/admin/config', { headers: H })).body
await call('/admin/config', { method: 'PUT', headers: H, body: JSON.stringify({ ...cfg0, client: { ...cfg0.client, plugin_version: '0.4.0', install_spec: 'github:yourname/dsh-store' } }) })
const m1 = await call('/api/v1/manifest')
check('推送客户端插件 0.4.0', m1.body.client_plugin && m1.body.client_plugin.version === '0.4.0', JSON.stringify(m1.body.client_plugin))
check('推送含安装地址', m1.body.client_plugin.install.includes('github:'), m1.body.client_plugin.install)
await call('/admin/config', { method: 'PUT', headers: H, body: JSON.stringify(cfg0) })

// 3. 注销端点：未登录 401（登录后的完整流程由 repo 级测试覆盖）
const deact = await call('/api/v1/me/deactivate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ combos: 'delete' }) })
check('注销端点未登录被拒(401)', deact.status === 401)

// 4. 在线更新执行器：本机无 bash/git → 状态 failed + 明确错误（证明真实执行而非假流水线）
const upd = await call('/admin/update', { method: 'POST', headers: H, body: JSON.stringify({ version: 'v9.9.9' }) })
check('一键更新进入真实执行器', upd.status === 500 && upd.body.stage === 'failed', `stage=${upd.body.stage}`)
const st = await call('/admin/update/status', { headers: H })
check('更新状态含错误说明', typeof st.body.error === 'string' && st.body.error.length > 0, String(st.body.error).slice(0, 60))
check('更新状态含当前版本', typeof st.body.current_version === 'string' && st.body.current_version.startsWith('v'), st.body.current_version)
check('更新状态含跟踪通道', typeof st.body.track === 'string' && ['release', 'commit'].includes(st.body.track), st.body.track)

// 4.5 手动一键检测（未配置仓库地址 → 400 + 明确提示；已配置 → 200 + latest_release）
const chk = await call('/admin/update/check', { method: 'POST', headers: H, body: JSON.stringify({}) })
const chkOk = chk.status === 400 ? typeof chk.body.message === 'string' : chk.status === 200 && 'latest_release' in chk.body
check('手动一键检测接口', chkOk, `status=${chk.status} ${String(chk.body.message || '').slice(0, 50)}`)

// 5. 管理页含横幅与版本监控文案
const page = await fetch(BASE + '/admin').then((r) => r.text())
check('管理页含版本横幅逻辑', page.includes('updateBanner') && page.includes('服务端有新版本'))
check('管理页含一键检测与客户端推送', page.includes('一键检测') && page.includes('客户端插件版本推送'))
check('管理页含跟踪通道文案', page.includes('跟踪通道') && page.includes('commit 通道'))
check('管理页含更新横幅忽略', page.includes('ignoreUpdate'))
check('管理页含插件库一键扫描', page.includes('startScanAll') && page.includes('scanBanner'))
check('管理页含配置项独立保存', page.includes('saveField'))

// 6. 一键安全扫描：状态端点可读（不实际跑全量扫描）
const scanSt = await call('/admin/scan/status', { headers: H })
check('扫描状态端点可读', scanSt.status === 200 && typeof scanSt.body.total === 'number' && typeof scanSt.body.running === 'boolean', JSON.stringify({ total: scanSt.body.total, running: scanSt.body.running }))

console.log(failed === 0 ? '\n全部通过 ✅（版本推送专项）' : `\n${failed} 项失败 ❌`)
process.exitCode = failed === 0 ? 0 : 1
