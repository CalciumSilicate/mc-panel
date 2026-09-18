import { useEffect, useMemo, useState } from 'react'
import { Crown, Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react'

import { ApiError } from '@/api/client'
import { type PanelUser, createUser, deleteUser, listUsers, transferOwner, updateUser } from '@/api/users'
import { ROLE_LABELS, ROLE_ORDER, useAuth } from '@/components/auth-context'
import { useConfirm } from '@/components/ui/dialog-context'
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
import { QuickEdit } from '@/components/QuickEdit'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useGlobalToast } from '@/components/ui/use-global-toast'
import { Pagination } from '@/components/Pagination'
import { usePaged } from '@/lib/use-paged'
import { useResource } from '@/lib/use-resource'
import { cn } from '@/lib/utils'

const ROLE_TONE: Record<string, string> = {
  owner: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  admin: 'border-primary/30 bg-primary/10 text-primary',
  helper: 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300',
  user: 'border-border/70 bg-muted text-muted-foreground',
}

export default function Users() {
  const confirm = useConfirm()
  const { user: me } = useAuth()
  const { showToast } = useGlobalToast()
  const { data, loading, error, refresh } = useResource(() => listUsers(), [])
  const [q, setQ] = useState('')
  const [saved, setSaved] = useState<Record<number, PanelUser>>({})
  const filtered = useMemo(() => (data ?? []).map((u) => saved[u.id] ?? u).filter((u) => `${u.username} ${u.player_id} ${u.role} ${ROLE_LABELS[u.role]}`.toLowerCase().includes(q.trim().toLowerCase())), [data, saved, q])
  const paged = usePaged(filtered, 20)
  useEffect(() => { paged.setPage(1) }, [q]) // eslint-disable-line react-hooks/exhaustive-deps
  const save = async (u: PanelUser, patch: Parameters<typeof updateUser>[1]) => {
    const updated = await updateUser(u.id, patch)
    setSaved((prev) => ({ ...prev, [u.id]: updated }))
  }
  const [createOpen, setCreateOpen] = useState(false)
  const [busy, setBusy] = useState<number | null>(null)

  // 可指定的角色:严格低于自己的(从 user/helper/admin 里)
  const assignable = useMemo(() => ['user', 'helper', 'admin'].filter((r) => ROLE_ORDER[r] < ROLE_ORDER[me.role]), [me.role])
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
      description="管理面板账号"
      width="6xl"
      actions={
        <>
          <Button type="button" variant="outline" className="gap-2" onClick={() => { setSaved({}); refresh() }} disabled={loading}>
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
        <div className="border-b p-4"><Input aria-label="搜索用户" value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索用户名 / 玩家 / 角色" className="max-w-sm" /></div>
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
                  <TableHead>验证</TableHead><TableHead>绑定玩家</TableHead><TableHead>密码</TableHead>
                  <TableHead>创建时间</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {paged.pageItems.map((u) => (
                  <TableRow key={u.id}>
                    <TableCell className="font-medium">
                      <QuickEdit label={`修改 ${u.username} 的用户名`} value={u.username} disabled={!canManage(u)} onSave={(v) => save(u, { username: v })} />
                      {u.id === me.id ? <span className="ml-1 text-xs text-muted-foreground">(你)</span> : null}
                    </TableCell>
                    <TableCell>
                      <QuickEdit label={`修改 ${u.username} 的角色`} value={u.role} display={<Badge variant="outline" className={cn('text-[11px]', ROLE_TONE[u.role])}>{ROLE_LABELS[u.role] ?? u.role}</Badge>} disabled={!canManage(u)} options={assignable.map((r) => ({ value: r, label: ROLE_LABELS[r] }))} onSave={(v) => save(u, { role: v })} />
                    </TableCell>
                    <TableCell><QuickEdit label={`修改 ${u.username} 的验证状态`} value={String(u.verified)} display={u.verified ? '已验证' : '未验证'} disabled={!canManage(u)} options={[{ value: 'true', label: '已验证' }, { value: 'false', label: '未验证' }]} onSave={(v) => save(u, { verified: v === 'true' })} /></TableCell>
                    <TableCell><QuickEdit label={`修改 ${u.username} 的绑定玩家`} value={u.player_id} disabled={!canManage(u)} onSave={(v) => save(u, { player_id: v })} /></TableCell>
                    <TableCell><QuickEdit label={`修改 ${u.username} 的密码`} value="" display="••••••" password disabled={!canManage(u)} onSave={(v) => save(u, { new_password: v })} /></TableCell>
                    <TableCell className="text-muted-foreground">{new Date(u.created_at).toLocaleString()}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        {me.role === 'owner' && u.role !== 'owner' ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-muted-foreground hover:text-amber-600"
                            title="转让所有者"
                            disabled={busy === u.id}
                            onClick={async () => {
                              if (await confirm({ title: `转让所有者给「${u.username}」?`, description: '你将降为管理员。', confirmText: '转让' }))
                                run(u.id, () => transferOwner(u.id), '已转让所有者')
                            }}
                          >
                            <Crown className="h-4 w-4" />
                          </Button>
                        ) : null}
                        {canManage(u) ? (
                          <Button type="button" variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" title="删除" disabled={busy === u.id} onClick={async () => {
                            if (await confirm({ title: `删除用户「${u.username}」?`, confirmText: '删除', destructive: true })) run(u.id, () => deleteUser(u.id), '已删除')
                          }}>
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
                {!paged.total ? <TableRow><TableCell colSpan={7} className="h-24 text-center text-muted-foreground">没有匹配的用户</TableCell></TableRow> : null}
              </TableBody>
            </Table>
            <Pagination page={paged.page} pageCount={paged.pageCount} total={paged.total} onPage={paged.setPage} />
          </div>
        )}

      <CreateUserDialog open={createOpen} assignable={assignable} onClose={() => setCreateOpen(false)} onCreated={() => { setCreateOpen(false); refresh() }} />
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
