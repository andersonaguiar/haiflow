import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from "react";

// --- Badge ---

const badgeStyles: Record<string, string> = {
  idle: "bg-green-500/20 text-green-400 border-green-500/30",
  busy: "bg-amber-500/20 text-amber-400 border-amber-500/30 animate-[pulse_2s_ease-in-out_infinite]",
  offline: "bg-gray-500/20 text-gray-400 border-gray-500/30",
  delivered: "bg-green-500/20 text-green-400 border-green-500/30",
  failed: "bg-red-500/20 text-red-400 border-red-500/30",
  partial: "bg-orange-500/20 text-orange-400 border-orange-500/30",
  pending: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  published: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  queued: "bg-purple-500/20 text-purple-400 border-purple-500/30",
  skipped: "bg-gray-500/20 text-gray-400 border-gray-500/30",
  session: "bg-cyan-500/20 text-cyan-400 border-cyan-500/30",
  webhook: "bg-violet-500/20 text-violet-400 border-violet-500/30",
};

const dotColors: Record<string, string> = {
  idle: "bg-green-500",
  busy: "bg-amber-500 animate-[pulse_2s_ease-in-out_infinite]",
  offline: "bg-gray-600",
};

export function Badge({ variant, className }: { variant: string; className?: string }) {
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full border ${badgeStyles[variant] ?? badgeStyles.offline} ${className ?? ""}`}>
      {variant}
    </span>
  );
}

export function StatusDot({ status }: { status: string }) {
  return <span className={`w-2 h-2 rounded-full shrink-0 ${dotColors[status] ?? "bg-gray-600"}`} />;
}

// --- Skeleton ---

export function Skeleton({ className }: { className?: string }) {
  return <div className={`bg-gray-800 rounded animate-pulse ${className ?? "h-4 w-full"}`} />;
}

export function SkeletonLine({ width }: { width?: string }) {
  return <div className={`bg-gray-800 rounded animate-pulse h-3 ${width ?? "w-full"}`} />;
}

// --- Empty State ---

export function EmptyState({ icon, title, description, children }: {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
      {icon && <div className="text-gray-600 mb-3">{icon}</div>}
      <p className="text-sm font-medium text-gray-400 mb-1">{title}</p>
      {description && <p className="text-xs text-gray-600 max-w-xs">{description}</p>}
      {children && <div className="mt-4">{children}</div>}
    </div>
  );
}

// --- Card ---

export function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`bg-gray-900 border border-gray-800 rounded-lg ${className ?? ""}`}>
      {children}
    </div>
  );
}

// --- Kbd ---

export function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="bg-gray-800 border border-gray-700 rounded px-1.5 py-0.5 text-[10px] font-mono text-gray-400 leading-none">
      {children}
    </kbd>
  );
}

// --- Stat Card ---

export function StatCard({ label, value, className }: { label: string; value: string | number; className?: string }) {
  return (
    <div className={`bg-gray-900 border border-gray-800 rounded-lg px-3 py-2 ${className ?? ""}`}>
      <span className="text-[10px] uppercase tracking-wider text-gray-600 font-medium block">{label}</span>
      <span className="text-lg font-semibold text-gray-200">{value}</span>
    </div>
  );
}

// --- Toast ---

interface ToastItem {
  id: number;
  message: string;
  type: "success" | "error" | "info";
}

const ToastContext = createContext<((message: string, type?: ToastItem["type"]) => void) | null>(null);

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(0);

  const toast = useCallback((message: string, type: ToastItem["type"] = "info") => {
    const id = nextId.current++;
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 3000);
  }, []);

  const toastColors: Record<string, string> = {
    success: "border-green-500/30 bg-green-950/80 text-green-300",
    error: "border-red-500/30 bg-red-950/80 text-red-300",
    info: "border-blue-500/30 bg-blue-950/80 text-blue-300",
  };

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`px-4 py-2 rounded-lg border text-sm shadow-lg animate-[slideIn_200ms_ease-out] pointer-events-auto ${toastColors[t.type]}`}
          >
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

// --- SVG Icons (inline, no dependency) ---

export function InboxIcon({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
      <path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z" />
    </svg>
  );
}

export function MessageIcon({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
    </svg>
  );
}

export function TerminalIcon({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  );
}

export function NetworkIcon({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="5" r="3" />
      <circle cx="5" cy="19" r="3" />
      <circle cx="19" cy="19" r="3" />
      <line x1="12" y1="8" x2="5" y2="16" />
      <line x1="12" y1="8" x2="19" y2="16" />
    </svg>
  );
}

export function SearchIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

export function GridIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" />
      <rect x="14" y="3" width="7" height="7" />
      <rect x="3" y="14" width="7" height="7" />
      <rect x="14" y="14" width="7" height="7" />
    </svg>
  );
}

export function MonitorIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  );
}
