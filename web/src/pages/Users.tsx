import { useEffect, useState } from 'react'
import { Check, Crown, Loader2, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'

import { ApiError } from '@/api/client'
import { type PanelUser, createUser, deleteUser, listUsers, transferOwner, updateUser } from '@/api/users'
import { ROLE_LABELS, ROLE_ORDER, useAuth } from '@/components/auth-context'
import { InlineLoader } from '@/components/PageLoader'
import { PageShell, PageSurface } from '@/components/layout/PageScaffold'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useGlobalToast } from '@/components/ui/use-global-toast'
import { useResource } from '@/lib/use-resource'
import { cn } from '@/lib/utils'

const ROLE_TONE: Record<string, string> = {
  owner: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  admin: 'border-primary/30 bg-primary/10 text-primary',
  helper: 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300',
  user: 'border-border/70 bg-muted text-muted-foreground',
}

export default function Users() {
  const { user: me } = useAuth()
  const { showToast } = useGlobalToast()
  const { data, loading, error, refresh } = useResource(() => listUsers(), [])
  const [createOpen, setCreateOpen] = useState(false)
  const [editUser, setEditUser] = useState<PanelUser | null>(null)
  const [busy, setBusy] = useState<number | null>(null)

  // 可指定的角色:严格低于自己的(从 user/helper/admin 里)
  const assignable = ['user', 'helper', 'admin'].filter((r) => ROLE_ORDER[r] < ROLE_ORDER[me.role])
  const canManage = (u: PanelUser) => u.id !== me.id && ROLE_ORDER[me.role] > ROLE_ORDER[u.role]

  const run = async (id: number, fn: () => Promise<unknown>, ok: string) => {
    setBusy(id)
    try {
      await fn()
      showToast('success', ok)
      refresh()
    } catch (err) {
      showToast('error', err instanceof ApiError ? err.message : '操作失败')
    } finally {
      setBusy(null)
    }
  }

  return (
    <PageShell
      title="用户管理"
      description="owner 管理所有用户;admin 仅能管理 helper / user。"
      width="6xl"
      actions={
        <>
          <Button type="button" variant="outline" className="gap-2" onClick={refresh} disabled={loading}>
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
            刷新
          </Button>
          <Button type="button" className="gap-2" onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" />
            新建用户
          </Button>
        </>
      }
    >
      <PageSurface bodyClassName="p-0">
        {loading && !data ? (
          <div className="flex h-40 items-center justify-center"><InlineLoader /></div>
        ) : error ? (
          <p className="py-10 text-center text-sm text-destructive">{error}</p>
        ) : (
          <div className="ops-table-shell border-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>用户名</TableHead>
                  <TableHead>角色</TableHead>
                  <TableHead>验证 / 绑定玩家</TableHead>
                  <TableHead>创建时间</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(data ?? []).map((u) => (
                  <TableRow key={u.id}>
                    <TableCell className="font-medium">
                      {u.username}
                      {u.id === me.id ? <span className="ml-1 text-xs text-muted-foreground">(你)</span> : null}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={cn('text-[11px]', ROLE_TONE[u.role])}>
                        {ROLE_LABELS[u.role] ?? u.role}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {u.verified ? (
                        <span className="inline-flex items-center gap-1.5 text-sm text-emerald-600 dark:text-emerald-400">
                          <Check className="h-4 w-4" />
                          {u.player_id || '已验证'}
                        </span>
                      ) : (
                        <span className="text-sm text-muted-foreground">未验证</span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{new Date(u.created_at).toLocaleString()}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        {canManage(u) ? (
                          <Button type="button" variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground" title="编辑" disabled={busy === u.id} onClick={() => setEditUser(u)}>
                            <Pencil className="h-4 w-4" />
                          </Button>
                        ) : null}
                        {me.role === 'owner' && u.role !== 'owner' ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-muted-foreground hover:text-amber-600"
                            title="转让所有者"
                            disabled={busy === u.id}
                            onClick={() => {
                              if (window.confirm(`把「所有者」转让给 ${u.username}?你将降为管理员。`))
                                run(u.id, () => transferOwner(u.id), '已转让所有者')
                            }}
                          >
                            <Crown className="h-4 w-4" />
                          </Button>
                        ) : null}
                        {canManage(u) ? (
                          <Button type="button" variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" title="删除" disabled={busy === u.id} onClick={() => {
                            if (window.confirm(`删除用户「${u.username}」?`)) run(u.id, () => deleteUser(u.id), '已删除')
                          }}>
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

      <CreateUserDialog open={createOpen} assignable={assignable} onClose={() => setCreateOpen(false)} onCreated={() => { setCreateOpen(false); refresh() }} />
      <EditUserDialog user={editUser} assignable={assignable} onClose={() => setEditUser(null)} onSaved={() => { setEditUser(null); refresh() }} />
      </PageSurface>
    </PageShell>
  )
}

function CreateUserDialog({ open, assignable, onClose, onCreated }: { open: boolean; assignable: string[]; onClose: () => void; onCreated: () => void }) {
  const { showToast } = useGlobalToast()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState('user')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open) {
      setUsername('')
      setPassword('')
      setRole(assignable[0] ?? 'user')
    }
  }, [open, assignable])

  const submit = async () => {
    if (!username.trim() || !password) {
      showToast('error', '请填写用户名和密码')
      return
    }
    setBusy(true)
    try {
      await createUser(username.trim(), password, role)
      showToast('success', '已创建')
      onCreated()
    } catch (err) {
      showToast('error', err instanceof ApiError ? err.message : '创建失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新建用户</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="nu-name">用户名</Label>
            <Input id="nu-name" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
          </div>
          <div className="space-y-2">
            <Label htmlFor="nu-pwd">密码</Label>
            <Input id="nu-pwd" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
          </div>
          <div className="space-y-2">
            <Label>角色</Label>
            <Select value={role} onValueChange={setRole}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {assignable.map((r) => (
                  <SelectItem key={r} value={r}>{ROLE_LABELS[r]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>取消</Button>
          <Button type="button" onClick={submit} disabled={busy}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : '创建'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function EditUserDialog({ user, assignable, onClose, onSaved }: { user: PanelUser | null; assignable: string[]; onClose: () => void; onSaved: () => void }) {
  const { showToast } = useGlobalToast()
  const [role, setRole] = useState('user')
  const [newPassword, setNewPassword] = useState('')
  const [verified, setVerified] = useState(false)
  const [playerId, setPlayerId] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (user) {
      setRole(user.role)
      setNewPassword('')
      setVerified(user.verified)
      setPlayerId(user.player_id)
    }
  }, [user])

  const submit = async () => {
    if (!user) return
    setBusy(true)
    try {
      await updateUser(user.id, {
        role: role !== user.role ? role : undefined,
        new_password: newPassword || undefined,
        verified: verified !== user.verified ? verified : undefined,
        player_id: playerId !== user.player_id ? playerId : undefined,
      })
      showToast('success', '已保存')
      onSaved()
    } catch (err) {
      showToast('error', err instanceof ApiError ? err.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }

  // 编辑时的可选角色:可分配集合 + 该用户当前角色(便于显示)
  const roleOptions = Array.from(new Set([user?.role ?? 'user', ...assignable]))

  return (
    <Dialog open={user !== null} onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>编辑用户 —— {user?.username}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="space-y-2">
            <Label>角色</Label>
            <Select value={role} onValueChange={setRole}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {roleOptions.map((r) => (
                  <SelectItem key={r} value={r} disabled={r !== (user?.role ?? '') && !assignable.includes(r)}>
                    {ROLE_LABELS[r] ?? r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="eu-pwd">重置密码(留空不改)</Label>
            <Input id="eu-pwd" type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" />
          </div>
          <label className="flex items-center justify-between gap-4 rounded-md border border-border/70 px-3 py-2.5">
            <span className="text-sm font-medium">已验证</span>
            <Switch checked={verified} onCheckedChange={setVerified} />
          </label>
          <div className="space-y-2">
            <Label htmlFor="eu-player">绑定玩家</Label>
            <Input id="eu-player" value={playerId} onChange={(e) => setPlayerId(e.target.value)} placeholder="正版玩家名" />
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>取消</Button>
          <Button type="button" onClick={submit} disabled={busy}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : '保存'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
