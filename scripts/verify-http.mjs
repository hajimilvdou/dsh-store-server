const BASE = 'http://127.0.0.1:8080'
let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
  if (!ok) failed++
}
const call = async (path, opts) => {
  const res = await fetch(BASE + path, opts)
  let body = null
  try { body = await res.json() } catch { /* ignore */ }
  return { status: res.status, body }
}

// 等待同步完成（最多 180s）
let plugins = null
for (let i = 0; i < 36; i++) {
  const r = await call('/api/v1/plugins')
  if (r.body && r.body.items && r.body.items.length) { plugins = r.body.items; break }
  await new Promise((res) => setTimeout(res, 5000))
}
check('同步完成（插件数据就绪）', Array.isArray(plugins) && plugins.length > 0, plugins ? `items=${plugins.length}` : 'timeout')
const target = plugins && plugins.length ? plugins[0].id : 'open-design'

// 1. 匿名凭证
const tok = await call('/api/v1/anon-token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instance_id: 'verify-http' }) })
check('换取匿名凭证', tok.status === 200 && !!tok.body.token)

// 2. 无凭证 → 401
const noToken = await call('/api/v1/downloads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target }) })
check('无凭证下载计数被拒(401)', noToken.status === 401 && noToken.body.error === 'anon_token_required')

// 3. 带凭证首次上报
const hd = { 'Content-Type': 'application/json', 'X-Anon-Token': tok.body.token }
const r1 = await call('/api/v1/downloads', { method: 'POST', headers: hd, body: JSON.stringify({ target }) })
check('首次上报计入', r1.status === 200 && r1.body.counted === true, JSON.stringify(r1.body))

// 4. 重复上报去重
const r2 = await call('/api/v1/downloads', { method: 'POST', headers: hd, body: JSON.stringify({ target }) })
check('1h 内重复上报去重', r2.status === 200 && r2.body.counted === false && r2.body.downloads_7d === r1.body.downloads_7d)

// 5. 未知目标 404
const r3 = await call('/api/v1/downloads', { method: 'POST', headers: hd, body: JSON.stringify({ target: 'no-such-plugin' }) })
check('未知目标 404', r3.status === 404)

// 6. 数据通道 downloads_7d 已更新
const after = await call('/api/v1/plugins')
const p = after.body.items.find((x) => x.id === target)
check('数据通道 downloads_7d 已更新', p && p.downloads_7d === r1.body.downloads_7d, p ? `downloads_7d=${p.downloads_7d}` : 'not found')

// 7. 管理端风控队列 + 统计
const admin = { 'X-Admin-Token': 'mock-admin' }
const rq = await call('/admin/risk-queue', { headers: admin })
check('管理端风控队列可读', rq.status === 200 && Array.isArray(rq.body), JSON.stringify(rq.body))
const stats = await call('/admin/stats', { headers: admin })
check('stats 含风控待复核数', stats.status === 200 && typeof stats.body.risk_pending === 'number', `risk_pending=${stats.body.risk_pending}`)

// 8. admin 页面含风控队列区
const page = await fetch(BASE + '/admin').then((r) => r.text())
check('admin 页面含风控队列区', page.includes('风控队列'))

console.log(failed === 0 ? '\n全部通过 ✅' : `\n${failed} 项失败 ❌`)
process.exitCode = failed === 0 ? 0 : 1
