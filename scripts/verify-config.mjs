// 配置中心专项验证：新字段齐备 / 管理员改密即时生效 / 注册开关 / token 池热更新 / 页面汉化
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
const H2 = (pw) => ({ 'Content-Type': 'application/json', 'X-Admin-Token': pw })

// 等待服务就绪
let ok = false
for (let i = 0; i < 24; i++) {
  const r = await call('/health')
  if (r.status === 200) { ok = true; break }
  await new Promise((res) => setTimeout(res, 5000))
}
check('服务就绪', ok)

// 1. 读取配置：新字段齐备
const c0 = await call('/admin/config', { headers: H })
check('读取配置(200)', c0.status === 200)
const cfg0 = c0.body
check('含注册开关', typeof cfg0.user.registration_enabled === 'boolean')
check('含注册方式', Array.isArray(cfg0.user.registration_methods) && cfg0.user.registration_methods.includes('github'))
check('含搜索 token 池', Array.isArray(cfg0.sync.github_tokens))
check('含认证凭证段', typeof cfg0.auth.github_client_id === 'string' && typeof cfg0.auth.jwt_secret === 'string')
check('含管理员口令', typeof cfg0.admin.password === 'string' && cfg0.admin.password.length > 0)
check('启动已合并环境变量 token', cfg0.sync.github_tokens.length >= 1, `tokens=${cfg0.sync.github_tokens.length}`)
const origTokens = cfg0.sync.github_tokens

// 2. 管理员改密：旧密码立即失效 / 新密码生效 / 恢复
const p1 = await call('/admin/config', { method: 'PUT', headers: H, body: JSON.stringify({ ...cfg0, admin: { ...cfg0.admin, password: 'verify-pass-9z' } }) })
check('修改管理员密码成功', p1.status === 200)
const oldPw = await call('/admin/config', { headers: H })
check('旧密码立即失效(401)', oldPw.status === 401)
const newPw = await call('/admin/config', { headers: H2('verify-pass-9z') })
check('新密码生效(200)', newPw.status === 200)
const back = await call('/admin/config', { method: 'PUT', headers: H2('verify-pass-9z'), body: JSON.stringify({ ...cfg0, admin: { ...cfg0.admin, password: 'mock-admin' } }) })
check('恢复默认密码', back.status === 200)
const confirm = await call('/admin/config', { headers: H })
check('恢复后旧流程可用', confirm.status === 200)

// 3. 注册开关
const off = await call('/admin/config', { method: 'PUT', headers: H, body: JSON.stringify({ ...cfg0, user: { ...cfg0.user, registration_enabled: false } }) })
check('关闭注册成功', off.status === 200)
const login = await call('/auth/login')
check('注册关闭后登录被拒(503)', login.status === 503 && login.body.error === 'registration_closed', JSON.stringify(login.body))
const on = await call('/admin/config', { method: 'PUT', headers: H, body: JSON.stringify({ ...cfg0, user: { ...cfg0.user, registration_enabled: true } }) })
check('重新开放注册', on.status === 200)

// 4. token 池热更新：清空 → 同步即时停用 → 恢复
const clr = await call('/admin/config', { method: 'PUT', headers: H, body: JSON.stringify({ ...cfg0, sync: { ...cfg0.sync, github_tokens: [] } }) })
check('清空 token 池', clr.status === 200)
const s0 = await call('/admin/sync', { headers: H })
check('同步即时停用', s0.body.enabled === false && s0.body.tokens === 0, JSON.stringify(s0.body))
const rst = await call('/admin/config', { method: 'PUT', headers: H, body: JSON.stringify({ ...cfg0, sync: { ...cfg0.sync, github_tokens: origTokens } }) })
check('恢复 token 池', rst.status === 200)
const s1 = await call('/admin/sync', { headers: H })
check('同步即时恢复', s1.body.enabled === true && s1.body.tokens === origTokens.length, `tokens=${s1.body.tokens}`)

// 5. 管理页含汉化配置中心文案
const page = await fetch(BASE + '/admin').then((r) => r.text())
check('管理页含汉化配置中心', page.includes('配置中心') && page.includes('开放注册') && page.includes('搜索 token'))

console.log(failed === 0 ? '\n全部通过 ✅（配置中心专项）' : `\n${failed} 项失败 ❌`)
process.exitCode = failed === 0 ? 0 : 1
