import { createHmac, randomBytes } from 'node:crypto'

export interface AuthUser {
  login: string
  name: string | null
  githubId: number
}

/**
 * GitHub OAuth + JWT 认证（v3 §3 / v3.6 U5）。
 * - 凭据（GITHUB_OAUTH_CLIENT_ID/SECRET + JWT_SECRET）缺失时 enabled=false，
 *   OAuth 路由返回明确提示；此时走 routes.ts 的 mock 认证。
 * - JWT：HS256，±60s clock skew 容忍；密钥泄露处置 = 手动更换 + 全员会话失效（v3.6 U4）。
 */
export class AuthService {
  enabled = false
  private clientId = ''
  private clientSecret = ''
  private jwtSecret = ''
  private readonly states = new Set<string>()

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.configure({
      clientId: env.GITHUB_OAUTH_CLIENT_ID ?? '',
      clientSecret: env.GITHUB_OAUTH_CLIENT_SECRET ?? '',
      jwtSecret: env.JWT_SECRET ?? '',
    })
  }

  /** 配置中心热更新：管理端保存后即时生效（JWT 密钥更换后全员会话失效，需重新登录）。 */
  configure(cfg: { clientId: string; clientSecret: string; jwtSecret: string }): void {
    this.clientId = cfg.clientId ?? ''
    this.clientSecret = cfg.clientSecret ?? ''
    this.jwtSecret = cfg.jwtSecret ?? ''
    this.enabled = !!(this.clientId && this.clientSecret && this.jwtSecret)
  }

  newState(): string {
    const state = randomBytes(16).toString('hex')
    this.states.add(state)
    return state
  }

  consumeState(state: string): boolean {
    if (!this.states.has(state)) return false
    this.states.delete(state)
    return true
  }

  authorizeUrl(redirectUri: string, state: string): string {
    return (
      'https://github.com/login/oauth/authorize?client_id=' +
      encodeURIComponent(this.clientId) +
      '&redirect_uri=' +
      encodeURIComponent(redirectUri) +
      '&scope=read:user&state=' +
      encodeURIComponent(state)
    )
  }

  /** 用授权码换取 GitHub 用户信息。 */
  async exchange(code: string): Promise<AuthUser | null> {
    if (!this.enabled) return null
    try {
      const res = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: this.clientId, client_secret: this.clientSecret, code }),
      })
      const data = (await res.json()) as { access_token?: string }
      if (!data.access_token) return null
      const ures = await fetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${data.access_token}`, Accept: 'application/json', 'User-Agent': 'dsh-store-server' },
      })
      if (!ures.ok) return null
      const user = (await ures.json()) as { login: string; name: string | null; id: number }
      return { login: user.login, name: user.name, githubId: user.id }
    } catch {
      return null
    }
  }

  issueToken(user: AuthUser): string {
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
    const now = Math.floor(Date.now() / 1000)
    const header = { alg: 'HS256', typ: 'JWT' }
    const payload = { login: user.login, name: user.name, github_id: user.githubId, iat: now, exp: now + 30 * 24 * 3600 }
    const unsigned = `${enc(header)}.${enc(payload)}`
    const sig = createHmac('sha256', this.jwtSecret).update(unsigned).digest('base64url')
    return `${unsigned}.${sig}`
  }

  verify(token: string): AuthUser | null {
    if (!this.enabled) return null
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const unsigned = `${parts[0]}.${parts[1]}`
    const expected = createHmac('sha256', this.jwtSecret).update(unsigned).digest('base64url')
    if (expected !== parts[2]) return null
    try {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as {
        login: string
        name: string | null
        github_id: number
        iat: number
        exp: number
      }
      const now = Math.floor(Date.now() / 1000)
      if (payload.exp < now - 60 || payload.iat > now + 60) return null
      return { login: payload.login, name: payload.name, githubId: payload.github_id }
    } catch {
      return null
    }
  }
}
