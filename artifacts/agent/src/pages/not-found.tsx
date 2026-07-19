import { Home } from "lucide-react";
import { Link } from "wouter";

export default function NotFound() {
  return (
    <div className="flex h-screen w-full flex-col items-center justify-center bg-background text-foreground">
      <div className="flex flex-col items-center space-y-4">
        <h1 className="text-6xl font-bold font-mono tracking-tighter text-primary">404</h1>
        <h2 className="text-xl font-medium text-muted-foreground">SIGNAL LOST</h2>
        <p className="text-sm text-muted-foreground/80 max-w-xs text-center">
          The quadrant you are looking for does not exist or has been archived.
        </p>
        <Link href="/" className="mt-8 inline-flex items-center space-x-2 text-sm font-medium text-primary hover:text-primary/80 transition-colors">
          <Home className="h-4 w-4" />
          <span>RETURN TO COMMAND</span>
        </Link>
      </div>
    </div>
  );
}