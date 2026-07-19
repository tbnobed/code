import { useState } from "react";
import { Terminal, Lock, Loader2, AlertCircle } from "lucide-react";
import { useLogin, useRegister, getGetCurrentUserQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function Auth() {
  const [isLogin, setIsLogin] = useState(true);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const queryClient = useQueryClient();
  const loginMutation = useLogin();
  const registerMutation = useRegister();

  const isPending = loginMutation.isPending || registerMutation.isPending;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const u = username.trim();
    if (!u || !password) {
      setError("Identifier and passphrase required");
      return;
    }

    if (!isLogin && password !== confirmPassword) {
      setError("Passphrases do not match");
      return;
    }

    const payload = { data: { username: u, password } };
    const onSuccess = () => {
      queryClient.invalidateQueries({ queryKey: getGetCurrentUserQueryKey() });
    };
    const onError = (err: any) => {
      setError(err.message || "Authentication failed");
    };

    if (isLogin) {
      loginMutation.mutate(payload, { onSuccess, onError });
    } else {
      registerMutation.mutate(payload, { onSuccess, onError });
    }
  };

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-background text-foreground selection:bg-primary/30 relative overflow-hidden">
      {/* Background elements */}
      <div className="absolute inset-0 pointer-events-none opacity-[0.03] dark:opacity-[0.05]" 
           style={{ backgroundImage: 'linear-gradient(to right, currentColor 1px, transparent 1px), linear-gradient(to bottom, currentColor 1px, transparent 1px)', backgroundSize: '2rem 2rem' }}>
      </div>

      <div className="w-full max-w-sm p-6 relative z-10">
        <div className="flex flex-col items-center mb-8">
          <div className="w-16 h-16 bg-sidebar-accent text-sidebar-primary rounded-sm flex items-center justify-center shadow-lg border border-sidebar-border mb-4">
            <Terminal className="w-8 h-8" />
          </div>
          <h1 className="font-bold tracking-widest font-mono text-xl uppercase">FORGE // <span className="text-muted-foreground">OS</span></h1>
          <p className="text-[10px] font-mono text-muted-foreground mt-2 tracking-widest uppercase">Secured Access Console</p>
        </div>

        <div className="bg-card border border-border shadow-2xl rounded-sm overflow-hidden">
          <div className="flex border-b border-border bg-muted/50">
            <button
              type="button"
              className={`flex-1 py-3 text-[10px] font-mono font-bold tracking-widest uppercase transition-colors ${isLogin ? "text-primary border-b-2 border-primary bg-background shadow-sm" : "text-muted-foreground hover:text-foreground hover:bg-muted/80"}`}
              onClick={() => { setIsLogin(true); setError(null); }}
            >
              Authenticate
            </button>
            <button
              type="button"
              className={`flex-1 py-3 text-[10px] font-mono font-bold tracking-widest uppercase transition-colors ${!isLogin ? "text-primary border-b-2 border-primary bg-background shadow-sm" : "text-muted-foreground hover:text-foreground hover:bg-muted/80"}`}
              onClick={() => { setIsLogin(false); setError(null); }}
            >
              Provision
            </button>
          </div>

          <form onSubmit={handleSubmit} className="p-6 space-y-4">
            {error && (
              <div className="bg-destructive/10 border border-destructive/30 rounded-sm p-3 flex items-start gap-2 text-destructive font-mono text-xs">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span className="leading-tight">{error}</span>
              </div>
            )}

            <div className="space-y-2">
              <Label className="font-mono text-[10px] text-muted-foreground tracking-widest uppercase">IDENTIFIER</Label>
              <Input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="font-mono text-sm bg-background border-input focus-visible:ring-primary rounded-sm h-10 transition-colors"
                placeholder={isLogin ? "system_admin" : "username (3-64 chars)"}
                disabled={isPending}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck="false"
                required
              />
            </div>

            <div className="space-y-2">
              <Label className="font-mono text-[10px] text-muted-foreground tracking-widest uppercase">PASSPHRASE</Label>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="font-mono text-sm bg-background border-input focus-visible:ring-primary rounded-sm h-10 transition-colors"
                placeholder={isLogin ? "••••••••" : "minimum 8 characters"}
                disabled={isPending}
                required
              />
            </div>

            {!isLogin && (
              <div className="space-y-2 animate-in fade-in slide-in-from-top-2 duration-200">
                <Label className="font-mono text-[10px] text-muted-foreground tracking-widest uppercase">VERIFY PASSPHRASE</Label>
                <Input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="font-mono text-sm bg-background border-input focus-visible:ring-primary rounded-sm h-10 transition-colors"
                  placeholder="••••••••"
                  disabled={isPending}
                  required
                />
              </div>
            )}

            <div className="pt-2">
              <Button
                type="submit"
                disabled={isPending}
                className="w-full font-mono text-[10px] font-bold tracking-widest uppercase rounded-sm h-10 shadow-sm border border-primary-border/50"
              >
                {isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : (
                  <span className="flex items-center gap-2">
                    <Lock className="w-3.5 h-3.5" />
                    {isLogin ? "INITIATE SESSION" : "PROVISION ACCOUNT"}
                  </span>
                )}
              </Button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
