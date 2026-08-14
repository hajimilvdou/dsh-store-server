import { MemoryRepo } from '../dist/repo/memory.js'

let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
  if (!ok) failed++
}

// seedDemo=true：拿到演示用户/点赞/风控种子，逻辑与生产完全一致
const repo = new MemoryRepo(true)

// ---- 匿名凭证 ----
const token = repo.mintAnonToken('inst-001')
check('mint 匿名凭证', token.startsWith('anon_'), token)
check('verify 合法凭证', repo.verifyAnonToken(token) === true)
check('verify 伪造凭证拒绝', repo.verifyAnonToken('fake_token_123') === false)

// ---- 安装计数：1h 窗口去重 + 聚合 ----
const before = repo.getPlugins().find((p) => p.id === 'dsh-memory').downloads_7d
const r1 = repo.recordInstall(token, 'dsh-memory')
check('首次安装计数生效', r1.ok && r1.counted && r1.downloads_7d === before + 1, `before=${before} after=${r1.downloads_7d}`)
const r2 = repo.recordInstall(token, 'dsh-memory')
check('1h 内同 token 同目标去重', r2.ok && r2.counted === false && r2.downloads_7d === before + 1)
const r3 = repo.recordInstall(token, '不存在的插件')
check('未知目标返回 not-ok', r3.ok === false)
const c1 = repo.recordInstall(token, 'store.example.com:combo_1')
check('组合下载计数生效', c1.ok && c1.counted)

// ---- 风控：同 IP 多账号集中点赞（阈值 3） ----
const a1 = repo.checkLikeRisk('u_a', 'userA', 'dsh-vision', '1.2.3.4')
const a2 = repo.checkLikeRisk('u_b', 'userB', 'dsh-vision', '1.2.3.4')
const a3 = repo.checkLikeRisk('u_c', 'userC', 'dsh-vision', '1.2.3.4')
check('前两个账号放行', a1 === null && a2 === null)
check('第 3 个同 IP 账号触发风控', typeof a3 === 'string' && a3.includes('同 IP'), a3)

// ---- 风控：注册即赞（注册 5 分钟内点赞） ----
repo.users.push({ id: 'u_fresh', github_id: 9001, login: 'freshUser', name: null, home_server: 'store.example.com', registered_at: new Date(Date.now() - 5 * 60_000).toISOString(), combo_count: 0, status: 'active' })
const b1 = repo.checkLikeRisk('u_fresh', 'freshUser', 'dsh-skins', '9.9.9.9')
check('注册即赞触发风控', typeof b1 === 'string' && b1.includes('注册'), b1)

// ---- 风控：高频切换点赞（同账号同目标 5 分钟内 3 次） ----
const c1r = repo.checkLikeRisk('u_fast', 'fastUser', 'dsh-pet', '8.8.8.8')
const c2r = repo.checkLikeRisk('u_fast', 'fastUser', 'dsh-pet', '8.8.8.8')
const c3r = repo.checkLikeRisk('u_fast', 'fastUser', 'dsh-pet', '8.8.8.8')
check('高频切换第 3 次触发风控', c1r === null && c2r === null && typeof c3r === 'string' && c3r.includes('高频'), c3r)

// ---- 风控队列：隔离不计入 + 复核生效/清除 ----
const likesBefore = repo.likeCount('dsh-vision')
const q1 = repo.queueRiskLike({ userId: 'u_c', login: 'userC', target: 'dsh-vision', ip: '1.2.3.4', reason: '测试' })
check('入队后点赞数不变（隔离不计入）', repo.likeCount('dsh-vision') === likesBefore)
const resolved = repo.resolveRiskLike(q1.id, 'include')
check('复核计入后生效', resolved?.status === 'included' && repo.likeCount('dsh-vision') === likesBefore + 1)
const q2 = repo.queueRiskLike({ userId: 'u_d', login: 'userD', target: 'dsh-vision', ip: '1.2.3.4', reason: '测试2' })
const rejected = repo.resolveRiskLike(q2.id, 'reject')
check('复核清除后不生效', rejected?.status === 'rejected' && repo.likeCount('dsh-vision') === likesBefore + 1)
check('未知风控 id 返回 null', repo.resolveRiskLike(9999, 'include') === null)
const pending = repo.getRiskQueue().filter((r) => r.status === 'pending').length
check('种子风控队列仍待复核', pending === 1, `pending=${pending}`)

// ---- 库外插件上报（登录用户 → 待确认清单） ----
const rep1 = repo.addReport({ pkg: 'my-own-plugin', repo_url: 'https://github.com/me/my-own-plugin', version: '0.1.0' })
check('上报进入待确认清单', rep1.status === 'pending' && repo.getReports().some((r) => r.pkg === 'my-own-plugin'))

// ---- 注销账号（联动清理：点赞回退计数 / 云端清单 / 组合删除或匿名保留） ----
const likesBeforeDel = repo.likeCount('dsh-memory')
const d1 = repo.deactivateUser('u_liwei', 'liwei', 'delete')
check('注销删除组合：点赞计数回退', repo.likeCount('dsh-memory') === likesBeforeDel - 1, `before=${likesBeforeDel} after=${repo.likeCount('dsh-memory')}`)
check('注销删除组合：云端清单清空', repo.installsOf('u_liwei').length === 0)
check('注销删除组合：组合已删除', repo.getCombos().every((c) => c.author !== 'liwei') && d1.deleted.combos >= 1, `combos=${d1.deleted.combos}`)
const d2 = repo.deactivateUser('u_xiaoyu', 'xiaoyu', 'anonymize')
const anon = repo.getCombos().filter((c) => c.author_github === null && c.author === '已注销用户')
check('注销匿名保留组合：作者置为已注销用户', anon.length >= 1)
check('用户已从列表移除', !repo.getUsers().some((u) => u.id === 'u_xiaoyu'))

console.log(failed === 0 ? '\n全部通过 ✅' : `\n${failed} 项失败 ❌`)
process.exit(failed === 0 ? 0 : 1)
