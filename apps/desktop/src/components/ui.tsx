import { cva, type VariantProps } from "class-variance-authority";
import { X } from "lucide-react";
import type { ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { cn } from "../lib/utils";

const button = cva("inline-flex items-center justify-center gap-1.5 rounded-md text-sm font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none cursor-pointer", {
  variants: {
    variant: {
      default: "bg-primary text-primary-foreground hover:opacity-90",
      outline: "border bg-card hover:bg-muted",
      ghost: "hover:bg-muted",
      danger: "bg-danger text-white hover:opacity-90",
    },
    size: { sm: "h-7 px-2.5 text-xs", md: "h-9 px-3.5", icon: "h-7 w-7" },
  },
  defaultVariants: { variant: "default", size: "md" },
});
export function Button({ className, variant, size, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof button>) {
  return <button className={cn(button({ variant, size }), className)} {...p} />;
}
export const Card = ({ className, ...p }: HTMLAttributes<HTMLDivElement>) => <div className={cn("rounded-xl border bg-card shadow-sm", className)} {...p} />;
export const Input = ({ className, ...p }: InputHTMLAttributes<HTMLInputElement>) => <input className={cn("h-9 w-full rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-primary/40", className)} {...p} />;
export const Textarea = ({ className, ...p }: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea className={cn("w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40", className)} {...p} />;
export const Select = ({ className, ...p }: SelectHTMLAttributes<HTMLSelectElement>) => <select className={cn("h-9 w-full rounded-md border bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-primary/40", className)} {...p} />;
export const Label = ({ children, hint }: { children: ReactNode; hint?: string }) => (
  <label className="mb-1 block text-xs font-medium text-muted-foreground">{children}{hint && <span className="ml-1 font-normal opacity-70">{hint}</span>}</label>
);

const badge = cva("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium", {
  variants: { tone: { muted: "bg-muted text-muted-foreground", ok: "bg-ok/15 text-ok", warn: "bg-warn/15 text-warn", danger: "bg-danger/15 text-danger", primary: "bg-primary/15 text-primary" } },
  defaultVariants: { tone: "muted" },
});
export const Badge = ({ tone, className, ...p }: HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badge>) => <span className={cn(badge({ tone }), className)} {...p} />;

export function Switch({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button role="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}
      className={cn("relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50 cursor-pointer", checked ? "bg-primary" : "bg-muted-foreground/40")}>
      <span className={cn("absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all", checked ? "left-[18px]" : "left-0.5")} />
    </button>
  );
}

export function Dialog({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onMouseDown={onClose}>
      <div className={cn("max-h-[90vh] w-full overflow-auto rounded-xl border bg-card p-5 shadow-xl", wide ? "max-w-3xl" : "max-w-lg")} onMouseDown={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between"><h2 className="text-base font-semibold">{title}</h2><Button variant="ghost" size="icon" onClick={onClose}><X size={16} /></Button></div>
        {children}
      </div>
    </div>
  );
}

const STATE_COLORS: Record<string, string> = { off: "bg-muted-foreground/50", idle: "bg-ok", working: "bg-primary pulse-dot", waiting_for_guy: "bg-warn pulse-dot", stuck: "bg-danger", restarting: "bg-warn pulse-dot" };
export const StateDot = ({ state }: { state: string }) => <span className={cn("inline-block h-2 w-2 rounded-full", STATE_COLORS[state] ?? "bg-muted-foreground")} />;
