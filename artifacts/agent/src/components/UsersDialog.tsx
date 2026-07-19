import { useState } from "react";
import { Users, Trash2, KeyRound, Loader2, AlertCircle, Plus, Check } from "lucide-react";
import {
  useListUsers,
  useCreateUser,
  useDeleteUser,
  useResetUserPassword,
  getListUsersQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const inputCls =
  "font-mono text-sm bg-background border-input focus-visible:ring-primary rounded-sm h-9 transition-colors";

export default function UsersDialog() {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Create form
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");

  // Password reset state: which user id is being reset + the new value
  const [resetId, setResetId] = useState<number | null>(null);
  const [resetPassword, setResetPassword] = useState("");

  const queryClient = useQueryClient();
  const { data: users, isLoading } = useListUsers({
    query: { enabled: open, queryKey: getListUsersQueryKey() },
  });
  const createUser = useCreateUser();
  const deleteUser = useDeleteUser();
  const resetUserPassword = useResetUserPassword();

  const refresh = () => queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() });
  const fail = (err: any) => {
    setNotice(null);
    setError(err?.message || "Operation failed");
  };
  const ok = (msg: string) => {
    setError(null);
    setNotice(msg);
  };

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const u = newUsername.trim();
    if (u.length < 3) return setError("Username must be at least 3 characters");
    if (newPassword.length < 8) return setError("Password must be at least 8 characters");
    createUser.mutate(
      { data: { username: u, password: newPassword } },
      {
        onSuccess: () => {
          setNewUsername("");
          setNewPassword("");
          ok(`User ${u} provisioned`);
          refresh();
        },
        onError: fail,
      },
    );
  };

  const handleDelete = (id: number, username: string) => {
    if (!window.confirm(`Delete user "${username}"? This cannot be undone.`)) return;
    deleteUser.mutate(
      { id },
      {
        onSuccess: () => {
          ok(`User ${username} deleted`);
          refresh();
        },
        onError: fail,
      },
    );
  };

  const handleReset = (id: number, username: string) => {
    if (resetPassword.length < 8) return setError("Password must be at least 8 characters");
    resetUserPassword.mutate(
      { id, data: { password: resetPassword } },
      {
        onSuccess: () => {
          setResetId(null);
          setResetPassword("");
          ok(`Passphrase updated for ${username}`);
        },
        onError: fail,
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        setError(null);
        setNotice(null);
        setResetId(null);
        setResetPassword("");
      }}
    >
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="w-8 h-8 text-sidebar-foreground/50 hover:text-sidebar-foreground hover:bg-sidebar-accent shrink-0"
          title="Manage Users"
        >
          <Users className="w-4 h-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg bg-card border-border rounded-sm">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm font-bold tracking-widest uppercase flex items-center gap-2">
            <Users className="w-4 h-4 text-primary" /> Operator Registry
          </DialogTitle>
        </DialogHeader>

        {error && (
          <div className="bg-destructive/10 border border-destructive/30 rounded-sm p-3 flex items-start gap-2 text-destructive font-mono text-xs">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span className="leading-tight">{error}</span>
          </div>
        )}
        {notice && (
          <div className="bg-primary/10 border border-primary/30 rounded-sm p-3 flex items-start gap-2 text-primary font-mono text-xs">
            <Check className="w-4 h-4 shrink-0 mt-0.5" />
            <span className="leading-tight">{notice}</span>
          </div>
        )}

        {/* User list */}
        <div className="border border-border rounded-sm divide-y divide-border max-h-64 overflow-y-auto">
          {isLoading && (
            <div className="p-4 flex justify-center">
              <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
            </div>
          )}
          {users?.map((u) => (
            <div key={u.id} className="p-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex flex-col min-w-0">
                  <span className="font-mono text-xs font-bold truncate">{u.username}</span>
                  <span className="font-mono text-[9px] text-muted-foreground uppercase tracking-widest">
                    {u.isAdmin ? "SYS_ADMIN" : "OPERATOR"}
                  </span>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="w-7 h-7 text-muted-foreground hover:text-foreground"
                    title="Reset passphrase"
                    onClick={() => {
                      setResetId(resetId === u.id ? null : u.id);
                      setResetPassword("");
                      setError(null);
                    }}
                  >
                    <KeyRound className="w-3.5 h-3.5" />
                  </Button>
                  {!u.isAdmin && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="w-7 h-7 text-muted-foreground hover:text-destructive"
                      title="Delete user"
                      disabled={deleteUser.isPending}
                      onClick={() => handleDelete(u.id, u.username)}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  )}
                </div>
              </div>
              {resetId === u.id && (
                <div className="flex gap-2">
                  <Input
                    type="password"
                    value={resetPassword}
                    onChange={(e) => setResetPassword(e.target.value)}
                    className={inputCls}
                    placeholder="new passphrase (min 8 chars)"
                    autoComplete="new-password"
                  />
                  <Button
                    size="sm"
                    className="font-mono text-[10px] font-bold tracking-widest uppercase rounded-sm h-9"
                    disabled={resetUserPassword.isPending}
                    onClick={() => handleReset(u.id, u.username)}
                  >
                    {resetUserPassword.isPending ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      "SET"
                    )}
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Create user */}
        <form onSubmit={handleCreate} className="space-y-3 border-t border-border pt-4">
          <Label className="font-mono text-[10px] text-muted-foreground tracking-widest uppercase">
            Provision new operator
          </Label>
          <div className="flex gap-2">
            <Input
              type="text"
              value={newUsername}
              onChange={(e) => setNewUsername(e.target.value)}
              className={inputCls}
              placeholder="username"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck="false"
            />
            <Input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className={inputCls}
              placeholder="passphrase"
              autoComplete="new-password"
            />
            <Button
              type="submit"
              size="icon"
              className="rounded-sm h-9 w-10 shrink-0"
              disabled={createUser.isPending}
              title="Create user"
            >
              {createUser.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Plus className="w-4 h-4" />
              )}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
