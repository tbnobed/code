import { ReactNode } from "react";
import { useLocation, useSearch } from "wouter";
import { Terminal, HardDrive, Cpu, Plus, Loader2, Trash2, LogOut, User as UserIcon } from "lucide-react";
import { useListSessions, useDeleteSession, useCreateSession, getListSessionsQueryKey, useGetCurrentUser, useLogout } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { useListModels } from "@workspace/api-client-react";
import { useState } from "react";

function CreateSessionDialog({ onOpenChange }: { onOpenChange?: (open: boolean) => void }) {
  const [title, setTitle] = useState("");
  const [model, setModel] = useState<string>("");
  const [open, setOpen] = useState(false);
  
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  const { data: models = [] } = useListModels();
  const createSession = useCreateSession();

  const handleOpenChange = (newOpen: boolean) => {
    setOpen(newOpen);
    if (!newOpen) {
      setTitle("");
      setModel("");
    }
    if (onOpenChange) onOpenChange(newOpen);
  };

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;

    createSession.mutate(
      { data: { title: title.trim(), model: model || undefined } },
      {
        onSuccess: (session) => {
          queryClient.invalidateQueries({ queryKey: getListSessionsQueryKey() });
          handleOpenChange(false);
          setLocation(`/?session=${session.id}`);
        }
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" className="w-full justify-start gap-2 h-10 border-dashed border-sidebar-border bg-sidebar-accent/30 text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground hover:border-sidebar-primary/50 transition-all">
          <Plus className="h-4 w-4 text-sidebar-primary" />
          <span className="font-mono tracking-tight">NEW_SESSION</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md border-border bg-card">
        <DialogHeader>
          <DialogTitle className="font-mono text-primary flex items-center gap-2">
            <Terminal className="h-5 w-5" />
            INITIALIZE_WORKSPACE
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4 pt-4">
          <div className="space-y-2">
            <Label htmlFor="title" className="font-mono text-xs text-muted-foreground uppercase">Session Title</Label>
            <Input 
              id="title" 
              placeholder="e.g. React Dashboard" 
              value={title} 
              onChange={(e) => setTitle(e.target.value)}
              className="font-mono bg-background border-input focus-visible:ring-primary"
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="model" className="font-mono text-xs text-muted-foreground uppercase">Model (Optional)</Label>
            <Select 
              id="model" 
              value={model} 
              onChange={(e) => setModel(e.target.value)}
              className="font-mono bg-background border-input"
            >
              <option value="">System Default</option>
              {models.map(m => (
                <option key={m.name} value={m.name}>{m.name}</option>
              ))}
            </Select>
          </div>
          <DialogFooter className="pt-4">
            <Button 
              type="submit" 
              disabled={!title.trim() || createSession.isPending}
              className="font-mono w-full sm:w-auto"
            >
              {createSession.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "EXECUTE"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SessionList() {
  const { data: sessions, isLoading } = useListSessions();
  const { data: me } = useGetCurrentUser();
  const [, setLocation] = useLocation();
  const search = useSearch();
  const searchParams = new URLSearchParams(search);
  const activeSessionId = searchParams.get("session") ? parseInt(searchParams.get("session")!, 10) : null;
  const deleteSession = useDeleteSession();
  const queryClient = useQueryClient();

  if (isLoading) {
    return (
      <div className="space-y-2 px-4 py-2">
        <Skeleton className="h-10 w-full bg-sidebar-accent/50" />
        <Skeleton className="h-10 w-full bg-sidebar-accent/50" />
        <Skeleton className="h-10 w-full bg-sidebar-accent/50" />
      </div>
    );
  }

  if (!sessions?.length) {
    return (
      <div className="px-4 py-8 text-center">
        <p className="text-xs font-mono text-sidebar-foreground/50">NO ACTIVE SESSIONS</p>
      </div>
    );
  }

  const handleDelete = (e: React.MouseEvent, id: number) => {
    e.preventDefault();
    e.stopPropagation();
    if (confirm("Permanently delete this session and its workspace?")) {
      deleteSession.mutate({ id }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListSessionsQueryKey() });
          if (activeSessionId === id) {
            setLocation("/");
          }
        }
      });
    }
  };

  return (
    <ScrollArea className="h-full">
      <div className="space-y-1 px-3 py-2">
        {sessions.map((session) => {
          const isActive = session.id === activeSessionId;
          return (
            <div
              key={session.id}
              onClick={() => setLocation(`/?session=${session.id}`)}
              className={cn(
                "group flex items-center justify-between px-3 py-2 text-sm rounded-sm cursor-pointer border transition-colors",
                isActive 
                  ? "bg-sidebar-accent text-sidebar-accent-foreground border-sidebar-primary/50 shadow-[0_0_10px_rgba(255,122,24,0.1)]" 
                  : "border-transparent text-sidebar-foreground/80 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
              )}
            >
              <div className="flex flex-col min-w-0 pr-2">
                <span className="font-medium truncate block font-mono text-xs">{session.title}</span>
                <span className="text-[10px] text-sidebar-foreground/50 truncate font-mono mt-0.5 flex items-center gap-1">
                  <Cpu className="h-3 w-3" />
                  {session.model}
                  {session.username && me?.username && session.username !== me.username && (
                    <span className="text-sidebar-primary/80 truncate" title={`Owned by ${session.username}`}>
                      @{session.username}
                    </span>
                  )}
                </span>
              </div>
              <Button 
                variant="ghost" 
                size="icon" 
                className={cn(
                  "h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 text-sidebar-foreground/50 hover:text-destructive hover:bg-destructive/10",
                  isActive && "opacity-100 text-sidebar-foreground/70"
                )}
                onClick={(e) => handleDelete(e, session.id)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          );
        })}
      </div>
    </ScrollArea>
  );
}

import { cn } from "@/lib/utils";
import ForgeWorkspace from "./ForgeWorkspace";
import UsersDialog from "@/components/UsersDialog";

function UserBlock() {
  const { data: user } = useGetCurrentUser();
  const logout = useLogout();
  const queryClient = useQueryClient();

  if (!user) return null;

  const handleLogout = () => {
    logout.mutate(undefined, {
      onSuccess: () => {
        queryClient.clear(); // Clear all data
        // Then re-fetch user (which will 401 and redirect to Auth)
        queryClient.invalidateQueries();
      }
    });
  };

  return (
    <div className="h-14 border-t border-sidebar-border bg-sidebar shrink-0 px-4 flex items-center justify-between relative z-10">
      <div className="flex items-center gap-2 overflow-hidden">
        <div className="w-6 h-6 rounded-sm bg-sidebar-primary/20 flex items-center justify-center text-sidebar-primary shrink-0">
          <UserIcon className="w-3.5 h-3.5" />
        </div>
        <div className="flex flex-col min-w-0">
          <span className="font-mono text-xs font-bold text-sidebar-foreground truncate tracking-wide">
            {user.username}
          </span>
          <span className="font-mono text-[9px] text-muted-foreground uppercase tracking-widest">
            {user.isAdmin ? "SYS_ADMIN" : "OPERATOR"}
          </span>
        </div>
      </div>
      {user.isAdmin && <UsersDialog />}
      <Button 
        variant="ghost" 
        size="icon" 
        onClick={handleLogout}
        disabled={logout.isPending}
        className="w-8 h-8 text-sidebar-foreground/50 hover:text-sidebar-foreground hover:bg-sidebar-accent shrink-0"
        title="Terminate Session"
      >
        {logout.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <LogOut className="w-4 h-4" />}
      </Button>
    </div>
  );
}

export default function ForgeLayout() {
  const search = useSearch();
  const searchParams = new URLSearchParams(search);
  const activeSessionId = searchParams.get("session") ? parseInt(searchParams.get("session")!, 10) : null;

  return (
    <div className="flex h-screen w-full overflow-hidden bg-background text-foreground font-sans selection:bg-primary/30">
      
      {/* Sidebar - Control Panel */}
      <aside className="w-72 flex-shrink-0 border-r border-sidebar-border bg-sidebar flex flex-col z-10 shadow-xl relative">
        {/* Subtle grid pattern background for the sidebar */}
        <div className="absolute inset-0 pointer-events-none opacity-[0.03] dark:opacity-[0.05]" 
             style={{ backgroundImage: 'linear-gradient(to right, currentColor 1px, transparent 1px), linear-gradient(to bottom, currentColor 1px, transparent 1px)', backgroundSize: '1rem 1rem' }}>
        </div>
        
        <div className="h-14 flex items-center px-4 border-b border-sidebar-border bg-sidebar relative z-10">
          <div className="flex items-center gap-2.5">
            <img src={`${import.meta.env.BASE_URL}mark.svg`} alt="" className="h-6 w-6" />
            <h1 className="font-bold tracking-widest font-mono text-sm uppercase text-sidebar-foreground">FORGE<span className="text-sidebar-primary">OS</span></h1>
          </div>
        </div>

        <div className="p-4 relative z-10">
          <CreateSessionDialog />
        </div>

        <div className="px-4 pb-2 relative z-10">
          <Label className="text-[10px] font-mono font-bold tracking-widest text-sidebar-foreground/50 uppercase flex items-center gap-1.5 mb-2">
            <HardDrive className="h-3 w-3" />
            LOCAL_INSTANCES
          </Label>
        </div>

        <div className="flex-1 overflow-hidden relative z-10">
          <SessionList />
        </div>

        <UserBlock />
      </aside>

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col relative overflow-hidden bg-background">
        {activeSessionId ? (
          <ForgeWorkspace sessionId={activeSessionId} />
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-center p-8 relative">
            {/* Background decorative elements */}
            <div className="absolute inset-0 pointer-events-none flex items-center justify-center opacity-[0.02] dark:opacity-[0.03]">
              <Terminal className="w-96 h-96" />
            </div>
            
            <div className="relative z-10 max-w-md space-y-6">
              <div className="w-16 h-16 bg-sidebar-accent text-sidebar-primary rounded-sm flex items-center justify-center mx-auto mb-6 shadow-lg border border-sidebar-border">
                <Terminal className="w-8 h-8" />
              </div>
              <h2 className="text-2xl font-bold font-mono tracking-tight text-foreground">SYSTEM OFFLINE</h2>
              <p className="text-muted-foreground text-sm font-mono max-w-sm mx-auto leading-relaxed">
                Awaiting connection to DGX core. Initialize a new session to mount workspace and boot local LLM worker.
              </p>
              <div className="pt-4 flex justify-center">
                <div className="w-64">
                  <CreateSessionDialog />
                </div>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}